/**
 * The aux price list onto the hook and clip registers [services/auxRates.service.js,
 * scripts/import-aux.js]: hooks by name, the rest (clips and their pads) as clips, the shade from
 * the name, "NONE" left out; a second run moves only a price that changed.
 *
 *   node --test tests/aux-rates.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let mongo;
let Component;
let service;
const list = readFileSync(new URL('../data/aux-rates.tsv', import.meta.url), 'utf8');

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: Component } = await import('../src/models/Component.js'));
  service = await import('../src/services/auxRates.service.js');
  await Component.create({ kind: 'hook', name: '80mm  MHOOK', ratePerPiece: 0.65 });
});

test.after(async () => {
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the list reads: 10 hooks and 34 clips, NONE left out, shades from the names', () => {
  const entries = service.readAux(list);
  assert.equal(entries.length, 44);
  assert.equal(entries.filter((entry) => entry.kind === 'hook').length, 10);
  assert.equal(entries.filter((entry) => entry.kind === 'clip').length, 34);
  assert.ok(!entries.some((entry) => /^none$/i.test(entry.name)));
  assert.equal(entries.find((entry) => entry.name === 'Ring hook (65 MM)').kind, 'hook');
  assert.equal(entries.find((entry) => entry.name === 'BKH pad').kind, 'clip');
  assert.equal(entries.find((entry) => entry.name === 'PL RMC clip MgreY').colour, 'M.Grey');
  assert.equal(entries.find((entry) => entry.name === '80MM MHOOK BLACK').colour, 'Black');
});

test('imported onto the registers; a part already there is repriced, not doubled; a second run is quiet', async () => {
  const plan = await service.planAux(service.readAux(list));
  assert.equal(plan.find((entry) => entry.name === '80MM MHOOK').action, 'update');
  assert.deepEqual(await service.applyAux(plan), { created: 43, updated: 1 });
  assert.equal(await Component.countDocuments({ kind: 'hook' }), 10);
  assert.equal(await Component.countDocuments({ kind: 'clip' }), 34);
  assert.equal((await Component.findOne({ name: '80mm  MHOOK' })).ratePerPiece, 0.7);
  assert.equal((await Component.findOne({ name: '80MM ALU HOOK' })).ratePerPiece, 1.5);
  const again = await service.planAux(service.readAux(list));
  assert.equal(again.filter((entry) => entry.action !== 'unchanged').length, 0);
});
