/**
 * The production register after years of orders: the newest work is never the part cut off,
 * and a closed order is not open work.
 *
 *   node --test tests/production-volume.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'production-volume-test-secret';

let mongo;
let server;
let baseUrl;
let admin;
let SalesOrder;
let base;

const api = async (path, token) => {
  const response = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: response.status, json: await response.json().catch(() => ({})), text: '' };
};
const days = (offset) => new Date(Date.now() + offset * 86400000);
const line = (extra = {}) => ({ modelNumber: 'NPT-400S', quantity: 10000, unitPrice: 8, deliveryDate: days(10), ...extra });

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' }),
  });
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@np.com', password: 'Admin@12345' }),
  });
  admin = (await login.json()).data.token;

  ({ default: SalesOrder } = await import('../src/models/SalesOrder.js'));
  const { default: User } = await import('../src/models/User.js');
  const { default: Customer } = await import('../src/models/Customer.js');
  const navin = await User.findOne({ email: 'admin@np.com' });
  const customer = await Customer.create({ code: 'CUST-V-1', name: 'SCM Garments', assignedTo: navin._id, createdBy: navin._id });
  base = { customer: customer._id, assignedTo: navin._id, createdBy: navin._id };

  /* Five thousand and ten finished orders from the years before — more than the register reads. */
  await SalesOrder.collection.insertMany(Array.from({ length: 5010 }, (_, n) => ({
    ...base, number: `SO-OLD-${n}`, status: 'closed', orderDate: days(-1000 + n / 10),
    lines: [{ _id: new mongoose.Types.ObjectId(), ...line({ deliveryDate: days(-900) }), production: { status: 'completed', producedQty: 10000, readyQty: 10000 } }],
    createdAt: days(-1000 + n / 10), updatedAt: days(-1000 + n / 10),
  })));
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('an order placed today is in the register however many came before it', async () => {
  const fresh = await SalesOrder.create({ ...base, number: 'SO-TODAY-1', status: 'production_running', orderDate: new Date(), lines: [line()] });
  /* Unsearched, as the queue opens: the register reads at most 5,000 orders, and today's must be among them. */
  const listed = await api('/api/production?open=true&limit=100', admin);
  assert.equal(listed.status, 200, listed.json.message);
  assert.ok(listed.json.data.some((row) => row.order.number === 'SO-TODAY-1'), 'today’s order is on the register');

  const exported = await fetch(`${baseUrl}/api/production/export`, { headers: { Authorization: `Bearer ${admin}` } });
  assert.match(await exported.text(), /SO-TODAY-1/, 'and in the export');
  await SalesOrder.deleteOne({ _id: fresh._id });
});

test('a closed order with a line short of its quantity is not open work', async () => {
  const shortClosed = await SalesOrder.create({
    ...base, number: 'SO-SHORT-1', status: 'closed', orderDate: new Date(),
    lines: [line({ deliveryDate: days(-5), production: { status: 'running', producedQty: 9500, readyQty: 9500 } })],
  });
  /* Searched, so the order is certainly read — the question is only whether it counts as open. */
  const everything = await api('/api/production?search=SO-SHORT-1', admin);
  assert.ok(everything.json.data.some((row) => row.order.number === 'SO-SHORT-1'), 'it is in the register’s history');
  const open = await api('/api/production?search=SO-SHORT-1&open=true', admin);
  assert.equal(open.status, 200, open.json.message);
  assert.ok(!open.json.data.some((row) => row.order.number === 'SO-SHORT-1'), 'not in the open queue');
  const overdue = await api('/api/production?search=SO-SHORT-1&overdue=true', admin);
  assert.ok(!overdue.json.data.some((row) => row.order.number === 'SO-SHORT-1'), 'nor overdue');
  await SalesOrder.deleteOne({ _id: shortClosed._id });
});
