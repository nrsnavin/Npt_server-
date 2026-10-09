import Sample, {
  CLOSED_SAMPLE_STATUSES, IN_WORK_STATUSES, NOT_ESCALATED_STATUSES, SAMPLE_NEXT_STEP,
  WITH_CUSTOMER_STATUSES,
} from '../models/Sample.js';
import Query from '../models/Query.js';
import asyncHandler from '../utils/asyncHandler.js';
import { ownershipFilter } from '../services/ownership.service.js';
import { stalledSamples } from '../services/anomaly.service.js';
import { readyTime, sampleAnalytics } from '../services/sampleAnalytics.service.js';

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
    .populate('customer', 'name')
    /* Plain objects: this screen reads fields and never saves, and building a full document for
       every sample the bench has ever made was most of what it cost. */
    .lean();

  const open = samples.filter((sample) => !CLOSED_SAMPLE_STATUSES.includes(sample.status));

  // Scoped like everything else on this screen, so the bench sees the bench's.
  const stalled = await stalledSamples({ filter: scope, now, limit: 10 });

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
    // Shared with the analytics page rather than recomputed: two screens quoting a different
    // average turnaround for the same bench is worse than either being wrong on its own.
    const readyAt = readyTime(sample);
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
        stalled: stalled.length,
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
      /*
       * What has gone quiet. Distinct from `overdue`, and the more useful of the two: overdue
       * says a date has passed, this says nobody is working on it. A sample due in ten days
       * that nobody has opened for three is invisible to the first and is what becomes it.
       */
      stalled,
      byPurpose: countBy(samples, 'purpose'),
      byRequester: countBy(open, (sample) => sample.requestedBy?.name),
      oldestOpen,
      awaitingFeedback,
    },
  });
});

/**
 * The analytics period.
 *
 * Defaults to this calendar month, because "fulfilled this month" is the question people
 * actually ask. `from` and `to` override it; `months=N` asks for the last N whole months
 * including this one, which is what a trend needs.
 */
function periodFrom(query) {
  const now = new Date();

  if (query.from || query.to) {
    const from = query.from ? new Date(query.from) : new Date(now.getFullYear(), 0, 1);
    const to = query.to ? new Date(query.to) : now;
    to.setHours(23, 59, 59, 999);
    return { from, to };
  }

  const months = Math.min(Math.max(Number(query.months) || 1, 1), 24);
  const from = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  return { from, to };
}

export const sampleAnalyticsReport = asyncHandler(async (req, res) => {
  const { from, to } = periodFrom(req.query);

  const data = await sampleAnalytics({
    scope: ownershipFilter(req.user, 'requestedBy'),
    from,
    to,
  });

  res.json({ success: true, data });
});

/* ------------------------------ The bench's day ------------------------------ */

/**
 * What the sample team should do now [BLUEPRINT §4-6, and §22's own principle].
 *
 * A different question from the dashboard above, and worth its own endpoint rather than a
 * fourth section on that one. `/samples/dashboard` answers *how is the team doing* — ageing,
 * rework rate, throughput — which somebody opens on a Monday. This answers *what do I pick up
 * next*, which somebody opens every hour, and the two would fight for the same screen.
 *
 * Three buckets, and the order is the order the bench should work them:
 *
 *   **New** — nobody has started it. Split by whether anyone has claimed it, because an
 *   unclaimed request is the one that quietly belongs to nobody; that is the failure a shared
 *   queue has and a personal list does not.
 *
 *   **Overdue** — past the date it was wanted, and still ours. A sample sitting with the
 *   customer is not the bench being late, so those are excluded on the same list §25's alarm
 *   uses rather than a second definition of the same thing.
 *
 *   **In work** — started, on time, and each one carrying *what the next thing is*. "Pending
 *   action: 7" is a number nobody can act on; seven rows each saying "get it printed" or "say
 *   whether there is stock" is a morning's plan.
 *
 * Scoped like every other sampling read: marketing sees what it asked for, the bench sees the
 * bench's whole queue.
 */
export const sampleDay = asyncHandler(async (req, res) => {
  const now = Date.now();
  const scope = ownershipFilter(req.user, 'requestedBy');

  const samples = await Sample.find({
    ...scope,
    status: { $nin: CLOSED_SAMPLE_STATUSES },
  })
    .select(
      'number modelNumber colour colourMandatory status purpose requiredDate requestedAt ' +
        'createdAt requestedBy assignedTo customer escalationLevel'
    )
    .populate('requestedBy', 'name')
    .populate('assignedTo', 'name')
    /* The customer's owner as well as its name [§29] — not the same person as the requester,
       and the one the buyer will actually ring when a sample slips. */
    .populate({ path: 'customer', select: 'name assignedTo', populate: { path: 'assignedTo', select: 'name' } })
    .limit(500);

  const mine = (sample) => String(sample.assignedTo?._id || sample.assignedTo) === String(req.user._id);

  /** One row, as the day screen draws it. */
  const card = (sample) => ({
    _id: sample._id,
    number: sample.number,
    model: sample.modelNumber || '—',
    colour: sample.colour,
    /* Whether the bench may reach for the nearest drum. The costliest wrong turn on this screen,
       so the card carries it rather than making somebody open the request to find out. */
    colourMandatory: Boolean(sample.colourMandatory),
    status: sample.status,
    purpose: sample.purpose,
    customer: sample.customer?.name || null,
    /* Who the buyer belongs to, which is who hears about it when this slips. */
    customerOwner: sample.customer?.assignedTo?.name || null,
    requestedBy: sample.requestedBy?.name,
    assignedTo: sample.assignedTo?.name || null,
    mine: mine(sample),
    requiredDate: sample.requiredDate || null,
    /* How long it has been sitting, which is the figure §22 says beats a count. */
    waitingDays: ageInDays(sample.requestedAt || sample.createdAt, now),
    daysLate: sample.requiredDate ? ageInDays(sample.requiredDate, now) : 0,
    nextStep: SAMPLE_NEXT_STEP[sample.status] || null,
    link: `/samples/${sample._id}`,
  });

  const isOverdue = (sample) =>
    sample.requiredDate &&
    new Date(sample.requiredDate) < new Date(now) &&
    !NOT_ESCALATED_STATUSES.includes(sample.status);

  /* Oldest first throughout: the queue is worked from the top, and the top is what has waited. */
  const oldestFirst = (a, b) =>
    new Date(a.requestedAt || a.createdAt) - new Date(b.requestedAt || b.createdAt);

  const fresh = samples.filter((sample) => sample.status === 'request_received').sort(oldestFirst);

  /*
   * Overdue is taken first, so a late request appears once. A row in both lists would be read
   * as two jobs, and the count at the top of the screen would be wrong by exactly the number
   * of things going worst.
   */
  const late = samples.filter(isOverdue).sort(oldestFirst);
  const lateIds = new Set(late.map((sample) => String(sample._id)));

  const inWork = samples
    .filter(
      (sample) => IN_WORK_STATUSES.includes(sample.status) && !lateIds.has(String(sample._id))
    )
    .sort(oldestFirst);

  res.json({
    success: true,
    data: {
      fresh: fresh.map(card),
      overdue: late.map(card),
      inWork: inWork.map(card),
    },
    meta: {
      fresh: fresh.length,
      /*
       * Unclaimed across everything open, not only the new ones.
       *
       * It was the new bucket alone at first, and that read wrongly on the screen: a late
       * request nobody has picked up would sit there marked "Unclaimed" under a heading saying
       * everything had been claimed. And it is the worse case of the two — a request that is
       * both late and nobody's is exactly the one a shared queue loses.
       */
      unclaimed: samples.filter((sample) => !sample.assignedTo).length,
      overdue: late.length,
      inWork: inWork.length,
      mine: samples.filter(mine).length,
    },
  });
});

/* ------------------------------ The work queue ------------------------------ */

/**
 * The six things the sampling team says about a request, and the statuses behind each.
 *
 * The bench's own statuses are finer than this — stock checked, moulding, printing — and they
 * stay on the request for whoever wants them. The queue speaks in the team's words: received,
 * not available, under process, ready, sent, closed.
 */
export const QUEUE_STATUSES = [
  { key: 'received', label: 'Sample Request Received', statuses: ['request_received'] },
  { key: 'not_available', label: 'Sample Not Available', statuses: ['not_available'] },
  {
    key: 'under_process',
    label: 'Sample Under Process',
    statuses: ['checking_stock', 'sample_available', 'production_required', 'printing_required'],
  },
  { key: 'ready', label: 'Sample Ready', statuses: ['sample_ready'] },
  {
    key: 'sent',
    label: 'Sample Sent',
    statuses: ['dispatched', 'delivered', 'customer_feedback_pending', 'approved', 'modification_required', 'rejected'],
  },
  { key: 'closed', label: 'Task Closed', statuses: ['cancelled'] },
];

const queueStatusOf = (sample) =>
  sample.benchClosedAt
    ? 'closed'
    : QUEUE_STATUSES.find((entry) => entry.statuses.includes(sample.status))?.key || 'received';

/** How long a closed task stays under "Task Closed" before it drops off the queue. */
const CLOSED_SHOWN_DAYS = 30;

/** What a row's request says, in the bench's shorthand: model — material : colour — rule — pieces. */
const itemLine = (item) =>
  [
    item.modelNumber || 'New model',
    [item.material?.toUpperCase(), item.colour?.toUpperCase()].filter(Boolean).join(' : ') || null,
    item.colour ? (item.colourMandatory ? 'Exact colour' : 'Preferred colour') : null,
    `${item.quantity || 1} pcs`,
  ]
    .filter(Boolean)
    .join(' — ');

/**
 * The sampling department's work queue.
 *
 * One row per request, with the customer, who asked, what is wanted, who has it, where it
 * stands, how urgent it is, and the handover once it has gone. Open rows first, then what the
 * team closed in the last month — the screen filters between them, so one read answers every
 * chip without a round trip.
 */
export const sampleQueue = asyncHandler(async (req, res) => {
  const now = Date.now();
  const scope = ownershipFilter(req.user, 'requestedBy');

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(startOfToday.getTime() + DAY);
  const closedSince = new Date(now - CLOSED_SHOWN_DAYS * DAY);

  const samples = await Sample.find({
    ...scope,
    $or: [
      { benchClosedAt: null, status: { $nin: CLOSED_SAMPLE_STATUSES } },
      { updatedAt: { $gte: closedSince } },
    ],
  })
    .select(
      'number items modelNumber material colour colourMandatory quantity remarks purpose status ' +
        'requiredDate requestedAt createdAt updatedAt requestedBy assignedTo customer enquiry ' +
        'escalationLevel courier awbNumber deliveryMethod handedTo recipientPhone dispatchedAt ' +
        'dispatchedQuantity dispatchedColour benchClosedAt statusHistory'
    )
    .populate('requestedBy', 'name')
    .populate('assignedTo', 'name')
    .populate('customer', 'name')
    .populate('enquiry', 'number status')
    .sort({ requiredDate: 1, createdAt: 1 })
    .limit(500)
    .lean();

  const rows = samples.map((sample) => {
    const queueStatus = queueStatusOf(sample);
    const closed = queueStatus === 'closed' || CLOSED_SAMPLE_STATUSES.includes(sample.status);
    const unsent = ['received', 'not_available', 'under_process', 'ready'].includes(queueStatus);
    const due = sample.requiredDate ? new Date(sample.requiredDate) : null;
    const late = Boolean(!closed && unsent && due && due < startOfToday);
    const dueToday = Boolean(!closed && unsent && due && due >= startOfToday && due < endOfToday);
    const urgent = !closed && (late || dueToday || (sample.escalationLevel || 0) > 0);
    const items = sample.items?.length ? sample.items : [sample];
    const lastNote = [...(sample.statusHistory || [])].reverse().find((entry) => entry.note)?.note;

    return {
      _id: sample._id,
      number: sample.number,
      customer: sample.customer ? { _id: sample.customer._id, name: sample.customer.name } : null,
      enquiry: sample.enquiry ? { _id: sample.enquiry._id, number: sample.enquiry.number, status: sample.enquiry.status } : null,
      requestedBy: sample.requestedBy?.name || null,
      assignedTo: sample.assignedTo ? { _id: sample.assignedTo._id, name: sample.assignedTo.name } : null,
      models: items.map((item) => ({
        model: item.modelNumber || null,
        material: item.material || null,
        colour: item.colour || null,
        colourMandatory: Boolean(item.colourMandatory),
        quantity: item.quantity || 1,
      })),
      pieces: items.reduce((sum, item) => sum + (item.quantity || 1), 0),
      colour: sample.colour || null,
      request: [sample.remarks, items.map(itemLine).join('; ')].filter(Boolean).join(' | '),
      status: sample.status,
      queueStatus,
      lastNote: lastNote || null,
      fresh: sample.status === 'request_received',
      closed,
      late,
      dueToday,
      priority: urgent ? 'urgent' : 'normal',
      highlighted: urgent || sample.status === 'not_available',
      requiredDate: sample.requiredDate || null,
      handover: WITH_CUSTOMER_STATUSES.includes(sample.status) || sample.dispatchedAt
        ? {
          method: sample.deliveryMethod || (sample.courier ? 'courier' : null),
          courier: sample.courier || null,
          awbNumber: sample.awbNumber || null,
          handedTo: sample.handedTo || null,
          recipientPhone: sample.recipientPhone || null,
          at: sample.dispatchedAt || null,
          quantity: sample.dispatchedQuantity || null,
          colour: sample.dispatchedColour || null,
        }
        : null,
      link: `/samples/${sample._id}`,
    };
  });

  const open = rows.filter((row) => !row.closed);
  const unsentOpen = open.filter((row) => ['received', 'not_available', 'under_process', 'ready'].includes(row.queueStatus));

  /* Questions put to the sampling department and not yet closed — the "internal tags". */
  const internalTags = await Query.countDocuments({
    'participants.department': 'sampling',
    status: { $ne: 'closed' },
  });

  res.json({
    success: true,
    data: {
      rows: [...open, ...rows.filter((row) => row.closed)],
      tiles: {
        open: open.length,
        dueToday: unsentOpen.filter((row) => row.dueToday || row.late).length,
        urgentDispatch: unsentOpen.filter((row) => row.queueStatus === 'ready' || row.late || row.dueToday).length,
        internalTags,
      },
      statuses: QUEUE_STATUSES.map(({ key, label }) => ({ key, label })),
    },
  });
});
