/**
 * The mould register [BLUEPRINT §28].
 *
 * The register exists to answer one question the product master could not: what a piece
 * *consumes*, as against what it weighs. Every shot throws a runner alongside the parts, and
 * the pieces that came out with it have to carry its cost. Costing on the part weight
 * understates the resin on every quotation off that tool, always in the same direction, and
 * nothing about the sheet looks wrong — the arithmetic below the figure is perfectly correct.
 *
 * So the tests here are mostly about arithmetic that has one right answer and several plausible
 * wrong ones: dividing the runner over the cut cavities rather than the running ones, forgetting
 * the runner in the shot weight, treating regrind as free resin.
 *
 *   node --test tests/mould.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'mould-test-secret-value';

let mongo;
let server;
let baseUrl;
let admin;      // management — sees costing, so sees machine rates
let ramesh;     // production — owns the register
let nandhini;   // marketing — reads it, and must not see money
let product;
let second;
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

/** A four-cavity tool on a 30 g part with a 12 g runner — the worked example in the model. */
const FOUR_UP = {
  name: '400mm shirt hanger',
  cavities: 4,
  partWeightGrams: 30,
  runnerWeightGrams: 12,
  cycleTimeSeconds: 30,
};

let codeSeq = 0;
const addMould = async (body = {}, token = admin) =>
  api('/api/moulds', {
    method: 'POST',
    token,
    body: { mouldCode: `M-T${++codeSeq}`, ...FOUR_UP, ...body },
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

  for (const person of [
    { name: 'Ramesh Plant', email: 'ramesh@np.com', password: 'Prod@123456', department: 'production' },
    { name: 'Nandhini S', email: 'nandhini@np.com', password: 'Passw0rd@123', department: 'marketing' },
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: person });
  }
  ramesh = await signIn('ramesh@np.com', 'Prod@123456');
  nandhini = await signIn('nandhini@np.com', 'Passw0rd@123');

  const madeProduct = await api('/api/products', {
    method: 'POST',
    token: admin,
    body: { modelCode: 'NH-400', name: 'Shirt hanger 400mm', category: 'shirt', material: 'pp', sizeMm: 400, standardWeightGrams: 30 },
  });
  product = madeProduct.json.data._id;

  const madeSecond = await api('/api/products', {
    method: 'POST',
    token: admin,
    body: { modelCode: 'NH-400R', name: 'Shirt hanger 400mm recycled', category: 'shirt', material: 'recycled_pp', sizeMm: 400, standardWeightGrams: 30 },
  });
  second = madeSecond.json.data._id;

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

/* ------------------------------- The arithmetic ------------------------------- */

test('a piece consumes its own weight plus its share of the runner', async () => {
  const { status, json } = await addMould();
  assert.equal(status, 201, json.message);

  const mould = json.data;
  assert.equal(mould.shotWeightGrams, 132, '4 x 30 g of parts, plus the 12 g runner');
  assert.equal(mould.runnerPerPieceGrams, 3, 'the runner over the four pieces that carried it');
  assert.equal(mould.consumptionPerPieceGrams, 33, '30 g of hanger, 33 g of resin');

  /*
   * The gap is the whole point of the register, and it is a tenth of the resin. Stated as its
   * own assertion so a change that quietly reverts consumption to the part weight fails on a
   * line that says why it matters, rather than on an arithmetic identity.
   */
  assert.equal(
    Math.round(((mould.consumptionPerPieceGrams - mould.partWeightGrams) / mould.partWeightGrams) * 100),
    10,
    'costing on the part weight would understate the resin by 10%'
  );
});

test('a blocked cavity cuts the output and raises what each piece consumes', async () => {
  const { json } = await addMould({ activeCavities: 3 });
  const mould = json.data;

  assert.equal(mould.runningCavities, 3);
  assert.equal(mould.shotWeightGrams, 102, 'three parts and the whole runner, which is unchanged');
  assert.equal(mould.consumptionPerPieceGrams, 34, 'the runner now divides over three, not four');

  /*
   * Both directions at once, which is the pair a cut-cavity count gets wrong. Dividing the
   * runner over four while making three is the plausible bug: it reports 33 g and 480 pieces an
   * hour on a tool doing 34 g and 360 — flattering on both counts.
   */
  assert.equal(mould.piecesPerHour, 360, '120 shots an hour, three up');
});

test('regrind comes off the runner, not off the part', async () => {
  const { json } = await addMould({ regrindRecoveryPercent: 50 });
  const mould = json.data;

  assert.equal(mould.consumptionPerPieceGrams, 31.5, '30 g of part, plus half of the 3 g runner');
  assert.equal(mould.partWeightGrams, 30, 'the part itself is not reground');
  assert.ok(
    mould.consumptionPerPieceGrams >= mould.partWeightGrams,
    'no recovery rate can make a piece consume less than it weighs'
  );

  const perfect = await addMould({ regrindRecoveryPercent: 100 });
  assert.equal(perfect.json.data.consumptionPerPieceGrams, 30, 'a fully recovered runner is free resin');
});

test('output and machine cost follow the cycle, the cavities and what the tool really achieves', async () => {
  const { json } = await addMould({
    cycleTimeSeconds: 30,
    efficiencyPercent: 90,
    machine: { code: 'INJ-02', tonnage: 200, hourRate: 450 },
  });
  const mould = json.data;

  assert.equal(mould.shotsPerHour, 108, '120 shots at 90%');
  assert.equal(mould.piecesPerHour, 432);
  assert.equal(mould.machineHoursPer1000, 2.31);
  assert.equal(mould.machineCostPerPiece, 1.042, '450 an hour over 432 pieces');
});

test('a mould with no machine rate has no cost per piece, rather than a free one', async () => {
  const { json } = await addMould();
  assert.equal(json.data.machineCostPerPiece, null, 'zero would flow into a costing as a fact');
});

/* -------------------------------- The register -------------------------------- */

test('a mould cannot run more cavities than it has', async () => {
  const rejected = await addMould({ cavities: 4, activeCavities: 6 });
  assert.equal(rejected.status, 400);

  /*
   * And again on the patch door, where the two numbers arrive one at a time. This is the
   * request that slips past a check written over the payload instead of the merged record: the
   * cavity count is not in it at all.
   */
  const { json } = await addMould({ cavities: 4 });
  const patched = await api(`/api/moulds/${json.data._id}`, {
    method: 'PATCH',
    token: admin,
    body: { activeCavities: 6 },
  });
  assert.equal(patched.status, 400, patched.json.message);
  assert.match(patched.json.message, /4 cavities/);
});

test('a mould number cannot be reused', async () => {
  const first = await addMould();
  const again = await api('/api/moulds', {
    method: 'POST',
    token: admin,
    body: { ...FOUR_UP, mouldCode: first.json.data.mouldCode },
  });
  assert.equal(again.status, 409);
});

test('one tool can make several models', async () => {
  const { json } = await addMould({ products: [product, second] });
  assert.equal(json.data.products.length, 2);

  /* And it is found by either of them, because the question is "what makes this model". */
  const found = await api(`/api/moulds?product=${second}`, { token: admin });
  assert.ok(found.json.data.some((row) => row._id === json.data._id));
});

test('a model the catalogue does not have is refused, and named', async () => {
  const missing = new mongoose.Types.ObjectId().toString();
  const { status, json } = await addMould({ products: [product, missing] });
  assert.equal(status, 400);
  assert.match(json.message, new RegExp(missing));
});

test('ownership has to agree with itself', async () => {
  const noCustomer = await addMould({ ownedBy: 'customer' });
  assert.equal(noCustomer.status, 400, 'a customer-owned tool needs the customer');

  const strayCustomer = await addMould({ ownedBy: 'company', ownedByCustomer: customer });
  assert.equal(strayCustomer.status, 400, 'a company tool carries no customer');

  const good = await addMould({ ownedBy: 'customer', ownedByCustomer: customer });
  assert.equal(good.status, 201, good.json.message);
});

test('production keeps the register and marketing only reads it', async () => {
  const theirs = await addMould({}, ramesh);
  assert.equal(theirs.status, 201, theirs.json.message);

  const refused = await addMould({}, nandhini);
  assert.equal(refused.status, 403);

  const read = await api('/api/moulds', { token: nandhini });
  assert.equal(read.status, 200, 'marketing still needs to know what tools exist');
});

/* ------------------------------ What money is ------------------------------ */

test('the machine rate is a cost, so marketing does not see it [§8]', async () => {
  const { json } = await addMould({ machine: { code: 'INJ-02', tonnage: 200, hourRate: 450 } });
  const id = json.data._id;

  const asManagement = await api(`/api/moulds/${id}`, { token: admin });
  assert.equal(asManagement.json.data.machine.hourRate, 450);
  assert.equal(asManagement.json.data.machineCostPerPiece, 0.938);

  const asMarketing = await api(`/api/moulds/${id}`, { token: nandhini });
  assert.equal(asMarketing.json.data.machine.hourRate, undefined);
  assert.equal(asMarketing.json.data.machineCostPerPiece, undefined);

  /*
   * The tonnage stays. Hiding which press a tool runs on protects nothing and costs marketing
   * the one thing they ask production about — whether the job can be scheduled at all.
   */
  assert.equal(asMarketing.json.data.machine.tonnage, 200);
  assert.equal(asMarketing.json.data.piecesPerHour, 480, 'output is not a secret');
});

test('the export does not hand over what the screen hides', async () => {
  await addMould({ machine: { code: 'INJ-09', hourRate: 999 } });

  const download = async (token) => {
    const response = await fetch(`${baseUrl}/api/moulds/export`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.text();
  };

  assert.match(await download(admin), /999/, 'management gets the rate');
  const marketingFile = await download(nandhini);
  assert.doesNotMatch(marketingFile, /999/, 'a redaction the Export button walks around is none');
  assert.match(marketingFile, /INJ-09/, 'but the rest of the register is still theirs');
});

/* ------------------------------- Into a costing ------------------------------- */

test('a costing on a model with one tool starts from consumption, not from the catalogue weight', async () => {
  /*
   * Its own model. `product` has picked up a second tool from the multi-model test above, and
   * two tools is deliberately the case where the register declines to choose — so reusing it
   * here would test the fallback while claiming to test the fill.
   */
  const made = await api('/api/products', {
    method: 'POST',
    token: admin,
    body: { modelCode: 'NH-380', name: 'Shirt hanger 380mm', category: 'shirt', material: 'pp', sizeMm: 380, standardWeightGrams: 30 },
  });
  const oneTool = made.json.data._id;

  await addMould({ products: [oneTool], partWeightGrams: 30, runnerWeightGrams: 12, cavities: 4 });

  const { json } = await api('/api/pricings', {
    method: 'POST',
    token: admin,
    body: { customer, product: oneTool, quantity: 40000 },
  });

  assert.equal(json.data.cost.gramWeight, 33, 'the mould overrules the catalogue’s 30 g');
  assert.ok(json.data.mould, 'and the sheet records which tool it came off');
});

test('a model with two tools is not guessed at', async () => {
  const madeProduct = await api('/api/products', {
    method: 'POST',
    token: admin,
    body: { modelCode: 'NH-450', name: 'Coat hanger 450mm', category: 'coat', material: 'pp', sizeMm: 450, standardWeightGrams: 48 },
  });
  const twoTools = madeProduct.json.data._id;

  await addMould({ products: [twoTools], partWeightGrams: 48, cavities: 2, runnerWeightGrams: 16 });
  await addMould({ products: [twoTools], partWeightGrams: 48, cavities: 4, runnerWeightGrams: 20 });

  const { json } = await api('/api/pricings', {
    method: 'POST',
    token: admin,
    body: { customer, product: twoTools, quantity: 40000 },
  });

  /*
   * Falls back to the catalogue rather than picking one. The two tools give 56 g and 53 g, and
   * either would look entirely reasonable on the sheet — which is exactly why the register must
   * not choose. 48 g is visibly the catalogue's own number and prompts somebody to say which
   * tool the job runs on.
   */
  assert.equal(json.data.cost.gramWeight, 48);
  assert.equal(json.data.mould, undefined);
});

test('attaching a mould to a sheet rewrites its gram weight, and re-runs the floor', async () => {
  const made = await addMould({ partWeightGrams: 30, runnerWeightGrams: 12, cavities: 4 });

  const sheet = await api('/api/pricings', {
    method: 'POST',
    token: admin,
    body: { customer, quantity: 40000, modelNumber: 'NH-400' },
  });

  const built = await api(`/api/pricings/${sheet.json.data._id}/cost`, {
    method: 'PATCH',
    token: admin,
    body: { mould: made.json.data._id, cost: { rawMaterialRate: 100 }, markupPercent: 10 },
  });

  assert.equal(built.status, 200, built.json.message);
  assert.equal(built.json.data.cost.gramWeight, 33);
  assert.equal(built.json.data.materialCost, 3.3, '33 g at 100 a kilo');

  /* An explicit weight in the same request still wins — somebody who weighed a bag is not
     overruled by the register. */
  const weighed = await api(`/api/pricings/${sheet.json.data._id}/cost`, {
    method: 'PATCH',
    token: admin,
    body: { mould: made.json.data._id, cost: { gramWeight: 31.5 } },
  });
  assert.equal(weighed.json.data.cost.gramWeight, 31.5);
});

test('the tool on a costing does not carry its machine rate to marketing', async () => {
  const made = await addMould({ machine: { hourRate: 777 } });

  const sheet = await api('/api/pricings', {
    method: 'POST',
    token: admin,
    body: { customer, quantity: 40000, modelNumber: 'NH-400', mould: made.json.data._id },
  });
  const id = sheet.json.data._id;

  const asMarketing = await api(`/api/pricings/${id}`, { token: nandhini });
  assert.equal(asMarketing.status, 200);
  assert.equal(asMarketing.json.data.mould?.machine?.hourRate, undefined);
  assert.equal(asMarketing.json.data.cost, undefined, 'and the sheet itself is still redacted');

  const asManagement = await api(`/api/pricings/${id}`, { token: admin });
  assert.equal(asManagement.json.data.mould.machine.hourRate, 777);
});

test('whoever keeps the register can see the rate they are keeping', async () => {
  const made = await addMould({ machine: { code: 'INJ-07', tonnage: 200, hourRate: 480 } }, ramesh);
  const id = made.json.data._id;

  /*
   * Production owns the register and does not hold `pricing: write`, so §8's costing gate said
   * no to them — which made the rate invisible to the only people who maintain it. That is not
   * a redaction, it is a trap: their edit form loads the field blank, and the next save they
   * make wipes a figure they were never shown.
   */
  const read = await api(`/api/moulds/${id}`, { token: ramesh });
  assert.equal(read.json.data.machine.hourRate, 480, 'the plant sees its own machine rate');

  const roundTripped = await api(`/api/moulds/${id}`, {
    method: 'PATCH',
    token: ramesh,
    body: { location: 'Moulding bay 4' },
  });
  assert.equal(roundTripped.json.data.machine.hourRate, 480, 'and an unrelated edit does not lose it');

  /* Marketing, who only read it, still do not. */
  const asMarketing = await api(`/api/moulds/${id}`, { token: nandhini });
  assert.equal(asMarketing.json.data.machine.hourRate, undefined);
});
