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
let mould;

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

/**
 * Who a token belongs to.
 *
 * Creating a customer or a lead names its owner now, rather than inheriting whoever posted the
 * request — see `assertCanOwnBuyer`. These fixtures always meant "the person making this call
 * owns it", which is what they relied on the old default for; this says it out loud.
 */
const tokenOwnerId = async (token) => (await api('/api/auth/me', { token })).json.data.id;

const signIn = async (email, password) => {
  const { json } = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  return json.data?.token;
};

/**
 * A quotation, described the way the tests want to talk about one.
 *
 * The API takes `lines`; most of these tests care about a single price, so the line fields may
 * be passed flat and are folded into one line here. `lines` may be passed instead, whole, for
 * the multi-model cases — which is what the plant's own quotations actually look like.
 */
const quote = async (extra = {}, token = nandhini) => {
  const { quantity, unitPrice, modelNumber, moq, pricing, mould, lines, ...terms } = extra;

  const { status, json } = await api('/api/quotations', {
    method: 'POST',
    token,
    body: {
      customer,
      paymentTerms: '30 days',
      validUntil: inDays(30),
      ...terms,
      lines: lines ?? [
        {
          quantity: quantity ?? 40000,
          unitPrice: unitPrice ?? 7.5,
          modelNumber: modelNumber ?? 'NH-400',
          ...(moq !== undefined ? { moq } : {}),
          ...(pricing !== undefined ? { pricing } : {}),
          ...(mould !== undefined ? { mould } : {}),
        },
      ],
    },
  });
  assert.equal(status, 201, json.message);
  return json.data;
};

/** A revision expressed as one new price, for the single-line cases. */
const reviseTo = (id, unitPrice, body = {}, token = nandhini) =>
  api(`/api/quotations/${id}/revisions`, {
    method: 'POST',
    token,
    body: { lines: [{ quantity: 40000, modelNumber: 'NH-400', unitPrice }], ...body },
  });

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

  const madeMould = await api('/api/moulds', {
    method: 'POST',
    token: admin,
    body: {
      mouldCode: 'M-NH-400', name: 'Shirt hanger 400mm', category: 'shirt', sizeMm: 400, material: 'plastic',
      /* Measured facts, which the register will not take a model without. */
      cavities: 4, partWeightGrams: 26, cycleTimeSeconds: 28, moq: 5000,
    },
  });
  mould = madeMould.json.data._id;

  const madeCustomer = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { assignedTo: await tokenOwnerId(nandhini), name: 'Sri Kumaran Knits', mobile: '9840011223' },
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
  assert.equal(made.revisions[0].lines[0].unitPrice, 7.5);
});

test('every revision stays — Rev 0 ₹7.50, Rev 1 ₹7.30, Rev 2 ₹7.20', async () => {
  const made = await quote();

  for (const price of [7.3, 7.2]) {
    const revised = await reviseTo(made._id, price, { note: 'Buyer pushed back' });
    assert.equal(revised.status, 200, revised.json.message);
  }

  const { json } = await api(`/api/quotations/${made._id}`, { token: nandhini });
  assert.equal(json.data.revision, 2);
  assert.equal(json.data.lines[0].unitPrice, 7.2, 'the live price is the newest');
  assert.deepEqual(
    json.data.revisions.map((row) => [row.revision, row.lines[0].unitPrice]),
    [[0, 7.5], [1, 7.3], [2, 7.2]],
    'and every price it ever carried is answerable'
  );
});

test('the price cannot be changed by editing — that would overwrite the history', async () => {
  const made = await quote();
  const edited = await api(`/api/quotations/${made._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { lines: [{ quantity: 40000, modelNumber: 'NH-400', unitPrice: 6.9 }] },
  });

  assert.equal(edited.status, 400);
  assert.match(edited.json.message, /revision/i);
});

test('a revision has to revise something', async () => {
  const made = await quote();
  const empty = await reviseTo(made._id, 7.5);

  assert.equal(empty.status, 400);
});

test('revising a sent quote takes it back out of the customer’s hands', async () => {
  /*
   * Leaving it at `sent` would mean the list of what is with customers includes a price nobody
   * has been given.
   */
  const made = await quote();
  await api(`/api/quotations/${made._id}/send`, { method: 'POST', token: nandhini, body: {} });

  const revised = await reviseTo(made._id, 7.1);

  assert.equal(revised.json.data.status, 'revised');
  assert.equal(revised.json.data.revisions.at(-1).sentAt, undefined, 'the new price has not gone out');
  assert.ok(revised.json.data.revisions[0].sentAt, 'and the one that did is still marked');
});

/* --------------------------------- Sending --------------------------------- */

test('sending it moves the enquiry to quote submitted', async () => {
  const enquiry = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: { customer, mould, requirement: { quantity: 40000 }, ...followUp },
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
    body: { customer, mould, requirement: { quantity: 40000 }, ...followUp },
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
    body: { customer, mould, requirement: { quantity: 40000 }, ...followUp },
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

/* ------------------- The costing, read from the quotation ------------------- */

test('a quotation line shows the margin on the price actually offered', async () => {
  /*
   * The figure neither record holds alone. The costing knows what it would earn at the price it
   * was approved at; the line knows what was really quoted, and the two diverge the moment
   * anybody negotiates — which is most of the time. Reading the sheet's own
   * `grossMarginPercent` here would answer a question nobody asked.
   */
  const costing = await withCosting({ minimum: 6, approved: 9 });
  const quoted = await quote({ pricing: costing, unitPrice: 8 });

  const { json } = await api(`/api/quotations/${quoted._id}`, { token: admin });
  const line = json.data.lines[0];

  assert.ok(line.pricing.totalCost > 0, 'the cost base is there for somebody who may see it');
  assert.equal(
    line.pricing.marginPerPiece,
    Math.round((8 - line.pricing.totalCost) * 100) / 100,
    'margin is against the 8.00 quoted, not the 9.00 approved'
  );
  assert.ok(line.pricing.marginPercent > 0);
  assert.equal(line.pricing.belowFloor, false, 'and 8.00 clears a floor of 6.00');
});

test('marketing sees the quotation exactly as before, and nothing of the cost', async () => {
  /*
   * The wall §8 draws, checked on the new door rather than assumed. A quotation is the document
   * that goes to the buyer; the cost base, the margin and the floor are the things that must
   * never travel with it.
   */
  const costing = await withCosting({ minimum: 6, approved: 9 });
  const quoted = await quote({ pricing: costing, unitPrice: 8 });

  const { json } = await api(`/api/quotations/${quoted._id}`, { token: nandhini });
  const line = json.data.lines[0];

  assert.equal(line.pricing.number !== undefined, true, 'the costing is still named');
  assert.equal(line.pricing.approvedSellingPrice, 9, 'and the price they may quote is public');

  for (const field of ['totalCost', 'minimumSellingPrice', 'marginPerPiece', 'marginPercent', 'markupPercent']) {
    assert.equal(line.pricing[field], undefined, `${field} must not reach a marketing reader`);
  }
});

test('marketing learns whether a line is under its floor, never where the floor is', async () => {
  // The same distinction §8 already draws for `belowMinimum` on the costing itself: the block
  // has to be explainable, or it reads as the system being broken.
  const costing = await withCosting({ minimum: 9, approved: 9 });
  const quoted = await quote({ pricing: costing, unitPrice: 7 });

  const { json } = await api(`/api/quotations/${quoted._id}`, { token: nandhini });
  const line = json.data.lines[0];

  assert.equal(line.pricing.belowFloor, true, 'they can see there is a problem');
  assert.equal(line.pricing.minimumSellingPrice, undefined, 'without learning the number');
});

test('a line with no costing behind it says so rather than inventing figures', async () => {
  const quoted = await quote({ unitPrice: 8 });

  const { json } = await api(`/api/quotations/${quoted._id}`, { token: admin });
  assert.equal(json.data.lines[0].pricing, null);
});

/* --------------------------- §9: the price gate --------------------------- */

/** A costing with a floor, linked to a quotation. */
const withCosting = async ({ minimum, approved }) => {
  const made = await api('/api/pricings', {
    method: 'POST',
    token: admin,
    /* A costing prices one model, so it keeps its flat shape — lines are the quotation's. */
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
    body: { customer, lines: [{ quantity: 100, unitPrice: 5 }] },
  });

  assert.equal(attempt.status, 403);
});

/* --------------------------------- Figures --------------------------------- */

test('the totals are the line and the tax on it', async () => {
  const made = await quote({ unitPrice: 7.5, quantity: 40000, gstPercent: 18 });

  assert.equal(made.netValue, 300000);
  assert.equal(made.totalValue, 354000);
});

test('an export quote is not GST at zero', async () => {
  // Showing ₹0 tax invites somebody to wonder whether the rate was forgotten.
  const made = await quote({ unitPrice: 7.5, quantity: 40000, isExport: true, gstPercent: 18 });
  assert.equal(made.totalValue, 300000);
});

/* ------------------------- Several models, one document ------------------------- */

test('a quotation carries every model quoted to that buyer, under one number', async () => {
  /*
   * The plant's own `NP/26-27/1` covers eight models for Yorker knit on one document, with one
   * validity and one set of payment terms. Modelling that as eight quotations gives the buyer
   * eight reference numbers for one conversation and makes "what did we quote them?" a question
   * with eight answers and no total.
   */
  const made = await quote({
    gstPercent: 18,
    lines: [
      { modelNumber: 'MAU-35 WB', quantity: 20000, unitPrice: 3.6 },
      { modelNumber: 'CRF-30', quantity: 20000, unitPrice: 4.2 },
      { modelNumber: 'RW-236', quantity: 10000, unitPrice: 7.4 },
    ],
  });

  assert.equal(made.lines.length, 3);
  assert.equal(made.lineCount, 3);
  assert.equal(made.netValue, 230000, '20000×3.6 + 20000×4.2 + 10000×7.4');
  assert.equal(made.totalValue, 271400, 'and GST on the document, not per line');
  assert.equal(made.soleLine, null, 'there is no single price to speak for it');
});

test('a quotation needs at least one line', async () => {
  const { status } = await api('/api/quotations', {
    method: 'POST',
    token: nandhini,
    body: { customer, lines: [] },
  });
  assert.equal(status, 400, 'an empty quotation is a mistake, not a draft');
});

test('one line under its floor holds the whole document [§9]', async () => {
  /*
   * The case a single-line model could not express, and the reason the gate had to move onto
   * the lines: seven prices that are perfectly fine and an eighth that is not. A document-level
   * check has no single price to look at, so it waves the whole thing through.
   */
  const fine = await withCosting({ minimum: 7, approved: 7.5 });
  const under = await withCosting({ minimum: 7, approved: 7.5 });

  const made = await quote({
    lines: [
      { modelNumber: 'NH-400', quantity: 40000, unitPrice: 7.5, pricing: fine },
      { modelNumber: 'NH-450', quantity: 10000, unitPrice: 6.5, pricing: under },
    ],
  });

  const sent = await api(`/api/quotations/${made._id}/send`, {
    method: 'POST',
    token: nandhini,
    body: {},
  });

  assert.equal(sent.status, 400);
  assert.match(sent.json.message, /NH-450/, 'and it names the line to argue about');
  assert.ok(!/NH-400\b/.test(sent.json.message), 'not the one that was fine');
  assert.ok(!/\b7\b/.test(sent.json.message), '§8 still keeps the figure away from marketing');
});

test('every line clearing its own floor sends the document', async () => {
  const first = await withCosting({ minimum: 7, approved: 7.5 });
  const second = await withCosting({ minimum: 7, approved: 7.5 });

  const made = await quote({
    lines: [
      { modelNumber: 'NH-400', quantity: 40000, unitPrice: 7.5, pricing: first },
      { modelNumber: 'NH-450', quantity: 10000, unitPrice: 8.2, pricing: second },
    ],
  });

  const sent = await api(`/api/quotations/${made._id}/send`, {
    method: 'POST',
    token: nandhini,
    body: {},
  });
  assert.equal(sent.status, 200, sent.json.message);
});

test('a revision records every line, not just the price that moved', async () => {
  /*
   * A revision on a multi-line quote is routinely a discount on one model out of several. A
   * history that stored a single figure could not say which — so the next round would be
   * argued from memory.
   */
  const made = await quote({
    lines: [
      { modelNumber: 'NH-400', quantity: 40000, unitPrice: 7.5 },
      { modelNumber: 'NH-450', quantity: 10000, unitPrice: 8.2 },
    ],
  });

  const revised = await api(`/api/quotations/${made._id}/revisions`, {
    method: 'POST',
    token: nandhini,
    body: {
      note: 'Buyer pushed on the 400 only',
      lines: [
        { modelNumber: 'NH-400', quantity: 40000, unitPrice: 7.1 },
        { modelNumber: 'NH-450', quantity: 10000, unitPrice: 8.2 },
      ],
    },
  });
  assert.equal(revised.status, 200, revised.json.message);

  const { json } = await api(`/api/quotations/${made._id}`, { token: nandhini });
  assert.deepEqual(
    json.data.revisions.map((row) => row.lines.map((line) => line.unitPrice)),
    [[7.5, 8.2], [7.1, 8.2]],
    'both revisions hold the whole offer'
  );
  assert.equal(json.data.revisions[0].netValue, 382000, 'and what each was worth');
  assert.equal(json.data.revisions[1].netValue, 366000);
});

test('dropping a model from a sent quote is a revision, not an edit', async () => {
  /*
   * The change a field-by-field comparison misses entirely: no single value moved, a whole line
   * simply disappeared. On a document the customer has already seen that is a new offer.
   */
  const made = await quote({
    lines: [
      { modelNumber: 'NH-400', quantity: 40000, unitPrice: 7.5 },
      { modelNumber: 'NH-450', quantity: 10000, unitPrice: 8.2 },
    ],
  });
  await api(`/api/quotations/${made._id}/send`, { method: 'POST', token: nandhini, body: {} });

  const edited = await api(`/api/quotations/${made._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { lines: [{ modelNumber: 'NH-400', quantity: 40000, unitPrice: 7.5 }] },
  });

  assert.equal(edited.status, 400);
  assert.match(edited.json.message, /revision/i);
});

test('the history is frozen — a later edit does not rewrite what Rev 0 said', async () => {
  /*
   * Pushing the live subdocuments into `revisions` would store references that move with the
   * next change, and the history would then agree with the present no matter what it used to
   * say. A revision list that cannot disagree with the current price is not a history.
   */
  const made = await quote({ unitPrice: 7.5 });
  await reviseTo(made._id, 6.9, { note: 'Discount' });

  const { json } = await api(`/api/quotations/${made._id}`, { token: nandhini });
  assert.equal(json.data.revisions[0].lines[0].unitPrice, 7.5, 'Rev 0 still says what it said');
  assert.equal(json.data.lines[0].unitPrice, 6.9);
});

test('a revision keeps the costing behind a line it does not re-name', async () => {
  /*
   * The quiet failure the line shape invites. A revision restates the offer, and a caller that
   * sends back `{ modelNumber, quantity, unitPrice }` without repeating `pricing` would detach
   * the costing. Nothing errors — the quote saves, and §9's floor check silently stops applying
   * at the exact moment somebody is cutting the price.
   */
  const costing = await withCosting({ minimum: 7, approved: 7.5 });
  const made = await quote({ pricing: costing, unitPrice: 7.5 });

  const revised = await api(`/api/quotations/${made._id}/revisions`, {
    method: 'POST',
    token: nandhini,
    body: { lines: [{ modelNumber: 'NH-400', quantity: 40000, unitPrice: 6.5 }], note: 'Cut' },
  });
  assert.equal(revised.status, 200, revised.json.message);
  assert.ok(revised.json.data.lines[0].pricing, 'the costing came across');

  /* And because it did, the floor still bites on the way out. */
  const sent = await api(`/api/quotations/${made._id}/send`, {
    method: 'POST',
    token: nandhini,
    body: {},
  });
  assert.equal(sent.status, 400);
  assert.match(sent.json.message, /below the approved minimum/i);
});

/* ------------------------- The document the buyer gets ------------------------- */

/**
 * A one-pixel PNG. Enough to prove the picture reached the page — what it is a picture *of* is
 * not something a test can check, and a real photograph in the repository would be a megabyte
 * committed to prove a buffer moved.
 */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * The words a PDF actually prints.
 *
 * pdfkit deflates its content streams, so the text is not in the bytes as text — a test that
 * greps the raw file passes on a document that says nothing at all. Every stream that inflates
 * is inflated; the ones that do not are the images.
 *
 * Inside, a run of text is a hex-encoded array with kerning between the pieces:
 * `[<50524943452051> 10 <554f> 40 <5445>] TJ` is "PRICE QUOTE". Only the hex pieces are taken,
 * and they are joined with nothing between them — take the numbers too and the page reads
 * "PRICE Q10UO40TE".
 */
const textOf = async (bytes) => {
  const { inflateSync } = await import('node:zlib');
  const raw = bytes.toString('latin1');
  const streams = [];

  for (const match of raw.matchAll(/stream\r?\n/g)) {
    const from = match.index + match[0].length;
    const to = raw.indexOf('endstream', from);
    if (to < 0) continue;
    try {
      streams.push(inflateSync(Buffer.from(raw.slice(from, to), 'latin1')).toString('latin1'));
    } catch {
      /* An image, or a stream stored flat. Neither carries the words. */
    }
  }

  const fromHex = (hex) =>
    Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex').toString('latin1');

  return streams
    .join('\n')
    /* Each text-showing array, reduced to the characters it shows. */
    .replace(/\[((?:\s*<[0-9a-fA-F]*>|\s*-?\d+(?:\.\d+)?)*)\]\s*TJ/g, (whole, inner) =>
      ` ${(inner.match(/<([0-9a-fA-F]*)>/g) || [])
        .map((run) => fromHex(run.slice(1, -1)))
        .join('')} `)
    /* And the simple form, for anything drawn without kerning. */
    .replace(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g, (whole, inner) => ` ${inner} `)
    .replace(/\s+/g, ' ');
};

/** Puts a part photo on a mould, the way the register form does. */
const photograph = async (mouldId) => {
  const boundary = `----npt${Date.now()}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="part.png"\r\n` +
        'Content-Type: image/png\r\n\r\n'
    ),
    PIXEL,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const response = await fetch(`${baseUrl}/api/moulds/${mouldId}/photo`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${admin}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

test('the part photo comes back on the record that was just given one', async () => {
  /*
   * `save()` leaves the reference as the id it was set to, so the reply described the record
   * correctly and uselessly: the screen that had just uploaded a picture got no key to draw it
   * from and went on showing nothing until somebody reloaded. The one call whose whole purpose
   * is the photograph was the one not returning it.
   */
  const { status, json } = await photograph(mould);

  assert.equal(status, 200, json.message);
  assert.ok(json.data.photo?.key, 'the upload did not return the key it just stored');
});

test('a part photo can actually be fetched by anybody who may read the register', async () => {
  /*
   * The register could take a photograph and could never show one.
   *
   * The file route resolves who may read a file through the record it hangs off, and it knew
   * about samples, customers and enquiries. A photo hanging off a *mould* resolved to no owner
   * at all, so it was refused to everybody — an upload that returned 200 and a picture that
   * never appeared, which reads as the upload having silently failed.
   *
   * A mould belongs to nobody: it is the model master [§28], and the photograph of what it
   * makes goes out on the price quote. So the rule is the module's grant, not an owner's.
   */
  const { json } = await photograph(mould);
  const key = json.data.photo.key;

  for (const [who, token] of [['marketing', nandhini], ['an administrator', admin]]) {
    const response = await fetch(`${baseUrl}/api/files/${key}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200, `${who} cannot see the part photo`);
    assert.match(response.headers.get('content-type'), /^image\//);
  }
});

test('the quote carries the part photo, the shade and the tariff heading', async () => {
  /*
   * The document is the product here. A hanger is bought by its shape — six near-identical
   * codes with no picture is how a buyer orders NCP-27 and means NCP-30 — and the plant's own
   * sheet has carried the photographs for years for exactly that reason.
   *
   * Asserted on the PDF's own bytes rather than on a render call returning: an image that fails
   * to embed throws inside pdfkit and is swallowed by design, so "it rendered" is true of a
   * document with an empty picture column.
   */
  await photograph(mould);

  const made = await quote({
    lines: [{ mould, modelNumber: 'NH-400', colour: 'White', unitPrice: 4.9, moq: 5000 }],
  });

  assert.equal(made.lines[0].colour, 'White', 'the shade the rate is offered in was dropped');

  const response = await fetch(`${baseUrl}/api/quotations/${made._id}/pdf`, {
    headers: { Authorization: `Bearer ${nandhini}` },
  });
  assert.equal(response.status, 200);

  const bytes = Buffer.from(await response.arrayBuffer());

  /* An embedded image declares itself in the page's resources, which are not compressed. No
     XObject, no picture — and "it rendered" is true of a document with an empty photo column. */
  assert.match(
    bytes.toString('latin1'),
    /\/Subtype\s*\/Image/,
    'no image was embedded in the quotation'
  );

  /* The words themselves live in a deflated content stream, so they have to be inflated to be
     read. Worth the few lines: without it the test passes on a PDF that says anything at all. */
  const printed = await textOf(bytes);
  assert.match(printed, /PRICE QUOTE/);
  assert.match(printed, /HSN\/SAC/);
  assert.match(printed, /GST 18% EXTRA/);
  /* The fixture's tool is registered as `plastic`; what matters is that the resin and the
     shade both reach the page, joined the way the plant's sheet prints them. */
  assert.match(printed, /PLASTIC : WHITE/, 'the resin and shade are not on the document');
  assert.match(printed, /39269069/, 'the tariff heading is not on the document');
});

test('a quotation whose photograph has gone still prints', async () => {
  /*
   * The file can be deleted underneath the record — a restored backup, a cleared volume. A
   * document somebody is waiting to send should come out with a gap where the picture was
   * rather than fail, because the rate is the part the buyer is waiting for.
   */
  await photograph(mould);

  const Attachment = (await import('../src/models/Attachment.js')).default;
  const Mould = (await import('../src/models/Mould.js')).default;
  const record = await Mould.findById(mould);
  const attachment = await Attachment.findById(record.photo);

  const { remove } = await import('../src/services/storage.service.js');
  await remove(attachment.key);

  const made = await quote({ lines: [{ mould, modelNumber: 'NH-400', unitPrice: 4.9 }] });
  const response = await fetch(`${baseUrl}/api/quotations/${made._id}/pdf`, {
    headers: { Authorization: `Bearer ${nandhini}` },
  });

  assert.equal(response.status, 200, 'a missing photo took the whole document down');

  const bytes = Buffer.from(await response.arrayBuffer());
  assert.match(await textOf(bytes), /PRICE QUOTE/);
  /* And the cell is simply empty — no half-written image object left behind. */
  assert.doesNotMatch(bytes.toString('latin1'), /\/Subtype\s*\/Image/);
});

test('an eight-model quotation does not spill blank pages', async () => {
  /*
   * The renderer was written when a quotation carried one model and assumed one page. With
   * eight lines the content ran past the margin and pdfkit silently added a page for every
   * overflowing draw — the document came out as a correct first page, a lone signature on the
   * second, and four blank sheets after it. Nothing errored; it was a perfectly valid PDF.
   *
   * Asserted on the page count because that is the symptom a person would notice, and because
   * a check on "does it render" passed throughout.
   */
  const made = await quote({
    gstPercent: 18,
    lines: Array.from({ length: 8 }, (unused, index) => ({
      modelNumber: `NH-${400 + index}`,
      quantity: 20000,
      unitPrice: 6 + index * 0.4,
    })),
  });

  const response = await fetch(`${baseUrl}/api/quotations/${made._id}/pdf`, {
    headers: { Authorization: `Bearer ${nandhini}` },
  });
  assert.equal(response.status, 200);

  const pdf = Buffer.from(await response.arrayBuffer()).toString('latin1');
  /*
   * Bounded rather than exact: whether the closing block lands on page one or page two depends
   * on how much address and how many remarks this particular quote carries, and both are right.
   * What is never right is a third page — the broken renderer produced six.
   */
  const pages = Number(pdf.match(/\/Count\s+(\d+)/)?.[1]);
  assert.ok(pages >= 1 && pages <= 2, `eight lines should not need ${pages} pages`);
});

/* ---------------------- What has actually gone to a buyer ---------------------- */

/**
 * `sent` is a question about the document, not about its status.
 *
 * The distinction is the whole reason the filter exists. `sent` is only the state a quotation
 * rests in between leaving the building and being answered; the moment the buyer says something,
 * or the price moves, the status becomes `accepted`, `rejected` or `revised` — and every one of
 * those has still been in front of a customer. A board built on the status would show a plant
 * three quotations out with buyers when it has sent thirty.
 */
test('sent=true is every quote that has left the building, whatever its status now says', async () => {
  const draft = await quote({ modelNumber: 'SENT-DRAFT' });

  const gone = await quote({ modelNumber: 'SENT-PLAIN' });
  await api(`/api/quotations/${gone._id}/send`, { method: 'POST', token: nandhini, body: {} });

  /* Sent, then the price moved: `revised`, and still something the buyer has seen. */
  const moved = await quote({ modelNumber: 'SENT-REVISED' });
  await api(`/api/quotations/${moved._id}/send`, { method: 'POST', token: nandhini, body: {} });
  await api(`/api/quotations/${moved._id}/revisions`, {
    method: 'POST',
    token: nandhini,
    body: { lines: [{ quantity: 40000, modelNumber: 'SENT-REVISED', unitPrice: 7.1 }] },
  });

  /* Sent, then answered: `accepted`, and the one people most often go looking for. */
  const won = await quote({ modelNumber: 'SENT-WON' });
  await api(`/api/quotations/${won._id}/send`, { method: 'POST', token: nandhini, body: {} });
  await api(`/api/quotations/${won._id}/response`, {
    method: 'POST',
    token: nandhini,
    body: { accepted: true },
  });

  const { json } = await api('/api/quotations?sent=true&limit=200', { token: admin });
  const ids = json.data.map((row) => String(row._id));

  assert.ok(ids.includes(String(gone._id)), 'the plain sent one');
  assert.ok(ids.includes(String(moved._id)), 'and the one revised after going out');
  assert.ok(ids.includes(String(won._id)), 'and the one the buyer accepted');
  assert.ok(!ids.includes(String(draft._id)), 'but never a draft nobody has been shown');
  assert.ok(json.data.every((row) => row.sentAt), 'nothing on this board is unsent');
});

test('sent=false is the other half, and the two do not overlap', async () => {
  const draft = await quote({ modelNumber: 'UNSENT-ONE' });
  const gone = await quote({ modelNumber: 'UNSENT-TWO' });
  await api(`/api/quotations/${gone._id}/send`, { method: 'POST', token: nandhini, body: {} });

  const { json } = await api('/api/quotations?sent=false&limit=200', { token: admin });
  const ids = json.data.map((row) => String(row._id));

  assert.ok(ids.includes(String(draft._id)));
  assert.ok(!ids.includes(String(gone._id)));
  assert.ok(json.data.every((row) => !row.sentAt));
});

/**
 * The stage chips follow the board they sit on.
 *
 * Everywhere else in this application the pipeline counts the whole register rather than the
 * current filter, because that is what makes it a pipeline and not an echo. `sent` is the
 * exception, and deliberately: it scopes the screen rather than selecting within it, so a Draft
 * chip counting drafts on a sent-only board would offer a filter that can only come back empty.
 */
test('the stage counts on a sent board count only what was sent', async () => {
  const draft = await quote({ modelNumber: 'COUNT-DRAFT' });

  const { json } = await api('/api/quotations?sent=true&limit=200', { token: admin });
  const drafts = json.stageCounts?.draft?.leads ?? 0;

  const everything = await api('/api/quotations?limit=200', { token: admin });
  assert.ok(
    (everything.json.stageCounts?.draft?.leads ?? 0) > drafts,
    'the unscoped board still counts the drafts the sent board leaves out'
  );
  assert.ok(draft._id, 'a draft exists to be left out');
});

/**
 * The costing on the row, not two screens down.
 *
 * "What did we work this price out from?" is the first question asked of a quotation that has
 * gone out. It was answerable only by opening the document and then opening the sheet.
 */
test('a listed line carries the costing it was priced off', async () => {
  const pricing = await withCosting({ minimum: 7, approved: 7.5 });
  const made = await quote({ pricing, unitPrice: 7.5, modelNumber: 'ATTACHED' });
  await api(`/api/quotations/${made._id}/send`, { method: 'POST', token: nandhini, body: {} });

  const { json } = await api('/api/quotations?sent=true&limit=200', { token: admin });
  const row = json.data.find((entry) => String(entry._id) === String(made._id));

  assert.ok(row, 'the quote is on the board');
  assert.ok(row.lines[0].pricing, 'and its line names the sheet behind it');
  assert.match(row.lines[0].pricing.number, /^PR/i);
  assert.equal(row.lines[0].pricing.minimumSellingPrice, 7, 'costing sees the floor');
});

/**
 * And §8 holds on the list exactly as it does on the document.
 *
 * This is the risk the change carries: the sheet is populated whole so that the allow-list has
 * something to work from, and an allow-list that is applied on one route and forgotten on
 * another publishes the cost base to marketing on a screen nobody thought to check.
 */
test('marketing reads the same board without the cost base on it', async () => {
  const pricing = await withCosting({ minimum: 7, approved: 7.5 });
  const made = await quote({ pricing, unitPrice: 7.5, modelNumber: 'REDACTED' });
  await api(`/api/quotations/${made._id}/send`, { method: 'POST', token: nandhini, body: {} });

  const { json } = await api('/api/quotations?sent=true&limit=200', { token: nandhini });
  const row = json.data.find((entry) => String(entry._id) === String(made._id));
  const costing = row.lines[0].pricing;

  assert.ok(costing, 'marketing still gets the sheet number, which is how they ask about it');
  assert.equal(costing.number !== undefined, true);
  assert.equal(costing.totalCost, undefined, '§8: never the cost base');
  assert.equal(costing.minimumSellingPrice, undefined, '§8: never the floor');
  assert.equal(costing.marginPercent, undefined, '§8: never the margin');
  assert.equal(costing.belowFloor, false, 'only whether, which is what a block has to explain');

  const raw = JSON.stringify(json.data);
  assert.ok(!raw.includes('machineCostPerPiece'), 'and nothing leaks through the populated sheet');
});
