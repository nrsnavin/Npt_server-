/**
 * Scoring a press for a job [services/pressScore.service.js]: lowest score best, the reasons in
 * plain words, and the presses that cannot hold the mould set aside with why.
 *
 *   node --test tests/press-score.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SCORE_WEIGHTS, colourSteps, rankPresses, scorePress } from '../src/services/pressScore.service.js';
import { fitOf } from '../src/services/planning.service.js';

/* 4 cavities at 30 s: 480 pieces an hour; 20 h a day is 9,600. */
const plant = { hoursPerDay: 20, weeklyOff: 0, mouldChangeHours: 2 };
const today = '2026-10-19'; // a Monday
const tool = { _id: 'm1', mouldCode: 'M-1', status: 'active', cavities: 4, cycleTimeSeconds: 30, efficiencyPercent: 100, partWeightGrams: 20, machine: { tonnage: 120 } };
const press = (id, extra = {}) => ({ _id: id, code: id.toUpperCase(), tonnage: 150, shotCapacityGrams: 200, status: 'idle', active: true, ...extra });
const job = (extra = {}) => ({ _id: 'j', number: 'WO-9', status: 'planned', machine: null, mould: tool, colour: 'White', toMake: 9600 * 2, dueDay: '2026-10-24', ...extra });

test('colour steps: none for the same colour, one a step darker, double going lighter', () => {
  assert.equal(colourSteps('White', 'white'), 0);
  assert.equal(colourSteps('White', 'Black'), 5);
  assert.equal(colourSteps('Black', 'White'), 10);
  assert.equal(colourSteps(null, 'Black'), 0, 'nothing known before — no step counted');
});

test('a free press with the same mould in it wins over one that needs a mould change', () => {
  const same = press('p1', { lastMould: tool, lastColour: 'White' });
  const empty = press('p2');
  const kept = scorePress({ job: job(), press: same, plant, today });
  const changed = scorePress({ job: job(), press: empty, plant, today });
  assert.equal(kept.score, 0, 'on time, no change, no purge, starts today');
  assert.equal(changed.parts.mouldChange, 2 * SCORE_WEIGHTS.mouldChangeHour);
  assert.ok(kept.reasons.some((reason) => reason.good && /Same mould already on it/.test(reason.text)));
  assert.ok(kept.reasons.some((reason) => /Already on White — no purge/.test(reason.text)));
  assert.ok(changed.reasons.some((reason) => !reason.good && /Mould change, about 2 hr/.test(reason.text)));
  const slow = scorePress({ job: job({ mould: { ...tool, changeoverMinutes: 180 } }), press: empty, plant, today });
  assert.equal(slow.parts.mouldChange, 30, 'the mould’s own changeover time beats the plant’s');
});

test('lateness outweighs the rest: a day late costs more than a mould change and a purge', () => {
  /* p1 is on White but booked for five days with another mould; p2 is free. */
  const busy = press('p1');
  const free = press('p2');
  const queue = [{ _id: 'q', status: 'released', mould: { ...tool, _id: 'm2', mouldCode: 'M-2' }, colour: 'White', toMake: 9600 * 5 }];
  const ranked = rankPresses({ job: job(), presses: [busy, free], queues: new Map([['p1', queue], ['p2', []]]), plant, today });
  assert.equal(ranked.choices[0].machine.code, 'P2');
  const late = ranked.choices.find((choice) => choice.machine.code === 'P1');
  assert.equal(late.late, true);
  assert.equal(late.lateDays, 2);
  assert.match(late.reasons[0].text, /2 days after the due date/);
  assert.ok(late.parts.late > ranked.choices[0].score);
});

test('a big press for a small mould, a broken press and a dark-to-light purge each cost', () => {
  const huge = scorePress({ job: job(), press: press('p3', { tonnage: 400 }), plant, today });
  assert.equal(huge.parts.size, SCORE_WEIGHTS.wrongSize);
  assert.ok(huge.reasons.some((reason) => /Big press for this mould \(400 T, it needs 120 T\)/.test(reason.text)));
  const broken = scorePress({ job: job(), press: press('p4', { status: 'breakdown' }), plant, today });
  assert.equal(broken.parts.risk, SCORE_WEIGHTS.breakdown);
  const purge = scorePress({ job: job(), press: press('p5', { lastMould: tool, lastColour: 'Black' }), plant, today });
  assert.equal(purge.parts.colour, 10 * SCORE_WEIGHTS.colourStep);
  assert.ok(purge.reasons.some((reason) => /dark to light/.test(reason.text)));
});

test('the mould’s usual press is preferred; one mould cannot run on two presses at once', () => {
  const usual = rankPresses({
    job: job({ mould: { ...tool, preferredMachines: ['p2'] } }), presses: [press('p1'), press('p2')],
    queues: new Map(), plant, today,
  });
  assert.equal(usual.choices[0].machine.code, 'P2');
  assert.ok(usual.choices[0].reasons.some((reason) => /usual press/.test(reason.text)));

  /* The same tool is running WO-1 on p1 for three days: p2 would need it at the same time. */
  const queues = new Map([['p1', [{ _id: 'run', status: 'running', mould: tool, colour: 'White', toMake: 9600 * 3 }]], ['p2', []]]);
  const ranked = rankPresses({ job: job({ dueDay: '2026-10-30' }), presses: [press('p1'), press('p2')], queues, plant, today });
  const elsewhere = ranked.choices.find((choice) => choice.machine.code === 'P2');
  assert.equal(elsewhere.start, '2026-10-22', 'it waits for the tool to come off P1');
  assert.match(elsewhere.reasons.find((reason) => /is on P1/.test(reason.text)).text, /M-1 is on P1 until 21 Oct — it starts after that/);
  assert.equal(ranked.choices[0].machine.code, 'P1', 'behind its own mould, with no mould change, it costs less');
});

test('a press that cannot hold the mould is set aside with why; an unsized mould is said', () => {
  const ranked = rankPresses({ job: job(), presses: [press('p1', { tonnage: 80 }), press('p2')], queues: new Map(), plant, today });
  assert.deepEqual(ranked.choices.map((choice) => choice.machine.code), ['P2']);
  assert.match(ranked.cannot[0].why, /needs a 120 T press — P1 is 80 T/);
  const unsized = rankPresses({ job: job({ mould: { ...tool, cycleTimeSeconds: null } }), presses: [press('p2')], queues: new Map(), plant, today });
  assert.equal(unsized.sized, false);
  assert.match(unsized.why, /no cycle time/);
});

test('the fit checks the tie bars either way up, the mould height, the hot runner and the dryer', () => {
  const machine = press('p1', { tieBarWidthMm: 400, tieBarHeightMm: 350, minMouldHeightMm: 150, maxMouldHeightMm: 450, hotRunnerZones: 2, hasDryer: false });
  assert.equal(fitOf({ ...tool, widthMm: 340, heightMm: 390 }, machine).ok, true, 'turned on its side it passes');
  assert.match(fitOf({ ...tool, widthMm: 420, heightMm: 420 }, machine).blocks[0], /does not pass between P1’s tie bars \(400 × 350 mm\)/);
  assert.match(fitOf({ ...tool, thicknessMm: 500 }, machine).blocks[0], /at most 450 mm/);
  assert.match(fitOf({ ...tool, thicknessMm: 100 }, machine).blocks[0], /cannot close on less than 150 mm/);
  assert.match(fitOf({ ...tool, hotRunnerZones: 4 }, machine).blocks[0], /needs 4 hot-runner zones — P1 drives 2/);
  assert.match(fitOf({ ...tool, hotRunnerZones: 2 }, { ...machine, hotRunnerZones: 0 }).blocks[0], /no hot-runner controller/);
  const dry = fitOf({ ...tool, needsDryer: true }, machine);
  assert.equal(dry.ok, true, 'a dryer can be wheeled over — a warning, not a block');
  assert.match(dry.warnings[0], /no dryer beside it/);
  assert.equal(fitOf({ ...tool, widthMm: 900, heightMm: 900 }, press('p2')).ok, true, 'no tie-bar figure on the press — not guessed');
});

test('a tie goes to the smaller press that can hold the mould', () => {
  const ranked = rankPresses({ job: job(), presses: [press('p9', { tonnage: 220 }), press('p8', { tonnage: 180 })], queues: new Map(), plant, today });
  assert.equal(ranked.choices[0].score, ranked.choices[1].score);
  assert.equal(ranked.choices[0].machine.code, 'P8');
});
