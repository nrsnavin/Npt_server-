/**
 * Quotations [BLUEPRINT §10], and the price gate in front of them [§9].
 *
 * §10 is explicit that **every revision stays in history** — Rev 0 ₹7.50, Rev 1 ₹7.30, Rev 2
 * ₹7.20. That is not an audit nicety. Six weeks into a negotiation the only way to answer "what
 * did we last tell them?" is that list, and a quotation that overwrites its own price cannot
 * answer it at all, which is how a plant ends up honouring a number it never sent.
 *
 * The gate is the other half: a price below the approved minimum must not reach a customer
 * until somebody who can see the minimum has signed it off. Marketing cannot see the figure, so
 * they cannot be the ones to decide they are above it.
 *
 *   node --test tests/quotation.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'quotation-test-secret-value';

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
const followUp = { nextAction: 'Call the buyer', nextFollowUpDate: inDays(3) };

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let kavitha;
let customer;
let product;

const api = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

const signIn = async (email, password) => {
  const { json } = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  return json.data?.token;
};

const quote = async (extra = {}, token = nandhini) => {
  const { status, json } = await api('/api/quotations', {
    method: 'POST',
    token,
    body: {
      customer,
      quantity: 40000,
      unitPrice: 7.5,
      modelNumber: 'NH-400',
      paymentTerms: '30 days',
      validUntil: inDays(30),
      ...extra,
    },
  });
  assert.equal(status, 201, json.message);
  return json.data;
};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' },
  });
  admin = await signIn('admin@np.com', 'Admin@12345');

  for (const [name, email, password] of [
    ['Nandhini S', 'nandhini@np.com', 'Passw0rd@123'],
    ['Kavitha R', 'kavitha@np.com', 'Passw0rd@456'],
  ]) {
    await api('/api/users', {
      method: 'POST',
      token: admin,
      body: { name, email, password, department: 'marketing' },
    });
  }
  nandhini = await signIn('nandhini@np.com', 'Passw0rd@123');
  kavitha = await signIn('kavitha@np.com', 'Passw0rd@456');

  const madeProduct = await api('/api/products', {
    method: 'POST',
    token: admin,
    body: { modelCode: 'NH-400', name: 'Shirt hanger 400mm', category: 'shirt', material: 'plastic', sizeMm: 400 },
  });
  product = madeProduct.json.data._id;

  const madeCustomer = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'Sri Kumaran Knits', mobile: '9840011223' },
  });
  customer = madeCustomer.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* -------------------------------- Revisions -------------------------------- */

test('the first price is Rev 0, in the history from the start', async () => {
  // A history that begins at Rev 1 has silently lost the original quote.
  const made = await quote();

  assert.equal(made.revision, 0);
  assert.equal(made.revisions.length, 1);
  assert.equal(made.revisions[0].unitPrice, 7.5);
});

test('every revision stays — Rev 0 ₹7.50, Rev 1 ₹7.30, Rev 2 ₹7.20', async () => {
  const made = await quote();

  for (const price of [7.3, 7.2]) {
    const revised = await api(`/api/quotations/${made._id}/revisions`, {
      method: 'POST',
      token: nandhini,
      body: { unitPrice: price, note: 'Buyer pushed back' },
    });
    assert.equal(revised.status, 200, revised.json.message);
  }

  const { json } = await api(`/api/quotations/${made._id}`, { token: nandhini });
  assert.equal(json.data.revision, 2);
  assert.equal(json.data.unitPrice, 7.2, 'the live price is the newest');
  assert.deepEqual(
    json.data.revisions.map((row) => [row.revision, row.unitPrice]),
    [[0, 7.5], [1, 7.3], [2, 7.2]],
    'and every price it ever carried is answerable'
  );
});

test('the price cannot be changed by editing — that would overwrite the history', async () => {
  const made = await quote();
  const edited = await api(`/api/quotations/${made._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { unitPrice: 6.9 },
  });

  assert.equal(edited.status, 400);
  assert.match(edited.json.message, /revision/i);
});

test('a revision has to revise something', async () => {
  const made = await quote();
  const empty = await api(`/api/quotations/${made._id}/revisions`, {
    method: 'POST',
    token: nandhini,
    body: { unitPrice: 7.5 },
  });

  assert.equal(empty.status, 400);
});

test('revising a sent quote takes it back out of the customer’s hands', async () => {
  /*
   * Leaving it at `sent` would mean the list of what is with customers includes a price nobody
   * has been given.
   */
  const made = await quote();
  await api(`/api/quotations/${made._id}/send`, { method: 'POST', token: nandhini, body: {} });

  const revised = await api(`/api/quotations/${made._id}/revisions`, {
    method: 'POST',
    token: nandhini,
    body: { unitPrice: 7.1 },
  });

  assert.equal(revised.json.data.status, 'revised');
  assert.equal(revised.json.data.revisions.at(-1).sentAt, undefined, 'the new price has not gone out');
  assert.ok(revised.json.data.revisions[0].sentAt, 'and the one that did is still marked');
});

/* --------------------------------- Sending --------------------------------- */

test('sending it moves the enquiry to quote submitted', async () => {
  const enquiry = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: { customer, product, requirement: { quantity: 40000 }, ...followUp },
  });
  const made = await quote({ enquiry: enquiry.json.data._id });

  const sent = await api(`/api/quotations/${made._id}/send`, {
    method: 'POST',
    token: nandhini,
    body: {},
  });
  assert.equal(sent.status, 200, sent.json.message);
  assert.equal(sent.json.data.status, 'sent');
  assert.ok(sent.json.data.sentAt);

  await new Promise((resolve) => setTimeout(resolve, 300));
  const after = await api(`/api/enquiries/${enquiry.json.data._id}`, { token: nandhini });
  assert.equal(after.json.data.status, 'quote_submitted');
});

test('accepting one moves the enquiry to PO expected', async () => {
  const enquiry = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: { customer, product, requirement: { quantity: 40000 }, ...followUp },
  });
  const made = await quote({ enquiry: enquiry.json.data._id });
  await api(`/api/quotations/${made._id}/send`, { method: 'POST', token: nandhini, body: {} });

  const answered = await api(`/api/quotations/${made._id}/response`, {
    method: 'POST',
    token: nandhini,
    body: { accepted: true },
  });
  assert.equal(answered.json.data.status, 'accepted');

  await new Promise((resolve) => setTimeout(resolve, 300));
  const after = await api(`/api/enquiries/${enquiry.json.data._id}`, { token: nandhini });
  assert.equal(after.json.data.status, 'po_expected');
});

test('a refused quote does not close the enquiry', async () => {
  /*
   * It is usually re-priced rather than abandoned, and whether it is lost is marketing's call
   * — they are the only ones who have spoken to the buyer.
   */
  const enquiry = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: { customer, product, requirement: { quantity: 40000 }, ...followUp },
  });
  const made = await quote({ enquiry: enquiry.json.data._id });
  await api(`/api/quotations/${made._id}/send`, { method: 'POST', token: nandhini, body: {} });

  const refused = await api(`/api/quotations/${made._id}/response`, {
    method: 'POST',
    token: nandhini,
    body: { accepted: false, note: 'Incumbent is at 6.90' },
  });
  assert.equal(refused.json.data.status, 'rejected');

  await new Promise((resolve) => setTimeout(resolve, 300));
  const after = await api(`/api/enquiries/${enquiry.json.data._id}`, { token: nandhini });
  assert.notEqual(after.json.data.status, 'lost');
});

test('an unsent quote has nothing to answer', async () => {
  const made = await quote();
  const answered = await api(`/api/quotations/${made._id}/response`, {
    method: 'POST',
    token: nandhini,
    body: { accepted: true },
  });

  assert.equal(answered.status, 400);
  assert.match(answered.json.message, /not been sent/i);
});

test('refusing one needs a reason', async () => {
  const made = await quote();
  await api(`/api/quotations/${made._id}/send`, { method: 'POST', token: nandhini, body: {} });

  const bare = await api(`/api/quotations/${made._id}/response`, {
    method: 'POST',
    token: nandhini,
    body: { accepted: false },
  });
  assert.equal(bare.status, 400);
  assert.match(bare.json.message, /why/i);
});

/* --------------------------- §9: the price gate --------------------------- */

/** A costing with a floor, linked to a quotation. */
const withCosting = async ({ minimum, approved }) => {
  const made = await api('/api/pricings', {
    method: 'POST',
    token: admin,
    body: { customer, quantity: 40000, modelNumber: 'NH-400' },
  });
  const built = await api(`/api/pricings/${made.json.data._id}/cost`, {
    method: 'PATCH',
    token: admin,
    body: {
      cost: { gramWeight: 22, rawMaterialRate: 95, jobWorkCost: 1 },
      markupPercent: 20,
      minimumOverride: minimum,
      approvedSellingPrice: approved,
    },
  });
  /*
   * Asserted, because it was not: when the field names changed under it this helper went on
   * returning an id for a costing that had silently failed to build, and three §9 tests passed
   * a quote through a gate that was no longer there.
   */
  assert.equal(built.status, 200, built.json.message);
  return made.json.data._id;
};

test('a quote under the floor cannot be sent, and says so without naming the floor', async () => {
  const pricing = await withCosting({ minimum: 7, approved: 7.5 });
  const made = await quote({ pricing, unitPrice: 6.5 });

  const sent = await api(`/api/quotations/${made._id}/send`, {
    method: 'POST',
    token: nandhini,
    body: {},
  });

  assert.equal(sent.status, 400);
  assert.match(sent.json.message, /below the approved minimum/i);
  assert.ok(!/\b7\b/.test(sent.json.message), '§8 keeps the figure away from marketing');
});

test('the blocked quote is visibly in the queue it is in', async () => {
  // A bare refusal leaves it looking ready and not being ready.
  const pricing = await withCosting({ minimum: 7, approved: 7.5 });
  const made = await quote({ pricing, unitPrice: 6.5 });
  await api(`/api/quotations/${made._id}/send`, { method: 'POST', token: nandhini, body: {} });

  const { json } = await api(`/api/quotations/${made._id}`, { token: nandhini });
  assert.equal(json.data.status, 'approval_pending');
});

test('a quote at or above the floor goes straight out', async () => {
  const pricing = await withCosting({ minimum: 7, approved: 7.5 });
  const made = await quote({ pricing, unitPrice: 7.5 });

  const sent = await api(`/api/quotations/${made._id}/send`, {
    method: 'POST',
    token: nandhini,
    body: {},
  });
  assert.equal(sent.status, 200, sent.json.message);
});

test('a costing still waiting on approval blocks its quote', async () => {
  // The costing itself is under the floor, so nothing priced off it may go out yet.
  const pricing = await withCosting({ minimum: 8, approved: 6 });
  const made = await quote({ pricing, unitPrice: 6 });

  const sent = await api(`/api/quotations/${made._id}/send`, {
    method: 'POST',
    token: nandhini,
    body: {},
  });
  assert.equal(sent.status, 400);
  assert.match(sent.json.message, /waiting on approval/i);
});

test('once signed off, the same quote sends', async () => {
  const pricing = await withCosting({ minimum: 8, approved: 6 });
  const made = await quote({ pricing, unitPrice: 6 });

  await api(`/api/pricings/${pricing}/decision`, {
    method: 'POST',
    token: admin,
    body: { approve: true, note: 'Strategic account' },
  });

  const sent = await api(`/api/quotations/${made._id}/send`, {
    method: 'POST',
    token: nandhini,
    body: {},
  });
  assert.equal(sent.status, 200, sent.json.message);
});

test('a quote with no costing behind it is not blocked', async () => {
  // Plenty of repeat jobs are quoted from a known price; refusing those would make the module
  // unusable for the commonest case it has.
  const made = await quote({ unitPrice: 0.5 });
  const sent = await api(`/api/quotations/${made._id}/send`, {
    method: 'POST',
    token: nandhini,
    body: {},
  });

  assert.equal(sent.status, 200, sent.json.message);
});

/* -------------------------------- Ownership -------------------------------- */

test('a quotation is a customer conversation, and is scoped like one', async () => {
  const made = await quote();

  const theirs = await api(`/api/quotations/${made._id}`, { token: kavitha });
  assert.equal(theirs.status, 404, 'a colleague’s quote is not theirs to read');

  const list = await api('/api/quotations', { token: kavitha });
  assert.deepEqual(list.json.data, []);

  const management = await api(`/api/quotations/${made._id}`, { token: admin });
  assert.equal(management.status, 200, 'management is not ownership-scoped');
});

test('a quote cannot be raised against another marketing person’s customer', async () => {
  const attempt = await api('/api/quotations', {
    method: 'POST',
    token: kavitha,
    body: { customer, quantity: 100, unitPrice: 5 },
  });

  assert.equal(attempt.status, 403);
});

/* --------------------------------- Figures --------------------------------- */

test('the totals are the line and the tax on it', async () => {
  const made = await quote({ unitPrice: 7.5, quantity: 40000, gstPercent: 18 });

  assert.equal(made.lineValue, 300000);
  assert.equal(made.totalValue, 354000);
});

test('an export quote is not GST at zero', async () => {
  // Showing ₹0 tax invites somebody to wonder whether the rate was forgotten.
  const made = await quote({ unitPrice: 7.5, quantity: 40000, isExport: true, gstPercent: 18 });
  assert.equal(made.totalValue, 300000);
});
