import Sample, { IN_WORK_STATUSES, WITH_CUSTOMER_STATUSES } from '../models/Sample.js';

/**
 * A nudge on a sample sitting at one status past its usual time [the sampling audit, item 5] —
 * "at Checking stock two days, usual is four hours". A rule, not the model: the usual time is the
 * median the bench itself has taken at that status over the last ninety days, and a nudge is a
 * suggestion on the row, never an escalation [§25's sweep stays the only thing that escalates].
 */

const HOUR = 3600000;
const DAY = 24 * HOUR;
/** Below this the plant has not been at a status often enough for a "usual" to mean anything. */
const ENOUGH = 5;
/** A nudge needs the dwell to be well past the usual, and never for a wait under this. */
const PAST_FACTOR = 2;
const AT_LEAST_HOURS = 4;
/** Where no history says otherwise, what the bench would call too long at each status. */
export const DEFAULT_USUAL_HOURS = {
  request_received: 4,
  checking_stock: 4,
  sample_available: 8,
  production_required: 48,
  printing_required: 24,
  sample_ready: 24,
  dispatched: 3 * 24,
  delivered: 2 * 24,
  customer_feedback_pending: 3 * 24,
};

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * The usual hours at each status, from the bench's own history: the median dwell between a
 * move into a status and the move out of it, over samples touched in the last ninety days.
 * Falls back to the defaults where the plant has not been there often enough.
 */
export async function usualHoursAtStatus({ now = Date.now(), days = 90 } = {}) {
  const recent = await Sample.find({ updatedAt: { $gte: new Date(now - days * DAY) } }).select('statusHistory').lean();
  const dwell = {};
  for (const sample of recent) {
    const history = (sample.statusHistory || []).filter((entry) => entry.at).sort((a, b) => new Date(a.at) - new Date(b.at));
    for (let i = 0; i + 1 < history.length; i += 1) {
      const hours = (new Date(history[i + 1].at) - new Date(history[i].at)) / HOUR;
      if (hours <= 0) continue;
      (dwell[history[i].to] ||= []).push(hours);
    }
  }
  const usual = { ...DEFAULT_USUAL_HOURS };
  for (const [status, hours] of Object.entries(dwell)) {
    if (hours.length >= ENOUGH) usual[status] = Math.max(1, Math.round(median(hours)));
  }
  return usual;
}

/** When a sample reached its current status — the last move to it, or when it was raised. */
export function atStatusSince(sample) {
  const last = [...(sample.statusHistory || [])].reverse().find((entry) => entry.to === sample.status && entry.at);
  return new Date(last?.at || sample.requestedAt || sample.createdAt || Date.now());
}

const hoursWords = (hours) => (hours >= 48 ? `${Math.round(hours / 24)} days` : hours >= 24 ? '1 day' : `${Math.round(hours)} h`);
const stageWords = (status) => String(status || '').replace(/_/g, ' ');

/**
 * The nudge for one sample, or null: its dwell at the current status against the usual. Only
 * for statuses with something to do — the bench's, and the buyer's three, where the nudge is
 * marketing's to chase.
 */
export function nudgeFor(sample, usual = DEFAULT_USUAL_HOURS, now = Date.now()) {
  const status = sample.status;
  if (!IN_WORK_STATUSES.includes(status) && !WITH_CUSTOMER_STATUSES.includes(status) && status !== 'request_received') return null;
  const expected = usual[status] || DEFAULT_USUAL_HOURS[status];
  if (!expected) return null;
  const hours = (now - atStatusSince(sample).getTime()) / HOUR;
  if (hours < Math.max(AT_LEAST_HOURS, expected * PAST_FACTOR)) return null;
  const where = WITH_CUSTOMER_STATUSES.includes(status) ? 'with the buyer' : `at ${stageWords(status)}`;
  return { text: `${hoursWords(hours)} ${where} — usual is ${hoursWords(expected)}`, hours: Math.round(hours), usualHours: expected, status };
}
