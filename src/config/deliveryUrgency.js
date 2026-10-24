/**
 * How soon the buyer needs the goods, as marketing or Admin says it on the Dispatch request
 * [services/deliveryUrgency.service.js]. The Dispatch desk's delivery queue is ordered by it.
 *
 *   rank    the order on the queue, Top Most Urgent first
 *   day     0 = the day the urgency was given, 1 = the day after
 *   hour    the cut-off that day in India time, after which the request reads late
 *
 * Top Most Urgent has no cut-off: the truck is at the gate, and it is first whatever the clock.
 */
export const DELIVERY_URGENCIES = Object.freeze([
  { key: 'top_urgent', label: 'Top Most Urgent', rank: 0 },
  { key: 'today_morning', label: 'Today Morning', rank: 1, day: 0, hour: 12 },
  { key: 'today_evening', label: 'Today Evening', rank: 2, day: 0, hour: 19 },
  { key: 'today', label: 'Today', rank: 3, day: 0, hour: 19 },
  { key: 'tomorrow', label: 'Tomorrow', rank: 4, day: 1, hour: 19 },
]);

export const URGENCY_KEYS = DELIVERY_URGENCIES.map((entry) => entry.key);
export const urgencyOf = (key) => DELIVERY_URGENCIES.find((entry) => entry.key === key) || null;

/**
 * The urgency a Dispatch request's own "Dispatch schedule" names — the choice on the request
 * form, new wording and old: "Tomorrow First Dispatch" is still a Tomorrow.
 */
export function urgencyFromSchedule(label) {
  const text = String(label || '').toLowerCase();
  if (!text) return null;
  if (text.includes('top most') || text.includes('urgent')) return 'top_urgent';
  if (text.includes('tomorrow')) return 'tomorrow';
  if (text.includes('morning')) return 'today_morning';
  if (text.includes('evening')) return 'today_evening';
  if (text.includes('today')) return 'today';
  return null;
}

/** The request form's choices: the urgencies in the words the form uses. */
export const SCHEDULE_CHOICES = DELIVERY_URGENCIES.map((entry) => `${entry.label} Dispatch`);

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** The instant an urgency given at `at` turns late: its day's cut-off hour, India time. Null for Top Most Urgent. */
export function dueByFor(key, at = new Date()) {
  const urgency = urgencyOf(key);
  if (!urgency || urgency.hour == null) return null;
  const local = new Date(new Date(at).getTime() + IST_OFFSET_MS);
  const cutoff = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + urgency.day, urgency.hour, 0, 0);
  return new Date(cutoff - IST_OFFSET_MS);
}

/**
 * The urgency a Dispatch request carries until marketing or Admin gives one: Today, the day it
 * reached Dispatch [services/deliveryUrgency.service `askForUrgency`]. Due by 7 PM that day, or by
 * the end of that day when it came after 7 PM — a request that arrives in the evening is not late
 * the moment it lands.
 */
export const DEFAULT_URGENCY = 'today';
export function defaultDueBy(arrived = new Date()) {
  const at = new Date(arrived);
  const evening = dueByFor(DEFAULT_URGENCY, at);
  if (evening && evening > at) return evening;
  const local = new Date(at.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 23, 59, 59) - IST_OFFSET_MS);
}
