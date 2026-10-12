/**
 * The resin rate list onto the material register [services/materialRates.service.js,
 * scripts/import-materials.js]: each material by its store name and rate, HIPS at +18.8%
 * grammage over PP and every other resin at PP's; a second run moves only what changed.
 *
 *   node --test tests/material-rates.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let mongo;
let Material;
let service;
const list = readFileSync(new URL('../data/material-rates.tsv', import.meta.url), 'utf8');

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: Material } = await import('../src/models/Material.js'));
  service = await import('../src/services/materialRates.service.js');
  /* Already on the register, under the same name spaced differently, at an old rate. */
  await Material.create({ name: 'PP :  natural', type: 'pp', ratePerKg: 150, grammageFactorPercent: 0 });
});

test.after(async () => {
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the list reads: 51 materials, each resin known, the one without a rate said so', () => {
  const entries = service.readRates(list);
  assert.equal(entries.length, 51);
  assert.deepEqual([...new Set(entries.map((entry) => entry.type))].sort(), ['abs', 'eva', 'gpps', 'hd', 'hips', 'kresin', 'ld', 'pp']);
  assert.equal(entries.find((entry) => entry.name === 'GP-PS : NATURAL').type, 'gpps', 'GP-PS is GPPS');
  const velvet = entries.find((entry) => entry.name === 'HIPS : velvet');
  assert.equal(velvet.rate, undefined);
  assert.match(velvet.warnings.join(), /No rate/);
});

test('imported: HIPS at +18.8% grammage, the rest at 0; a name already there is updated, not doubled', async () => {
  const plan = await service.planRates(service.readRates(list));
  const natural = plan.find((entry) => entry.name === 'PP : NATURAL');
  assert.equal(natural.action, 'update');
  assert.deepEqual(natural.changes.ratePerKg, { from: 150, to: 160 });

  const result = await service.applyRates(plan);
  assert.deepEqual(result, { created: 50, updated: 1 });
  assert.equal(await Material.countDocuments(), 51);
  assert.equal((await Material.findOne({ name: 'HIPS : WHITE' })).grammageFactorPercent, 18.8);
  assert.equal((await Material.findOne({ name: 'HIPS : WHITE' })).ratePerKg, 195);
  assert.equal((await Material.findOne({ name: 'GPPS : NATURAL' })).grammageFactorPercent, 0);
  assert.equal((await Material.findOne({ name: 'KRESIN : NATURAL' })).type, 'kresin');
  assert.equal((await Material.findOne({ name: 'HIPS : velvet' })).ratePerKg, 0);
  assert.equal((await Material.findOne({ name: 'PP :  natural' })).ratePerKg, 160);

  const again = await service.planRates(service.readRates(list));
  assert.equal(again.filter((entry) => entry.action !== 'unchanged').length, 0, 'nothing moves on a second run');
});

test('the price-sheet import costs bought-in items at PP Natural, not whichever PP grade moved last', async () => {
  await Material.updateOne({ name: 'PP : G/BLACK' }, { $set: { notes: 'touched' } });
  const { ppRateFor } = await import('../src/services/mouldSheet.service.js');
  assert.equal((await ppRateFor()).rate, 160);
});
