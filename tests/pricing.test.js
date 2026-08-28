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
const costed = async ({ approvedSellingPrice, minimumSellingPrice = 8, product: on } = {}) => {
  const made = await api('/api/pricings', {
    method: 'POST',
    token: admin,
    body: {
      customer, quantity: 40000, modelNumber: 'NH-400', targetPrice: 7.5,
      ...(on !== undefined ? { product: on } : {}),
    },
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

/* ------------------- A costing with no enquiry behind it ------------------- */

test('a costing can be raised with no enquiry at all', async () => {
  const made = await api('/api/pricings', {
    method: 'POST',
    token: admin,
    body: { customer, quantity: 5000, modelNumber: 'NH-400' },
  });

  assert.equal(made.status, 201, made.json.message);
  assert.equal(made.json.data.enquiry, undefined);
  assert.equal(made.json.data.status, 'requested');
});

test('a costing still needs the customer it is for', async () => {
  const made = await api('/api/pricings', {
    method: 'POST',
    token: admin,
    body: { quantity: 5000, modelNumber: 'NH-400' },
  });

  assert.equal(made.status, 400);
  assert.match(made.json.message, /customer/i);
});

/* ----------------------------------- MOQ ----------------------------------- */

/** A catalogue model that carries a standard minimum. */
const modelWithMoq = async (code, moq) => {
  const made = await api('/api/products', {
    method: 'POST',
    token: admin,
    body: {
      modelCode: code, name: `Hanger ${code}`, category: 'shirt',
      material: 'plastic', sizeMm: 360, moq,
    },
  });
  return made.json.data._id;
};

test('a costing carries no MOQ — it is a term of the offer, not of the cost', async () => {
  const product = await modelWithMoq('NH-MOQ', 2500);

  const made = await api('/api/pricings', {
    method: 'POST',
    token: admin,
    body: { customer, product, quantity: 40000 },
  });

  assert.equal(made.status, 201, made.json.message);
  assert.equal(made.json.data.moq, undefined);
  // The rest of what the master knows still comes across, so the sheet is not retyped.
  assert.equal(made.json.data.modelNumber, 'NH-MOQ');
});

test('building the sheet refuses an MOQ outright', async () => {
  const sheet = await costed({ approvedSellingPrice: 9 });

  const built = await api(`/api/pricings/${sheet._id}/cost`, {
    method: 'PATCH',
    token: admin,
    body: { moq: 5000 },
  });

  // Strict, so it is refused rather than quietly dropped — a screen that sent it would
  // otherwise look like it worked and change nothing.
  assert.equal(built.status, 400);
});

test('a quotation states the minimum it is offered at, from the master', async () => {
  const product = await modelWithMoq('NH-MOQ2', 2500);
  const sheet = await costed({ approvedSellingPrice: 9, product });

  const quote = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: {},
  });

  assert.equal(quote.status, 201, quote.json.message);
  assert.equal(quote.json.data.moq, 2500);
});

test('a minimum set on the quote beats the master', async () => {
  const product = await modelWithMoq('NH-MOQ3', 2500);
  const sheet = await costed({ approvedSellingPrice: 9, product });

  const quote = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: { moq: 10000, quantity: 12000 },
  });

  assert.equal(quote.json.data.moq, 10000);
});

test('the minimum is part of what a revision said [§10]', async () => {
  const product = await modelWithMoq('NH-MOQ4', 2000);
  const sheet = await costed({ approvedSellingPrice: 9, product });
  const quote = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: {},
  });

  await api(`/api/quotations/${quote.json.data._id}/revisions`, {
    method: 'POST', token: nandhini, body: { unitPrice: 8.5, moq: 5000 },
  });

  const back = await api(`/api/quotations/${quote.json.data._id}`, { token: nandhini });
  assert.equal(back.json.data.moq, 5000);
  assert.equal(back.json.data.revisions[0].moq, 2000, 'Rev 0 keeps the minimum it stated');
  assert.equal(back.json.data.revisions[1].moq, 5000);
});

/* --------------------- Turning a costing into a quote --------------------- */

test('a quote raised from a costing starts at the MOQ, not the costed quantity', async () => {
  const product = await modelWithMoq('NH-MOQ5', 5000);
  const sheet = await costed({ approvedSellingPrice: 9, product });

  const quote = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: {},
  });

  assert.equal(quote.status, 201, quote.json.message);
  // The sheet was costed at 40,000; the offer stands down to 5,000, so that is what is offered.
  assert.equal(quote.json.data.quantity, 5000);
  assert.equal(quote.json.data.unitPrice, 9);
});

test('the quote carries the costing, the customer and the model across', async () => {
  const sheet = await costed({ approvedSellingPrice: 9 });

  const quote = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: {},
  });

  assert.equal(String(quote.json.data.pricing), String(sheet._id));
  assert.equal(String(quote.json.data.customer), String(customer));
  assert.equal(quote.json.data.modelNumber, 'NH-400');
  // Rev 0 exists from the start [§10], whichever door the quote came through.
  assert.equal(quote.json.data.revisions.length, 1);
  assert.equal(quote.json.data.revisions[0].revision, 0);
});

test('a quantity under the stated minimum is refused', async () => {
  const product = await modelWithMoq('NH-MOQ6', 5000);
  const sheet = await costed({ approvedSellingPrice: 9, product });

  const quote = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: { quantity: 400 },
  });

  assert.equal(quote.status, 400);
  assert.match(quote.json.message, /5000|minimum/i);
});

test('a costing waiting on approval cannot be quoted [§9]', async () => {
  const sheet = await costed({ approvedSellingPrice: 6, minimumSellingPrice: 8 });
  assert.equal(sheet.status, 'approval_pending');

  const quote = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: {},
  });

  assert.equal(quote.status, 400);
  assert.match(quote.json.message, /approval/i);
  // And the refusal does not hand over the floor it is protecting [§8].
  assert.ok(!quote.json.message.includes('8'));
});

test('once signed off, the same costing quotes at the sanctioned price', async () => {
  const sheet = await costed({ approvedSellingPrice: 6, minimumSellingPrice: 8 });
  await api(`/api/pricings/${sheet._id}/decision`, {
    method: 'POST', token: admin, body: { approve: true },
  });

  const quote = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: {},
  });

  assert.equal(quote.status, 201, quote.json.message);
  assert.equal(quote.json.data.unitPrice, 6);
});

test('a costing shows what it was quoted at', async () => {
  const sheet = await costed({ approvedSellingPrice: 9 });
  await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: { quantity: 12000 },
  });

  const back = await api(`/api/pricings/${sheet._id}/quotations`, { token: admin });
  assert.equal(back.status, 200);
  assert.equal(back.json.data.length, 1);
  assert.equal(back.json.data[0].quantity, 12000);
});

/* --------------------- The enquiry, and what it produced --------------------- */

test('an enquiry’s costings and quotations are reachable from it', async () => {
  const enquiry = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer, product, source: 'manual',
      requirement: { modelNumber: 'NH-400', quantity: 20000 },
      ...followUp,
    },
  });
  const enquiryId = enquiry.json.data._id;

  const made = await api('/api/pricings', {
    method: 'POST',
    token: admin,
    body: { enquiry: enquiryId, customer, quantity: 20000, modelNumber: 'NH-400' },
  });
  await api(`/api/pricings/${made.json.data._id}/cost`, {
    method: 'PATCH',
    token: admin,
    body: { cost: { gramWeight: 22, rawMaterialRate: 95 }, targetMargin: 20, minimumSellingPrice: 1 },
  });
  await api(`/api/pricings/${made.json.data._id}/quotation`, {
    method: 'POST', token: nandhini, body: { quantity: 20000 },
  });

  /*
   * Reached by filtering each module on the enquiry rather than by the enquiry carrying them
   * inline. The detail screen replaces its record wholesale after every action — including
   * "Ask for a price", the action that creates a costing — so a list hanging off that record
   * would blank itself at exactly the moment it became interesting.
   */
  const costings = await api(`/api/pricings?enquiry=${enquiryId}`, { token: nandhini });
  assert.equal(costings.status, 200);
  assert.equal(costings.json.data.length, 1);

  const quotes = await api(`/api/quotations?enquiry=${enquiryId}`, { token: nandhini });
  assert.equal(quotes.status, 200);
  assert.equal(quotes.json.data.length, 1);
  assert.equal(String(quotes.json.data[0].enquiry._id ?? quotes.json.data[0].enquiry), enquiryId);

  // §8 still applies when a costing is reached this way.
  assert.equal(costings.json.data[0].costingHidden, true);
  assert.equal(costings.json.data[0].cost, undefined);
});

/* ---------------------------------- The PDF ---------------------------------- */

test('the quotation renders as a PDF', async () => {
  const sheet = await costed({ approvedSellingPrice: 9 });
  const quote = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: { quantity: 12000, gstPercent: 18 },
  });

  const response = await fetch(`${baseUrl}/api/quotations/${quote.json.data._id}/pdf`, {
    headers: { Authorization: `Bearer ${nandhini}` },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');

  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(body.subarray(0, 5).toString(), '%PDF-', 'should be a real PDF');
  assert.ok(body.length > 1500, 'a quotation document is not 1 KB');
});

test('the PDF names no cost, margin or floor [§8]', async () => {
  const sheet = await costed({ approvedSellingPrice: 9, minimumSellingPrice: 8 });
  const quote = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: { quantity: 12000 },
  });

  const response = await fetch(`${baseUrl}/api/quotations/${quote.json.data._id}/pdf`, {
    headers: { Authorization: `Bearer ${nandhini}` },
  });
  const text = Buffer.from(await response.arrayBuffer()).toString('latin1');

  /*
   * The document goes to the *customer*. §8 keeps the cost base from our own marketing team;
   * putting it in front of the buyer would be the same leak with a stamp on it. Checked against
   * the raw stream rather than the layout, so a figure smuggled into metadata still fails.
   */
  for (const forbidden of ['Gross margin', 'Minimum', 'Cost base', 'Material cost']) {
    assert.ok(!text.includes(forbidden), `the PDF must not mention ${forbidden}`);
  }
});

/* ---------------------------- The costing detail ---------------------------- */

test('a costing comes back with the model master and what it was quoted at', async () => {
  const product = await modelWithMoq('NH-DETAIL', 3000);
  const sheet = await costed({ approvedSellingPrice: 9, product });
  await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: { quantity: 15000 },
  });

  const seen = await api(`/api/pricings/${sheet._id}`, { token: admin });
  assert.equal(seen.status, 200);

  // The master, so the sheet can be read against the model's own standard.
  assert.equal(seen.json.data.product.modelCode, 'NH-DETAIL');
  assert.equal(seen.json.data.product.moq, 3000);

  // And what has actually been offered off this price.
  assert.equal(seen.json.quotations.length, 1);
  assert.equal(seen.json.quotations[0].quantity, 15000);
});

test('the detail keeps §8 for a marketing reader', async () => {
  const sheet = await costed({ approvedSellingPrice: 9 });

  const seen = await api(`/api/pricings/${sheet._id}`, { token: nandhini });
  assert.equal(seen.status, 200);
  assert.equal(seen.json.data.cost, undefined);
  assert.equal(seen.json.data.minimumSellingPrice, undefined);
  assert.equal(seen.json.data.grossMarginPercent, undefined);
  assert.equal(seen.json.data.costingHidden, true);
  // The price it may quote is still there, or the screen has nothing to show.
  assert.equal(seen.json.data.approvedSellingPrice, 9);
});

/* ------------------ Automation advances, it never retreats ------------------ */

test('re-sending a quote during a negotiation does not pull the enquiry back', async () => {
  const enquiry = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer, product, source: 'manual',
      requirement: { modelNumber: 'NH-400', quantity: 20000 },
      ...followUp,
    },
  });
  const enquiryId = enquiry.json.data._id;

  const made = await api('/api/pricings', {
    method: 'POST',
    token: admin,
    body: { enquiry: enquiryId, customer, quantity: 20000 },
  });
  await api(`/api/pricings/${made.json.data._id}/cost`, {
    method: 'PATCH',
    token: admin,
    body: { cost: { gramWeight: 22, rawMaterialRate: 95 }, targetMargin: 20, minimumSellingPrice: 1 },
  });

  const quote = await api(`/api/pricings/${made.json.data._id}/quotation`, {
    method: 'POST', token: nandhini, body: { quantity: 20000 },
  });

  // Sending it moves the enquiry to `quote_submitted` — the automation doing its job.
  await api(`/api/quotations/${quote.json.data._id}/send`, {
    method: 'POST', token: nandhini, body: {},
  });
  let seen = await api(`/api/enquiries/${enquiryId}`, { token: nandhini });
  assert.equal(seen.json.data.status, 'quote_submitted');

  // The buyer pushes back; marketing moves it on.
  await api(`/api/enquiries/${enquiryId}/status`, {
    method: 'POST', token: nandhini, body: { status: 'negotiation', ...followUp },
  });

  /*
   * Now the ordinary shape of a negotiation: revise the price and send it again. The event is
   * the same one that first moved the enquiry forward, and without the guard it would march
   * the funnel backwards while marketing did exactly the right thing.
   */
  await api(`/api/quotations/${quote.json.data._id}/revisions`, {
    method: 'POST', token: nandhini, body: { unitPrice: 6.9 },
  });
  await api(`/api/quotations/${quote.json.data._id}/send`, {
    method: 'POST', token: nandhini, body: {},
  });

  seen = await api(`/api/enquiries/${enquiryId}`, { token: nandhini });
  assert.equal(seen.json.data.status, 'negotiation', 'the enquiry stays where marketing put it');
});
