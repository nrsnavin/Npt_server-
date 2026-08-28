/**
 * Costings and quotations [BLUEPRINT §7, §8, §9, §10].
 *
 * Two rules carry this module, and both are the kind that fail silently.
 *
 * **§8 — what marketing may see.** A grant says whether you may open a costing; §8 says that
 * inside one you may open, the raw material rate, the full cost, the gross margin and the
 * minimum price are not yours. Nothing errors when that leaks. The sheet simply arrives with
 * the plant's cost base on it, and whoever reads it is now carrying the thing a competitor
 * would pay for.
 *
 * **§9 — the floor.** A price under the approved minimum cannot be quoted until MD signs it
 * off. Nothing errors when that is missed either: the quote goes out at a price the plant
 * loses money on, and the first anyone knows is the invoice.
 *
 *   node --test tests/pricing.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

import { CONFIDENTIAL, PUBLIC_FIGURES } from '../src/services/pricingVisibility.js';
import { priceFrom } from '../src/services/pricing.service.js';

process.env.JWT_SECRET = 'pricing-test-secret-value';

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
const followUp = { nextAction: 'Call the buyer', nextFollowUpDate: inDays(3) };

let mongo;
let server;
let baseUrl;
let admin;      // management — sees costing
let nandhini;   // marketing — must not
let product;
let customer;

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

/** A costing that has been built, with a floor under the approved price unless asked otherwise. */
const costed = async ({ approvedSellingPrice, minimumSellingPrice = 8 } = {}) => {
  const made = await api('/api/pricings', {
    method: 'POST',
    token: admin,
    body: { customer, quantity: 40000, modelNumber: 'NH-400', targetPrice: 7.5 },
  });
  const id = made.json.data._id;

  const built = await api(`/api/pricings/${id}/cost`, {
    method: 'PATCH',
    token: admin,
    body: {
      cost: { gramWeight: 22, rawMaterialRate: 95, productionCost: 1.1, packingCost: 0.4 },
      targetMargin: 20,
      minimumSellingPrice,
      ...(approvedSellingPrice !== undefined ? { approvedSellingPrice } : {}),
    },
  });
  assert.equal(built.status, 200, built.json.message);
  return built.json.data;
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

  await api('/api/users', {
    method: 'POST',
    token: admin,
    body: { name: 'Nandhini S', email: 'nandhini@np.com', password: 'Passw0rd@123', department: 'marketing' },
  });
  nandhini = await signIn('nandhini@np.com', 'Passw0rd@123');

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

/* --------------------------------- The sheet --------------------------------- */

test('the selling price is margin on the price, not margin on the cost', async () => {
  /*
   * The difference is bigger than people expect, and quoting one while believing the other is
   * how a job that looked profitable is not. ₹10 at 20% is ₹12.50, never ₹12.
   */
  assert.equal(priceFrom({ totalCost: 10, targetMargin: 20 }), 12.5);
  assert.equal(priceFrom({ totalCost: 10, targetMargin: 0 }), 10);
  assert.equal(priceFrom({ totalCost: 0, targetMargin: 20 }), undefined, 'no cost, no price');
  assert.equal(priceFrom({ totalCost: 10, targetMargin: 100 }), 10, 'and 100% does not divide by zero');
});

test('the sheet adds up, and the calculated price cannot be typed', async () => {
  const sheet = await costed();

  // 22g at ₹95/kg = ₹2.09, plus 1.1 production and 0.4 packing = ₹3.59.
  assert.equal(sheet.materialCost, 2.09);
  assert.equal(Math.round(sheet.totalCost * 100) / 100, 3.59);
  assert.equal(sheet.calculatedSellingPrice, 4.49, '3.59 at a 20% margin');

  const typed = await api(`/api/pricings/${sheet._id}/cost`, {
    method: 'PATCH',
    token: admin,
    body: { calculatedSellingPrice: 99 },
  });
  assert.equal(typed.status, 400, 'a figure that can be posted is one that can disagree with its inputs');
});

test('the margin is measured on the price actually approved', async () => {
  // The margin on a number nobody quoted is not a fact about this job.
  const sheet = await costed({ approvedSellingPrice: 5, minimumSellingPrice: 4 });
  assert.equal(sheet.approvedSellingPrice, 5);
  assert.equal(sheet.grossMarginPercent, 28.2, '(5 − 3.59) / 5');
});

/* ----------------------------- §8: who sees what ----------------------------- */

test('marketing never sees the cost base', async () => {
  const sheet = await costed();
  const { json } = await api(`/api/pricings/${sheet._id}`, { token: nandhini });

  for (const field of CONFIDENTIAL) {
    assert.equal(json.data[field], undefined, `${field} must not reach marketing`);
  }
  assert.equal(json.data.costingHidden, true, 'and the screen is told why it is thin');
});

test('marketing does see the price it may quote', async () => {
  // The rule is a split, not a wall. A costing marketing cannot read at all is a costing they
  // will ask for over the phone, and then the figure is loose anyway.
  const sheet = await costed();
  const { json } = await api(`/api/pricings/${sheet._id}`, { token: nandhini });

  assert.equal(json.data.approvedSellingPrice, sheet.approvedSellingPrice);
  assert.equal(json.data.number, sheet.number);
  assert.equal(json.data.quantity, 40000);
});

test('the confidential half is stripped from the list as well as the record', async () => {
  // One endpoint remembering and another forgetting is exactly how this rule fails.
  await costed();
  const { json } = await api('/api/pricings', { token: nandhini });

  assert.ok(json.data.length);
  for (const row of json.data) {
    for (const field of CONFIDENTIAL) {
      assert.equal(row[field], undefined, `${field} leaked through the list`);
    }
  }
});

test('management sees the whole sheet', async () => {
  const sheet = await costed();
  const { json } = await api(`/api/pricings/${sheet._id}`, { token: admin });

  assert.equal(json.data.cost.rawMaterialRate, 95);
  assert.equal(json.data.minimumSellingPrice, 8);
  assert.ok(json.data.grossMarginPercent !== undefined);
});

test('every money field on the sheet has been ruled on', async () => {
  /*
   * The guard that keeps §8 true as the model grows. A cost line added later without deciding
   * who may see it is visible by default — so this walks the model's own paths and fails on
   * anything money-shaped that is in neither list.
   */
  const { default: Pricing } = await import('../src/models/Pricing.js');

  /*
   * Every number on the sheet, by its type rather than by its name. Matching on the name
   * caught `costedBy`, which is a person — and a guard that cries wolf is one somebody
   * eventually silences.
   */
  const numbers = Object.entries(Pricing.schema.paths)
    .filter(([name, path]) => path.instance === 'Number' && name !== '__v')
    .map(([name]) => name);

  // Virtuals have no declared type, so they are named — but they are six, and all derived.
  const derived = Object.keys(Pricing.schema.virtuals).filter(
    (name) => !['id', 'belowMinimum', 'needsApproval'].includes(name)
  );

  const undecided = [...numbers, ...derived].filter((name) => {
    const root = name.split('.')[0];
    return !CONFIDENTIAL.includes(root) && !PUBLIC_FIGURES.includes(root);
  });

  assert.deepEqual(undecided, [], `these have no §8 ruling: ${undecided.join(', ')}`);
});

test('only costing may build a sheet', async () => {
  const sheet = await costed();
  const attempt = await api(`/api/pricings/${sheet._id}/cost`, {
    method: 'PATCH',
    token: nandhini,
    body: { targetMargin: 5 },
  });

  assert.equal(attempt.status, 403);
  assert.match(attempt.json.message, /costing or management/i);
});

/* ------------------------------ §9: the floor ------------------------------ */

test('a price under the floor goes to approval rather than through', async () => {
  const sheet = await costed({ approvedSellingPrice: 6, minimumSellingPrice: 8 });

  assert.equal(sheet.status, 'approval_pending');
  assert.equal(sheet.belowMinimum, true);
});

test('a price at or above the floor is approved on the spot', async () => {
  const sheet = await costed({ approvedSellingPrice: 9, minimumSellingPrice: 8 });
  assert.equal(sheet.status, 'approved');
});

test('marketing learns that a quote is blocked, not where the floor is', async () => {
  /*
   * The block has to be explainable or it reads as the system being broken — but explaining it
   * with the figure would hand over the very number §8 protects.
   */
  const sheet = await costed({ approvedSellingPrice: 6, minimumSellingPrice: 8 });
  const { json } = await api(`/api/pricings/${sheet._id}`, { token: nandhini });

  assert.equal(json.data.belowMinimum, true, 'they can see it is blocked');
  assert.equal(json.data.minimumSellingPrice, undefined, 'and not what it is blocked by');
});

test('refusing a price needs a reason, and sends it back', async () => {
  const sheet = await costed({ approvedSellingPrice: 6, minimumSellingPrice: 8 });

  const bare = await api(`/api/pricings/${sheet._id}/decision`, {
    method: 'POST',
    token: admin,
    body: { approve: false },
  });
  assert.equal(bare.status, 400);
  assert.match(bare.json.message, /why/i);

  const refused = await api(`/api/pricings/${sheet._id}/decision`, {
    method: 'POST',
    token: admin,
    body: { approve: false, note: 'Take another look at the packing cost' },
  });
  assert.equal(refused.status, 200, refused.json.message);
  assert.equal(refused.json.data.status, 'rejected');
});

test('a signed-off sheet stops asking for a signature', async () => {
  /*
   * `belowMinimum` and "is anything blocked" are not the same question, and the screen has the
   * second one. A sheet MD approved is still under the floor — showing "needs approval" beside
   * a badge reading Approved is the screen contradicting itself, and the reader believes
   * whichever half is worse news.
   */
  const sheet = await costed({ approvedSellingPrice: 6, minimumSellingPrice: 8 });
  assert.equal(sheet.needsApproval, true);

  await api(`/api/pricings/${sheet._id}/decision`, {
    method: 'POST',
    token: admin,
    body: { approve: true, note: 'Strategic account' },
  });

  const { json } = await api(`/api/pricings/${sheet._id}`, { token: nandhini });
  assert.equal(json.data.needsApproval, false, 'nothing is waiting any more');
  assert.equal(json.data.belowMinimum, true, 'though it is still under the floor');
});

test('approving one lets it through', async () => {
  const sheet = await costed({ approvedSellingPrice: 6, minimumSellingPrice: 8 });
  const signed = await api(`/api/pricings/${sheet._id}/decision`, {
    method: 'POST',
    token: admin,
    body: { approve: true, note: 'Strategic account, take it' },
  });

  assert.equal(signed.status, 200, signed.json.message);
  assert.equal(signed.json.data.status, 'approved');
  assert.ok(signed.json.data.approvedAt);
});

/* -------------------------- The enquiry raises one -------------------------- */

test('an enquiry reaching pricing raises the costing itself', async () => {
  const enquiry = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer,
      product,
      requirement: { quantity: 25000, modelNumber: 'NH-400' },
      targetPrice: 7.2,
      ...followUp,
    },
  });
  const id = enquiry.json.data._id;

  await api(`/api/enquiries/${id}/actions`, {
    method: 'POST',
    token: nandhini,
    body: { action: 'request_pricing' },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));

  const { json } = await api(`/api/pricings?enquiry=${id}`, { token: admin });
  assert.equal(json.data.length, 1, 'exactly one, not one per visit to the stage');
  assert.equal(json.data[0].quantity, 25000, 'with the quantity that was asked about');
  assert.equal(json.data[0].targetPrice, 7.2, 'and what the buyer wants to pay');
});
