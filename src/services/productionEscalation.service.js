import SalesOrder, { PRE_RELEASE_STATUSES } from '../models/SalesOrder.js';
import User from '../models/User.js';
import { raiseTask } from './task.service.js';

/**
 * The production escalation [BLUEPRINT §25].
 *
 * | Threshold                     | Escalate to                              |
 * | Expected completion crossed   | Production head + marketing + MD red flag |
 *
 * §25 gives this one row and one threshold, and unusually it names three audiences at once
 * rather than tiering them. That is right for what it describes: a job past the date the plant
 * itself agreed is not news the plant needs breaking to them — they know — it is news the
 * person who promised a buyer needs, at the same moment.
 *
 * So this rings once, to all three, and does not tier upward. A second tier would be telling
 * the same three people the same thing again.
 *
 * The unit is the **line**, not the order. A 53,000-piece order covering two models has two
 * dates and can be late on one of them, and an order-level alarm would either cry wolf on the
 * whole order or stay silent while half of it slipped.
 */

/** Marked on the line so an alarm rings once rather than on every sweep. */
const originKey = (order, line) => `order:${order._id}:line:${line._id}:overdue`;

/** How many days past the date the plant agreed, for saying so in the task. */
const daysLate = (line, now) =>
  Math.floor((now - new Date(line.production.expectedCompletion).getTime()) / (24 * 60 * 60 * 1000));

/**
 * Who hears about it.
 *
 * Everyone who can work production, so the head is included without needing a title the
 * organisation does not have; the marketing person who owns the order, because they are who
 * the buyer will ring; and management, which is §25's red flag.
 */
async function recipientsFor(order) {
  const [plant, managers] = await Promise.all([
    User.find({
      isActive: { $ne: false },
      moduleAccess: { $elemMatch: { module: 'production', level: 'write' } },
    }).select('_id'),
    User.find({
      isActive: { $ne: false },
      $or: [{ role: 'admin' }, { department: 'management' }],
    }).select('_id'),
  ]);

  const everyone = [
    ...plant.map((user) => user._id),
    ...managers.map((user) => user._id),
    order.assignedTo,
  ].filter(Boolean);

  /* One task each, however many of those lists somebody appears on. */
  return [...new Map(everyone.map((id) => [String(id), id])).values()];
}

export async function runProductionEscalations({ now = Date.now() } = {}) {
  /*
   * Only released orders, and only ones with a line whose date has passed. The date test is
   * narrowed in the query as far as it can be — the rest has to be per line, because whether a
   * line still owes pieces is a comparison between two of its own fields.
   */
  const orders = await SalesOrder.find({
    status: { $nin: [...PRE_RELEASE_STATUSES, 'cancelled', 'closed'] },
    'lines.production.expectedCompletion': { $lt: new Date(now) },
  }).select('number assignedTo customer lines status');

  const raised = [];

  for (const order of orders) {
    for (const line of order.lines) {
      /*
       * `isOverdue` is the model's own answer, so the alarm and the screen cannot disagree
       * about what late means — past the agreed date *and* still owing pieces. A line finished
       * a day after its date was delivered, not delayed.
       */
      if (!line.isOverdue) continue;
      if (line.production.escalatedAt) continue;

      const late = daysLate(line, now);
      const model = line.modelNumber || 'a model';
      const recipients = await recipientsFor(order);

      await Promise.all(
        recipients.map((user) =>
          raiseTask({
            user,
            title: `${order.number} is late — ${model}`,
            notes:
              `${line.toMakeQty.toLocaleString('en-IN')} of ${line.quantity.toLocaleString('en-IN')} pieces still to make` +
              `${late > 0 ? ` · ${late} day${late === 1 ? '' : 's'} past the agreed date` : ''}` +
              `${line.production.holdReason ? ` · held: ${line.production.holdReason}` : ''}`,
            priority: 'high',
            link: `/orders/${order._id}`,
            originKey: originKey(order, line),
          })
        )
      );

      /*
       * Stamped rather than counted. The sampling escalation carries a level because it tiers;
       * this one rings once, so a timestamp says both that it happened and when — and a line
       * that slips again after being re-dated is caught by the date moving, not by a counter.
       */
      line.production.escalatedAt = new Date(now);
      raised.push({ order: order.number, model, daysLate: late, recipients: recipients.length });
    }

    if (raised.some((entry) => entry.order === order.number)) await order.save();
  }

  return raised;
}
