/**
 * The look-ahead rules, without a database: unusual runs, slip, the suggested schedule,
 * maintenance risk, the purchase forecast, floor readings over WhatsApp and the copilot's
 * answer by topic [services/productionInsights, scheduleSuggest, productionRisk,
 * floorMessage, productionCopilot].
 *
 *   node --test tests/production-insights.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { factorFor, unusual, unusualSoFar } from '../src/services/productionInsights.service.js';
import { chainQueue, suggestSchedule } from '../src/services/scheduleSuggest.service.js';
import { forecastItem, scoreMachine, scoreMould } from '../src/services/productionRisk.service.js';
import { describeLog, parseFloorMessage } from '../src/services/floorMessage.service.js';
import { answerByRules } from '../src/services/productionCopilot.service.js';

const history = { rejectRates: [0.01, 0.012, 0.009, 0.011, 0.01, 0.013], performance: [0.9, 0.92, 0.88, 0.91, 0.9] };
const start = new Date('2026-10-10T08:00:00+05:30');
const hours = (count) => new Date(start.getTime() + count * 3600000);
/* 4 cavities at 30 s: 120 shots an hour, 480 pieces. */
const mould = { cycleTimeSeconds: 30, cavities: 4 };

test('a run far outside its mould’s rejects or speed is unusual; a usual one is not', () => {
  const usual = { startedAt: start, endedAt: hours(10), counterStart: 0, counterEnd: 1080, cavitiesRunning: 4, goodPieces: 4260, rejectedPieces: 60, mould };
  assert.deepEqual(unusual(usual, history), []);
  const rejecting = { ...usual, goodPieces: 3920, rejectedPieces: 400 };
  const found = unusual(rejecting, history);
  assert.equal(found[0].kind, 'rejects');
  assert.match(found[0].text, /usually runs at 1(\.\d)?%/);
  const slow = { ...usual, counterEnd: 600, goodPieces: 2370, rejectedPieces: 30 };
  assert.ok(unusual(slow, history).some((entry) => entry.kind === 'slow'));
  assert.deepEqual(unusual(rejecting, { rejectRates: [0.01, 0.01], performance: [] }), [], 'too little history to judge');
});

test('rejects running high are flagged once enough pieces are counted, and only once', () => {
  const run = { counterStart: 0, cavitiesRunning: 4, counterLog: [{ counter: 100 }], rejects: [{ pieces: 60 }] };
  assert.deepEqual(unusualSoFar(run, history), [], '400 pieces is too few to judge');
  const more = { ...run, counterLog: [{ counter: 1000 }], rejects: [{ pieces: 300 }] };
  assert.equal(unusualSoFar(more, history)[0].kind, 'rejects_running');
  assert.deepEqual(unusualSoFar({ ...more, anomalies: [{ kind: 'rejects_running' }] }, history), []);
});

test('slip falls back from the mould to the press to the plant to standard', () => {
  const factors = { mould: { m1: 1.4 }, machine: { p1: 1.2 }, plant: 1.1 };
  assert.equal(factorFor(factors, { mould: 'm1', machine: 'p1' }), 1.4);
  assert.equal(factorFor(factors, { mould: 'm2', machine: 'p1' }), 1.2);
  assert.equal(factorFor(factors, { mould: 'm2', machine: 'p2' }), 1.1);
  assert.equal(factorFor({ mould: {}, machine: {}, plant: null }, {}), 1);
});

/* 480 pieces an hour × 20 h = 9,600 a day on the plant's hours. */
const plant = { hoursPerDay: 20, weeklyOff: 0 };
const tool = { mouldCode: 'M-1', status: 'active', cavities: 4, cycleTimeSeconds: 30, efficiencyPercent: 100, partWeightGrams: 20, machine: { tonnage: 120 } };
const big = { _id: 'p1', code: 'IM-1', tonnage: 150, shotCapacityGrams: 200, status: 'idle', active: true };
const other = { _id: 'p2', code: 'IM-2', tonnage: 150, shotCapacityGrams: 200, status: 'idle', active: true };
const small = { _id: 'p3', code: 'IM-3', tonnage: 80, shotCapacityGrams: 200, status: 'idle', active: true };
const today = '2026-10-19'; // a Monday

test('a press queue runs back to back from today, skipping the weekly off', () => {
  const slots = chainQueue([{ _id: 'a', toMake: 9600 * 6, mould: tool }, { _id: 'b', toMake: 9600, mould: tool }], big, { plant, slipOf: () => 1, today });
  assert.equal(slots[0].start, '2026-10-19');
  assert.equal(slots[0].end, '2026-10-24', 'six days, Monday to Saturday');
  assert.equal(slots[1].start, '2026-10-26', 'Sunday is off');
  const slipped = chainQueue([{ _id: 'a', toMake: 9600 * 5, mould: tool }], big, { plant, slipOf: () => 1.2, today });
  assert.equal(slipped[0].days, 6, 'history says 20% longer');
});

test('the suggestion spreads late work across presses that can hold the mould, keeping the running job', () => {
  const jobs = [
    { _id: 'run', number: 'WO-1', status: 'running', machine: 'p1', sequence: 1, mould: tool, colour: 'White', toMake: 9600 * 3, dueDay: '2026-10-30' },
    { _id: 'a', number: 'WO-2', status: 'released', machine: 'p1', sequence: 2, mould: tool, colour: 'Black', toMake: 9600 * 3, dueDay: '2026-10-22' },
    { _id: 'b', number: 'WO-3', status: 'released', machine: 'p1', sequence: 3, mould: tool, colour: 'White', toMake: 9600 * 2, dueDay: '2026-10-24', priority: 'urgent' },
    { _id: 'c', number: 'WO-4', status: 'planned', machine: null, mould: { ...tool, cycleTimeSeconds: null }, colour: 'Red', toMake: 1000 },
  ];
  const result = suggestSchedule({ presses: [big, other, small], jobs, plant, today });
  assert.equal(result.summary.lateBefore, 2, 'both queued behind the running job end late');
  assert.ok(result.summary.lateAfter < result.summary.lateBefore);
  const onBig = result.plan.find((press) => press.machine.code === 'IM-1').jobs;
  assert.equal(onBig[0].number, 'WO-1', 'the running job stays first');
  assert.equal(onBig[0].why, 'Running now — stays first');
  const onSmall = result.plan.find((press) => press.machine.code === 'IM-3').jobs;
  assert.equal(onSmall.length, 0, 'IM-3 cannot hold a 120 T mould');
  assert.equal(result.summary.lateAfter, 0);
  const all = result.plan.flatMap((press) => press.jobs.map((job) => ({ ...job, press: press.machine.code })));
  const urgent = all.find((job) => job.number === 'WO-3');
  assert.equal(urgent.press, 'IM-1', 'the urgent white job stays behind the white run — no purge, still on time');
  assert.match(urgent.why, /already on White/);
  const moved = all.find((job) => job.number === 'WO-2');
  assert.deepEqual([moved.press, moved.from], ['IM-2', 'IM-1'], 'the black job moves to the free press to make its date');
  assert.ok(result.moves.every((move) => move.workOrder !== 'run'), 'the running job is never moved');
  assert.equal(result.cannotPlace[0].number, 'WO-4');
  assert.match(result.cannotPlace[0].why, /no cycle time/);
});

test('a press’s risk climbs with breakdowns, rising stops and an overdue service', () => {
  assert.deepEqual(scoreMachine({}, { today }), { score: 0, level: 'ok', reasons: [] });
  const worn = scoreMachine({ breakdowns: 2, stopRecent: 120, stopBefore: 30, serviceDue: '2026-10-10', andonOpen: true }, { today });
  assert.equal(worn.level, 'high');
  assert.equal(worn.reasons.length, 4);
  assert.ok(worn.reasons.some((line) => /Service overdue/.test(line)));
  const mouldRisk = scoreMould({ shotsSince: 110000, everyShots: 100000, repairs: 1, rejectRecent: 0.06, rejectBefore: 0.01 });
  assert.equal(mouldRisk.level, 'high');
  assert.ok(mouldRisk.reasons[0].includes('due now'));
  assert.equal(scoreMould({ shotsSince: 50000, everyShots: 100000 }).level, 'ok');
});

test('the forecast says weeks of cover, the run-out day and the day to order by', () => {
  const item = forecastItem({ onHand: 400, weeklyUse: 100, required: 0, reorder: 100, leadDays: 14 }, { today });
  assert.equal(item.weeksCover, 4);
  assert.equal(item.runOutOn, '2026-11-16');
  assert.equal(item.orderBy, '2026-11-02');
  assert.equal(item.orderNow, false);
  assert.equal(item.buy, 0, 'covers the lead time and the reorder level');
  const thin = forecastItem({ onHand: 50, weeklyUse: 100, required: 300, reorder: 100, leadDays: 14 }, { today });
  assert.equal(thin.orderNow, true);
  assert.equal(thin.buy, 550, 'the plan, two weeks’ use and the reorder level, less what is held');
  assert.equal(forecastItem({ onHand: 10, weeklyUse: 0 }, { today }).runOutOn, null, 'nothing drawn, nothing to forecast');
});

test('a floor text reads into a run log; anything that names no press is left alone', () => {
  const codes = ['IM-1', 'IM-2', 'M4'];
  assert.deepEqual(parseFloorMessage('IM-2 23400 rej 40 flash', codes), { code: 'IM-2', log: { counter: 23400, rejects: { pieces: 40, reason: 'flash' } } });
  assert.deepEqual(parseFloorMessage('im2 down 30 min heater band', codes), { code: 'IM-2', log: { downtime: { minutes: 30, reason: 'heater_band' } } });
  assert.deepEqual(parseFloorMessage('M4 counter 12,500 rejects 25 short shot down 15 power', codes).log, {
    counter: 12500, rejects: { pieces: 25, reason: 'short_shot' }, downtime: { minutes: 15, reason: 'power_cut' },
  });
  assert.equal(parseFloorMessage('IM 1 2.5k', codes).log.counter, 2500, 'a space in the code and a k');
  assert.equal(parseFloorMessage('Hello, is the plant open Saturday?', codes).error, 'press');
  assert.equal(parseFloorMessage('IM-1 all good', codes).error, 'reading');
  assert.equal(parseFloorMessage('IM-1 rej 10 something odd', codes).log.rejects.reason, 'other');
  assert.equal(describeLog({ counter: 23400, rejects: { pieces: 40, reason: 'flash' } }), 'counter 23,400, 40 rejects (Flash)');
});

test('without a model, the copilot answers from the brief by topic', () => {
  const brief = {
    late: [{ workOrder: 'WO-9', press: 'IM-1', customer: 'SKK', due: '22 Oct', plannedEnd: '24 Oct', predictedEnd: '25 Oct', slip: 1.2, why: 'planned end after due' }],
    unplanned: [], andons: [], risk: [], shortages: [{ item: 'PP Black', unit: 'kg', short: 120, buy: 220 }],
    oeeWeek: { total: { oee: '61%', availability: '80%', performance: '85%', quality: '90%', runs: 12 }, worstPresses: [], topStops: [{ reason: 'Power cut', minutes: 240 }], topRejects: [] },
  };
  const late = answerByRules('Which orders will be late?', brief);
  assert.equal(late.from, 'rules');
  assert.match(late.points[0], /WO-9 on IM-1/);
  assert.match(answerByRules('what should we buy', brief).points[0], /PP Black: short 120 kg, buy 220 kg/);
  assert.match(answerByRules('why is OEE low', brief).points.join(' '), /Power cut, 240 min/);
  assert.ok(answerByRules('hello', brief).points.length >= 1, 'an open question gets what stands out');
});
