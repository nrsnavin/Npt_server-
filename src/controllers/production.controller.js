import SalesOrder, { PRODUCTION_STATUSES, PRE_RELEASE_STATUSES } from '../models/SalesOrder.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { listParams, paginated } from '../utils/query.js';
import { recordChange, snapshot } from '../services/audit.service.js';
import { ownershipFilter, ownsRecord } from '../services/ownership.service.js';
import { orderVisibleTo } from '../services/pricingVisibility.js';
import {
  HELD_PRODUCTION_STATUSES, assertProductionFigures, assertStatusFits, rollUpOrderStatus,
} from '../services/production.service.js';
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
      order: { _id: order._id, number: order.number, status: order.status, customer: order.customer },
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
export const updateProductionLine = asyncHandler(async (req, res) => {
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

  const before = snapshot(order);
  if (!line.production) line.production = {};

  const patch = req.body;
  const next = {
    producedQty: patch.producedQty ?? line.production.producedQty ?? 0,
    readyQty: patch.readyQty ?? line.production.readyQty ?? 0,
  };

  const wrong = assertProductionFigures(next);
  if (wrong) throw ApiError.badRequest(wrong);

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
  res.json({
    success: true,
    data: orderVisibleTo(order, req.user),
    line: order.lines.id(req.params.lineId),
    /* Said out loud, because the plant did not ask for it and will see it on the order. */
    orderMovedTo: moved,
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
