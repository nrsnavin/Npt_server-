/**
 * Whether an order on the press will make its EDD, read off its quantity [web: components/
 * ProductionQueueList.jsx]. Four readings, one colour each:
 *
 *   late      red     the EDD has passed and the goods are not ready
 *   at_risk   orange  the pieces still to mould take more press days than the days left —
 *                     started today, they finish after the EDD [capacity.service `estimate`]
 *   close     yellow  the EDD is within three days, or the press days leave a day or less to spare
 *   on_track  green   the rest
 *
 * `none` when there is no EDD to read against (the undated band says so already), or the task
 * is ready for dispatch or closed — a finished job is not at risk whatever its date.
 *
 * Pure: the queue hands it the figures it already has, so it is tested without a database.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const CLOSE_WITHIN_DAYS = 3;
export const SLACK_DAYS = 1;
export const RISK_LEVELS = ['late', 'at_risk', 'close', 'on_track'];
/** The statuses where the goods are made: the EDD no longer threatens them. */
export const DONE_STATUSES = ['ready_dispatch', 'closed', 'completed', 'handed_printing', 'handed_assembly'];

const indiaDay = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
const dayOf = (value) => (value ? (value instanceof Date ? indiaDay(value) : String(value).slice(0, 10)) : null);
const daysBetween = (fromDay, toDay) => Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS);
const pcs = (n) => Number(n || 0).toLocaleString('en-IN');
const days = (n) => `${n} day${n === 1 ? '' : 's'}`;

/**
 * @param edd    the EDD as YYYY-MM-DD, or null
 * @param left   pieces still to mould (the order quantity less what the runs have made)
 * @param est    the press-time estimate for those pieces [capacity.service `estimate`]: `{ days, finish }`, or null
 * @param status the Production task's status
 * @param now    the clock
 */
export function riskOf({ edd, left = 0, est = null, status = null, now = new Date() }) {
  const day = dayOf(edd);
  if (!day) return { level: 'none', why: null, daysLeft: null, daysNeeded: est?.days ?? null, left };
  if (DONE_STATUSES.includes(status)) return { level: 'none', why: 'Made', daysLeft: null, daysNeeded: 0, left };
  const today = indiaDay(now);
  const daysLeft = daysBetween(today, day);
  const daysNeeded = est?.days ?? null;
  const finish = dayOf(est?.finish);
  const base = { daysLeft, daysNeeded, left, finish };
  if (daysLeft < 0) {
    return { ...base, level: 'late', why: `Past the EDD by ${days(-daysLeft)}${left > 0 ? ` — ${pcs(left)} pcs still to make` : ''}` };
  }
  if (left > 0 && finish && finish > day) {
    return { ...base, level: 'at_risk', why: `May miss the EDD — ${days(daysNeeded)} on the press for ${pcs(left)} pcs, ${days(daysLeft)} left` };
  }
  if (daysLeft <= CLOSE_WITHIN_DAYS || (daysNeeded != null && left > 0 && daysLeft - daysNeeded <= SLACK_DAYS)) {
    return { ...base, level: 'close', why: `Close to the EDD — ${daysLeft === 0 ? 'due today' : `${days(daysLeft)} left`}${daysNeeded && left > 0 ? `, ${days(daysNeeded)} on the press` : ''}` };
  }
  return { ...base, level: 'on_track', why: `On track — ${days(daysLeft)} left${daysNeeded && left > 0 ? `, ${days(daysNeeded)} on the press` : ''}` };
}

/**
 * The same four readings for Printing's and Assembly's queues [finishingQueue.controller], with
 * no press rate to count by: red past the date the team works to; orange when the goods have not
 * come and the team before said it hands over on or after that date (or gave no day and the date
 * is tomorrow or today); yellow within three days; green otherwise. None without a date, or once
 * the team says ready.
 *
 * @param edd      the date the team works to (its own, else the enquiry's), YYYY-MM-DD
 * @param waiting  models still with the team before
 * @param expected the earliest day the team before said it hands those over, or null
 * @param ready    the task reads Ready for Dispatch, handed on, or closed
 */
export function riskOfFinishing({ edd, waiting = 0, expected = null, ready = false, now = new Date() }) {
  const day = dayOf(edd);
  if (!day) return { level: 'none', why: null, daysLeft: null };
  if (ready) return { level: 'none', why: 'Ready', daysLeft: null };
  const today = indiaDay(now);
  const daysLeft = daysBetween(today, day);
  const due = dayOf(expected);
  const base = { daysLeft, expected: due };
  if (daysLeft < 0) return { ...base, level: 'late', why: `Past the EDD by ${days(-daysLeft)}` };
  if (waiting > 0 && ((due && due >= day) || (!due && daysLeft <= 1))) {
    return { ...base, level: 'at_risk', why: due ? `May miss the EDD — the goods come ${due === day ? 'on the EDD itself' : `${days(daysBetween(day, due))} after it`}` : `May miss the EDD — the goods are not here and ${daysLeft === 0 ? 'it is today' : 'it is tomorrow'}` };
  }
  if (daysLeft <= CLOSE_WITHIN_DAYS) return { ...base, level: 'close', why: `Close to the EDD — ${daysLeft === 0 ? 'due today' : `${days(daysLeft)} left`}${waiting > 0 && due ? `, goods due ${days(daysBetween(today, due))} from now` : ''}` };
  return { ...base, level: 'on_track', why: `On track — ${days(daysLeft)} left` };
}
