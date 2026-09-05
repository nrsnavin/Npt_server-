import Dispatch, { CLOSED_DISPATCH_STATUSES, GONE_DISPATCH_STATUSES } from '../models/Dispatch.js';
import { ROLLED_UP_STATUSES } from './production.service.js';

/**
 * What is free to put on a lorry [BLUEPRINT §17–19].
 *
 * This file is the reservation, and the reservation is the point of the whole dispatch module.
 * Production packs 32,000 of a 50,000-piece line; despatch raises a consignment for 20,000;
 * somebody else raises a second for 20,000 an hour later. Without an arithmetic that both of
 * them go through, the second one is accepted, a lorry is loaded against stock that is already
 * on another lorry, and the plant finds out at the gate.
 *
 * **Everything here is derived and nothing is stored.** A `reservedQty` written onto the order
 * line would be right until the first consignment is cancelled, corrected or split — and then
 * wrong permanently, with nothing on the record to say so. The order line stores what production
 * packed; the consignments store what was claimed; the difference is computed on every read.
 * That is a few more documents loaded, and it is the difference between a figure that can be
 * trusted and one that has to be reconciled by hand every month.
 *
 * **Two kinds of claim, and only one of them is reversible.** A consignment before it leaves has
 * *reserved* pieces: they are on the floor, and cancelling the consignment puts them back. A
 * consignment that has gone has *taken* them, and no edit brings them back. Both reduce what is
 * free, so the arithmetic treats them alike — but the screens name them separately, because
 * "held for tomorrow's lorry" and "gone last Tuesday" are different answers to a buyer.
 */

/** Claims that count. A cancelled consignment holds nothing; everything else does. */
const CLAIMING = { status: { $nin: ['cancelled'] } };

/**
 * What each line of these orders has packed, claimed and free, keyed by line id.
 *
 * One query for however many orders are asked about, because the despatch queue asks about all
 * of them at once and a per-order round trip inside a list loop is the shape that turns a fast
 * screen into a slow one somewhere around the fiftieth open order.
 *
 * `excluding` leaves one consignment's own claim out of the sum. Editing a consignment from
 * 20,000 to 25,000 has to be checked against the stock *without* its existing 20,000 held
 * against it, or every edit that raises a quantity is refused by the consignment being edited.
 */
export async function claimsFor(orderIds, { excluding } = {}) {
  const filter = { order: { $in: orderIds }, ...CLAIMING };
  if (excluding) filter._id = { $ne: excluding };

  const dispatches = await Dispatch.find(filter).select('order status lines number');

  /** line id -> { reserved, dispatched, on: [{ number, status, quantity }] } */
  const claims = new Map();

  for (const dispatch of dispatches) {
    const gone = GONE_DISPATCH_STATUSES.includes(dispatch.status);

    for (const line of dispatch.lines || []) {
      const key = String(line.orderLine);
      const entry = claims.get(key) || { reserved: 0, dispatched: 0, on: [] };

      entry[gone ? 'dispatched' : 'reserved'] += line.quantity || 0;
      entry.on.push({ number: dispatch.number, status: dispatch.status, quantity: line.quantity });
      claims.set(key, entry);
    }
  }

  return claims;
}

/**
 * One line's position, as a plain object a screen can render without arithmetic of its own.
 *
 * `available` is the number this module exists to produce: what production has packed, less
 * everything already spoken for. Floored at zero, because an over-claim that somehow got in —
 * a correction to a produced count *downwards* after a consignment left, say — should read as
 * nothing free rather than as a negative quantity nobody can interpret.
 */
export function stockOf(line, claim = { reserved: 0, dispatched: 0, on: [] }) {
  const readyQty = line.production?.readyQty || 0;
  const claimed = claim.reserved + claim.dispatched;

  return {
    orderLine: line._id,
    modelNumber: line.modelNumber,
    colour: line.colour,
    quantity: line.quantity,
    producedQty: line.production?.producedQty || 0,
    readyQty,
    reserved: claim.reserved,
    dispatched: claim.dispatched,
    available: Math.max(0, readyQty - claimed),
    /* What is holding it, so a refusal can name the consignment rather than only the shortfall. */
    on: claim.on,
    /**
     * Nothing left to send on this line.
     *
     * Either the ordered quantity has gone, or the plant has called the line finished and the
     * floor is empty. The second half matters because of the ±5% the quotation's own terms
     * allow: a 50,000 line that finished at 49,900 and shipped all of it is delivered, and a
     * rule that only compared against the ordered figure would leave the order one hundred
     * pieces short of `fully_dispatched` for ever.
     */
    fullyShipped:
      claim.dispatched >= line.quantity ||
      (line.production?.status === 'completed' && Math.max(0, readyQty - claimed) === 0 && claim.dispatched > 0),
  };
}

/** Every line of one order, with its claims resolved. The tracker panel's whole payload. */
export async function stockFor(order, options) {
  const claims = await claimsFor([order._id], options);
  return (order.lines || []).map((line) => stockOf(line, claims.get(String(line._id))));
}

/**
 * Whether a proposed load can actually be taken off the floor.
 *
 * Refuses **by name and by number**, and that is deliberate. "Insufficient stock" sends somebody
 * to open three screens to find out whose. "Only 12,000 of NPT-400S are free — 32,000 packed,
 * 20,000 already on DSP-2026-0003" is a sentence they can act on, and in the common case it
 * tells them the consignment they were about to duplicate.
 *
 * @param {object[]} stock  the lines' positions, from `stockFor`
 * @param {object[]} wanted `{ orderLine, quantity }` as the request asks for them
 * @returns {string|null}   the refusal, or null
 */
export function assertClaimable(stock, wanted) {
  const byLine = new Map(stock.map((entry) => [String(entry.orderLine), entry]));

  for (const ask of wanted) {
    const line = byLine.get(String(ask.orderLine));
    if (!line) return 'One of those lines is not on this order';

    if (ask.quantity > line.available) {
      const name = line.modelNumber || 'that model';
      const held = line.on
        .filter((claim) => claim.status !== 'cancelled')
        .map((claim) => `${claim.quantity.toLocaleString('en-IN')} on ${claim.number}`)
        .join(', ');

      return (
        `Only ${line.available.toLocaleString('en-IN')} of ${name} ${line.available === 1 ? 'is' : 'are'} free to dispatch — ` +
        `${line.readyQty.toLocaleString('en-IN')} packed` +
        `${held ? `, ${held}` : ''}`
      );
    }
  }

  return null;
}

/* ------------------------------ The order's status ------------------------------ */

/**
 * The §12 statuses the dispatch roll-up is allowed to write.
 *
 * Production's own roll-up stops at `production_completed` and this one takes over from there,
 * so the two never fight: once a consignment exists the order is at `dispatch_planning`, which
 * is not in production's list, and a produced count corrected afterwards updates the line
 * without dragging the order backwards. The plant's per-line status stays accurate either way.
 *
 * Both stop before `payment_pending`, `closed` and `cancelled`, which are decisions somebody
 * made rather than summaries of what the lines say.
 */
export const DISPATCH_ROLLED_UP_STATUSES = [
  ...ROLLED_UP_STATUSES,
  'dispatch_planning',
  'part_dispatched',
  'fully_dispatched',
];

/**
 * What the consignments imply about the order, in strict precedence.
 *
 * Read bottom up: something raised means planning, something gone means part dispatched, and
 * everything gone means fully dispatched.
 *
 * The interesting case is a two-model order with one model on a lorry and the other still on a
 * press. The order is honestly both "production running" and "part dispatched", and §12's ladder
 * can only say one. It says the dispatch, because that is the fact the buyer already knows and
 * the one everybody downstream — accounts especially — is waiting on. The per-line production
 * statuses underneath stay exactly as accurate as they were, and the order screen shows both.
 */
export function orderStatusFromStock(stock) {
  if (!stock.length) return null;

  const claimed = stock.filter((line) => line.reserved > 0 || line.dispatched > 0);
  if (!claimed.length) return null;

  if (stock.every((line) => line.fullyShipped)) return 'fully_dispatched';
  if (stock.some((line) => line.dispatched > 0)) return 'part_dispatched';
  return 'dispatch_planning';
}

/**
 * Applies that to an order, and says whether it moved.
 *
 * Mutates rather than returning a copy, for the reason the production roll-up does: every caller
 * is holding the document it is about to save, and a version that handed a status back for the
 * caller to assign is a version somebody eventually forgets to assign.
 */
export function rollUpDispatchStatus(order, stock, user) {
  if (!DISPATCH_ROLLED_UP_STATUSES.includes(order.status)) return null;

  const next = orderStatusFromStock(stock);
  if (!next || next === order.status) return null;

  order.statusHistory.push({
    from: order.status,
    to: next,
    by: user?._id,
    note: 'Followed the consignments',
  });
  order.status = next;
  return next;
}

export { CLOSED_DISPATCH_STATUSES, GONE_DISPATCH_STATUSES };
