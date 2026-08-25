/**
 * End-to-end smoke test of the core flow:
 * register -> catalogue -> BOM -> purchase receipt -> quotation -> sales order ->
 * production (issue + output) -> dispatch -> invoice -> payment.
 *
 * Runs against an in-memory MongoDB, so no local mongod is required:
 *   node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'test-secret-value-for-smoke-tests';

let mongo;
let server;
let baseUrl;
let token;

const api = async (path, { method = 'GET', body, auth = true } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('first registered user becomes admin and receives a token', async () => {
  const { status, json } = await api('/api/auth/register', {
    auth: false,
    method: 'POST',
    body: { name: 'Plant Admin', email: 'admin@test.local', password: 'Admin@12345' },
  });

  assert.equal(status, 201);
  assert.equal(json.data.user.role, 'admin');
  assert.ok(json.data.token);
  token = json.data.token;
});

test('rejects an invalid registration payload', async () => {
  const { status, json } = await api('/api/auth/register', {
    auth: false,
    method: 'POST',
    body: { name: 'X', email: 'not-an-email', password: 'short' },
  });

  assert.equal(status, 400);
  assert.ok(json.details.length >= 2);
});

test('full order-to-cash and material flow', async () => {
  const rawStore = (
    await api('/api/warehouses', {
      method: 'POST',
      body: { code: 'RM-01', name: 'Raw Store', type: 'raw_material' },
    })
  ).json.data;
  const fgStore = (
    await api('/api/warehouses', {
      method: 'POST',
      body: { code: 'FG-01', name: 'Finished Store', type: 'finished_goods' },
    })
  ).json.data;

  const supplier = (
    await api('/api/suppliers', {
      method: 'POST',
      body: { code: 'SUP001', name: 'Southern Polymers', category: 'resin' },
    })
  ).json.data;

  const resin = (
    await api('/api/materials', {
      method: 'POST',
      body: { code: 'RM-PP-001', name: 'PP Granules', category: 'resin', uom: 'kg', standardCost: 118 },
    })
  ).json.data;

  const product = (
    await api('/api/products', {
      method: 'POST',
      body: {
        sku: 'HNG-SHT-380-BLK',
        name: 'Shirt Hanger 380mm Black',
        hangerType: 'shirt',
        material: 'plastic',
        sizeMm: 380,
        unitPrice: 11.5,
        standardCost: 6.8,
      },
    })
  ).json.data;

  const bom = await api('/api/boms', {
    method: 'POST',
    body: {
      product: product._id,
      components: [{ material: resin._id, quantityPerUnit: 0.05, uom: 'kg', scrapPercent: 0 }],
    },
  });
  assert.equal(bom.status, 201);

  // Buy and receive 1000 kg of resin.
  const purchaseOrder = (
    await api('/api/purchase-orders', {
      method: 'POST',
      body: {
        supplier: supplier._id,
        warehouse: rawStore._id,
        lines: [{ material: resin._id, quantity: 1000, unitPrice: 118, taxPercent: 18 }],
      },
    })
  ).json.data;
  assert.equal(purchaseOrder.grandTotal, 139240);

  const received = await api(`/api/purchase-orders/${purchaseOrder._id}/receive`, { method: 'POST' });
  assert.equal(received.json.data.status, 'received');

  const customer = (
    await api('/api/customers', {
      method: 'POST',
      body: { code: 'CUST001', name: 'Trendline Retail', paymentTermsDays: 30 },
    })
  ).json.data;

  const quotation = (
    await api('/api/quotations', {
      method: 'POST',
      body: {
        customer: customer._id,
        lines: [{ product: product._id, quantity: 1000, unitPrice: 11.5, taxPercent: 18 }],
      },
    })
  ).json.data;
  assert.match(quotation.number, /^QUO-\d{4}-\d{4}$/);
  assert.equal(quotation.grandTotal, 13570);

  const salesOrder = (
    await api(`/api/quotations/${quotation._id}/convert`, { method: 'POST' })
  ).json.data;
  assert.equal(salesOrder.grandTotal, quotation.grandTotal);

  // No finished stock yet, so planning must raise a production order.
  const planned = await api(`/api/sales-orders/${salesOrder._id}/plan-production`, {
    method: 'POST',
  });
  assert.equal(planned.json.data.productionOrders.length, 1);
  const productionOrder = planned.json.data.productionOrders[0];
  assert.equal(productionOrder.quantityPlanned, 1000);
  assert.equal(productionOrder.materials[0].quantityRequired, 50);

  const issued = await api(`/api/production-orders/${productionOrder._id}/issue-materials`, {
    method: 'POST',
  });
  assert.equal(issued.json.data.materialsIssued, true);

  const output = await api(`/api/production-orders/${productionOrder._id}/output`, {
    method: 'POST',
    body: { quantityProduced: 1000, quantityScrapped: 12 },
  });
  assert.equal(output.json.data.status, 'completed');

  const stock = await api('/api/stock');
  const resinRow = stock.json.data.find((row) => row.code === 'RM-PP-001');
  const productRow = stock.json.data.find((row) => row.code === 'HNG-SHT-380-BLK');
  assert.equal(resinRow.quantity, 950);
  assert.equal(productRow.quantity, 1000);

  const dispatched = await api(`/api/sales-orders/${salesOrder._id}/dispatch`, {
    method: 'POST',
    body: { warehouse: fgStore._id },
  });
  assert.equal(dispatched.json.data.status, 'dispatched');

  const invoice = (
    await api(`/api/sales-orders/${salesOrder._id}/invoice`, { method: 'POST' })
  ).json.data;
  assert.equal(invoice.grandTotal, 13570);

  const payment = await api(`/api/invoices/${invoice._id}/payments`, {
    method: 'POST',
    body: { amount: 5000, mode: 'upi' },
  });
  assert.equal(payment.json.data.invoice.status, 'partially_paid');

  const overpay = await api(`/api/invoices/${invoice._id}/payments`, {
    method: 'POST',
    body: { amount: 999999 },
  });
  assert.equal(overpay.status, 400);

  const summary = await api('/api/dashboard/summary');
  assert.equal(summary.json.data.receivables, 8570);
  assert.equal(summary.json.data.activeCustomers, 1);
});

test('blocks issuing more stock than is on hand', async () => {
  const warehouse = (
    await api('/api/warehouses', {
      method: 'POST',
      body: { code: 'RM-02', name: 'Second Store', type: 'raw_material' },
    })
  ).json.data;
  const material = (
    await api('/api/materials', {
      method: 'POST',
      body: { code: 'RM-WR-005', name: 'Hook Wire', category: 'metal_wire', uom: 'kg' },
    })
  ).json.data;

  const { status, json } = await api('/api/stock/adjust', {
    method: 'POST',
    body: { itemType: 'Material', item: material._id, warehouse: warehouse._id, quantity: -10 },
  });

  assert.equal(status, 400);
  assert.match(json.message, /Insufficient stock/);
});
