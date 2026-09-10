import { HELD_PRODUCTION_STATUSES } from './production.service.js';
import { claimsFor, stockOf } from './dispatchStock.service.js';
import Dispatch, { GONE_DISPATCH_STATUSES, PRE_LOAD_DISPATCH_STATUSES } from '../models/Dispatch.js';
import OrderQuery from '../models/OrderQuery.js';
import SalesOrder, { PRE_RELEASE_STATUSES } from '../models/SalesOrder.js';
import { ownershipFilter } from './ownership.service.js';

/**
 * Why an order marketing called urgent has not gone yet [§12, §29].
 *
 * Marketing can already mark an order `high` or `critical`, and the plant's day screen already
 * lifts it up the press queue. What nobody could see was the other half: **an urgent order that
 * is not moving, and whose fault that is.** Despatch would be asked about it — they are the last
 * department before the buyer, so they are who gets rung — and the answer was very often not
 * theirs to give. It was material that had not landed, or a lot quality had stopped.
 *
 * So this works out the *blocker*, and names the department that can clear it. That is what
 * turns "where is my urgent order" from a question somebody has to chase into a concern
 * addressed to whoever can answer it — and it is what puts the concern on the right screen.
 *
 * The order of the checks is the order of the pipeline, and it matters: an order held in
 * production *and* short of paperwork is a production problem, because the paperwork cannot be
 * finished for goods that do not exist. Reporting despatch's own blocker first would have the
 * team chasing an invoice for a lot still on a press.
 */

/** Who can clear each blocker. `null` means nothing is blocking it. */
export const BLOCKERS = {
  quality: {
    key: 'quality',
    department: 'quality',
    label: 'Held by quality',
  },
  production_held: {
    key: 'production_held',
    department: 'production',
    label: 'Stopped in production',
  },
  production_pending: {
    key: 'production_pending',
    department: 'production',
    label: 'Still being made',
  },
  paperwork: {
    key: 'paperwork',
    department: 'despatch',
    label: 'Waiting on paperwork',
  },
  unclaimed: {
    key: 'unclaimed',
    department: 'despatch',
    label: 'Packed, nothing claiming it',
  },
  moving: {
    key: 'moving',
    department: null,
    label: 'On the road',
  },
};

const pieces = (count) => `${Math.round(count).toLocaleString('en-IN')} pieces`;

/**
 * One urgent order, as the despatch screen reads it.
 *
 * Takes the order, the claims already resolved for it, and the consignments raised against it —
 * all three of which the caller has loaded anyway, because computing them here per row is how a
 * day screen becomes a hundred queries.
 */
export function urgencyOfOrder(order, claims, dispatches = [], questions = []) {
  const stock = (order.lines || []).map((line) => stockOf(line, claims.get(String(line._id))));

  const toMake = stock.reduce((sum, line) => sum + Math.max(0, line.quantity - line.producedQty), 0);
  const free = stock.reduce((sum, line) => sum + line.available, 0);
  const gone = stock.reduce((sum, line) => sum + line.dispatched, 0);
  const ordered = stock.reduce((sum, line) => sum + line.quantity, 0);

  /* A held line names itself, because "stopped in production" without the reason is the phone
     call this module exists to remove. */
  const heldLine = (order.lines || []).find((line) =>
    HELD_PRODUCTION_STATUSES.includes(line.production?.status)
  );

  const waiting = dispatches.filter((row) => PRE_LOAD_DISPATCH_STATUSES.includes(row.status));
  const short = waiting.find((row) => !row.shippable);

  let blocker = null;
  const why = [];

  if (heldLine?.production?.status === 'quality_hold') {
    blocker = BLOCKERS.quality;
    why.push(`${heldLine.modelNumber || 'A model'} is on a quality hold`);
    if (heldLine.production.holdReason) why.push(heldLine.production.holdReason);
  } else if (heldLine) {
    blocker = BLOCKERS.production_held;
    why.push(`${heldLine.modelNumber || 'A model'} is stopped on the floor`);
    if (heldLine.production.holdReason) why.push(heldLine.production.holdReason);
  } else if (toMake > 0) {
    blocker = BLOCKERS.production_pending;
    why.push(`${pieces(toMake)} of ${pieces(ordered)} still to make`);
  } else if (short) {
    blocker = BLOCKERS.paperwork;
    why.push(`${short.number} still needs ${short.outstandingPaperwork.join(', ')}`);
  } else if (free > 0) {
    blocker = BLOCKERS.unclaimed;
    why.push(`${pieces(free)} packed and free — nothing has claimed it`);
  } else if (gone > 0) {
    blocker = BLOCKERS.moving;
    why.push(`${pieces(gone)} on the road`);
  }

  return {
    _id: order._id,
    number: order.number,
    customer: order.customer,
    priority: order.priority,
    priorityReason: order.priorityReason,
    priorityBy: order.priorityBy?.name || null,
    priorityAt: order.priorityAt,
    owner: order.assignedTo?.name || null,
    ordered,
    toMake,
    free,
    gone,
    /* The earliest date anybody promised on this order, which is what makes one urgent order
       more urgent than another. */
    deliveryDate: (order.lines || [])
      .map((line) => line.deliveryDate)
      .filter(Boolean)
      .sort((a, b) => new Date(a) - new Date(b))[0] || null,
    blocker: blocker?.key || null,
    blockedBy: blocker?.department || null,
    blockerLabel: blocker?.label || 'Nothing is holding it',
    why,
    consignments: dispatches.map((row) => ({
      _id: row._id, number: row.number, status: row.status,
      gone: GONE_DISPATCH_STATUSES.includes(row.status),
    })),
    /*
     * What is already being asked about this order, with the latest answer.
     *
     * Carried on the row so every department's screen shows the same exchange against the same
     * order. Without it each screen would show its own half — production sees what it was asked,
     * despatch sees what it asked, and neither can tell whether the other already has the
     * answer. That is how the same question gets asked twice in a morning.
     */
    questions: questions.map((query) => ({
      _id: query._id,
      number: query.number,
      askedOf: query.askedOf,
      by: query.raisedBy?.name || null,
      byDepartment: query.raisedBy?.department || null,
      question: query.question,
      status: query.status,
      urgency: query.urgency,
      dueBy: query.dueBy,
      isOverdue: query.isOverdue,
      latestAnswer: query.answers?.length
        ? {
            body: query.answers[query.answers.length - 1].body,
            by: query.answers[query.answers.length - 1].by?.name || null,
            at: query.answers[query.answers.length - 1].at,
          }
        : null,
    })),
    /* Nobody has asked anything about an order somebody escalated — worth its own flag, because
       it is the case where a screen should be inviting the question rather than showing one. */
    unanswered: questions.filter((query) => query.status === 'open').length,
    link: `/orders/${order._id}`,
  };
}

/**
 * Sorts urgent orders: critical first, then by the date somebody promised.
 *
 * Not by how much is outstanding. A `critical` order with 2,000 pieces left is still the one
 * that was escalated, and burying it under a `high` order with 80,000 outstanding would undo
 * the flag marketing set.
 */
export const byOrderUrgency = (a, b) => {
  if (a.priority !== b.priority) return a.priority === 'critical' ? -1 : 1;
  if (!a.deliveryDate) return 1;
  if (!b.deliveryDate) return -1;
  return new Date(a.deliveryDate) - new Date(b.deliveryDate);
};

/** The blockers somebody other than despatch has to clear — the ones worth a concern. */
export const RAISABLE_BLOCKERS = Object.values(BLOCKERS)
  .filter((entry) => entry.department && entry.department !== 'despatch')
  .map((entry) => entry.key);

/**
 * Every urgent order a reader may see, with its blocker and its open questions resolved.
 *
 * Written once because three screens want the same list and would otherwise each assemble it:
 * the yard's day, the plant's day, and any register that grows one later. Three assemblies of
 * "which order is urgent and why" is three chances for two screens to disagree about an order
 * the buyer is chasing — which is the failure this whole feature exists to prevent.
 *
 * Four queries however many orders come back, not four per order: the orders, then their claims,
 * their consignments and their questions in one round each. A day screen that made a round trip
 * per row is a day screen that gets slow exactly when the plant is busy.
 */
export async function urgentOrdersFor(user) {
  const orders = await SalesOrder.find({
    status: { $nin: [...PRE_RELEASE_STATUSES, 'cancelled', 'closed', 'fully_dispatched'] },
    priority: { $ne: 'normal' },
    ...ownershipFilter(user),
  })
    .populate([
      { path: 'customer', select: 'code name city' },
      { path: 'assignedTo', select: 'name' },
      { path: 'priorityBy', select: 'name' },
    ])
    .limit(200);

  if (!orders.length) return [];

  const ids = orders.map((order) => order._id);

  const [claims, loads, questions] = await Promise.all([
    claimsFor(ids),
    Dispatch.find({ order: { $in: ids } })
      .select('order number status invoice transporter lrNumber destination ownVehicle'),
    OrderQuery.find({ order: { $in: ids }, status: { $in: ['open', 'answered'] } })
      .populate([
        { path: 'raisedBy', select: 'name department' },
        { path: 'answers.by', select: 'name' },
      ])
      .sort({ createdAt: -1 }),
  ]);

  const by = (rows, key) => {
    const map = new Map();
    for (const row of rows) {
      const id = String(row[key]);
      map.set(id, [...(map.get(id) || []), row]);
    }
    return map;
  };

  const loadsByOrder = by(loads, 'order');
  const questionsByOrder = by(questions, 'order');

  return orders
    .map((order) =>
      urgencyOfOrder(
        order,
        claims,
        loadsByOrder.get(String(order._id)) || [],
        questionsByOrder.get(String(order._id)) || []
      )
    )
    .sort(byOrderUrgency);
}
