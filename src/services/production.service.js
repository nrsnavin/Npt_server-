import { PRODUCTION_STATUSES } from '../models/SalesOrder.js';

/**
 * What the plant does to a line, and what the order says about it [BLUEPRINT §14–17].
 *
 * §14 is explicit that this module carries **customer-facing visibility only** — material and
 * machine planning stay in the production ERP. So what is modelled here is what a buyer might
 * ring up and ask: has it started, how many are made, how many are packed, and when will the
 * rest be. Nothing about which press or which shift.
 *
 * The one piece of real logic is the roll-up. An order's §12 status has to follow its lines'
 * §15 statuses or the two disagree, and they disagree in the worst possible way: the order says
 * "production completed" while a line is still on hold. Written once here because three callers
 * need it — updating a line, releasing an order, and the plant's own queue — and three copies
 * of a precedence rule is three chances for one to be forgotten.
 */

/** Statuses that mean nothing is moving on this line and somebody has to do something. */
export const HELD_PRODUCTION_STATUSES = [
  'material_pending',
  'mould_pending',
  'printing_material_pending',
  'production_hold',
  'quality_hold',
];

/**
 * The order status a set of lines implies, in strict precedence.
 *
 * Read top to bottom: the *worst* thing true of any line wins over the best thing true of all
 * of them. An order with three finished lines and one on quality hold is not "completed" — it
 * is an order with a problem, and saying otherwise is how a buyer gets told their goods are
 * ready when a quarter of them are not.
 *
 * Returns `null` when the lines say nothing the order does not already know, which is what
 * keeps this from dragging an order backwards out of dispatch or payment.
 */
export function orderStatusFor(lines = []) {
  if (!lines.length) return null;

  const production = lines.map((line) => line.production?.status || 'awaiting_planning');
  const some = (...wanted) => production.some((status) => wanted.includes(status));
  const every = (...wanted) => production.every((status) => wanted.includes(status));

  /* Anything held is the headline, whatever else is going well. */
  if (some(...HELD_PRODUCTION_STATUSES)) return 'production_running';

  if (every('completed')) return 'production_completed';
  if (some('part_quantity_ready')) return 'part_quantity_ready';
  if (some('running')) return 'production_running';
  if (some('scheduled', 'planning')) return 'production_planning';
  if (every('awaiting_planning')) return 'approved_for_production';

  return 'production_running';
}

/**
 * The §12 statuses this roll-up is allowed to write.
 *
 * A guard rather than a comment, because the roll-up runs on every line edit and an order that
 * has reached dispatch or payment must not be dragged back to `production_running` by somebody
 * correcting a produced count weeks later. The plant's own statuses stay accurate either way;
 * it is only the order-level summary that stops moving once the order is past production.
 */
export const ROLLED_UP_STATUSES = [
  'approved_for_production',
  'production_planning',
  'production_running',
  'part_quantity_ready',
  'production_completed',
];

/**
 * Applies the roll-up to an order, and says whether it moved.
 *
 * Mutates rather than returns a copy, because every caller is holding the document it is about
 * to save — and a version that returned a new status for the caller to assign is a version
 * somebody eventually forgets to assign.
 */
export function rollUpOrderStatus(order, user) {
  if (!ROLLED_UP_STATUSES.includes(order.status)) return null;

  const next = orderStatusFor(order.lines);
  if (!next || next === order.status) return null;

  order.statusHistory.push({
    from: order.status,
    to: next,
    by: user?._id,
    note: 'Followed the lines',
  });
  order.status = next;
  return next;
}

/**
 * What a line's figures may become.
 *
 * Two invariants, and only one of them is the obvious one.
 *
 * **Packed cannot exceed made.** You cannot pack more pieces than came off the press, and a
 * ready count above the produced count is the shape of a typo that then flows into a dispatch
 * as available stock.
 *
 * **Made may exceed ordered, and that is not an error.** The quotation's own standing terms
 * accept ±5% on moulded items as full delivery, so a 50,000 line finishing at 51,200 is an
 * ordinary Tuesday. A guard that capped production at the ordered quantity would refuse the
 * normal case and teach people to type the wrong number.
 */
export function assertProductionFigures({ producedQty, readyQty }) {
  if (readyQty > producedQty) {
    return `Only ${producedQty.toLocaleString('en-IN')} pieces have been made — ${readyQty.toLocaleString('en-IN')} cannot be packed and ready`;
  }
  return null;
}

/**
 * Whether a status change on a line is one the plant can actually make.
 *
 * Deliberately permissive about order — a job that goes back on hold after running is ordinary,
 * and a rigid graph would have the plant fighting the tool to record what happened. What it
 * refuses is the one move that is always a mistake: calling a line completed while pieces are
 * still owed. That is not a workflow opinion, it is the count disagreeing with the word.
 */
export function assertStatusFits(line, status) {
  if (!PRODUCTION_STATUSES.includes(status)) return `${status} is not a production status`;

  if (status === 'completed' && line.toMakeQty > 0) {
    return (
      `${line.toMakeQty.toLocaleString('en-IN')} pieces of ${line.quantity.toLocaleString('en-IN')} ` +
      'are still to make — record them before calling this line complete'
    );
  }
  if (status === 'part_quantity_ready' && !(line.production?.readyQty > 0)) {
    return 'Nothing is packed yet, so no part quantity is ready';
  }
  return null;
}
