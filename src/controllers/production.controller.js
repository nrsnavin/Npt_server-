import { withOrderLock } from '../services/operationLock.service.js';
import SalesOrder, { PRODUCTION_STATUSES, PRE_RELEASE_STATUSES } from '../models/SalesOrder.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { listParams, paginated } from '../utils/query.js';
import { recordChange, snapshot } from '../services/audit.service.js';
import { expectVersion, withoutVersion } from '../utils/concurrency.js';
import { ownershipFilter, ownsRecord } from '../services/ownership.service.js';
import { orderVisibleTo } from '../services/pricingVisibility.js';
import {
  HELD_PRODUCTION_STATUSES, assertProductionFigures, assertStatusFits, rollUpOrderStatus,
} from '../services/production.service.js';
import { notifyMaterialReady } from '../services/dispatchEscalation.service.js';
import { PRESSING_BANDS, byUrgency, urgencyOf } from '../services/productionUrgency.service.js';
import { urgentOrdersFor } from '../services/urgentOrders.service.js';
import OrderQuery from '../models/OrderQuery.js';
import { sendCsv } from '../utils/csv.js';

/**
 * Production status [BLUEPRINT §14–17].
 *
 * **The unit of work here is the line, not the order**, and that is the whole shape of this
 * file. A 53,000-piece order covering two models finishes at two different times on two
 * different presses; an order-level "produced" figure describes neither of them, and §17's part
 * delivery — 20,000 of 50,000 released while the rest stays open — only means anything where
 * the count actually differs.
 *
 * So the plant's screen is a list of *lines* drawn from every released order, and the order's
 * own status follows from them rather than being typed alongside them.
 *
 * §14 draws the boundary on what this holds: customer-facing visibility only. Planned, produced,
 * ready, and when the rest is expected. Which press and which shift stay in the production ERP,
 * and putting them here would be building a second one badly.
 */

/** What a plant screen needs to recognise a line, and nothing about money. */
const LINE_POPULATE = [
  { path: 'customer', select: 'code name' },
  { path: 'lines.mould', select: 'mouldCode name category sizeMm cavities activeCavities partWeightGrams cycleTimeSeconds' },
];

const EXPORT_LIMIT = 5000;

/**
 * Every order that has passed the §13 gate.
 *
 * Anything before it is not the plant's business yet: an order still being verified may have
 * its lines changed, and a press queue that included them would be a queue of jobs that can
 * still turn into different jobs.
 */
const RELEASED = { status: { $nin: [...PRE_RELEASE_STATUSES, 'cancelled'] } };

/* --------------------------------- The queue --------------------------------- */

/**
 * The plant's own list: one row per line, across every released order.
 *
 * Flattened here rather than in the browser, because the filters are about the *line* — its
 * production status, its tool, whether it is past its date — and a screen that fetched orders
 * and filtered lines client-side would page by order and show the wrong number of rows.
 *
 * Ownership still applies: a marketing person reading this list sees their own orders' lines.
 * Production and the rest see everything, which is what `ownershipFilter` already decides.
 */
export const listProductionLines = asyncHandler(async (req, res) => {
  const { page, limit, filter } = listParams(req.query, {
    searchFields: ['number', 'customerPo.number', 'lines.modelNumber'],
    defaultSort: '-orderDate',
  });

  Object.assign(filter, RELEASED);
  if (req.query.customer) filter.customer = req.query.customer;
  if (req.query.mould) filter['lines.mould'] = req.query.mould;

  /*
   * Every released order, then flattened. Deliberately not paged in the database: paging orders
   * would give a page of unpredictable length in lines, and the export beside it promises the
   * file matches the screen. The set is bounded by what a plant actually has open.
   */
  const orders = await SalesOrder.find({ ...filter, ...ownershipFilter(req.user) })
    .populate(LINE_POPULATE)
    .limit(EXPORT_LIMIT);

  let rows = orders.flatMap((order) =>
    (order.lines || []).map((line, index) => ({
      /* `updatedAt` travels with the row so the screen can echo it back on a write — the
         concurrency token for a line is the order's, because the order is what gets saved. */
      order: {
        _id: order._id, number: order.number, status: order.status,
        customer: order.customer, updatedAt: order.updatedAt,
      },
      lineId: line._id,
      position: index + 1,
      modelNumber: line.modelNumber,
      mould: line.mould,
      colour: line.colour,
      printing: line.printing,
      quantity: line.quantity,
      deliveryDate: line.deliveryDate,
      production: line.production,
      toMakeQty: line.toMakeQty,
      madePercent: line.madePercent,
      isOverdue: line.isOverdue,
    }))
  );

  if (req.query.status) {
    const wanted = String(req.query.status).split(',');
    rows = rows.filter((row) => wanted.includes(row.production?.status));
  }
  /** The queue that matters: everything not finished. */
  if (req.query.open === 'true') rows = rows.filter((row) => row.production?.status !== 'completed');
  if (req.query.overdue === 'true') rows = rows.filter((row) => row.isOverdue);
  if (req.query.held === 'true') {
    rows = rows.filter((row) => HELD_PRODUCTION_STATUSES.includes(row.production?.status));
  }

  /*
   * Late first, then by the date the plant agreed. A plant list sorted by order number is a
   * list nobody can work from — the question this screen answers is what to put on a press
   * next, and the answer is whatever is furthest past its promise.
   */
  rows.sort((a, b) => {
    if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1;
    const left = a.production?.expectedCompletion || a.deliveryDate;
    const right = b.production?.expectedCompletion || b.deliveryDate;
    if (!left) return 1;
    if (!right) return -1;
    return new Date(left) - new Date(right);
  });

  const total = rows.length;
  const start = (page - 1) * limit;

  paginated(res, rows.slice(start, start + limit), { page, limit, total }, {
    meta: {
      /* The three figures a production head opens this screen for. */
      open: rows.filter((row) => row.production?.status !== 'completed').length,
      overdue: rows.filter((row) => row.isOverdue).length,
      held: rows.filter((row) => HELD_PRODUCTION_STATUSES.includes(row.production?.status)).length,
      toMake: rows.reduce((sum, row) => sum + row.toMakeQty, 0),
    },
  });
});

export const exportProductionLines = asyncHandler(async (req, res) => {
  const orders = await SalesOrder.find({ ...RELEASED, ...ownershipFilter(req.user) })
    .populate(LINE_POPULATE)
    .limit(EXPORT_LIMIT);

  const rows = orders.flatMap((order) =>
    (order.lines || []).map((line, index) => ({ order, line, index }))
  );

  /*
   * No rate and no value: this is the plant's file, and the same §8 rule that keeps the price
   * off their screen keeps it out of their download. A redaction the Export button walks around
   * is not a redaction.
   */
  sendCsv(res, 'production', rows, [
    ['Order', (row) => row.order.number],
    ['Customer', (row) => row.order.customer?.name],
    ['Line', (row) => row.index + 1],
    ['Model', (row) => row.line.modelNumber || row.line.mould?.mouldCode],
    ['Mould', (row) => row.line.mould?.mouldCode],
    ['Colour', (row) => row.line.colour],
    ['Ordered', (row) => row.line.quantity],
    ['Planned', (row) => row.line.production?.plannedQty],
    ['Made', (row) => row.line.production?.producedQty],
    ['Packed', (row) => row.line.production?.readyQty],
    ['Still to make', (row) => row.line.toMakeQty],
    ['Status', (row) => row.line.production?.status],
    ['Expected', (row) => row.line.production?.expectedCompletion],
    ['Wanted by', (row) => row.line.deliveryDate],
    ['Late', (row) => (row.line.isOverdue ? 'Yes' : '')],
    ['Held because', (row) => row.line.production?.holdReason],
  ]);
});

/* ------------------------------ Working a line ------------------------------ */

/**
 * What the plant did to one line.
 *
 * One door for the figures and the status together, because they constrain each other: calling
 * a line complete is only truthful alongside a produced count that says so, and two doors would
 * let somebody set the word and the number in either order with a moment in between where the
 * record contradicts itself.
 */
export const updateProductionLine = asyncHandler(withOrderLock(req => req.params.id, async (req, res) => {
  const order = await SalesOrder.findById(req.params.id);
  if (!order) throw ApiError.notFound('Order not found');
  if (!ownsRecord(req.user, order)) throw ApiError.notFound('Order not found');

  const line = order.lines.id(req.params.lineId);
  if (!line) throw ApiError.notFound('That line is not on this order');

  if (PRE_RELEASE_STATUSES.includes(order.status)) {
    throw ApiError.badRequest(
      'This order has not been released to production yet — it still needs its §13 checks'
    );
  }
  if (order.status === 'cancelled') {
    throw ApiError.badRequest('This order was cancelled — nothing more is made against it');
  }

  /*
   * Refuse a count built on figures somebody has already replaced.
   *
   * This is the screen where two people most plausibly collide: the day screen and the register
   * both record the same line, and a plant has more than one supervisor. Without this it is
   * last-write-wins on a *count* — one records 24,000 made, the other saves 20,000 from a
   * screen loaded ten minutes earlier, and the plant's own record of what it made silently goes
   * backwards. Nothing errors, so neither of them finds out.
   *
   * The token is the order's `updatedAt`, because the line is a subdocument and the order is
   * what gets saved. That is coarser than the line: two supervisors recording *different* lines
   * of the same order in the same moment will see a conflict they did not really have. The
   * helper's own note settles that trade — a false conflict costs a reload and a false accept
   * costs somebody's work — and on this plant's orders, which carry one or two lines, the case
   * being protected is far commoner than the case being annoyed.
   */
  expectVersion(order, req.body);

  const before = snapshot(order);
  if (!line.production) line.production = {};

  const patch = withoutVersion(req.body);
  const next = {
    producedQty: patch.producedQty ?? line.production.producedQty ?? 0,
    readyQty: patch.readyQty ?? line.production.readyQty ?? 0,
  };

  const wrong = assertProductionFigures(next);
  if (wrong) throw ApiError.badRequest(wrong);

  /*
   * Whether this save adds packed material, decided before the figures are written. It is what
   * starts §25's dispatch clock and what tells despatch there is something to collect — and both
   * need the *previous* count, which the assignment loop below is about to overwrite.
   */
  const packedMore = next.readyQty > (line.production.readyQty || 0);

  for (const field of [
    'plannedQty', 'producedQty', 'readyQty',
    'plannedStart', 'expectedCompletion', 'actualStart', 'remarks',
  ]) {
    if (patch[field] !== undefined) line.production[field] = patch[field];
  }

  /*
   * A hold has to say why. A hold with no reason is a hold nobody can clear — the next person
   * to look sees a stopped job and has to go and ask, which is the phone call this module
   * exists to remove.
   */
  if (patch.status && HELD_PRODUCTION_STATUSES.includes(patch.status)) {
    const reason = patch.holdReason ?? line.production.holdReason;
    if (!reason?.trim()) throw ApiError.badRequest('Say why this line is held');
    line.production.holdReason = reason;
  } else if (patch.status) {
    /* Moving off a hold clears the reason: an old one left behind reads as a live problem. */
    line.production.holdReason = undefined;
  }

  if (patch.status) {
    const refusal = assertStatusFits(line, patch.status);
    if (refusal) throw ApiError.badRequest(refusal);

    /* Stamped from the status rather than typed, so the dates cannot disagree with the word. */
    if (patch.status === 'running' && !line.production.actualStart) {
      line.production.actualStart = new Date();
    }
    if (patch.status === 'completed') line.production.completedAt = new Date();

    line.production.status = patch.status;
  }

  /*
   * The clock §25 measures the dispatch escalation from, restarted by every new batch. See the
   * note on `readyAt` in the model for why it is the last addition rather than the first.
   */
  if (packedMore) line.production.readyAt = new Date();

  /* The order's own status follows its lines — see production.service.js for the precedence. */
  const moved = rollUpOrderStatus(order, req.user);

  await order.save();
  await recordChange({
    model: 'SalesOrder',
    doc: order,
    before,
    by: req.user,
    note: `Production on line ${line.modelNumber || line.mould || ''}`.trim(),
  });

  await order.populate(LINE_POPULATE);

  /*
   * §5's handover: material appearing on the floor is despatch's cue, and the plant should not
   * have to remember to tell them. A task rather than an auto-created consignment — see the
   * note at the top of dispatchEscalation.service.js for why that is the right shape.
   *
   * After the save and outside its result, deliberately: a notification that failed must not
   * take down the record of what was made, which is the fact that actually matters.
   */
  if (packedMore) {
    await notifyMaterialReady(order, order.lines.id(req.params.lineId)).catch(() => {});
  }

  res.json({
    success: true,
    data: orderVisibleTo(order, req.user),
    line: order.lines.id(req.params.lineId),
    /* Said out loud, because the plant did not ask for it and will see it on the order. */
    orderMovedTo: moved,
  });
}));

/* ------------------------------ The plant's day ------------------------------ */

/**
 * What to run next, and who is waiting on an answer.
 *
 * The plant's own front page, and it answers two questions rather than one because those are
 * the two a supervisor actually opens the app with: *what goes on a press this morning*, and
 * *what has somebody asked me that I have not answered*. They are unrelated as data and
 * inseparable in practice — the second is nearly always about the first, and splitting them
 * across two screens is how a question about a job sits unanswered beside the job.
 *
 * The queue half is deliberately not the production list with a different sort. That list is a
 * register: every line, filterable, paged. This is a shortlist — what is late, and what will be
 * late — with the sentence that explains each one. A supervisor who has to work out *why* a row
 * is near the top is a supervisor who goes back to the whiteboard.
 */
export const productionDay = asyncHandler(async (req, res) => {
  const now = new Date();

  const orders = await SalesOrder.find({ ...RELEASED, ...ownershipFilter(req.user) })
    .populate(LINE_POPULATE)
    .populate({ path: 'priorityBy', select: 'name' })
    .limit(EXPORT_LIMIT);

  const rows = orders.flatMap((order) =>
    (order.lines || [])
      .map((line, index) => ({
        order: {
          _id: order._id,
          number: order.number,
          status: order.status,
          customer: order.customer,
          /* See the note on the register's row: the write needs the order's version back. */
          updatedAt: order.updatedAt,
          priority: order.priority,
          priorityReason: order.priorityReason,
          /* Who asked, by name. The plant is being told to reorder its day and is entitled to
             know by whom — and it is what makes an over-used flag visible to anybody. */
          priorityBy: order.priorityBy?.name || null,
        },
        lineId: line._id,
        position: index + 1,
        modelNumber: line.modelNumber,
        mould: line.mould,
        colour: line.colour,
        quantity: line.quantity,
        deliveryDate: line.deliveryDate,
        production: line.production,
        toMakeQty: line.toMakeQty,
        madePercent: line.madePercent,
        isOverdue: line.isOverdue,
        link: `/orders/${order._id}`,
      }))
      .map((row) => ({
        ...row,
        urgency: urgencyOf(row, { now, priority: order.priority }),
      }))
  );

  const running = rows.filter((row) => row.production?.status !== 'completed');
  const pressing = running.filter((row) => PRESSING_BANDS.includes(row.urgency.band)).sort(byUrgency);
  const next = running
    .filter((row) => !PRESSING_BANDS.includes(row.urgency.band))
    .sort(byUrgency)
    .slice(0, 10);

  /*
   * The questions, from the same request. Fetched here rather than left to a second call from
   * the browser so the screen cannot render half of itself: a supervisor seeing the queue but
   * not the questions would answer neither.
   *
   * Addressed to *this* department rather than to production by name — the same endpoint then
   * serves quality and despatch when their own screens are built, and there is no list of
   * department-to-endpoint mappings to keep in step.
   */
  const queries = await OrderQuery.find({
    askedOf: req.user.department,
    status: { $in: ['open', 'answered'] },
  })
    .populate([
      { path: 'raisedBy', select: 'name department' },
      { path: 'answers.by', select: 'name' },
      { path: 'order', select: 'number customer', populate: { path: 'customer', select: 'name' } },
    ])
    .sort({ status: 1, dueBy: 1 })
    .limit(50);

  /*
   * The orders marketing or despatch have escalated, and what is holding each one [§29].
   *
   * The same list the yard reads, from the other end. Despatch needs it because they are who
   * gets rung; the plant needs it because on most of these orders **the plant is the answer** —
   * `blockedBy` is production on anything still being made or stopped on the floor, which is
   * the majority of an escalation's life.
   *
   * Shown whoever the blocker is, though, rather than filtered to production's own. An urgent
   * order sitting on paperwork is not the plant's to fix and is still worth a supervisor
   * knowing about: it is the one they will be asked about tomorrow, and the one they should not
   * put a press on today.
   */
  const urgent = await urgentOrdersFor(req.user);

  res.json({
    success: true,
    data: {
      pressing,
      next,
      urgent,
      /* Unanswered first: an answered question is waiting on the asker, not on the plant. */
      queries: queries.filter((query) => query.status === 'open'),
      answered: queries.filter((query) => query.status === 'answered'),
    },
    meta: {
      late: running.filter((row) => row.urgency.band === 'late').length,
      atRisk: running.filter((row) => row.urgency.band === 'at_risk').length,
      running: running.length,
      /* What the plant owes an answer on, and how much of it is already past its promise. */
      questions: queries.filter((query) => query.status === 'open').length,
      questionsOverdue: queries.filter((query) => query.isOverdue).length,
      toMake: running.reduce((sum, row) => sum + (row.toMakeQty || 0), 0),
      /* Said separately from the bands: a plant told "3 late" wants to know how many of those
         are late because somebody asked for something else to go first. */
      raised: running.filter((row) => row.order.priority !== 'normal').length,
      /* Escalated orders, and the ones the plant itself is holding up — the second is the
         number a supervisor is answerable for. */
      urgent: urgent.length,
      urgentOnUs: urgent.filter((row) => row.blockedBy === 'production').length,
      /* Escalated and nobody has even asked — the case where the screen should be inviting a
         question rather than showing one. */
      urgentUnasked: urgent.filter((row) => !row.questions.length).length,
    },
  });
});

/** The production statuses, so a screen need not carry its own copy of §15's list. */
export const listProductionStatuses = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: PRODUCTION_STATUSES.map((status) => ({
      value: status,
      held: HELD_PRODUCTION_STATUSES.includes(status),
    })),
  });
});
