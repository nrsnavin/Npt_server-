/**
 * The costing on a quotation's lines [BLUEPRINT §7, §8, §9; models/Quotation.js].
 *
 * The costing sheet and the quotation are one record now: the Quotation department costs each
 * line, and the price on the line is what the buyer is offered. Two rules carry it, and both
 * fail silently:
 *
 *   §8 — marketing sees the price and never the cost behind it.
 *   §9 — a price under its line's minimum waits on Admin before it can go out.
 *
 *   node --test tests/quotation-costing.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { raiseEnquiryFor, withEnquiries } from './support/onEnquiry.js';

import { CONFIDENTIAL, PUBLIC_FIGURES, seesCosting } from '../src/services/pricingVisibility.js';
import { minimumFor, priceAt, priceFrom, tiersFor } from '../src/services/pricing.service.js';

process.env.JWT_SECRET = 'quotation-costing-test-secret';

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

let mongo;
let server;
let baseUrl;
let admin;      // management — costs, signs off, sees everything
let kumar;      // the Quotation department — costs and may send
let nandhini;   // marketing — prices and sends, never sees a cost
let priya;      // order confirmation — books the order at the end
let customer;
let nandhiniId;
let light;      // a 300mm tool, PP
let heavy;      // a 450mm tool, HIPS
let pp;
let hips;
let hook;
let clip;
let print;

const rawApi = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const api = withEnquiries(rawApi);

const signIn = async (email, password) =>
  (await api('/api/auth/login', { method: 'POST', body: { email, password } })).json.data?.token;

/** A quotation waiting for costing, with the lines given. */
const toCost = async (lines = [{ modelNumber: 'NH-400' }], token = nandhini) => {
  const { status, json } = await api('/api/quotations', {
    method: 'POST', token, body: { customer, validUntil: inDays(30), lines },
  });
  assert.equal(status, 201, json.message);
  return json.data;
};

const cost = (id, lineId, body, token = admin) =>
  api(`/api/quotations/${id}/lines/${lineId}/cost`, { method: 'PATCH', token, body });

const send = (id, token = nandhini) => api(`/api/quotations/${id}/send`, { method: 'POST', token, body: {} });

const decide = (id, lineId, body, token = admin) =>
  api(`/api/quotations/${id}/lines/${lineId}/decision`, { method: 'POST', token, body });

/* 22 g at ₹95/kg = ₹2.09, plus ₹1.10 job work and ₹0.40 packing = ₹3.59 a piece. */
const COST = { gramWeight: 22, rawMaterialRate: 95, jobWorkCost: 1.1, packingCost: 0.4 };

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

  for (const person of [
    { name: 'Nandhini S', email: 'nandhini@np.com', password: 'Mktg@123456', department: 'marketing' },
    { name: 'Kumar Q', email: 'kumar@np.com', password: 'Quote@12345', department: 'quotation' },
    { name: 'Priya Orders', email: 'priya@np.com', password: 'Orders@1234', department: 'order_confirmation' },
  ]) {
    const made = await api('/api/users', { method: 'POST', token: admin, body: person });
    assert.equal(made.status, 201, made.json.message);
  }
  nandhini = await signIn('nandhini@np.com', 'Mktg@123456');
  kumar = await signIn('kumar@np.com', 'Quote@12345');
  priya = await signIn('priya@np.com', 'Orders@1234');
  nandhiniId = (await api('/api/auth/me', { token: nandhini })).json.data.id;

  const mould = async (body) => {
    const { status, json } = await api('/api/moulds', { method: 'POST', token: admin, body });
    assert.equal(status, 201, json.message);
    return json.data._id;
  };
  light = await mould({
    mouldCode: 'M-300', name: 'Top hanger 300mm', category: 'shirt', sizeMm: 300,
    material: 'pp', cavities: 8, partWeightGrams: 14, cycleTimeSeconds: 24, moq: 5000,
  });
  heavy = await mould({
    mouldCode: 'M-450', name: 'Suit hanger 450mm', category: 'suit', sizeMm: 450,
    material: 'hips', cavities: 2, partWeightGrams: 62, cycleTimeSeconds: 42, moq: 2000,
  });

  const made = async (path, body) => (await api(path, { method: 'POST', token: admin, body })).json.data;
  pp = await made('/api/materials', { name: 'PP Natural', code: 'PP-NAT', type: 'pp', colour: 'Natural', ratePerKg: 96 });
  hips = await made('/api/materials', { name: 'HIPS White', code: 'HIPS-W', type: 'hips', colour: 'White', ratePerKg: 118, grammageFactorPercent: 18 });
  hook = await made('/api/components', { kind: 'hook', name: 'Swivel metal hook', code: 'HK-01', ratePerPiece: 1.4 });
  clip = await made('/api/components', { kind: 'clip', name: 'Wooden clip 25mm', code: 'CL-01', ratePerPiece: 0.9 });
  print = await made('/api/components', { kind: 'print', name: '2 colour screen', code: 'PR-02', ratePerPiece: 0.35 });

  customer = (await api('/api/customers', {
    method: 'POST', token: nandhini, body: { assignedTo: nandhiniId, name: 'Sri Kumaran Knits', mobile: '9840011223' },
  })).json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------- The arithmetic ------------------------------- */

test('the selling price is cost plus a markup, the way the sheet works it', () => {
  /* Verified against the plant's own 26-27 sheet: every row is `cost × (1 + pct)`. */
  assert.equal(priceFrom({ totalCost: 10, markupPercent: 20 }), 12);
  assert.equal(priceFrom({ totalCost: 10, markupPercent: 0 }), 10);
  assert.equal(priceFrom({ totalCost: 6.95, markupPercent: 10 }), 7.65, "the sheet's first row");
  assert.equal(priceFrom({ totalCost: 0, markupPercent: 20 }), undefined, 'no cost, no price');
  assert.deepEqual(tiersFor(6.95), { 10: 7.65, 15: 8, 20: 8.35 });
  assert.equal(minimumFor({ totalCost: 6.95 }), 7.65, 'the minimum is the 10% tier');
  assert.equal(minimumFor({ totalCost: 6.95, minimumOverride: 5 }), 5, 'unless this job has its own');
});

test('a price is rounded up to five paise, never down', () => {
  assert.equal(priceAt(6.95, 15), 8, '7.9925 rounds up, not to 7.99');
  assert.equal(priceAt(6.95, 10), 7.65, 'already on a five-paise step');
  for (const base of [3.59, 6.95, 7.01, 11.113]) {
    for (const percent of [10, 15, 20]) {
      assert.ok(priceAt(base, percent) >= Math.round(base * (1 + percent / 100) * 100) / 100);
    }
  }
});

test('a line adds up, and the calculated price cannot be typed', async () => {
  const made = await toCost();
  const built = await cost(made._id, made.lines[0]._id, { cost: COST, markupPercent: 20 });
  assert.equal(built.status, 200, built.json.message);
  const line = built.json.data.lines[0];

  assert.equal(line.materialCost, 2.09);
  assert.equal(Math.round(line.totalCost * 100) / 100, 3.59);
  assert.deepEqual(line.tiers, { 10: 3.95, 15: 4.15, 20: 4.35 });
  assert.equal(line.calculatedSellingPrice, 4.35, 'the 20% tier, to the paisa');
  assert.equal(line.unitPrice, 4.35, 'and the price on the line defaults to it');

  const typed = await cost(made._id, made.lines[0]._id, { calculatedSellingPrice: 99 });
  assert.equal(typed.status, 400, 'a figure that can be posted is one that can disagree with its inputs');
});

test('a typed price is kept exactly where it was typed, and the margin is on it', async () => {
  const made = await toCost();
  const built = await cost(made._id, made.lines[0]._id, { cost: COST, markupPercent: 20, minimumOverride: 4, unitPrice: 5 });
  const line = built.json.data.lines[0];
  assert.equal(line.unitPrice, 5);
  assert.equal(line.grossMarginPercent, 28.2, '(5 − 3.59) / 5');
});

/* ----------------------------- §8: who sees what ----------------------------- */

test('every money field on the quotation has been ruled on', async () => {
  /*
   * The guard that keeps §8 true as the model grows: a cost figure added later without deciding
   * who may see it would be visible by default. So this walks the model's own paths and fails on
   * anything numeric that is in neither list.
   */
  const { default: Quotation } = await import('../src/models/Quotation.js');
  const lineSchema = Quotation.schema.path('lines').schema;
  const numbersIn = (schema) =>
    Object.entries(schema.paths)
      .filter(([name, path]) => path.instance === 'Number' && name !== '__v')
      .map(([name]) => name);
  /* Facts about what happens next, or about the document, rather than figures of cost. */
  const NOT_FIGURES = ['id', 'belowMinimum', 'needsApproval', 'linesAwaitingApproval', 'isExpired', 'soleLine',
    'lineCount', 'revision', 'gstPercent', 'netValue', 'totalValue', 'lineValue'];
  const virtualsOf = (schema) => Object.keys(schema.virtuals).filter((name) => !NOT_FIGURES.includes(name));
  const ruled = (name) => {
    const root = name.split('.')[0];
    return CONFIDENTIAL.includes(root) || PUBLIC_FIGURES.includes(root) || NOT_FIGURES.includes(root);
  };
  const undecided = [
    ...numbersIn(Quotation.schema), ...numbersIn(lineSchema),
    ...virtualsOf(Quotation.schema), ...virtualsOf(lineSchema),
  ].filter((name) => !ruled(name));
  assert.deepEqual([...new Set(undecided)], [], `these have no §8 ruling: ${undecided.join(', ')}`);
});

test('marketing never sees the cost, on the record or the list; costing sees all of it', async () => {
  const made = await toCost();
  await cost(made._id, made.lines[0]._id, { cost: COST, markupPercent: 20, minimumOverride: 8, unitPrice: 9 });

  const theirs = await api(`/api/quotations/${made._id}`, { token: nandhini });
  const list = await api('/api/quotations?limit=200', { token: nandhini });
  for (const line of [theirs.json.data.lines[0], ...list.json.data.flatMap((row) => row.lines)]) {
    for (const field of CONFIDENTIAL) assert.equal(line[field], undefined, `${field} reached marketing`);
  }
  assert.equal(theirs.json.data.lines[0].unitPrice, 9, 'the price is theirs');
  assert.equal(theirs.json.data.costingHidden, true, 'and the screen is told why it is thin');

  const costing = await api(`/api/quotations/${made._id}`, { token: kumar });
  assert.equal(costing.json.data.lines[0].cost.rawMaterialRate, 95);
  assert.equal(costing.json.data.lines[0].minimumSellingPrice, 8);
  assert.equal(costing.json.data.costingHidden, undefined);
});

test('the register rates do not reach marketing through the populated resin and parts', async () => {
  const made = await toCost([{ mould: light, materialRef: pp._id, hookRef: hook._id, modelNumber: 'NH-300' }]);
  const theirs = await api(`/api/quotations/${made._id}`, { token: nandhini });
  const line = theirs.json.data.lines[0];
  assert.equal(line.materialRef.name, 'PP Natural', 'they see which resin');
  assert.equal(line.materialRef.ratePerKg, undefined, 'and not what it costs');
  assert.equal(line.hookRef.ratePerPiece, undefined);
});

test('quoting is not costing: marketing may price and send, never cost', async () => {
  const me = await api('/api/auth/me', { token: nandhini });
  const pricing = me.json.data.modules.find((module) => module.key === 'pricing');
  assert.equal(pricing.level, 'quote');
  assert.equal(pricing.canWrite, false, 'quoting must not imply seeing the cost');

  const made = await toCost();
  const built = await cost(made._id, made.lines[0]._id, { cost: COST }, nandhini);
  assert.equal(built.status, 403);
  assert.match(built.json.message, /costing or management/i);
});

test('a grant for the retired quotations module still lets its holder quote', async () => {
  const { normaliseGrants, accessLevel } = await import('../src/services/access.service.js');
  const legacy = { isActive: true, moduleAccess: [{ module: 'quotations', level: 'write' }] };
  assert.equal(accessLevel(legacy, 'pricing'), 'quote');
  assert.equal(seesCosting(legacy), false, 'the old grant must not become a costing grant');
  assert.deepEqual(normaliseGrants([{ module: 'dispatch', level: 'quote' }]), [], 'quote is pricing’s level only');
});

/* ------------------------- Either department sends it ------------------------- */

test('the Quotation department costs it and may send it too', async () => {
  const made = await toCost();
  const built = await cost(made._id, made.lines[0]._id, { cost: COST, markupPercent: 20 }, kumar);
  assert.equal(built.status, 200, built.json.message);
  assert.equal(built.json.data.costedBy.name, 'Kumar Q');

  const queue = await api('/api/quotations?costing=true&limit=200', { token: kumar });
  assert.ok(!queue.json.data.some((row) => String(row._id) === String(made._id)), 'off the costing queue once priced');

  const sent = await send(made._id, kumar);
  assert.equal(sent.status, 200, sent.json.message);
  assert.equal(sent.json.data.status, 'sent');
});

test('Admin signs off below the minimum; the Quotation department cannot', async () => {
  const made = await toCost();
  await cost(made._id, made.lines[0]._id, { cost: COST, minimumOverride: 8, unitPrice: 6 }, kumar);
  assert.equal((await decide(made._id, made.lines[0]._id, { approve: true }, kumar)).status, 403);
  const signed = await decide(made._id, made.lines[0]._id, { approve: true });
  assert.equal(signed.status, 200, signed.json.message);
  assert.equal(signed.json.data.lines[0].approvedBy.name, 'Navin R');
});

/* ------------------------------- On an enquiry ------------------------------- */

test('an enquiry reaching pricing raises its quotation, a line per model, waiting for costing', async () => {
  const enquiry = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer, mould: light, requirement: { modelNumber: 'NH-300' }, targetPrice: 7.2,
      nextAction: 'Call the buyer', nextFollowUpDate: inDays(3),
    },
  });
  const id = enquiry.json.data._id;
  const acted = await api(`/api/enquiries/${id}/actions`, { method: 'POST', token: nandhini, body: { action: 'request_pricing' } });
  assert.equal(acted.status, 200, acted.json.message);

  let rows = [];
  for (let i = 0; i < 100 && !rows.length; i += 1) {
    rows = (await api(`/api/quotations?enquiry=${id}`, { token: admin })).json.data;
    if (!rows.length) await new Promise((resolve) => setTimeout(resolve, 60));
  }
  assert.equal(rows.length, 1, 'exactly one');
  const [quotation] = rows;
  assert.equal(quotation.status, 'costing');
  assert.equal(quotation.targetPrice, 7.2, 'with what the buyer wants to pay');
  assert.equal(quotation.lines[0].modelNumber, 'NH-300');
  assert.equal(quotation.lines[0].moq, 5000, 'the minimum order from the mould register');
  assert.ok(quotation.lines[0].cost.gramWeight > 0, 'and the grams off the tool, ready to cost');
});

test('a quotation is raised on an enquiry, for that enquiry’s buyer', async () => {
  const alone = await rawApi('/api/quotations', { method: 'POST', token: admin, body: { customer, lines: [{ modelNumber: 'NH-400' }] } });
  assert.equal(alone.status, 400);
  assert.match(alone.json.message, /raise the quotation from there/i);

  const enquiry = await raiseEnquiryFor({ customer });
  const made = await rawApi('/api/quotations', {
    method: 'POST', token: admin, body: { enquiry: String(enquiry._id), lines: [{ modelNumber: 'NH-400' }] },
  });
  assert.equal(made.status, 201, made.json.message);
  assert.equal(String(made.json.data.customer?._id || made.json.data.customer), String(customer));

  /* An enquiry that names no model gets a line called by the enquiry, rather than refusing. */
  const unnamed = await rawApi('/api/quotations', { method: 'POST', token: admin, body: { enquiry: String(enquiry._id) } });
  assert.equal(unnamed.status, 201, unnamed.json.message);
  assert.equal(unnamed.json.data.lines[0].modelNumber, `As per ${enquiry.number}`);
});

test('every line names a mould or a model — a blank row takes the enquiry’s model at its place, and only that', async () => {
  /* The fixture enquiry asks about one model, so the first blank row is it and the second is nothing. */
  const attempt = await api('/api/quotations', { method: 'POST', token: nandhini, body: { customer, lines: [{ moq: 100 }, { moq: 100 }] } });
  assert.equal(attempt.status, 400);
  assert.match(attempt.json.message, /Name the model on every line/);
});

/* -------------------------------- The minimum -------------------------------- */

test('a minimum under what the piece costs is refused, and says where the price goes instead', async () => {
  const made = await toCost();
  const refused = await cost(made._id, made.lines[0]._id, { cost: COST, minimumOverride: 1 });
  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /below what the piece costs to make/);
  assert.match(refused.json.message, /Admin/);
});

test('the minimum order comes from the master, and a figure on the line beats it', async () => {
  const fromMaster = await toCost([{ mould: light }]);
  assert.equal(fromMaster.lines[0].moq, 5000);
  assert.equal(fromMaster.lines[0].modelNumber, 'M-300', 'named by its tool');
  const own = await toCost([{ mould: light, moq: 12000 }]);
  assert.equal(own.lines[0].moq, 12000);
});

/* ------------------------------ Several models ------------------------------ */

const twoModels = () => toCost([
  { mould: light, materialRef: pp._id, hookRef: hook._id, modelNumber: 'NH-300' },
  { mould: heavy, materialRef: hips._id, hookRef: hook._id, clipRef: clip._id, printRef: print._id, modelNumber: 'NH-450' },
]);

test('two models on one quotation are costed off their own registers', async () => {
  const made = await twoModels();
  const [small, big] = made.lines;
  const costed = await api(`/api/quotations/${made._id}`, { token: admin });
  const [a, b] = costed.json.data.lines;

  assert.equal(a.cost.rawMaterialRate, 96, 'PP for the 300');
  assert.equal(b.cost.rawMaterialRate, 118, 'HIPS for the 450');
  assert.equal(b.cost.metalClipsCost, 0.9, 'and the clip only where it was named');
  assert.equal(a.cost.metalClipsCost, 0);
  assert.ok(String(small._id) !== String(big._id));
});

test('signing one model off leaves the other where it was', async () => {
  const made = await twoModels();
  const [small, big] = made.lines;
  await cost(made._id, small._id, { markupPercent: 10, minimumOverride: 9, unitPrice: 2 });
  const second = await cost(made._id, big._id, { markupPercent: 10, minimumOverride: 20, unitPrice: 15 });
  assert.deepEqual(second.json.data.lines.map((line) => line.status), ['approval_pending', 'approval_pending']);

  const signed = await decide(made._id, small._id, { approve: true });
  assert.deepEqual(signed.json.data.lines.map((line) => line.status), ['approved', 'approval_pending']);
  assert.equal(signed.json.data.status, 'approval_pending', 'the document still waits on the other');
});

test('re-costing a model keeps its resin, hook, clips, print and packing', async () => {
  const made = await toCost([{ modelNumber: 'NH-RC' }]);
  const line = made.lines[0]._id;

  const costed = await cost(made._id, line, {
    mould: light, materialRef: hips._id, hookRef: hook._id, clipRef: clip._id, printRef: print._id,
    cost: { packingCost: 0.35 },
  });
  assert.equal(costed.status, 200, costed.json.message);
  const saved = costed.json.data.lines[0];
  assert.equal(saved.materialRef?.name, 'HIPS White');
  assert.equal(saved.cost.hookCost, 1.4);
  assert.equal(saved.cost.metalClipsCost, 0.9);
  assert.equal(saved.cost.printingCost, 0.35);
  assert.equal(saved.cost.packingCost, 0.35, 'the typed packing kept');
  assert.equal(saved.material, 'hips', 'the line records the resin it was costed in');

  const again = await cost(made._id, line, { expectedUpdatedAt: costed.json.data.updatedAt, markupPercent: 15 });
  assert.equal(again.status, 200, again.json.message);
  assert.equal(again.json.data.lines[0].hookRef?.name, 'Swivel metal hook');
  assert.equal(again.json.data.lines[0].cost.packingCost, 0.35);

  const cleared = await cost(made._id, line, { expectedUpdatedAt: again.json.data.updatedAt, clipRef: null });
  assert.equal(cleared.json.data.lines[0].clipRef, undefined);
  assert.equal(cleared.json.data.lines[0].hookRef?.name, 'Swivel metal hook');
});

test('an order booked from the quote is made of each model’s own registers', async () => {
  const made = await twoModels();
  for (const line of made.lines) await cost(made._id, line._id, { markupPercent: 10 });
  assert.equal((await send(made._id)).status, 200);
  await api(`/api/quotations/${made._id}/response`, { method: 'POST', token: nandhini, body: { accepted: true } });

  const order = await api(`/api/quotations/${made._id}/order`, {
    method: 'POST',
    token: priya,
    body: { customerPo: { number: 'PO-LINES-1' }, lines: made.lines.map((line) => ({ quotationLine: line._id, quantity: 10000 })) },
  });
  assert.equal(order.status, 201, order.json.message);
  const [made300, made450] = order.json.data.lines;
  assert.equal(made300.materialRef.name, 'PP Natural');
  assert.equal(made300.clipRef, undefined);
  assert.equal(made450.materialRef.name, 'HIPS White');
  assert.equal(made450.clipRef.name, 'Wooden clip 25mm');
  assert.equal(String(made450.quotationLine), String(made.lines[1]._id), 'and remembers the line it was priced on');
});

/* ------------------------------- After sending ------------------------------- */

test('a re-cost after sending leaves the price the buyer has; a new price is a revision', async () => {
  const made = await toCost();
  await cost(made._id, made.lines[0]._id, { cost: COST, markupPercent: 20 });
  assert.equal((await send(made._id)).status, 200);

  const recost = await cost(made._id, made.lines[0]._id, { cost: { rawMaterialRate: 120 } });
  assert.equal(recost.status, 200, recost.json.message);
  assert.equal(recost.json.data.lines[0].unitPrice, 4.35, 'the buyer’s price did not move');
  assert.equal(recost.json.data.status, 'sent');

  const repriced = await cost(made._id, made.lines[0]._id, { unitPrice: 5 });
  assert.equal(repriced.status, 400);
  assert.match(repriced.json.message, /revision/);
});

/* ------------------------------- The document ------------------------------- */

/** The words a PDF prints: its deflated content streams, with the hex text runs decoded. */
const printedText = async (bytes) => {
  const { inflateSync } = await import('node:zlib');
  const raw = bytes.toString('latin1');
  const streams = [];
  for (const match of raw.matchAll(/stream\r?\n/g)) {
    const from = match.index + match[0].length;
    const to = raw.indexOf('endstream', from);
    if (to < 0) continue;
    try {
      streams.push(inflateSync(Buffer.from(raw.slice(from, to), 'latin1')).toString('latin1'));
    } catch { /* An image. */ }
  }
  const fromHex = (hex) => Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex').toString('latin1');
  return streams
    .join('\n')
    .replace(/\[((?:\s*<[0-9a-fA-F]*>|\s*-?\d+(?:\.\d+)?)*)\]\s*TJ/g, (whole, inner) =>
      ` ${(inner.match(/<([0-9a-fA-F]*)>/g) || []).map((run) => fromHex(run.slice(1, -1))).join('')} `)
    .replace(/\s+/g, ' ');
};

const pdfOf = async (id) => {
  const response = await fetch(`${baseUrl}/api/quotations/${id}/pdf`, { headers: { Authorization: `Bearer ${nandhini}` } });
  assert.equal(response.status, 200);
  return Buffer.from(await response.arrayBuffer());
};

test('the document names the material each model was costed in, not the tool’s', async () => {
  const made = await toCost([
    { mould: light, materialRef: pp._id, modelNumber: 'NH-300' },
    { mould: heavy, materialRef: hips._id, modelNumber: 'NH-450' },
  ]);
  /* Each tool costed in the *other* resin, so the tool's own would be wrong on both. */
  await cost(made._id, made.lines[0]._id, { materialRef: hips._id, markupPercent: 10 });
  await cost(made._id, made.lines[1]._id, { materialRef: pp._id, markupPercent: 10 });

  const printed = await printedText(await pdfOf(made._id));
  const rowOf = (model) => {
    const from = printed.indexOf(model);
    const next = printed.indexOf('NH-', from + model.length);
    return printed.slice(from, next > from ? next : from + 400);
  };
  assert.match(rowOf('NH-300'), /HIPS WHITE/);
  assert.match(rowOf('NH-450'), /PP NATURAL/);
});

test('the document names no cost, margin or minimum [§8]', async () => {
  const made = await toCost();
  await cost(made._id, made.lines[0]._id, { cost: COST, minimumOverride: 8, unitPrice: 9 });
  const bytes = await pdfOf(made._id);
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  const text = `${bytes.toString('latin1')} ${await printedText(bytes)}`;
  for (const forbidden of ['Gross margin', 'Minimum', 'Cost base', 'Material cost']) {
    assert.ok(!text.includes(forbidden), `the PDF must not mention ${forbidden}`);
  }
});

/* --------------------------------- The list --------------------------------- */

test('the list cannot be ordered by a figure that is not a column', async () => {
  const refused = await api('/api/quotations?sort=totalCost', { token: admin });
  assert.equal(refused.status, 400);
});
