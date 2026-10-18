/**
 * The planning board's rules, without a database [services/planning.service.js].
 *
 *   node --test tests/planning.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { changeovers, colourOrder, colourRank, fitOf, shotGrams } from '../src/services/planning.service.js';

const mould = { mouldCode: 'M-400', status: 'active', cavities: 4, partWeightGrams: 30, runnerWeightGrams: 12, machine: { tonnage: 150 } };
const press = { code: 'IM-1', tonnage: 150, shotCapacityGrams: 200, status: 'idle', active: true };

test('a shot is every running cavity plus the runner', () => {
  assert.equal(shotGrams(mould), 132);
  assert.equal(shotGrams({ ...mould, activeCavities: 2 }), 72);
  assert.equal(shotGrams({ cavities: 4 }), null);
});

test('a mould fits a press that can inject its shot and has the tonnage', () => {
  assert.deepEqual(fitOf(mould, press), { ok: true, blocks: [], warnings: [] });
  const small = fitOf(mould, { ...press, code: 'IM-2', shotCapacityGrams: 100, tonnage: 100 });
  assert.equal(small.ok, false);
  assert.equal(small.blocks.length, 2, 'shot and tonnage both refused');
  assert.match(small.blocks[0], /132 g/);
  assert.equal(fitOf(mould, { ...press, status: 'retired' }).ok, false);
  assert.equal(fitOf({ ...mould, status: 'maintenance' }, press).ok, false, 'a mould in the tool room runs nowhere');
});

test('a broken press or a service due is a warning, not a block; unknown figures are not guessed', () => {
  const down = fitOf(mould, { ...press, status: 'breakdown', nextServiceDue: '2026-10-20' }, { on: '2026-10-25' });
  assert.equal(down.ok, true);
  assert.equal(down.warnings.length, 2);
  assert.equal(fitOf(mould, { code: 'IM-3', status: 'idle' }).ok, true, 'no capacity on record, no check');
  const worn = fitOf({ ...mould, maintenanceEveryShots: 100000, totalShots: 250000, lastMaintenanceShots: 140000 }, press);
  assert.ok(worn.warnings.some((line) => /maintenance by shot count/.test(line)));
});

test('colours run light to dark; the darkest word decides', () => {
  assert.ok(colourRank('White') < colourRank('Red'));
  assert.ok(colourRank('Blue') < colourRank('Dark Blue'));
  assert.equal(colourRank('Black'), 5);
  const queue = [
    { status: 'released', colour: 'Black', dueDate: '2026-11-01' },
    { status: 'running', colour: 'Red' },
    { status: 'released', colour: 'White', dueDate: '2026-11-03' },
    { status: 'released', colour: 'Black', dueDate: '2026-10-30' },
    { status: 'released', colour: 'White', dueDate: '2026-11-02' },
  ];
  const ordered = colourOrder(queue);
  assert.deepEqual(ordered.map((job) => job.colour), ['Red', 'White', 'White', 'Black', 'Black'], 'the running job stays first');
  assert.equal(ordered[3].dueDate, '2026-10-30', 'within a colour, the earliest due first');
  assert.equal(changeovers(queue), 4);
  assert.equal(changeovers(ordered), 2);
});
