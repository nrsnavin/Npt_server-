/**
 * OEE from runs [services/oee.service.js] — the arithmetic, without a database.
 *
 *   node --test tests/oee.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { factors, measureRun } from '../src/services/oee.service.js';

const start = new Date('2026-10-17T08:00:00+05:30');
const hours = (h) => new Date(start.getTime() + h * 3600000);

test('one run: planned stops leave the plan, unplanned stops cost availability', () => {
  /* 10 hours; a 60-minute mould change (planned) and a 60-minute breakdown (unplanned). */
  const run = {
    startedAt: start, endedAt: hours(10), counterStart: 0, counterEnd: 2400, cavitiesRunning: 4,
    goodPieces: 9000, rejectedPieces: 600, mould: { cycleTimeSeconds: 12 },
    downtime: [{ reason: 'mould_change', minutes: 60 }, { reason: 'machine_breakdown', minutes: 60 }],
  };
  const part = measureRun(run);
  assert.equal(part.plannedTime, 540);
  assert.equal(part.runTime, 480);
  assert.equal(part.idealMinutes, 480, '2,400 shots × 12 s');
  const result = factors({ ...part, runs: 1, measuredRunTime: part.runTime });
  assert.equal(result.availability, 88.9);
  assert.equal(result.performance, 100);
  assert.equal(result.quality, 93.8);
  assert.equal(result.oee, 83.3);
});

test('a slow cycle shows as performance; without a standard cycle performance is not guessed', () => {
  const slow = measureRun({ startedAt: start, endedAt: hours(8), counterStart: 0, counterEnd: 1920, goodPieces: 7680, rejectedPieces: 0, mould: { cycleTimeSeconds: 12 } });
  assert.equal(factors({ ...slow, runs: 1, measuredRunTime: slow.runTime }).performance, 80, '1,920 shots took 8 h, 6.4 h at standard');
  const unknown = measureRun({ startedAt: start, endedAt: hours(8), goodPieces: 100, rejectedPieces: 0, mould: {} });
  assert.equal(unknown.measurable, false);
  assert.equal(factors({ ...unknown, runs: 1, measuredRunTime: 0 }).oee, null);
});

test('a free-text stop with no codes counts as unplanned; a run with no end is not measured', () => {
  const part = measureRun({ startedAt: start, endedAt: hours(5), downtimeMinutes: 30, goodPieces: 10, mould: { cycleTimeSeconds: 10 } });
  assert.equal(part.unplanned, 30);
  assert.equal(measureRun({ startedAt: start }), null);
});
