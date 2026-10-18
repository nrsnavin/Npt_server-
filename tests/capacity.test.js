/**
 * Capacity from the mould register and the plant calendar [services/capacity.service.js].
 *
 *   node --test tests/capacity.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimate, piecesPerDay, piecesPerHour, workingDaysUntil } from '../src/services/capacity.service.js';
import { PIECES_PER_DAY, urgencyOf } from '../src/services/productionUrgency.service.js';

const mould = { cavities: 4, activeCavities: 4, cycleTimeSeconds: 20, efficiencyPercent: 90 };
const plant = { hoursPerDay: 20, weeklyOff: 0 };

test('pieces an hour and a day come from cycle, running cavities, efficiency and press hours', () => {
  assert.equal(Math.round(piecesPerHour(mould)), 648, '180 shots × 90% × 4 cavities');
  assert.equal(piecesPerDay(mould, plant), 12960);
  assert.equal(Math.round(piecesPerHour({ ...mould, activeCavities: 2 })), 324, 'a blocked cavity halves it');
  assert.equal(piecesPerHour({ cavities: 4 }), 0, 'no cycle time, no rate');
});

test('without a usable mould the estimate falls back to the plant assumption, and says so', () => {
  const guessed = estimate(30000, null, plant);
  assert.equal(guessed.basis, 'assumed');
  assert.equal(guessed.perDay, PIECES_PER_DAY);
  const real = estimate(30000, mould, plant);
  assert.equal(real.basis, 'mould');
  assert.equal(real.days, 3);
  assert.equal(real.perHour, 648);
});

test('the finish date skips the weekly day off', () => {
  /* A Saturday in India time: three press days run Saturday, Monday, Tuesday. */
  const saturday = new Date('2026-10-17T10:00:00+05:30');
  const { finish, days } = estimate(30000, mould, plant, saturday);
  assert.equal(days, 3);
  assert.equal(finish.getDay(), 2, 'finishes on the Tuesday');
  assert.equal(workingDaysUntil(new Date('2026-10-20T10:00:00+05:30'), plant, saturday), 2, 'Sunday is not counted');
});

test('urgency uses the mould’s rate when given: a big job on a slow tool is at risk sooner', () => {
  const row = { toMakeQty: 20000, dueToBuyer: new Date(Date.now() + 3 * 86400000) };
  assert.equal(urgencyOf(row).band, 'soon', '20,000 fit in three days at the plant assumption');
  const slow = urgencyOf(row, { perDay: 5000 });
  assert.equal(slow.band, 'at_risk');
  assert.ok(slow.why.some((line) => /press days at 5,000 a day/.test(line)));
});
