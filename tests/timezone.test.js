/**
 * The plant's day on a server that keeps UTC [config/timezone.js].
 *
 * Plain Date arithmetic is used for "today" across the app — the start of the day, tomorrow, due
 * today. On a UTC machine that day began at 05:30 in India, so for five and a half hours every
 * morning the app was still on yesterday.
 *
 *   node --test tests/timezone.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'UTC';
process.env.JWT_SECRET ||= 'timezone-test-secret';
delete process.env.APP_TIMEZONE;

test('the app runs on India’s day even when the machine keeps UTC', async () => {
  /* 01:30 in India on 12 October is still 11 October in UTC. */
  const earlyMorning = new Date('2026-10-11T20:00:00Z');
  assert.equal(earlyMorning.getDate(), 11, 'precondition: a UTC clock says the 11th');

  await import('../src/app.js');

  assert.equal(process.env.TZ, 'Asia/Kolkata');
  assert.equal(earlyMorning.getDate(), 12, 'India’s date');
  const startOfToday = new Date(earlyMorning);
  startOfToday.setHours(0, 0, 0, 0);
  assert.equal(startOfToday.toISOString(), '2026-10-11T18:30:00.000Z', 'midnight in India, not in Greenwich');
});
