/**
 * A costing sheet with lines, each carrying its own floor [BLUEPRINT §7, §9].
 *
 * A conversation with a buyer is about four hangers, not one. Until now a costing priced a
 * single model, so four models meant four sheets, four numbers and four separate journeys
 * through approval for what everyone involved thought of as one job — and the quotation that
 * came out the other end had to be assembled by hand from four of them.
 *
 * The sheet holds the conversation now and each line holds a model. What that changes is not
 * the arithmetic, which is per model either way; it is **what §9 is checking against**. Every
 * figure that decides whether a price may go out — the cost, the floor, the approval — lives on
 * the line, and every reader downstream has to ask for the right one. Reading the sheet instead
 * would check one model's price against another model's floor, and a gate that checks the wrong
 * number does not fail loudly: it says yes.
 *
 * So the cases below are mostly about *which* line was read:
 *
 *   - a price under its own floor is held, and holds nothing else on the sheet
 *   - the quotation takes a line per approved model, each naming the line it was priced from
 *   - §9's send gate reads that line's floor, not the first line's
 *   - §8's wall reaches inside the lines, where the cost base now lives
 *   - the order booked at the end is made of *each model's* registers
 *
 *   node --test tests/pricing-lines.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'pricing-lines-test-secret';

let mongo;
let server;
let baseUrl;
let admin;      // management — may cost, and may see the floor
let nandhini;   // marketing — may quote, and may never see a cost
let priya;      // order confirmation — books the order at the end
let customer;
let nandhiniId;

/* Two tools and two resins, so the two models on a sheet are genuinely different jobs. */
let light;      // a cheap 300mm in PP
let heavy;      // a 450mm in HIPS, several rupees a piece dearer
let pp;
let hips;
let hook;
let clip;
let print;

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

/** A sheet of two models, raised the way the multi-model door is meant to be used. */
const twoModelSheet = async () => {
  const { status, json } = await api('/api/pricings', {
    method: 'POST',
    token: admin,
    body: {
      customer,
      lines: [
        { mould: light, materialRef: pp._id, hookRef: hook._id, modelNumber: 'NH-300' },
        { mould: heavy, materialRef: hips._id, hookRef: hook._id, clipRef: clip._id, printRef: print._id, modelNumber: 'NH-450' },
      ],
    },
  });
  assert.equal(status, 201, json.message);
  return json.data;
};

/** Build one line of a sheet, naming it. */
const cost = (sheet, line, body, token = admin) =>
  api(`/api/pricings/${sheet}/cost`, { method: 'PATCH', token, body: { line, ...body } });

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
    { name: 'Priya Orders', email: 'priya@np.com', password: 'Orders@1234', department: 'order_confirmation' },
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: person });
  }
  nandhini = await signIn('nandhini@np.com', 'Mktg@123456');
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

  pp = (
    await api('/api/materials', {
      method: 'POST', token: admin,
      body: { name: 'PP Natural', code: 'PP-NAT', type: 'pp', colour: 'Natural', ratePerKg: 96 },
    })
  ).json.data;
  hips = (
    await api('/api/materials', {
      method: 'POST', token: admin,
      body: { name: 'HIPS White', code: 'HIPS-W', type: 'hips', colour: 'White', ratePerKg: 118, grammageFactorPercent: 18 },
    })
  ).json.data;

  hook = (
    await api('/api/components', {
      method: 'POST', token: admin,
      body: { kind: 'hook', name: 'Swivel metal hook', code: 'HK-01', ratePerPiece: 1.4 },
    })
  ).json.data;
  clip = (
    await api('/api/components', {
      method: 'POST', token: admin,
      body: { kind: 'clip', name: 'Wooden clip 25mm', code: 'CL-01', ratePerPiece: 0.9 },
    })
  ).json.data;
  print = (
    await api('/api/components', {
      method: 'POST', token: admin,
      body: { kind: 'print', name: '2 colour screen', code: 'PR-02', ratePerPiece: 0.35 },
    })
  ).json.data;

  customer = (
    await api('/api/customers', {
      method: 'POST', token: nandhini,
      body: { assignedTo: nandhiniId, name: 'Sri Kumaran Knits', mobile: '9840011223' },
    })
  ).json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------ A line at a time ------------------------------ */

test('two models on one sheet are costed and priced separately', async () => {
  const sheet = await twoModelSheet();
  assert.equal(sheet.lines.length, 2);

  const [small, big] = sheet.lines;
  const first = await cost(sheet._id, small._id, { markupPercent: 10 });
  assert.equal(first.status, 200, first.json.message);
  const second = await cost(sheet._id, big._id, { markupPercent: 10 });
  assert.equal(second.status, 200, second.json.message);

  const priced = second.json.data.lines;

  /*
   * A 14g PP hanger and a 62g HIPS one do not cost the same, and on one sheet they must not be
   * made to. This is the whole claim of the redesign in one assertion: the figures are per line.
   */
  assert.ok(priced[0].totalCost > 0, 'the small model is costed');
  assert.ok(priced[1].totalCost > priced[0].totalCost * 2, 'and the big one costs a good deal more');
  assert.notEqual(priced[0].minimumSellingPrice, priced[1].minimumSellingPrice);
  assert.notEqual(priced[0].approvedSellingPrice, priced[1].approvedSellingPrice);
});

test('a price under its own floor holds that line and nothing else', async () => {
  const sheet = await twoModelSheet();
  const [small, big] = sheet.lines;

  await cost(sheet._id, small._id, { markupPercent: 10 });
  /* A rupee a piece on a 62g HIPS hanger is well under what it costs to make, let alone its floor. */
  const under = await cost(sheet._id, big._id, { markupPercent: 10, approvedSellingPrice: 1 });
  assert.equal(under.status, 200, under.json.message);

  const lines = under.json.data.lines;
  assert.equal(lines[0].status, 'approved', 'the model that clears its floor is settled');
  assert.equal(lines[1].status, 'approval_pending', 'the one that does not is held');

  /*
   * And the sheet says so. A roll-up that read "approved" because something on it was approved
   * would be the sheet telling marketing the whole conversation is priced.
   */
  assert.equal(under.json.data.status, 'approval_pending');
  assert.equal(under.json.data.linesAwaitingApproval, 1);
});

test('signing one model off leaves the other where it was', async () => {
  const sheet = await twoModelSheet();
  const [small, big] = sheet.lines;

  await cost(sheet._id, small._id, { markupPercent: 10, approvedSellingPrice: 1 });
  await cost(sheet._id, big._id, { markupPercent: 10, approvedSellingPrice: 1 });

  const decided = await api(`/api/pricings/${sheet._id}/decision`, {
    method: 'POST',
    token: admin,
    body: { line: small._id, approve: true },
  });
  assert.equal(decided.status, 200, decided.json.message);

  const lines = decided.json.data.lines;
  assert.equal(lines[0].status, 'approved');
  /*
   * The point of a per-line decision: one signature sanctions one price. A sheet-wide approval
   * would mean somebody signing for a cost they never opened, which is what §9 exists to stop.
   */
  assert.equal(lines[1].status, 'approval_pending', 'the second model still needs its own signature');
});

/* ------------------------------ Into the quotation ------------------------------ */

test('the quotation takes a line per approved model, each naming what priced it', async () => {
  const sheet = await twoModelSheet();
  const [small, big] = sheet.lines;
  await cost(sheet._id, small._id, { markupPercent: 10 });
  await cost(sheet._id, big._id, { markupPercent: 10 });

  const quote = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: {},
  });
  assert.equal(quote.status, 201, quote.json.message);

  const lines = quote.json.data.lines;
  assert.equal(lines.length, 2, 'both models are offered, on one document');
  assert.deepEqual(lines.map((line) => line.modelNumber), ['NH-300', 'NH-450']);

  /* Each line says which costing line it came from — which is what every floor check downstream
     needs in order to read the right one. */
  assert.equal(String(lines[0].pricingLine), String(small._id));
  assert.equal(String(lines[1].pricingLine), String(big._id));

  /* Its own price and its own minimum order, off its own tool. */
  assert.notEqual(lines[0].unitPrice, lines[1].unitPrice);
  assert.equal(lines[0].moq, 5000);
  assert.equal(lines[1].moq, 2000);
});

test('a model still waiting on a signature is not quoted, and the rest are', async () => {
  const sheet = await twoModelSheet();
  const [small, big] = sheet.lines;
  await cost(sheet._id, small._id, { markupPercent: 10 });
  await cost(sheet._id, big._id, { markupPercent: 10, approvedSellingPrice: 1 });

  const quote = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: {},
  });
  assert.equal(quote.status, 201, quote.json.message);

  /*
   * Four models settled and one under discussion should not hold up the four. The held one stays
   * on the sheet and can be added to the same document the day it is signed.
   */
  assert.equal(quote.json.data.lines.length, 1);
  assert.equal(quote.json.data.lines[0].modelNumber, 'NH-300');
});

test('quoting two of three does not stop the third going out later', async () => {
  const sheet = await twoModelSheet();
  const [small, big] = sheet.lines;
  await cost(sheet._id, small._id, { markupPercent: 10 });
  /* The second is held, so the first is quoted on its own. */
  await cost(sheet._id, big._id, { markupPercent: 10, approvedSellingPrice: 1 });

  const first = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: {},
  });
  assert.equal(first.status, 201, first.json.message);
  assert.equal(first.json.data.lines.length, 1);

  /* Management signs the second off a week later. */
  const decided = await api(`/api/pricings/${sheet._id}/decision`, {
    method: 'POST', token: admin, body: { line: big._id, approve: true },
  });
  assert.equal(decided.status, 200, decided.json.message);

  /*
   * **The refusal this replaces.** One live quotation per *sheet* meant the model just approved
   * could not be offered at all: the sheet was "already quoted", and the way round it was to
   * raise a second costing for a model this one had already priced. The block belongs to the
   * model, so the one that has not been out goes out.
   */
  const second = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: {},
  });
  assert.equal(second.status, 201, second.json.message);
  assert.equal(second.json.data.lines.length, 1);
  assert.equal(second.json.data.lines[0].modelNumber, 'NH-450');
  assert.notEqual(second.json.data.number, first.json.data.number);

  /* And a third press has nothing left to offer, which is still refused by name. */
  const again = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: {},
  });
  assert.equal(again.status, 409);
  assert.match(again.json.message, /already quoted on/i);
});

/* ----------------------------- §9 at the send gate ----------------------------- */

test('a line is checked against its own floor, not the first line’s', async () => {
  const sheet = await twoModelSheet();
  const [small, big] = sheet.lines;
  const cheap = await cost(sheet._id, small._id, { markupPercent: 10 });
  const dear = await cost(sheet._id, big._id, { markupPercent: 10 });

  const cheapFloor = cheap.json.data.lines[0].minimumSellingPrice;
  const dearFloor = dear.json.data.lines[1].minimumSellingPrice;
  assert.ok(dearFloor > cheapFloor, 'the two floors are genuinely different');

  /*
   * **The case a sheet-level check waves through.** A price for the 450mm set between the two
   * floors clears the *first* line's minimum comfortably and is under its own. Reading the sheet
   * rather than the line would find nothing to object to and send it — the gate saying yes to a
   * price nobody approved, which is worse than no gate at all because the record shows a check.
   *
   * Written by hand rather than raised off the sheet, because that is where a price like this
   * comes from: somebody typing what they agreed on the phone. The line names the costing line
   * it belongs to, which is the whole of what the gate needs to read the right floor.
   */
  const between = (cheapFloor + dearFloor) / 2;
  const quote = await api('/api/quotations', {
    method: 'POST',
    token: nandhini,
    body: {
      customer,
      lines: [
        { pricing: sheet._id, pricingLine: small._id, modelNumber: 'NH-300', unitPrice: cheapFloor, moq: 5000 },
        { pricing: sheet._id, pricingLine: big._id, modelNumber: 'NH-450', unitPrice: between, moq: 2000 },
      ],
    },
  });
  assert.equal(quote.status, 201, quote.json.message);

  const sent = await api(`/api/quotations/${quote.json.data._id}/send`, {
    method: 'POST', token: nandhini, body: {},
  });
  assert.equal(sent.status, 400, 'it is under the 450mm’s own minimum');
  assert.match(sent.json.message, /NH-450/);
  /* §8: the refusal says which model, never what the number it failed against is. */
  assert.ok(!sent.json.message.includes(String(dearFloor)), 'and never names the floor itself');
});

/* --------------------------------- §8, inside --------------------------------- */

test('marketing sees the price on a line and never the cost behind it', async () => {
  const sheet = await twoModelSheet();
  const [small, big] = sheet.lines;
  await cost(sheet._id, small._id, { markupPercent: 10 });
  await cost(sheet._id, big._id, { markupPercent: 10 });

  const read = await api(`/api/pricings/${sheet._id}`, { token: nandhini });
  assert.equal(read.status, 200, read.json.message);

  for (const line of read.json.data.lines) {
    assert.ok(line.approvedSellingPrice > 0, 'the price they may quote is theirs to see');
    /* The cost base moved onto the line, and so must the wall — §8 lists these by name. */
    for (const hidden of [
      'cost', 'totalCost', 'materialCost', 'minimumSellingPrice', 'minimumOverride',
      'grossMarginPercent', 'effectiveMarkupPercent', 'markupPercent', 'tiers',
    ]) {
      assert.equal(line[hidden], undefined, `${hidden} is not marketing's to see`);
    }
    /* Whether, not where: they are told a price sits under its floor without learning the floor. */
    assert.equal(typeof line.belowMinimum, 'boolean');
  }
});

/* ------------------------------ Down to the order ------------------------------ */

test('an order booked from the quote is made of each model’s own registers', async () => {
  const sheet = await twoModelSheet();
  const [small, big] = sheet.lines;
  await cost(sheet._id, small._id, { markupPercent: 10 });
  await cost(sheet._id, big._id, { markupPercent: 10 });

  const quote = await api(`/api/pricings/${sheet._id}/quotation`, {
    method: 'POST', token: nandhini, body: {},
  });
  const document = quote.json.data;

  await api(`/api/quotations/${document._id}/send`, { method: 'POST', token: nandhini, body: {} });
  await api(`/api/quotations/${document._id}/response`, {
    method: 'POST', token: nandhini, body: { accepted: true },
  });

  const order = await api(`/api/quotations/${document._id}/order`, {
    method: 'POST',
    token: priya,
    body: {
      customerPo: { number: 'PO-LINES-1' },
      lines: document.lines.map((line) => ({ quotationLine: line._id, quantity: 10000 })),
    },
  });
  assert.equal(order.status, 201, order.json.message);

  const [made300, made450] = order.json.data.lines;

  /*
   * Nothing retyped, and the right line read. Both models were costed on the same sheet, so a
   * reader that took the sheet's first line would put PP Natural and no clip on the 450mm — an
   * order that disagrees with the price it was booked at, discovered at the press.
   */
  assert.equal(made300.materialRef.name, 'PP Natural');
  assert.equal(made300.clipRef, undefined);
  assert.equal(made450.materialRef.name, 'HIPS White');
  assert.equal(made450.clipRef.name, 'Wooden clip 25mm');
  assert.equal(made450.printRef.name, '2 colour screen');
});
