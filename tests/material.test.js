/**
 * The material register, and the grammage it decides [BLUEPRINT §7].
 *
 * A mould's cavity is a fixed volume, so the same tool throws a heavier part in a denser resin.
 * The register records a tool's grammage on a PP basis and the material carries the uplift —
 * 0 for PP and LD, 18 for HIPS — so a costing switched from one to the other re-weighs itself.
 *
 * That is the arithmetic worth guarding, because getting it wrong is invisible: a HIPS job
 * costed at its PP weight produces a sheet where every line is right and the resin is 18% light.
 *
 *   node --test tests/material.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

import { grammageFrom } from '../src/models/Material.js';

process.env.JWT_SECRET = 'material-test-secret-value';

let mongo;
let server;
let baseUrl;
let admin;      // management — costing, so it sees rates
let ramesh;     // production — owns both registers
let nandhini;   // marketing — reads them
let customer;
let pp;
let hips;
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

const signIn = async (email, password) => {
  const { json } = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  return json.data?.token;
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

  for (const person of [
    { name: 'Ramesh Plant', email: 'ramesh@np.com', password: 'Prod@123456', department: 'production' },
    { name: 'Nandhini S', email: 'nandhini@np.com', password: 'Passw0rd@123', department: 'marketing' },
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: person });
  }
  ramesh = await signIn('ramesh@np.com', 'Prod@123456');
  nandhini = await signIn('nandhini@np.com', 'Passw0rd@123');

  const madeCustomer = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'Sri Kumaran Knits', mobile: '9840011223' },
  });
  customer = madeCustomer.json.data._id;

  const madePp = await api('/api/materials', {
    method: 'POST',
    token: admin,
    body: { name: 'PP Natural', code: 'PP-NAT', type: 'pp', colour: 'Natural', ratePerKg: 160 },
  });
  pp = madePp.json.data._id;

  const madeHips = await api('/api/materials', {
    method: 'POST',
    token: admin,
    body: {
      name: 'HIPS Natural', code: 'HIPS-NAT', type: 'hips', colour: 'Natural',
      ratePerKg: 90, grammageFactorPercent: 18,
    },
  });
  hips = madeHips.json.data._id;

  /* A single-cavity tool, so the runner share is the whole runner and the arithmetic is plain. */
  const madeMould = await api('/api/moulds', {
    method: 'POST',
    token: admin,
    body: {
      mouldCode: 'M-T1',
      name: '400mm shirt hanger',
      partWeightGrams: 30,
      runnerWeightGrams: 3,
      cycleTimeSeconds: 30,
      jobWorkCost: 0.8,
      hookCost: 0.7,
      clipsCost: 1.2,
      printingCost: 0.5,
      packingCost: 0.2,
    },
  });
  assert.equal(madeMould.status, 201, madeMould.json.message);
  mould = madeMould.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------- The register ------------------------------- */

test('a material carries its rate, its colour and its grammage basis', async () => {
  const { json } = await api(`/api/materials/${hips}`, { token: admin });

  assert.equal(json.data.ratePerKg, 90);
  assert.equal(json.data.colour, 'Natural');
  assert.equal(json.data.grammageFactorPercent, 18);
  assert.equal(json.data.ratePerGram, 0.09, 'which is what a per-piece costing multiplies by');
});

test('a rate change is dated, and an unrelated edit is not', async () => {
  /*
   * "Is ₹160 this week's number or last monsoon's?" is the question a register exists to
   * answer, and a generic `updatedAt` cannot — it moves when the colour is corrected too.
   */
  const made = await api('/api/materials', {
    method: 'POST',
    token: admin,
    body: { name: 'PP Smoke', code: 'PP-SMK', type: 'pp', ratePerKg: 158 },
  });
  const id = made.json.data._id;
  const firstStamp = made.json.data.rateUpdatedAt;
  assert.ok(firstStamp, 'a rate arrives dated from the first day');

  await new Promise((resolve) => setTimeout(resolve, 10));
  const renamed = await api(`/api/materials/${id}`, {
    method: 'PATCH', token: admin, body: { colour: 'Smoke Grey' },
  });
  assert.equal(renamed.json.data.rateUpdatedAt, firstStamp, 'a colour fix is not a repricing');

  const repriced = await api(`/api/materials/${id}`, {
    method: 'PATCH', token: admin, body: { ratePerKg: 162 },
  });
  assert.notEqual(repriced.json.data.rateUpdatedAt, firstStamp, 'a rate move is');
});

test('a grammage factor outside the plausible range is refused', async () => {
  /* 118 where 18 was meant would triple every costing and look entirely reasonable on screen. */
  const { status } = await api('/api/materials', {
    method: 'POST',
    token: admin,
    body: { name: 'Nonsense', type: 'pp', ratePerKg: 100, grammageFactorPercent: 400 },
  });
  assert.equal(status, 400);
});

test('production keeps the register and marketing only reads it', async () => {
  const theirs = await api('/api/materials', {
    method: 'POST',
    token: ramesh,
    body: { name: 'PP Blue', code: 'PP-BLU', type: 'pp', ratePerKg: 170 },
  });
  assert.equal(theirs.status, 201, theirs.json.message);

  const refused = await api('/api/materials', {
    method: 'POST',
    token: nandhini,
    body: { name: 'PP Green', type: 'pp', ratePerKg: 170 },
  });
  assert.equal(refused.status, 403);

  const read = await api('/api/materials', { token: nandhini });
  assert.equal(read.status, 200, 'marketing still needs to know what the plant runs');
});

/* ------------------------------- The grammage ------------------------------- */

test('PP and LD use the mould grammage as it stands; HIPS adds 18%', () => {
  assert.equal(grammageFrom(33, 0), 33, 'PP is the basis the mould is recorded in');
  assert.equal(grammageFrom(33, 18), 38.94, 'HIPS out of the same cavity is heavier');
  assert.equal(grammageFrom(0, 18), 0, 'no weight, no conversion');
});

test('a costing takes its grammage, rate and cost lines from the mould and the material', async () => {
  const { status, json } = await api('/api/pricings', {
    method: 'POST',
    token: admin,
    body: { customer, quantity: 40000, mould, materialRef: pp },
  });
  assert.equal(status, 201, json.message);

  const cost = json.data.cost;
  assert.equal(cost.gramWeight, 33, '30 g part + the whole 3 g runner on a single-cavity tool');
  assert.equal(cost.rawMaterialRate, 160, "the register's rate, copied onto the sheet");
  assert.equal(cost.jobWorkCost, 0.8);
  assert.equal(cost.hookCost, 0.7);
  assert.equal(cost.metalClipsCost, 1.2);
  assert.equal(cost.printingCost, 0.5);
  assert.equal(cost.packingCost, 0.2);

  /* 33 g × ₹160/kg = ₹5.28, plus ₹3.40 of conversion. */
  assert.equal(json.data.materialCost, 5.28);
  assert.equal(Math.round(json.data.totalCost * 100) / 100, 8.68);
});

test('the same tool in HIPS weighs 18% more, and the sheet says so', async () => {
  const { json } = await api('/api/pricings', {
    method: 'POST',
    token: admin,
    body: { customer, quantity: 40000, mould, materialRef: hips },
  });

  assert.equal(json.data.cost.gramWeight, 38.94, '33 g of PP is 38.94 g of HIPS');
  assert.equal(json.data.cost.rawMaterialRate, 90);
  /*
   * And the cost lands *below* the PP sheet despite the heavier piece, because HIPS is cheaper
   * per kilo — which is exactly why doing this conversion by eye goes wrong: the two effects
   * pull in opposite directions and neither is visible on the sheet.
   */
  assert.equal(Math.round(json.data.materialCost * 100) / 100, 3.5);
});

test('switching the material on a costing re-weighs the piece', async () => {
  const made = await api('/api/pricings', {
    method: 'POST',
    token: admin,
    body: { customer, quantity: 40000, mould, materialRef: pp },
  });
  assert.equal(made.json.data.cost.gramWeight, 33);

  const switched = await api(`/api/pricings/${made.json.data._id}/cost`, {
    method: 'PATCH',
    token: admin,
    body: { materialRef: hips },
  });

  assert.equal(switched.status, 200, switched.json.message);
  assert.equal(switched.json.data.cost.gramWeight, 38.94, 'the weight followed the resin');
  assert.equal(switched.json.data.cost.rawMaterialRate, 90, 'and so did the rate');
});

test('a weight typed on the sheet still beats both registers', async () => {
  /*
   * Somebody who has weighed a bag of finished pieces is not overruled by a density table.
   *
   * Asserted at `/cost` because that is the door that builds a sheet — the create route only
   * *raises* a costing and does not accept cost lines at all, which is worth knowing: sending
   * them there is silently dropped by the schema rather than refused.
   */
  const made = await api('/api/pricings', {
    method: 'POST',
    token: admin,
    body: { customer, quantity: 40000, mould, materialRef: hips },
  });
  assert.equal(made.json.data.cost.gramWeight, 38.94, 'the register filled it first');

  const weighed = await api(`/api/pricings/${made.json.data._id}/cost`, {
    method: 'PATCH',
    token: admin,
    body: { materialRef: hips, cost: { gramWeight: 37.5 } },
  });

  assert.equal(weighed.status, 200, weighed.json.message);
  assert.equal(weighed.json.data.cost.gramWeight, 37.5, 'the measured figure wins');
  assert.equal(weighed.json.data.cost.rawMaterialRate, 90, 'while the rate still came from the register');
});

test('the costing records which material it was priced in', async () => {
  const made = await api('/api/pricings', {
    method: 'POST',
    token: admin,
    body: { customer, quantity: 40000, mould, materialRef: hips },
  });

  const { json } = await api(`/api/pricings/${made.json.data._id}`, { token: admin });
  assert.equal(json.data.materialRef.code, 'HIPS-NAT');
  assert.equal(json.data.materialRef.grammageFactorPercent, 18);
  assert.equal(json.data.material, 'hips', 'and the sheet agrees about the family');
});

test('a rate that moves later does not re-price a costing already built', async () => {
  /*
   * The reason the rate is copied onto the sheet rather than read through the reference: a
   * quotation must not silently re-price itself under the customer who was given it.
   */
  const made = await api('/api/materials', {
    method: 'POST',
    token: admin,
    body: { name: 'PP Volatile', code: 'PP-VOL', type: 'pp', ratePerKg: 150 },
  });
  const id = made.json.data._id;

  const sheet = await api('/api/pricings', {
    method: 'POST',
    token: admin,
    body: { customer, quantity: 40000, mould, materialRef: id },
  });
  assert.equal(sheet.json.data.cost.rawMaterialRate, 150);

  await api(`/api/materials/${id}`, { method: 'PATCH', token: admin, body: { ratePerKg: 175 } });

  const after = await api(`/api/pricings/${sheet.json.data._id}`, { token: admin });
  assert.equal(after.json.data.cost.rawMaterialRate, 150, 'the sheet keeps what it was built on');

  /* But the register can say which sheets are now stale, so somebody can decide to re-cost. */
  const affected = await api(`/api/materials/${id}/pricings`, { token: admin });
  assert.equal(affected.json.stale, 1);
});

test('a material the register does not have is refused', async () => {
  const missing = new mongoose.Types.ObjectId().toString();
  const { status, json } = await api('/api/pricings', {
    method: 'POST',
    token: admin,
    body: { customer, quantity: 40000, materialRef: missing },
  });
  assert.equal(status, 400);
  assert.match(json.message, /not on the register/i);
});

/* -------------------------- What the mould now carries -------------------------- */

test('a mould defaults to one cavity', async () => {
  const { json } = await api('/api/moulds', {
    method: 'POST',
    token: admin,
    body: { mouldCode: 'M-T9', name: 'Single up', partWeightGrams: 20, cycleTimeSeconds: 20 },
  });
  assert.equal(json.data.cavities, 1);
  assert.equal(json.data.runningCavities, 1);
});

test("the mould's cost lines are cost, so marketing does not see them [§8]", async () => {
  const asPlant = await api(`/api/moulds/${mould}`, { token: ramesh });
  assert.equal(asPlant.json.data.hookCost, 0.7, 'the people who keep the register see them');

  const asMarketing = await api(`/api/moulds/${mould}`, { token: nandhini });
  assert.equal(asMarketing.json.data.hookCost, undefined);
  assert.equal(asMarketing.json.data.clipsCost, undefined);
  assert.equal(asMarketing.json.data.jobWorkCost, undefined);
  assert.equal(asMarketing.json.data.partWeightGrams, 30, 'but the weights are not a secret');
});
