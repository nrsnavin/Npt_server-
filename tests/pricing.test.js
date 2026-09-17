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

import { CONFIDENTIAL, PUBLIC_FIGURES, seesCosting } from '../src/services/pricingVisibility.js';
import { minimumFor, priceAt, priceFrom, tiersFor } from '../src/services/pricing.service.js';

process.env.JWT_SECRET = 'pricing-test-secret-value';

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
const followUp = { nextAction: 'Call the buyer', nextFollowUpDate: inDays(3) };

let mongo;
let server;
let baseUrl;
let admin;      // management — sees costing
let nandhini;   // marketing — must not
let mould;
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

/** A costing that has been built, with a floor under the approved price unless asked otherwise. */
const costed = async ({ approvedSellingPrice, minimumOverride = 8, mould: on } = {}) => {
  const made = await api('/api/pricings', {
    method: 'POST',
    token: admin,
    body: {
      customer, quantity: 40000, modelNumber: 'NH-400', targetPrice: 7.5,
      ...(on !== undefined ? { mould: on } : {}),
    },
  });
  const id = made.json.data._id;

  const built = await api(`/api/pricings/${id}/cost`, {
    method: 'PATCH',
    token: admin,
    body: {
      cost: { gramWeight: 22, rawMaterialRate: 95, jobWorkCost: 1.1, packingCost: 0.4 },
      markupPercent: 20,
      minimumOverride,
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

/* --------------------------------- The sheet --------------------------------- */

test('the selling price is cost plus a markup, the way the sheet works it', async () => {
  /*
   * Verified against the plant's own 26-27 quotation sheet: all 25 rows are `cost x (1 + pct)`.
   * This test used to assert the opposite convention — margin *on the selling price* — which is
   * a real convention and not this business's. At 10% the two agree to the paisa, which is why
   * it went unnoticed; at 20% they differ by 4%, and every quoted price was wrong by that much.
   */
  assert.equal(priceFrom({ totalCost: 10, markupPercent: 20 }), 12);
  assert.equal(priceFrom({ totalCost: 10, markupPercent: 0 }), 10);
  /* ₹7.645 exactly. Five paise would make it 7.65; the quoted price rounds to ten. */
  assert.equal(priceFrom({ totalCost: 6.95, markupPercent: 10 }), 7.7, "the sheet's first row");
  assert.equal(priceFrom({ totalCost: 0, markupPercent: 20 }), undefined, 'no cost, no price');

  // All three standing tiers at once, because the sheet shows them side by side.
  assert.deepEqual(tiersFor(6.95), { 10: 7.65, 15: 8, 20: 8.35 });

  // And the floor is the lowest of them rather than a number somebody typed.
  assert.equal(minimumFor({ totalCost: 6.95 }), 7.65);
  assert.equal(minimumFor({ totalCost: 6.95, minimumOverride: 5 }), 5, 'unless this job has its own');
});

test('a quoted price is rounded up to five paise, never down', async () => {
  /*
   * ₹6.95 + 15% is ₹7.9925 exactly. Nobody quotes that: somebody tidies it by hand on the way to
   * the quotation, and from then on the sheet and the quotation disagree. Rounding it here is
   * what stops that, and rounding *up* is what keeps it safe — `minimumFor` is the 10% tier run
   * through this same function, so rounding down would shave the very floor that §9's
   * below-minimum approval exists to defend.
   */
  assert.equal(priceAt(6.95, 15), 8, '7.9925 rounds up, not to 7.99');
  assert.equal(priceAt(6.95, 20), 8.35, '8.34 goes up to the next five paise');

  // A price already on the step does not move. Worked in whole paise for exactly this reason:
  // `Math.ceil(7.65 / 0.05)` is 153 in binary floating point, which would push it to 7.70.
  assert.equal(priceAt(6.95, 10), 7.65, 'already on a five-paise step');
  assert.equal(priceAt(10, 20), 12, 'and a round number stays round');

  // Never down: the rounded price is always at least the exact arithmetic.
  for (const cost of [3.59, 6.95, 7.01, 11.113]) {
    for (const percent of [10, 15, 20]) {
      assert.ok(
        priceAt(cost, percent) >= Math.round(cost * (1 + percent / 100) * 100) / 100,
        `${cost} at ${percent}% must not round below cost plus the markup`
      );
    }
  }
});
test('the sheet adds up, and the calculated price cannot be typed', async () => {
  const sheet = await costed();

  // 22g at ₹95/kg = ₹2.09, plus 1.1 job work and 0.4 packing = ₹3.59.
  assert.equal(sheet.materialCost, 2.09);
  assert.equal(Math.round(sheet.totalCost * 100) / 100, 3.59);
  assert.equal(sheet.calculatedSellingPrice, 4.4, '3.59 plus a 20% markup, rounded up to 10 paise');

  // And all three standing tiers come back, because the sheet chooses between them.
  assert.deepEqual(sheet.tiers, { 10: 3.95, 15: 4.15, 20: 4.35 });

  const typed = await api(`/api/pricings/${sheet._id}/cost`, {
    method: 'PATCH',
    token: admin,
    body: { calculatedSellingPrice: 99 },
  });
  assert.equal(typed.status, 400, 'a figure that can be posted is one that can disagree with its inputs');
});

test('the margin is measured on the price actually approved', async () => {
  // The margin on a number nobody quoted is not a fact about this job.
  const sheet = await costed({ approvedSellingPrice: 5, minimumOverride: 4 });
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
  /* A costing is a per-piece cost, so it is always of one piece — see the model's note. */
  assert.equal(json.data.quantity, 1);
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
    body: { markupPercent: 5 },
  });

  assert.equal(attempt.status, 403);
  assert.match(attempt.json.message, /costing or management/i);
});

/* ------------------------------ §9: the floor ------------------------------ */

test('a price under the floor goes to approval rather than through', async () => {
  const sheet = await costed({ approvedSellingPrice: 6, minimumOverride: 8 });

  assert.equal(sheet.status, 'approval_pending');
  assert.equal(sheet.belowMinimum, true);
});

test('a price at or above the floor is approved on the spot', async () => {
  const sheet = await costed({ approvedSellingPrice: 9, minimumOverride: 8 });
  assert.equal(sheet.status, 'approved');
});

test('marketing learns that a quote is blocked, not where the floor is', async () => {
  /*
   * The block has to be explainable or it reads as the system being broken — but explaining it
   * with the figure would hand over the very number §8 protects.
   */
  const sheet = await costed({ approvedSellingPrice: 6, minimumOverride: 8 });
  const { json } = await api(`/api/pricings/${sheet._id}`, { token: nandhini });

  assert.equal(json.data.belowMinimum, true, 'they can see it is blocked');
  assert.equal(json.data.minimumSellingPrice, undefined, 'and not what it is blocked by');
});

test('refusing a price needs a reason, and sends it back', async () => {
  const sheet = await costed({ approvedSellingPrice: 6, minimumOverride: 8 });

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
  const sheet = await costed({ approvedSellingPrice: 6, minimumOverride: 8 });
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
  const sheet = await costed({ approvedSellingPrice: 6, minimumOverride: 8 });
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
      mould,
      requirement: { modelNumber: 'NH-400' },
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
  /* No quantity comes across, because the enquiry no longer carries one — nothing before the
     purchase order knows how many, and a costing is a per-piece cost regardless. */
  assert.equal(json.data[0].quantity, 1);
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

/** A model on the register carrying a standard minimum — the master a quotation reads [§28]. */
const modelWithMoq = async (code, moq) => {
  const made = await api('/api/moulds', {
    method: 'POST',
    token: admin,
    body: {
      mouldCode: `M-${code}`, name: `Hanger ${code}`, category: 'shirt',
      material: 'pp', sizeMm: 360, moq,
      cavities: 4, partWeightGrams: 26, cycleTimeSeconds: 28,
    },
  });
  return made.json.data._id;
};

test('a costing carries no MOQ — it is a term of the offer, not of the cost', async () => {
  const tool = await modelWithMoq('NH-MOQ', 2500);

  const made = await api('/api/pricings', {
    method: 'POST',
    token: admin,
    body: { customer, mould: tool, quantity: 40000 },
  });

  assert.equal(made.status, 201, made.json.message);
  assert.equal(made.json.data.moq, undefined);
  // The rest of what the register knows still comes across, so the sheet is not retyped.
  assert.equal(made.json.data.modelNumber, 'M-NH-MOQ');
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
  const tool = await modelWithMoq('NH-MOQ2', 2500);
  const sheet = await costed({ approvedSellingPrice: 9, mould: tool });

  const quote = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: {},
  });

  assert.equal(quote.status, 201, quote.json.message);
  assert.equal(quote.json.data.lines[0].moq, 2500);
});

test('a minimum set on the quote beats the master', async () => {
  const tool = await modelWithMoq('NH-MOQ3', 2500);
  const sheet = await costed({ approvedSellingPrice: 9, mould: tool });

  const quote = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: { moq: 10000 },
  });

  assert.equal(quote.json.data.lines[0].moq, 10000);
});

test('the minimum is part of what a revision said [§10]', async () => {
  const tool = await modelWithMoq('NH-MOQ4', 2000);
  const sheet = await costed({ approvedSellingPrice: 9, mould: tool });
  const quote = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: {},
  });

  await api(`/api/quotations/${quote.json.data._id}/revisions`, {
    method: 'POST', token: nandhini,
    body: { lines: [{ unitPrice: 8.5, moq: 5000 }] },
  });

  const back = await api(`/api/quotations/${quote.json.data._id}`, { token: nandhini });
  assert.equal(back.json.data.lines[0].moq, 5000);
  assert.equal(back.json.data.revisions[0].lines[0].moq, 2000, 'Rev 0 keeps the minimum it stated');
  assert.equal(back.json.data.revisions[1].lines[0].moq, 5000);
});

/* --------------------- Turning a costing into a quote --------------------- */

test('a quote states the minimum the rate is good for, and no quantity [§10]', async () => {
  const tool = await modelWithMoq('NH-MOQ5', 5000);
  const sheet = await costed({ approvedSellingPrice: 9, mould: tool });

  const quote = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: {},
  });

  assert.equal(quote.status, 201, quote.json.message);
  /*
   * A rate against a minimum, which is what this plant's quotations are. The register's
   * minimum comes across; how many the buyer actually takes is the purchase order's answer,
   * months later, and putting a number here would have made it look agreed.
   */
  assert.equal(quote.json.data.lines[0].moq, 5000);
  assert.equal(quote.json.data.lines[0].quantity, undefined);
  assert.equal(quote.json.data.lines[0].unitPrice, 9);
});

test('the quote carries the costing, the customer and the model across', async () => {
  const sheet = await costed({ approvedSellingPrice: 9 });

  const quote = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: {},
  });

  assert.equal(String(quote.json.data.lines[0].pricing), String(sheet._id));
  assert.equal(String(quote.json.data.customer), String(customer));
  assert.equal(quote.json.data.lines[0].modelNumber, 'NH-400');
  // Rev 0 exists from the start [§10], whichever door the quote came through.
  assert.equal(quote.json.data.revisions.length, 1);
  assert.equal(quote.json.data.revisions[0].revision, 0);
});

test('a quantity sent to the quote door is ignored rather than honoured', async () => {
  const tool = await modelWithMoq('NH-MOQ6', 5000);
  const sheet = await costed({ approvedSellingPrice: 9, mould: tool });

  const quote = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: { quantity: 400 },
  });

  /*
   * There is nothing for it to be under any more — the offer is a rate against a minimum, so
   * a quantity is not a thing a quotation from this plant states. An old caller sending one is
   * not refused for a field that used to be required; it simply does not land.
   */
  assert.equal(quote.status, 201, quote.json.message);
  assert.equal(quote.json.data.lines[0].quantity, undefined);
  assert.equal(quote.json.data.lines[0].moq, 5000);
});

test('a costing waiting on approval cannot be quoted [§9]', async () => {
  const sheet = await costed({ approvedSellingPrice: 6, minimumOverride: 8 });
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
  const sheet = await costed({ approvedSellingPrice: 6, minimumOverride: 8 });
  await api(`/api/pricings/${sheet._id}/decision`, {
    method: 'POST', token: admin, body: { approve: true },
  });

  const quote = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: {},
  });

  assert.equal(quote.status, 201, quote.json.message);
  assert.equal(quote.json.data.lines[0].unitPrice, 6);
});

test('a costing shows what it was quoted at', async () => {
  const sheet = await costed({ approvedSellingPrice: 9 });
  await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: { moq: 12000 },
  });

  const back = await api(`/api/pricings/${sheet._id}/quotations`, { token: admin });
  assert.equal(back.status, 200);
  assert.equal(back.json.data.length, 1);
  /* The rate and the minimum it holds down to — which is the whole of what was offered. */
  assert.equal(back.json.data[0].lines[0].unitPrice, 9);
  assert.equal(back.json.data[0].lines[0].moq, 12000);
});

/* --------------------- The enquiry, and what it produced --------------------- */

test('an enquiry’s costings and quotations are reachable from it', async () => {
  const enquiry = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer, mould, source: 'manual',
      requirement: { modelNumber: 'NH-400' },
      ...followUp,
    },
  });
  const enquiryId = enquiry.json.data._id;

  const made = await api('/api/pricings', {
    method: 'POST',
    token: admin,
    body: { enquiry: enquiryId, customer, modelNumber: 'NH-400' },
  });
  await api(`/api/pricings/${made.json.data._id}/cost`, {
    method: 'PATCH',
    token: admin,
    body: { cost: { gramWeight: 22, rawMaterialRate: 95 }, markupPercent: 20 },
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
  const sheet = await costed({ approvedSellingPrice: 9, minimumOverride: 8 });
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
  const tool = await modelWithMoq('NH-DETAIL', 3000);
  const sheet = await costed({ approvedSellingPrice: 9, mould: tool });
  await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: {},
  });

  const seen = await api(`/api/pricings/${sheet._id}`, { token: admin });
  assert.equal(seen.status, 200);

  // The master, so the sheet can be read against the model's own standard.
  assert.equal(seen.json.data.mould.mouldCode, 'M-NH-DETAIL');
  assert.equal(seen.json.data.mould.moq, 3000);

  // And what has actually been offered off this price: a rate, against the register's minimum.
  assert.equal(seen.json.quotations.length, 1);
  assert.equal(seen.json.quotations[0].lines[0].unitPrice, 9);
  assert.equal(seen.json.quotations[0].lines[0].moq, 3000);
});

/**
 * A one-pixel PNG — enough to prove the picture travelled. See the note in quotation.test.js.
 */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

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
  return response.json();
};

test('the costing carries the part photo, like everywhere else the model is named', async () => {
  /*
   * The costing screen draws the thumbnail beside the code, and this populate names its fields
   * explicitly — which is right, but it means a field left off the list is simply absent. There
   * is no error for that: the sheet arrives with a mould that has no picture, the screen falls
   * through to its "no photo on the register" placeholder, and every costing in the plant looks
   * like a model nobody ever photographed.
   */
  const tool = await modelWithMoq('NH-PHOTO', 2000);
  await photograph(tool);

  const sheet = await costed({ approvedSellingPrice: 9, mould: tool });
  const seen = await api(`/api/pricings/${sheet._id}`, { token: admin });

  assert.equal(seen.status, 200);
  assert.ok(seen.json.data.mould.photo?.key, 'the costing lost the part photo on the way out');
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
      customer, mould, source: 'manual',
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
    body: { cost: { gramWeight: 22, rawMaterialRate: 95 }, markupPercent: 20 },
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
  const revised = await api(`/api/quotations/${quote.json.data._id}/revisions`, {
    method: 'POST',
    token: nandhini,
    body: { lines: [{ quantity: 20000, unitPrice: 6.9 }], note: 'Buyer pushed on price' },
  });
  /*
   * Asserted, because a revision is the precondition of the thing being tested and it used to be
   * sent as a bare `unitPrice` — which the revision schema has no field for, so zod stripped it,
   * the controller refused an empty revision, and the send below was a plain re-send of the same
   * offer. The test still passed, on a path it was not written to exercise.
   */
  assert.equal(revised.status, 200, revised.json.message);

  await api(`/api/quotations/${quote.json.data._id}/send`, {
    method: 'POST', token: nandhini, body: {},
  });

  seen = await api(`/api/enquiries/${enquiryId}`, { token: nandhini });
  assert.equal(seen.json.data.status, 'negotiation', 'the enquiry stays where marketing put it');
});

/* --------------------------- Editing a costing --------------------------- */

test('a settled costing can be re-costed rather than abandoned', async () => {
  const sheet = await costed({ approvedSellingPrice: 9 });
  assert.equal(sheet.status, 'approved');

  // The resin rate moved.
  const again = await api(`/api/pricings/${sheet._id}/cost`, {
    method: 'PATCH',
    token: admin,
    body: {
      cost: { gramWeight: 22, rawMaterialRate: 120, jobWorkCost: 1.1, packingCost: 0.4 },
      markupPercent: 20,
      minimumOverride: 8,
      approvedSellingPrice: 10,
    },
  });

  assert.equal(again.status, 200, again.json.message);
  assert.equal(again.json.data.approvedSellingPrice, 10);
  // And the re-costing is on the record, not only in the audit log.
  assert.ok(
    again.json.data.statusHistory.some((entry) => /Re-costed/i.test(entry.note || '')),
    'the sheet should say it was re-costed after being settled'
  );
});

test('re-costing below the floor sends an approved sheet back for signature [§9]', async () => {
  const sheet = await costed({ approvedSellingPrice: 9 });
  assert.equal(sheet.status, 'approved');

  const again = await api(`/api/pricings/${sheet._id}/cost`, {
    method: 'PATCH',
    token: admin,
    body: {
      cost: { gramWeight: 22, rawMaterialRate: 95, jobWorkCost: 1.1, packingCost: 0.4 },
      markupPercent: 20,
      minimumOverride: 8,
      approvedSellingPrice: 6,
    },
  });

  assert.equal(again.status, 200, again.json.message);
  assert.equal(again.json.data.status, 'approval_pending');
  /*
   * And it stops claiming a signature it no longer has. A sheet waiting on approval that still
   * names its old approver puts "signed off" beside "needs approval" on the same row.
   */
  assert.equal(again.json.data.approvedBy, undefined);
  assert.equal(again.json.data.approvedAt, undefined);
});

test('re-costing a refused sheet records the move it actually made', async () => {
  const sheet = await costed({ approvedSellingPrice: 6, minimumOverride: 8 });
  await api(`/api/pricings/${sheet._id}/decision`, {
    method: 'POST', token: admin, body: { approve: false, note: 'Too thin' },
  });

  const again = await api(`/api/pricings/${sheet._id}/cost`, {
    method: 'PATCH',
    token: admin,
    body: {
      cost: { gramWeight: 22, rawMaterialRate: 95, jobWorkCost: 1.1 },
      markupPercent: 20, minimumOverride: 4, approvedSellingPrice: 9,
    },
  });

  assert.equal(again.status, 200, again.json.message);
  assert.equal(again.json.data.status, 'approved');

  // rejected → costed → approved, with no entry claiming to start from a stage already left.
  const history = again.json.data.statusHistory;
  const reopen = history.find((entry) => /Re-costed/i.test(entry.note || ''));
  assert.equal(reopen.from, 'rejected');
  assert.equal(reopen.to, 'costed');
  assert.equal(history[history.length - 1].from, 'costed');
  assert.equal(history[history.length - 1].to, 'approved');
});

test('a quote already raised keeps its price when the costing is re-costed', async () => {
  const sheet = await costed({ approvedSellingPrice: 9 });
  const quote = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: { quantity: 12000 },
  });
  assert.equal(quote.json.data.lines[0].unitPrice, 9);

  await api(`/api/pricings/${sheet._id}/cost`, {
    method: 'PATCH',
    token: admin,
    body: {
      cost: { gramWeight: 30, rawMaterialRate: 120 },
      markupPercent: 20, minimumOverride: 1, approvedSellingPrice: 14,
    },
  });

  /*
   * A quotation records what was offered, not a pointer to a number that can move under it.
   * If this ever fails, a sheet edited months later would silently rewrite what a customer
   * was told.
   */
  const back = await api(`/api/quotations/${quote.json.data._id}`, { token: nandhini });
  assert.equal(back.json.data.lines[0].unitPrice, 9);
  assert.equal(back.json.data.revisions[0].lines[0].unitPrice, 9);
});

test('the details of a costing can be corrected', async () => {
  const made = await api('/api/pricings', {
    method: 'POST',
    token: admin,
    body: { customer, modelNumber: 'NH-400', targetPrice: 7.5 },
  });

  const fixed = await api(`/api/pricings/${made.json.data._id}`, {
    method: 'PATCH',
    token: admin,
    body: { modelNumber: 'NH-410', targetPrice: 8, remarks: 'Buyer moved to the wider hanger' },
  });

  assert.equal(fixed.status, 200, fixed.json.message);
  assert.equal(fixed.json.data.modelNumber, 'NH-410');
  assert.equal(fixed.json.data.targetPrice, 8);
  assert.equal(fixed.json.data.remarks, 'Buyer moved to the wider hanger');
});

test('the details door refuses a price outright', async () => {
  const sheet = await costed({ approvedSellingPrice: 9 });

  const sneaky = await api(`/api/pricings/${sheet._id}`, {
    method: 'PATCH',
    token: admin,
    body: { approvedSellingPrice: 2 },
  });

  /*
   * Refused rather than dropped. Prices move through the costing sheet where §9's floor is
   * checked; a details edit that silently ignored a price would look like it had worked and
   * leave the old number in place.
   */
  assert.equal(sneaky.status, 400);
  const unchanged = await api(`/api/pricings/${sheet._id}`, { token: admin });
  assert.equal(unchanged.json.data.approvedSellingPrice, 9);
});

test('a costing is always of one piece, whatever a caller sends', async () => {
  /*
   * The sheet has only ever been a per-piece cost: grams at a rate per kilo, plus a hook, a
   * clip and a print each priced per piece. Nothing in the build-up varies with the lot size,
   * so the quantity that used to sit beside it was a note about which enquiry raised the sheet
   * wearing the clothes of an input — and it travelled onto quotations as though somebody had
   * agreed to it.
   */
  const made = await api('/api/pricings', {
    method: 'POST', token: admin, body: { customer, modelNumber: 'NH-400', quantity: 40000 },
  });

  assert.equal(made.json.data.quantity, 1);

  /*
   * And the correction door refuses one outright rather than dropping it. That is the same
   * bargain it makes about prices: a strict door means a screen still sending the field finds
   * out, where a lenient one would look like it had worked and change nothing.
   */
  const patched = await api(`/api/pricings/${made.json.data._id}`, {
    method: 'PATCH', token: admin, body: { quantity: 5000 },
  });

  assert.equal(patched.status, 400);

  const after = await api(`/api/pricings/${made.json.data._id}`, { token: admin });
  assert.equal(after.json.data.quantity, 1, 'and it stays one');
});

test('only costing may edit a sheet', async () => {
  const sheet = await costed({ approvedSellingPrice: 9 });

  const refused = await api(`/api/pricings/${sheet._id}`, {
    method: 'PATCH', token: nandhini, body: { targetPrice: 100 },
  });
  assert.equal(refused.status, 403);
});

/* --------------------------- Editing a quotation --------------------------- */

/** A draft quotation on a fresh approved costing. */
const drafted = async (body = {}) => {
  const sheet = await costed({ approvedSellingPrice: 9 });
  const quote = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST',
    token: nandhini,
    body: { moq: 12000, paymentTerms: '30 days', ...body },
  });
  assert.equal(quote.status, 201, quote.json.message);
  return quote.json.data;
};

test('a draft quotation can be edited freely', async () => {
  const quote = await drafted();

  const edited = await api(`/api/quotations/${quote._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: {
      /* The minimum is per line; the terms belong to the document. The *price* is not editable
         even on a draft — it moves through a revision, so the old one is kept [§10]. */
      lines: [{ moq: 8000, unitPrice: quote.lines[0].unitPrice }],
      paymentTerms: '45 days from invoice',
      packing: '200 pcs per carton',
    },
  });

  assert.equal(edited.status, 200, edited.json.message);
  assert.equal(edited.json.data.lines[0].moq, 8000);
  assert.equal(edited.json.data.paymentTerms, '45 days from invoice');
});

test('once it has gone out, the offer only changes through a revision [§10]', async () => {
  const quote = await drafted();
  await api(`/api/quotations/${quote._id}/send`, {
    method: 'POST', token: nandhini, body: {},
  });

  const sneaky = await api(`/api/quotations/${quote._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: {
      paymentTerms: '90 days from invoice',
      lines: [{ moq: 500, unitPrice: quote.lines[0].unitPrice }],
    },
  });

  assert.equal(sneaky.status, 400);
  assert.match(sneaky.json.message, /already gone to the customer/i);
  // And it names what it refused, so the message is actionable rather than a wall.
  assert.match(sneaky.json.message, /the lines/);
  assert.match(sneaky.json.message, /paymentTerms/);

  // Nothing moved.
  const unchanged = await api(`/api/quotations/${quote._id}`, { token: nandhini });
  assert.equal(unchanged.json.data.paymentTerms, '30 days');
  assert.equal(unchanged.json.data.lines[0].moq, 12000);
});

test('a revision is the way through, and it keeps what was said', async () => {
  const quote = await drafted();
  await api(`/api/quotations/${quote._id}/send`, {
    method: 'POST', token: nandhini, body: {},
  });

  const revised = await api(`/api/quotations/${quote._id}/revisions`, {
    method: 'POST',
    token: nandhini,
    body: {
      lines: [{ quantity: 12000, unitPrice: 8.5 }],
      paymentTerms: '90 days from invoice',
      note: 'Buyer pushed on terms',
    },
  });

  assert.equal(revised.status, 200, revised.json.message);
  assert.equal(revised.json.data.paymentTerms, '90 days from invoice');
  assert.equal(revised.json.data.revisions[0].paymentTerms, '30 days', 'Rev 0 keeps what it said');
  assert.equal(revised.json.data.revisions[1].paymentTerms, '90 days from invoice');
});

test('the bookkeeping behind a sent quote is still editable', async () => {
  const quote = await drafted();
  await api(`/api/quotations/${quote._id}/send`, {
    method: 'POST', token: nandhini, body: {},
  });

  /*
   * Linking a sent quotation to the enquiry it belongs to changes nothing the buyer was told,
   * so it must not need a revision — a rule that blocks corrections as well as rewrites is one
   * people route around.
   */
  const enquiry = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer, mould, source: 'manual',
      requirement: { modelNumber: 'NH-400', quantity: 12000 },
      ...followUp,
    },
  });

  const linked = await api(`/api/quotations/${quote._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { enquiry: enquiry.json.data._id },
  });

  assert.equal(linked.status, 200, linked.json.message);
});

test('an answered quotation cannot be edited at all', async () => {
  const quote = await drafted();
  await api(`/api/quotations/${quote._id}/send`, { method: 'POST', token: nandhini, body: {} });
  await api(`/api/quotations/${quote._id}/response`, {
    method: 'POST', token: nandhini, body: { accepted: true },
  });

  const edited = await api(`/api/quotations/${quote._id}`, {
    method: 'PATCH', token: nandhini, body: { packing: 'anything' },
  });
  assert.equal(edited.status, 400);
  assert.match(edited.json.message, /accepted/i);
});

/* ------------------------- The quotation detail ------------------------- */

test('a quotation comes back with the names and the costing behind it', async () => {
  const sheet = await costed({ approvedSellingPrice: 9 });
  const quote = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: { quantity: 12000 },
  });
  await api(`/api/quotations/${quote.json.data._id}/revisions`, {
    method: 'POST',
    token: nandhini,
    body: { lines: [{ quantity: 12000, unitPrice: 8.5 }], note: 'Buyer pushed' },
  });

  const seen = await api(`/api/quotations/${quote.json.data._id}`, { token: nandhini });
  assert.equal(seen.status, 200);

  // Who made each revision, so the history reads as people rather than timestamps.
  assert.equal(seen.json.data.revisions[0].by.name, 'Nandhini S');
  assert.equal(seen.json.data.revisions[1].lines[0].unitPrice, 8.5);

  // And the costing it was priced off, so the trail goes both ways.
  assert.equal(seen.json.data.lines[0].pricing.number, sheet.number);
  assert.equal(seen.json.data.lines[0].pricing.approvedSellingPrice, 9);
});

test('the costing on a quotation carries nothing §8 protects', async () => {
  const sheet = await costed({ approvedSellingPrice: 9, minimumOverride: 8 });
  const quote = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: { quantity: 12000 },
  });

  const seen = await api(`/api/quotations/${quote.json.data._id}`, { token: nandhini });
  const pricing = seen.json.data.lines[0].pricing;

  /*
   * A populate that took the whole costing would hand marketing the cost base through a door
   * nobody thought to guard — the quotation is not a costing screen and nothing here runs the
   * §8 redaction.
   */
  assert.equal(pricing.cost, undefined);
  assert.equal(pricing.minimumSellingPrice, undefined);
  assert.equal(pricing.totalCost, undefined);
  assert.equal(pricing.grossMarginPercent, undefined);
});

/* ------------------- One module, three levels [§7–§11, §8] ------------------- */

/**
 * Pricing and quotations are one module now, and the seam that used to run between them runs
 * through the middle of it instead: `quote` may raise the document, `write` may build the sheet.
 *
 * These are the tests that make the merge safe. The whole risk of folding the two together is
 * that the person who quotes ends up holding write on pricing — which would hand every
 * marketing person the cost base, the margin and the floor price on the day it deployed. That
 * failure is silent: nothing errors, the sheet simply arrives complete.
 */

test('marketing holds quote, not write — it may offer a price and never see the cost', async () => {
  const me = await api('/api/auth/me', { token: nandhini });
  const pricing = me.json.data.modules.find((module) => module.key === 'pricing');

  assert.equal(pricing.level, 'quote');
  assert.equal(pricing.canRead, true);
  assert.equal(pricing.canQuote, true);
  assert.equal(pricing.canWrite, false, 'quoting must not imply seeing the cost');
});

test('the quotations module is gone, and the sheet is still redacted', async () => {
  const me = await api('/api/auth/me', { token: nandhini });
  assert.equal(
    me.json.data.modules.find((module) => module.key === 'quotations'),
    undefined,
    'quotations was merged into pricing and must not still be granted separately'
  );

  const sheet = await costed({ approvedSellingPrice: 9 });
  const seen = await api(`/api/pricings/${sheet._id}`, { token: nandhini });

  assert.equal(seen.status, 200, 'marketing must still be able to open the sheet');
  for (const field of CONFIDENTIAL) {
    assert.equal(seen.json.data[field], undefined, `${field} must not reach a quoting reader`);
  }
});

test('quoting is not costing: the same person cannot build the sheet', async () => {
  const made = await api('/api/pricings', {
    method: 'POST',
    token: nandhini,
    body: { customer, quantity: 1000, modelNumber: 'NH-LEVELS' },
  });
  assert.equal(made.status, 201, 'marketing may still ask for a costing');

  const built = await api(`/api/pricings/${made.json.data._id}/cost`, {
    method: 'PATCH',
    token: nandhini,
    body: { cost: { gramWeight: 20, rawMaterialRate: 90 }, markupPercent: 20 },
  });
  assert.equal(built.status, 403);
  assert.match(built.json.message, /costing or management/i);
});

test('a grant for the retired quotations module still lets its holder quote', async () => {
  /*
   * Access is whatever is stored on the user, so the day this merge deploys every marketing
   * person is carrying a grant for a module that no longer exists. Read as pricing, or they
   * lose the ability to quote at the moment of the deploy with nothing on screen to say why.
   *
   * `write` on the old module becomes `quote`, never `write`: it was permission to raise a
   * document, and promoting it would publish the cost base to everyone who had it.
   */
  const { normaliseGrants } = await import('../src/services/access.service.js');
  const { accessLevel } = await import('../src/services/access.service.js');

  const legacy = { isActive: true, moduleAccess: [{ module: 'quotations', level: 'write' }] };
  assert.equal(accessLevel(legacy, 'pricing'), 'quote');
  assert.equal(seesCosting(legacy), false, 'the old grant must not become a costing grant');

  assert.deepEqual(normaliseGrants(legacy.moduleAccess), [{ module: 'pricing', level: 'quote' }]);

  // Never a demotion: somebody who already held the sheet keeps it.
  assert.deepEqual(
    normaliseGrants([
      { module: 'quotations', level: 'write' },
      { module: 'pricing', level: 'write' },
    ]),
    [{ module: 'pricing', level: 'write' }]
  );
});

test('quote is pricing’s level and nobody else’s', async () => {
  const { normaliseGrants } = await import('../src/services/access.service.js');

  /* Offered where it means something... */
  assert.deepEqual(normaliseGrants([{ module: 'pricing', level: 'quote' }]), [
    { module: 'pricing', level: 'quote' },
  ]);

  /* ...and refused where it would store a level that grants nothing and reads as access. */
  assert.deepEqual(normaliseGrants([{ module: 'dispatch', level: 'quote' }]), []);
});

/* ------------------ A second model onto the same quotation ------------------ */

/**
 * A costing prices one model; a quotation is one conversation with one buyer.
 *
 * Without a way to put a second costing onto a quote that already exists, eight approved
 * costings for one customer produced eight quotation numbers — and the plant's own document
 * carries eight models under one. The person quoting had to choose between the real document
 * and the system's idea of one, which is how quoting goes back to a spreadsheet.
 */

test('a second costing goes onto a draft already being written', async () => {
  const first = await costed({ approvedSellingPrice: 9 });
  const second = await costed({ approvedSellingPrice: 12 });

  const raised = await api(`/api/pricings/${first._id}/quotation`, {
    method: 'POST', token: nandhini, body: {},
  });
  assert.equal(raised.status, 201);
  const draft = raised.json.data;

  const added = await api(`/api/pricings/${second._id}/quotation`, {
    method: 'POST', token: nandhini, body: { quotation: draft._id },
  });

  assert.equal(added.status, 200, added.json.message);
  assert.equal(added.json.data.number, draft.number, 'it must be the same document, not a new one');
  assert.equal(added.json.data.lines.length, 2);
  assert.deepEqual(
    added.json.data.lines.map((line) => line.unitPrice).sort((a, b) => a - b),
    [9, 12]
  );

  /* Rev 0 is what will be offered, and nothing has been offered yet — so it carries both. */
  assert.equal(added.json.data.revisions[0].lines.length, 2);

  /* And both costings can see the quote they ended up on. */
  for (const sheet of [first, second]) {
    const back = await api(`/api/pricings/${sheet._id}/quotations`, { token: nandhini });
    assert.ok(
      back.json.data.some((row) => row.number === draft.number),
      `${sheet.number} lost the quotation it was put on`
    );
  }
});

test('the same costing cannot be put on one quotation twice', async () => {
  const sheet = await costed({ approvedSellingPrice: 9 });
  const raised = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: {},
  });

  const again = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: { quotation: raised.json.data._id },
  });

  assert.equal(again.status, 400);
  assert.match(again.json.message, /already on/i);
});

test('a quotation the buyer has seen takes a revision, not another line', async () => {
  /*
   * The line that matters. Appending to a sent quote changes what the customer was told with
   * nothing in the history to say so — which is the whole of what §10 exists to prevent, and
   * exactly the shortcut "add this model to that quote" invites.
   */
  const first = await costed({ approvedSellingPrice: 9 });
  const second = await costed({ approvedSellingPrice: 12 });

  const raised = await api(`/api/pricings/${first._id}/quotation`, {
    method: 'POST', token: nandhini, body: {},
  });
  const sent = await api(`/api/quotations/${raised.json.data._id}/send`, {
    method: 'POST', token: nandhini, body: {},
  });
  assert.equal(sent.status, 200, sent.json.message);

  const added = await api(`/api/pricings/${second._id}/quotation`, {
    method: 'POST', token: nandhini, body: { quotation: raised.json.data._id },
  });

  assert.equal(added.status, 400);
  assert.match(added.json.message, /already gone out/i);
});

test('a costing cannot be added to another customer’s quotation', async () => {
  const other = await api('/api/customers', {
    method: 'POST', token: nandhini, body: { assignedTo: await tokenOwnerId(nandhini), name: 'Anugraha Exports', mobile: '9840099887' },
  });

  const theirs = await api('/api/pricings', {
    method: 'POST',
    token: admin,
    body: { customer: other.json.data._id, quantity: 5000, modelNumber: 'NH-OTHER' },
  });
  const built = await api(`/api/pricings/${theirs.json.data._id}/cost`, {
    method: 'PATCH',
    token: admin,
    body: { cost: { gramWeight: 20, rawMaterialRate: 90 }, markupPercent: 20, approvedSellingPrice: 9 },
  });
  assert.equal(built.status, 200, built.json.message);

  const mine = await costed({ approvedSellingPrice: 9 });
  const raised = await api(`/api/pricings/${mine._id}/quotation`, {
    method: 'POST', token: nandhini, body: {},
  });

  const crossed = await api(`/api/pricings/${theirs.json.data._id}/quotation`, {
    method: 'POST', token: nandhini, body: { quotation: raised.json.data._id },
  });

  assert.equal(crossed.status, 400);
  assert.match(crossed.json.message, /different customer/i);
});

/* ------------------------- Sorting, and what it can leak ------------------------- */

/**
 * An ordering is information about the field it orders by.
 *
 * This is the hole a sortable table opens. §8's redaction deletes the cost base on the way out,
 * and `?sort=markupPercent` hands back the very same sheets *ranked by the figure it deleted* —
 * cheapest job first is a fact about the cost base, and a few requests with a moving filter
 * narrow a hidden number a long way. Nothing errors; the response looks exactly like a sorted
 * list, because it is one.
 */
test('marketing cannot order the register by a figure §8 hides from them', async () => {
  for (const field of ['markupPercent', 'minimumOverride']) {
    const refused = await api(`/api/pricings?sort=-${field}`, { token: nandhini });
    assert.equal(refused.status, 400, `${field} must not be a sort key for marketing`);
    assert.match(refused.json.message, /Cannot sort by/);
    assert.ok(!refused.json.data, 'and no rows come back');
  }
});

test('costing can, because it is their own column', async () => {
  const { status, json } = await api('/api/pricings?sort=-markupPercent&limit=50', { token: admin });
  assert.equal(status, 200, json.message);

  const markups = json.data.map((row) => row.markupPercent).filter((value) => value != null);
  assert.ok(markups.length > 1, 'needs at least two sheets to be an ordering');
  assert.deepEqual(
    markups,
    [...markups].sort((a, b) => b - a),
    'descending is descending'
  );
});

test('both may sort by the price marketing is meant to see', async () => {
  /* `approvedSellingPrice` is on PUBLIC_FIGURES — it is the price they quote, so ordering by it
     tells them nothing they did not already have on the screen. */
  for (const token of [admin, nandhini]) {
    const { status } = await api('/api/pricings?sort=approvedSellingPrice', { token });
    assert.equal(status, 200);
  }
});

test('a field that is not a column at all is refused, and the message says what is', async () => {
  const refused = await api('/api/pricings?sort=customer.gstin', { token: admin });

  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /Cannot sort by "customer\.gstin"/);
  /* Named rather than left to guesswork: a screen asking for an ordering it cannot have is a
     bug, and a refusal that does not say what is allowed is a bug somebody has to bisect. */
  assert.match(refused.json.message, /This list sorts by: .*number/);
});

/**
 * The virtuals, which are the trap on this particular list.
 *
 * `totalCost` and `grossMarginPercent` are computed on the way out of the document — there is
 * nothing in the collection to order by, so Mongo would return the default order and the table
 * would draw an arrow over a column it had not sorted. Refusing is the honest answer, and it is
 * refused for costing too: this one is not about permissions at all.
 */
test('a virtual cannot be sorted by, and is refused rather than silently ignored', async () => {
  for (const field of ['totalCost', 'grossMarginPercent', 'minimumSellingPrice']) {
    const refused = await api(`/api/pricings?sort=-${field}`, { token: admin });
    assert.equal(refused.status, 400, `${field} is a virtual and cannot order a query`);
  }
});

/* ------------------- The quoted price carries one decimal ------------------- */

/**
 * The price a sheet puts forward is the number somebody reads down a phone, and a price carries
 * one decimal. ₹7.65 is a computed figure; ₹7.70 is a price.
 *
 * Only the cost-plus price moves. The three standing tiers and §9's floor stay on the five-paise
 * step, because they are reference figures shown *beside* the price rather than the price
 * itself — and moving the floor would change which sheets need MD's signature, which is a
 * different decision from how a quote reads.
 */
test('the calculated price rounds up to ten paise', async () => {
  assert.equal(priceFrom({ totalCost: 6.95, markupPercent: 10 }), 7.7, '7.645 → 7.70');
  assert.equal(priceFrom({ totalCost: 6.95, markupPercent: 15 }), 8, '7.9925 → 8.00');
  assert.equal(priceFrom({ totalCost: 6.95, markupPercent: 20 }), 8.4, '8.34 → 8.40');

  /* Already on a ten-paise step, and it must not drift up. This is the binary-float trap the
     whole-paise arithmetic exists for: `Math.ceil(7.7 / 0.1)` is 78, not 77. */
  assert.equal(priceFrom({ totalCost: 7, markupPercent: 10 }), 7.7, 'already on the step');
  assert.equal(priceFrom({ totalCost: 10, markupPercent: 20 }), 12, 'a round number stays round');
  assert.equal(priceFrom({ totalCost: 10, markupPercent: 0 }), 10);
});

test('the tiers and the floor keep the five-paise step', async () => {
  /* Unchanged on purpose: these are the reference columns, not the offer. */
  assert.deepEqual(tiersFor(6.95), { 10: 7.65, 15: 8, 20: 8.35 });
  assert.equal(minimumFor({ totalCost: 6.95 }), 7.65);
  assert.equal(priceAt(6.95, 20), 8.35, 'priceAt itself still steps by five paise');
});

/**
 * The consequence, asserted rather than left to be discovered.
 *
 * Two different steps on one sheet means the price and the tier beside it can disagree by up to
 * five paise. That is worth a test precisely because it looks like a bug when you first see it:
 * somebody will read 4.35 in the 20% column, ₹4.40 as the price, and wonder which is wrong.
 */
test('the price can sit above its tier, and never below', async () => {
  const cost = 3.59;
  const tiers = tiersFor(cost);

  for (const percent of [10, 15, 20]) {
    const price = priceFrom({ totalCost: cost, markupPercent: percent });
    assert.ok(price >= tiers[percent], `${percent}%: ${price} must not fall under its tier ${tiers[percent]}`);
    assert.ok(price - tiers[percent] < 0.1, 'and never by a whole step');
  }

  assert.equal(tiers[20], 4.35);
  assert.equal(priceFrom({ totalCost: cost, markupPercent: 20 }), 4.4, 'the case the comment names');
});

test('the quoted price is never under cost plus the markup', async () => {
  /* The property that makes rounding up the only safe direction — §9 defends a floor, and a
     price a paisa under cost-plus-ten would walk under it unnoticed. */
  for (const cost of [3.59, 6.95, 7.01, 11.113, 0.97]) {
    for (const percent of [0, 10, 15, 20, 35]) {
      const exact = Math.round(cost * (1 + percent / 100) * 100) / 100;
      const price = priceFrom({ totalCost: cost, markupPercent: percent });
      assert.ok(price >= exact, `${cost} at ${percent}%: ${price} is under ${exact}`);
      /* And on a ten-paise step, expressed as whole paise so the check is exact. */
      assert.equal(Math.round(price * 100) % 10, 0, `${price} is not on a ten-paise step`);
    }
  }
});

test('a price somebody typed is left exactly where they typed it', async () => {
  /* The rounding governs what the system works out. A figure a person entered is one they
     agreed with a buyer, and moving it by five paise afterwards is how a sheet comes to
     disagree with a conversation. */
  const sheet = await costed({ approvedSellingPrice: 4.37 });

  assert.equal(sheet.approvedSellingPrice, 4.37, 'not nudged to 4.40');
  assert.equal(sheet.calculatedSellingPrice, 4.4, 'while the calculated one is on the step');
});

/* ------------------- Four rules the sheet only implied ------------------- */

/**
 * §9's floor is what routes an under-priced job to a signature. A floor below cost is not a
 * lower floor — it is no floor at all, because every price that clears it is already above
 * the number the approval exists to defend. The screen offers "Minimum override" beside
 * "Approved price" and nothing distinguished them, so the shortcut for "let this one through"
 * was to type a small number into the wrong box: the sheet then approved itself outright and
 * §9 never fired again for that model.
 */
test('a floor under what the piece costs is refused, and says where the price goes instead', async () => {
  const made = await api('/api/pricings', {
    method: 'POST', token: admin, body: { customer, quantity: 40000, modelNumber: 'NH-401' },
  });

  const built = await api(`/api/pricings/${made.json.data._id}/cost`, {
    method: 'PATCH',
    token: admin,
    /* Cost is 3.59: 22g at ₹95/kg is 2.09, plus 1.10 job work and 0.40 packing. */
    body: {
      cost: { gramWeight: 22, rawMaterialRate: 95, jobWorkCost: 1.1, packingCost: 0.4 },
      markupPercent: 20,
      minimumOverride: 1,
    },
  });

  assert.equal(built.status, 400);
  assert.match(built.json.message, /below what the piece costs/i);
  /* The refusal has to point at the box that does what they wanted, or they will find another
     way round it. */
  assert.match(built.json.message, /goes for approval/i);

  /* And a floor above cost is ordinary business: a model the plant will not sell cheaply. */
  const higher = await api(`/api/pricings/${made.json.data._id}/cost`, {
    method: 'PATCH',
    token: admin,
    body: {
      cost: { gramWeight: 22, rawMaterialRate: 95, jobWorkCost: 1.1, packingCost: 0.4 },
      markupPercent: 20,
      minimumOverride: 9,
    },
  });
  assert.equal(higher.status, 200, higher.json.message);
  assert.equal(higher.json.data.minimumSellingPrice, 9);
  assert.equal(higher.json.data.status, 'approval_pending', 'a price under its own floor waits');
});

/**
 * One costing, one live offer.
 *
 * "Raise quotation" sits on the costing screen and did nothing to say it had already been
 * pressed. Two quotations off one sheet both carry the same model at the same price under
 * different numbers, and the buyer answers one of them: the other stays open for ever on the
 * sent board, counts twice in the §11 conversion figure, and chases a customer who has already
 * decided.
 */
test('a costing that already has a live quotation will not raise a second', async () => {
  const sheet = await costed({ approvedSellingPrice: 9 });

  const first = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: { quantity: 12000 },
  });
  assert.equal(first.status, 201, first.json.message);

  const second = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: { quantity: 12000 },
  });
  assert.equal(second.status, 409, second.json.message);
  assert.match(second.json.message, new RegExp(first.json.data.number));
  assert.match(second.json.message, /revise/i, 'and names the way through');

  /* Once the buyer has answered, the sheet is free again — a repeat order next season is a new
     quotation, not a revision of a closed one. */
  await api(`/api/quotations/${first.json.data._id}/send`, {
    method: 'POST', token: nandhini, body: {},
  });
  const answered = await api(`/api/quotations/${first.json.data._id}/response`, {
    method: 'POST', token: nandhini, body: { accepted: false, note: 'Went elsewhere on price' },
  });
  assert.equal(answered.status, 200, answered.json.message);

  const later = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: { quantity: 12000 },
  });
  assert.equal(later.status, 201, 'a settled quotation no longer holds the sheet');
});

/**
 * Sending is a fact about a day, not a button.
 *
 * `sentAt` is overwritten on every send, and it is what the sent board counts "unanswered for N
 * days" from. Pressing Send twice on the same offer therefore reset the chase clock on a quote
 * the buyer had been sitting on for a fortnight — and fired §42's message at them again with
 * nothing changed in it. A revision is the honest way to send the same job twice, and it is what
 * the refusal names.
 */
test('a quotation already with the customer cannot simply be sent again', async () => {
  const sheet = await costed({ approvedSellingPrice: 9 });
  const quote = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: { quantity: 12000 },
  });

  const sent = await api(`/api/quotations/${quote.json.data._id}/send`, {
    method: 'POST', token: nandhini, body: {},
  });
  assert.equal(sent.status, 200, sent.json.message);
  const firstSentAt = sent.json.data.sentAt;

  const again = await api(`/api/quotations/${quote.json.data._id}/send`, {
    method: 'POST', token: nandhini, body: {},
  });
  assert.equal(again.status, 400);
  assert.match(again.json.message, /already gone to the customer/i);

  const seen = await api(`/api/quotations/${quote.json.data._id}`, { token: nandhini });
  assert.equal(seen.json.data.sentAt, firstSentAt, 'the chase clock is where it was');

  /* Revise it and the door opens again, because the buyer is being told something new. */
  const revised = await api(`/api/quotations/${quote.json.data._id}/revisions`, {
    method: 'POST',
    token: nandhini,
    body: { lines: [{ quantity: 12000, unitPrice: 8.5 }], note: 'Buyer pushed on price' },
  });
  assert.equal(revised.status, 200, revised.json.message);
  const resent = await api(`/api/quotations/${quote.json.data._id}/send`, {
    method: 'POST', token: nandhini, body: {},
  });
  assert.equal(resent.status, 200, resent.json.message);
});

/**
 * A validity date is a promise with a deadline in it. One typed in the past is a quotation that
 * is expired on the screen it was created on: the sent board files it under Expired, the accept
 * action refuses it, and the buyer holds a PDF saying the offer ran out before it was written.
 * Every door that can set the date gets the same check, because marketing reaches the field from
 * three of them.
 */
test('a validity date already gone is refused wherever it is typed', async () => {
  const sheet = await costed({ approvedSellingPrice: 9 });

  const raised = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: { quantity: 12000, validUntil: inDays(-5) },
  });
  assert.equal(raised.status, 400, 'from the costing screen');
  assert.match(raised.json.message, /valid/i);

  const quote = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: { quantity: 12000, validUntil: inDays(30) },
  });
  assert.equal(quote.status, 201, quote.json.message);

  const edited = await api(`/api/quotations/${quote.json.data._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { validUntil: inDays(-1), expectedUpdatedAt: quote.json.data.updatedAt },
  });
  assert.equal(edited.status, 400, 'and from the edit door');

  await api(`/api/quotations/${quote.json.data._id}/send`, {
    method: 'POST', token: nandhini, body: {},
  });
  const revised = await api(`/api/quotations/${quote.json.data._id}/revisions`, {
    method: 'POST',
    token: nandhini,
    body: { lines: [{ quantity: 12000, unitPrice: 8.5 }], validUntil: inDays(-1) },
  });
  assert.equal(revised.status, 400, 'and from the revision door');

  /* Today is not the past: an offer good until close of business is an ordinary thing to write. */
  const today = await api(`/api/quotations/${quote.json.data._id}/revisions`, {
    method: 'POST',
    token: nandhini,
    body: { lines: [{ quantity: 12000, unitPrice: 8.5 }], validUntil: inDays(0) },
  });
  assert.equal(today.status, 200, today.json.message);
});
