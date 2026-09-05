import SalesOrder, { PRE_RELEASE_STATUSES } from '../models/SalesOrder.js';
import User from '../models/User.js';
import { raiseTask } from './task.service.js';
import { claimsFor, stockOf } from './dispatchStock.service.js';

/**
 * Telling despatch there is something to send [BLUEPRINT §5 and §25].
 *
 * Two things live here because they are two halves of one fact — *material is packed and has
 * not gone* — measured at two moments. §5 raises it the moment the material appears; §25 raises
 * it again, louder, when it is still there a day later.
 *
 * | Threshold                | Escalate to        |
 * | Material ready > 24 hrs  | Dispatch           |
 *
 * **On the §5 automation, which this deliberately implements differently from how it is
 * written.** The blueprint says production reaching "ready for dispatch" should *create a
 * dispatch request*. Creating a consignment document per line the moment it is packed would be
 * wrong in the ordinary case: one lorry carries several lines of one order, and often several
 * orders for the same customer. Which pieces travel together is despatch's judgement and
 * nobody else's — and an auto-created consignment would either be edited into the right shape
 * every time or, worse, quietly reserve stock against a lorry that was never going to run.
 *
 * So the automation raises a **task** rather than a document, and the "what can go out" queue
 * answers it. The reservation still happens, at the moment somebody actually claims the pieces,
 * which is the only moment it means anything.
 */

const DAY = 24 * 60 * 60 * 1000;

/**
 * Everyone who can put something on a lorry, plus the person who sold it.
 *
 * §25 names the audience only as "dispatch escalation". Despatch is who can act; the order's
 * owner is included because they are who the buyer rings, and goods sitting packed for two days
 * against a promised date is their problem before it is anybody else's.
 */
async function recipientsFor(order) {
  const despatch = await User.find({
    isActive: { $ne: false },
    moduleAccess: { $elemMatch: { module: 'dispatch', level: 'write' } },
  }).select('_id');

  const everyone = [...despatch.map((user) => user._id), order.assignedTo].filter(Boolean);
  /* One task each, however many of those lists somebody appears on. */
  return [...new Map(everyone.map((id) => [String(id), id])).values()];
}

/** Marked on the line so a task is raised once per batch of material rather than once per save. */
const readyKey = (order, line) => `order:${order._id}:line:${line._id}:ready`;
const sittingKey = (order, line) => `order:${order._id}:line:${line._id}:not-dispatched`;

/**
 * The §5 half: pieces have just been packed, and somebody should come and get them.
 *
 * Raised from the production controller rather than from a sweep, because it is an event and a
 * sweep would tell despatch about it up to an hour late — which on a line packed at four in the
 * afternoon is the difference between catching today's lorry and not.
 *
 * Deduplicated on the task's own origin key, so a plant recording 5,000 pieces at a time does
 * not raise six identical tasks in an afternoon. Once despatch has ticked it off, the next batch
 * raises a new one, which is a genuinely new ask.
 */
export async function notifyMaterialReady(order, line) {
  const ready = line.production?.readyQty || 0;
  if (ready <= 0) return [];

  const recipients = await recipientsFor(order);
  const model = line.modelNumber || line.mould?.mouldCode || 'a model';

  await Promise.all(
    recipients.map((user) =>
      raiseTask({
        user,
        title: `${order.number} — ${ready.toLocaleString('en-IN')} of ${model} packed and ready`,
        notes:
          `${ready.toLocaleString('en-IN')} of ${line.quantity.toLocaleString('en-IN')} ordered` +
          `${line.deliveryDate ? ` · wanted by ${new Date(line.deliveryDate).toISOString().slice(0, 10)}` : ''}`,
        priority: 'normal',
        link: `/orders/${order._id}`,
        originKey: readyKey(order, line),
      })
    )
  );

  return recipients;
}

/**
 * The §25 half: it is still sitting there.
 *
 * The clock starts at `readyAt` — the last time material was added to the line — rather than at
 * the order date or the line's first ready count. A line half-dispatched on Tuesday and topped
 * up on Wednesday starts a fresh day, because the pieces waiting are new pieces.
 *
 * **What re-arms it is the quantity, not the clock.** A line escalated at 10,000 packed and
 * later topped up to 30,000 has twenty thousand new pieces on the floor, and that is a new
 * problem however recently the last alarm rang. So the guard compares `readyQty` against what
 * was packed when despatch was last told, and there is no tier to count: §25 gives this one
 * threshold and one audience.
 *
 * `available` is what decides whether to ring at all, not `readyQty`. Material already claimed
 * by a consignment is material somebody is dealing with — escalating it would be telling
 * despatch about their own open work, which is how an escalation becomes noise.
 */
export async function runDispatchEscalations({ now = Date.now() } = {}) {
  const orders = await SalesOrder.find({
    status: { $nin: [...PRE_RELEASE_STATUSES, 'cancelled', 'closed'] },
    'lines.production.readyAt': { $lt: new Date(now - DAY) },
  }).select('number assignedTo customer lines status');

  if (!orders.length) return [];

  const claims = await claimsFor(orders.map((order) => order._id));
  const raised = [];

  for (const order of orders) {
    let touched = false;

    for (const line of order.lines) {
      const readyAt = line.production?.readyAt;
      if (!readyAt || new Date(readyAt).getTime() > now - DAY) continue;

      /* Already told them about this much. More since then is a new problem; the same is not. */
      const told = line.production.dispatchEscalatedAt;
      if (told && (line.production.readyQty || 0) <= (line.production.dispatchEscalatedQty || 0)) {
        continue;
      }

      const stock = stockOf(line, claims.get(String(line._id)));
      if (stock.available <= 0) continue;

      const waiting = Math.floor((now - new Date(readyAt).getTime()) / DAY);
      const model = line.modelNumber || 'a model';
      const recipients = await recipientsFor(order);

      await Promise.all(
        recipients.map((user) =>
          raiseTask({
            user,
            title: `${order.number} — ${stock.available.toLocaleString('en-IN')} of ${model} still not dispatched`,
            notes:
              `Packed ${waiting} day${waiting === 1 ? '' : 's'} ago` +
              `${stock.reserved ? ` · ${stock.reserved.toLocaleString('en-IN')} held on another consignment` : ''}` +
              `${line.deliveryDate ? ` · wanted by ${new Date(line.deliveryDate).toISOString().slice(0, 10)}` : ''}`,
            priority: 'high',
            link: `/orders/${order._id}`,
            originKey: sittingKey(order, line),
          })
        )
      );

      line.production.dispatchEscalatedAt = new Date(now);
      line.production.dispatchEscalatedQty = line.production.readyQty || 0;
      touched = true;
      raised.push({
        order: order.number,
        model,
        available: stock.available,
        daysWaiting: waiting,
        recipients: recipients.length,
      });
    }

    if (touched) await order.save();
  }

  return raised;
}
