/**
 * Will an order make its EDD, from the quantity [services/eddRisk.service.js]: red past
 * the EDD, orange when the pieces left take more press days than the days left, yellow close to
 * the EDD, green on track; nothing without an EDD or once the goods are made.
 *
 *   node --test tests/edd-risk.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { riskOf, RISK_LEVELS } from '../src/services/eddRisk.service.js';

const indiaDay = (offset = 0, from = NOW) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(from.getTime() + offset * 86400000));
/* A fixed clock, mid-morning in India, so "today" is one day wherever the test runs. */
const NOW = new Date('2026-10-22T05:00:00Z');
const est = (days, finishOffset) => ({ days, finish: new Date(NOW.getTime() + finishOffset * 86400000) });

test('the four readings, in order', () => {
  assert.deepEqual(RISK_LEVELS, ['late', 'at_risk', 'close', 'on_track']);
});

test('past the EDD is red, however many pieces are left', () => {
  const read = riskOf({ edd: indiaDay(-2), left: 4000, est: est(1, 0), status: 'started', now: NOW });
  assert.equal(read.level, 'late');
  assert.equal(read.daysLeft, -2);
  assert.match(read.why, /Past the EDD by 2 days — 4,000 pcs still to make/);
  const nothingLeft = riskOf({ edd: indiaDay(-1), left: 0, est: null, status: 'started', now: NOW });
  assert.equal(nothingLeft.level, 'late');
  assert.match(nothingLeft.why, /Past the EDD by 1 day$/);
});

test('orange when the press days for the pieces left run past the EDD', () => {
  /* 30,000 pieces at 6,000 a day: five press days, finishing four days out, against an EDD in two. */
  const read = riskOf({ edd: indiaDay(2), left: 30000, est: est(5, 4), status: 'started', now: NOW });
  assert.equal(read.level, 'at_risk');
  assert.equal(read.daysNeeded, 5);
  assert.match(read.why, /May miss the EDD — 5 days on the press for 30,000 pcs, 2 days left/);
});

test('yellow within three days of the EDD, or with a day or less to spare', () => {
  const soon = riskOf({ edd: indiaDay(3), left: 2000, est: est(1, 0), status: 'started', now: NOW });
  assert.equal(soon.level, 'close');
  assert.match(soon.why, /Close to the EDD — 3 days left, 1 day on the press/);
  const today = riskOf({ edd: indiaDay(0), left: 500, est: est(1, 0), status: 'started', now: NOW });
  assert.equal(today.level, 'close');
  assert.match(today.why, /due today/);
  /* Ten days out, but nine press days: a day to spare is close. */
  const tight = riskOf({ edd: indiaDay(10), left: 90000, est: est(9, 8), status: 'started', now: NOW });
  assert.equal(tight.level, 'close');
});

test('green when the press days fit the days left', () => {
  const read = riskOf({ edd: indiaDay(10), left: 12000, est: est(2, 1), status: 'started', now: NOW });
  assert.equal(read.level, 'on_track');
  assert.match(read.why, /On track — 10 days left, 2 days on the press/);
});

test('no reading without an EDD, and none once the goods are made', () => {
  assert.equal(riskOf({ edd: null, left: 5000, est: est(1, 0), status: 'started', now: NOW }).level, 'none');
  const made = riskOf({ edd: indiaDay(-3), left: 0, est: null, status: 'ready_dispatch', now: NOW });
  assert.equal(made.level, 'none');
  assert.equal(made.why, 'Made');
  assert.equal(riskOf({ edd: indiaDay(-3), left: 0, est: null, status: 'closed', now: NOW }).level, 'none');
  /* Handed to Printing: moulding is done; the EDD is Printing's and Assembly's to meet now. */
  assert.equal(riskOf({ edd: indiaDay(1), left: 1000, est: est(1, 0), status: 'handed_printing', now: NOW }).level, 'none');
});
