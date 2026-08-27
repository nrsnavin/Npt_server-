import Sample, { SAMPLE_PURPOSES, SAMPLE_STATUSES } from '../models/Sample.js';
import { HANGER_CATEGORIES, HOOK_TYPES, MATERIALS } from '../models/Product.js';

/**
 * Sample analytics: how long fulfilment takes, and what drives the difference.
 *
 * Distinct from the dashboard, which answers what is late *now*. This answers how long we
 * take and why, over a period, so the answer changes a decision rather than a to-do list.
 *
 * Three choices here matter more than the arithmetic.
 *
 * **Fulfilment is request → ready**, not request → delivered. That is the span the bench
 * controls; a courier sitting on a parcel is a real delay but not this team's, and mixing
 * them produces a number nobody can act on. Request → dispatched is reported alongside it as
 * what the customer actually experienced. Where the ready tick was skipped, the first status
 * that could only follow a finished sample stands in for it — see `readyTime`.
 *
 * **Median, p90 and the worst case accompany every mean.** An average of six days hides
 * whether the worst was eight or thirty, and every SLA conversation is about the tail. The
 * worst case is reported as well as p90 because at this plant's volumes p90 is not enough:
 * with a dozen samples in a month, the nearest-rank p90 is the eleventh-fastest, so a single
 * disaster sits above it and disappears. The one that took forty days is the one worth
 * talking about, and it has to be visible.
 *
 * **Every segment carries its sample size.** An average over two samples is noise dressed as
 * insight, so each row says how many it is drawn from and is marked unreliable below a
 * threshold rather than being quietly presented as equal to the rest.
 */

const DAY = 24 * 60 * 60 * 1000;

/** Below this a segment's average says more about luck than about the process. */
export const RELIABLE_SAMPLE_SIZE = 5;

/** The trailing window the trend always covers, whatever period the report is on. */
export const TREND_MONTHS = 12;

/** How many were asked for, smallest band first. */
export const QUANTITY_BANDS = ['1–2', '3–5', '6–10', '10+'];

/** When a sample first reached a status. */
const reached = (sample, status) =>
  sample.statusHistory?.find((entry) => entry.to === status)?.at || null;

/**
 * Statuses a sample can only be in once the sample itself exists — everything at or past
 * ready, minus the two that mean it never will (`rejected` can follow a shown sample, but
 * `cancelled` means the request was dropped and `modification_required` follows a ready one,
 * so both are kept: what is excluded is only the pre-ready work).
 */
const AT_OR_PAST_READY = SAMPLE_STATUSES.slice(SAMPLE_STATUSES.indexOf('sample_ready')).filter(
  (status) => status !== 'cancelled'
);

/**
 * When the sample was ready.
 *
 * Nothing forces the bench to tick `sample_ready` — the status route accepts any status, and
 * in practice a sample is sometimes marked dispatched the moment the parcel is handed over.
 * Reading only the ready tick would drop every such sample from the average, leaving a figure
 * computed over whoever was diligent about the boxes rather than over the work. So when the
 * tick is missing, the earliest status that could only have been reached *after* the sample
 * existed stands in: it is a real upper bound on ready, which is the honest reading.
 */
export function readyTime(sample) {
  const ticked = reached(sample, 'sample_ready');
  if (ticked) return ticked;

  const implied = (sample.statusHistory || [])
    .filter((entry) => AT_OR_PAST_READY.includes(entry.to) && entry.at)
    .map((entry) => new Date(entry.at));

  return implied.length ? new Date(Math.min(...implied)) : null;
}

/**
 * Nearest-rank percentile: the smallest value at or above which p of the set falls.
 *
 * Nearest-rank rather than interpolated because these are durations of real samples — p90
 * should be a duration something actually took, not an average of two that did not.
 */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

const round = (value, places = 1) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const mean = (values) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

/** The shape every segment reports, so a breakdown row and the headline are comparable. */
export function summarise(samples) {
  const days = samples
    .map((sample) => sample.fulfilmentMs)
    .filter((value) => value != null)
    .map((value) => value / DAY);

  const dated = samples.filter((sample) => sample.requiredDate && sample.readyAt);
  const onTime = dated.filter((sample) => new Date(sample.readyAt) <= new Date(sample.requiredDate));

  const answered = samples.filter((sample) =>
    ['approved', 'modification_required', 'rejected'].includes(sample.status)
  );
  const reworked = answered.filter((sample) => sample.status === 'modification_required');

  return {
    fulfilled: days.length,
    total: samples.length,
    averageDays: days.length ? round(mean(days)) : null,
    medianDays: days.length ? round(percentile(days, 50)) : null,
    p90Days: days.length ? round(percentile(days, 90)) : null,
    // p90 cannot see a one-in-twelve outlier; this can.
    worstDays: days.length ? round(Math.max(...days)) : null,
    // A promise kept matters as much as the duration: six days is fine if six was the promise.
    onTimePercent: dated.length ? Math.round((onTime.length / dated.length) * 100) : null,
    onTimeOf: dated.length,
    reworkPercent: answered.length ? Math.round((reworked.length / answered.length) * 100) : null,
    reworkOf: answered.length,
    reliable: days.length >= RELIABLE_SAMPLE_SIZE,
  };
}

/** Groups samples by an attribute and summarises each group, busiest first. */
function breakdown(samples, keyOf, { order } = {}) {
  const groups = new Map();

  for (const sample of samples) {
    const key = keyOf(sample);
    if (key == null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  }

  const rows = [...groups.entries()].map(([label, members]) => ({
    label,
    ...summarise(members),
  }));

  // A declared order keeps a chart stable as volumes move; otherwise busiest first.
  return order
    ? rows.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label))
    : rows.sort((a, b) => b.total - a.total);
}

/**
 * Where the days actually go.
 *
 * Total duration says a sample took nine days; this says six of them were in production
 * required. Only the latter tells anybody what to change. Computed from consecutive pairs in
 * the status history, so the time is attributed to the status it was *spent in*.
 *
 * Each row says whether it falls before ready. The headline turnaround deliberately stops at
 * ready, so a reader adding these up would otherwise reach a larger number and conclude one
 * of the two figures is wrong — when in fact the extra days are the courier's and the
 * customer's. Flagged rather than dropped, because how long a buyer sits on a sample is
 * worth knowing; it just is not the bench's to fix.
 */
function timeInStage(samples) {
  const totals = new Map();

  for (const sample of samples) {
    const history = sample.statusHistory || [];
    for (let index = 0; index < history.length - 1; index += 1) {
      const from = history[index];
      const to = history[index + 1];
      if (!from.at || !to.at) continue;

      const spent = new Date(to.at) - new Date(from.at);
      if (spent <= 0) continue;

      const current = totals.get(from.to) || { totalMs: 0, occurrences: 0 };
      current.totalMs += spent;
      current.occurrences += 1;
      totals.set(from.to, current);
    }
  }

  const readyIndex = SAMPLE_STATUSES.indexOf('sample_ready');

  return [...totals.entries()]
    .map(([label, { totalMs, occurrences }]) => ({
      label,
      averageDays: round(totalMs / occurrences / DAY),
      occurrences,
      beforeReady: SAMPLE_STATUSES.indexOf(label) < readyIndex,
    }))
    .sort((a, b) => b.averageDays - a.averageDays);
}

/**
 * Month-by-month, so a change in turnaround is visible rather than inferred.
 *
 * Always over the trailing year, never over the period the rest of the report is on. Asking
 * for this month's figures is the common case, and a trend one column wide is not a trend —
 * the question a chart answers is whether this month is better or worse than the ones before
 * it, which needs the ones before it on the page.
 */
function trend(samples, to, monthsBack = TREND_MONTHS) {
  const months = [];
  const cursor = new Date(to.getFullYear(), to.getMonth() - (monthsBack - 1), 1);

  while (cursor <= to) {
    const start = new Date(cursor);
    const end = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);

    const raised = samples.filter((sample) => {
      const at = new Date(sample.requestedAt);
      return at >= start && at < end;
    });
    const fulfilled = samples.filter((sample) => {
      if (!sample.readyAt) return false;
      const at = new Date(sample.readyAt);
      return at >= start && at < end;
    });

    const days = fulfilled.map((sample) => sample.fulfilmentMs / DAY);

    months.push({
      month: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`,
      raised: raised.length,
      fulfilled: fulfilled.length,
      averageDays: days.length ? round(mean(days)) : null,
    });

    cursor.setMonth(cursor.getMonth() + 1);
  }

  return months;
}

/**
 * Builds the analytics for a period.
 *
 * `scope` is the ownership filter the caller is entitled to, so marketing analyses what it
 * asked for and the bench analyses the bench.
 */
export async function sampleAnalytics({ scope = {}, from, to }) {
  const raw = await Sample.find(scope).select(
    'status purpose category material hookType printing quantity requiredDate requestedAt ' +
      'createdAt statusHistory dispatchedAt deliveredAt'
  );

  // Decorate once: every figure below is derived from these two spans.
  const all = raw.map((sample) => {
    const requestedAt = sample.requestedAt || sample.createdAt;
    const readyAt = readyTime(sample);
    const dispatchedAt = sample.dispatchedAt || reached(sample, 'dispatched');

    return {
      status: sample.status,
      purpose: sample.purpose,
      category: sample.category,
      material: sample.material,
      hookType: sample.hookType,
      printing: sample.printing,
      quantity: sample.quantity,
      requiredDate: sample.requiredDate,
      requestedAt,
      readyAt,
      statusHistory: sample.statusHistory,
      fulfilmentMs: readyAt ? new Date(readyAt) - new Date(requestedAt) : null,
      toCustomerMs: dispatchedAt ? new Date(dispatchedAt) - new Date(requestedAt) : null,
    };
  });

  // A sample counts in the period it was *fulfilled* in, which is what "fulfilled this month"
  // means. Raised-in-period is reported separately, since the two answer different questions.
  const inPeriod = all.filter(
    (sample) => sample.readyAt && new Date(sample.readyAt) >= from && new Date(sample.readyAt) <= to
  );
  const raisedInPeriod = all.filter(
    (sample) => new Date(sample.requestedAt) >= from && new Date(sample.requestedAt) <= to
  );

  const toCustomer = inPeriod
    .map((sample) => sample.toCustomerMs)
    .filter((value) => value != null)
    .map((value) => value / DAY);

  return {
    period: { from, to },
    headline: {
      ...summarise(inPeriod),
      raised: raisedInPeriod.length,
      // Still open at the end of the period: a queue that grows is the real warning.
      openAtEnd: all.filter((sample) => !sample.readyAt).length,
      toCustomerAverageDays: toCustomer.length ? round(mean(toCustomer)) : null,
      toCustomerP90Days: toCustomer.length ? round(percentile(toCustomer, 90)) : null,
    },
    trendMonths: TREND_MONTHS,
    trend: trend(all, to),
    timeInStage: timeInStage(inPeriod),
    byPurpose: breakdown(inPeriod, (sample) => sample.purpose, { order: SAMPLE_PURPOSES }),
    // Printing is free text — what matters analytically is whether there was any.
    byPrinting: breakdown(inPeriod, (sample) =>
      sample.printing?.trim() ? 'printed' : 'plain'
    ),
    byHookType: breakdown(inPeriod, (sample) => sample.hookType, { order: HOOK_TYPES }),
    byMaterial: breakdown(inPeriod, (sample) => sample.material, { order: MATERIALS }),
    byCategory: breakdown(inPeriod, (sample) => sample.category, { order: HANGER_CATEGORIES }),
    // Declared order, not busiest first: a band is ordinal, and a table reading 6–10, 3–5,
    // 10+, 1–2 makes the reader sort it in their head before they can see the trend in it.
    byQuantity: breakdown(
      inPeriod,
      (sample) => {
        const quantity = sample.quantity || 0;
        if (quantity <= 2) return '1–2';
        if (quantity <= 5) return '3–5';
        if (quantity <= 10) return '6–10';
        return '10+';
      },
      { order: QUANTITY_BANDS }
    ),
  };
}
