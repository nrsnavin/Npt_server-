import Sample, {
  CLOSED_SAMPLE_STATUSES, NOT_ESCALATED_STATUSES, WITH_CUSTOMER_STATUSES,
} from '../models/Sample.js';
import asyncHandler from '../utils/asyncHandler.js';
import { ownershipFilter } from '../services/ownership.service.js';

/**
 * The sampling dashboard [BLUEPRINT §22, docs/DASHBOARDS.md §4].
 *
 * Two of that spec's principles shape what this returns. **Ageing beats counts** — "12
 * pending" hides the one that has been sitting for three weeks, so every queue figure comes
 * with its oldest. And **rework rate is the quality signal for this team**: a high approval
 * rate alongside a high modification rate means samples are going out before they are right,
 * which no single number would show.
 *
 * Scoped like every other sampling read: marketing sees what it asked for, the bench sees
 * the bench.
 */

const DAY = 24 * 60 * 60 * 1000;
const ageInDays = (from, now) => Math.max(0, Math.floor((now - new Date(from).getTime()) / DAY));

/** Averages a set of millisecond spans into whole days, or null when there are none. */
const averageDays = (spans) =>
  spans.length ? Math.round((spans.reduce((sum, span) => sum + span, 0) / spans.length / DAY) * 10) / 10 : null;

/** When a sample first reached a status, from its own history. */
const reached = (sample, status) =>
  sample.statusHistory?.find((entry) => entry.to === status)?.at || null;

export const sampleDashboard = asyncHandler(async (req, res) => {
  const now = Date.now();
  const scope = ownershipFilter(req.user, 'requestedBy');

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(startOfToday.getTime() + DAY);

  const samples = await Sample.find(scope)
    .select(
      'number modelNumber colour status purpose requiredDate requestedAt createdAt ' +
        'statusHistory requestedBy assignedTo customer escalationLevel dispatchedAt'
    )
    .populate('requestedBy', 'name')
    .populate('customer', 'name');

  const open = samples.filter((sample) => !CLOSED_SAMPLE_STATUSES.includes(sample.status));

  /* ------------------------------- The three tiles ------------------------------- */

  const overdue = open.filter(
    (sample) =>
      sample.requiredDate &&
      new Date(sample.requiredDate) < new Date(now) &&
      !NOT_ESCALATED_STATUSES.includes(sample.status)
  );

  const dueToday = open.filter(
    (sample) =>
      sample.requiredDate &&
      new Date(sample.requiredDate) >= startOfToday &&
      new Date(sample.requiredDate) < endOfToday
  );

  const raisedThisWeek = samples.filter(
    (sample) => now - new Date(sample.requestedAt || sample.createdAt).getTime() < 7 * DAY
  );

  /* --------------------------------- Breakdowns --------------------------------- */

  const countBy = (rows, key) =>
    Object.entries(
      rows.reduce((counts, row) => {
        const value = typeof key === 'function' ? key(row) : row[key];
        if (!value) return counts;
        counts[value] = (counts[value] || 0) + 1;
        return counts;
      }, {})
    )
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);

  /* ------------------------------- Turnaround ------------------------------- */

  // Split at ready, because the two halves have different owners: getting there is the
  // bench's, getting it out of the door is marketing arranging a courier.
  const toReady = [];
  const readyToDispatch = [];

  for (const sample of samples) {
    const readyAt = reached(sample, 'sample_ready');
    const dispatchedAt = sample.dispatchedAt || reached(sample, 'dispatched');
    const raisedAt = sample.requestedAt || sample.createdAt;

    if (readyAt && raisedAt) toReady.push(new Date(readyAt) - new Date(raisedAt));
    if (dispatchedAt && readyAt) readyToDispatch.push(new Date(dispatchedAt) - new Date(readyAt));
  }

  /* --------------------------- Outcomes and rework --------------------------- */

  const answered = samples.filter((sample) =>
    ['approved', 'modification_required', 'rejected'].includes(sample.status)
  );
  const modified = answered.filter((sample) => sample.status === 'modification_required').length;

  /* ------------------------------ Ranked tables ------------------------------ */

  const oldestOpen = [...open]
    .filter((sample) => !WITH_CUSTOMER_STATUSES.includes(sample.status))
    .sort((a, b) => new Date(a.requestedAt || a.createdAt) - new Date(b.requestedAt || b.createdAt))
    .slice(0, 8)
    .map((sample) => ({
      _id: sample._id,
      number: sample.number,
      modelNumber: sample.modelNumber,
      customer: sample.customer?.name || null,
      status: sample.status,
      ageDays: ageInDays(sample.requestedAt || sample.createdAt, now),
      escalationLevel: sample.escalationLevel || 0,
    }));

  // The commonest silent stall [DASHBOARDS §3]: it reached them, and then nothing.
  const awaitingFeedback = open
    .filter((sample) => WITH_CUSTOMER_STATUSES.includes(sample.status))
    .map((sample) => ({
      _id: sample._id,
      number: sample.number,
      customer: sample.customer?.name || null,
      status: sample.status,
      ageDays: ageInDays(sample.dispatchedAt || reached(sample, 'dispatched') || sample.createdAt, now),
    }))
    .sort((a, b) => b.ageDays - a.ageDays)
    .slice(0, 8);

  res.json({
    success: true,
    data: {
      tiles: {
        raisedThisWeek: raisedThisWeek.length,
        dueToday: dueToday.length,
        overdue: overdue.length,
        escalated: open.filter((sample) => (sample.escalationLevel || 0) > 0).length,
        openTotal: open.length,
        unassigned: open.filter((sample) => !sample.assignedTo).length,
      },
      turnaround: {
        requestToReadyDays: averageDays(toReady),
        readyToDispatchDays: averageDays(readyToDispatch),
      },
      quality: {
        answered: answered.length,
        approved: answered.filter((sample) => sample.status === 'approved').length,
        modificationRequired: modified,
        rejected: answered.filter((sample) => sample.status === 'rejected').length,
        // The signal for this team: high approval with high rework means they go out too early.
        reworkRatePercent: answered.length ? Math.round((modified / answered.length) * 100) : null,
      },
      queueByStatus: countBy(open, 'status'),
      byPurpose: countBy(samples, 'purpose'),
      byRequester: countBy(open, (sample) => sample.requestedBy?.name),
      oldestOpen,
      awaitingFeedback,
    },
  });
});
