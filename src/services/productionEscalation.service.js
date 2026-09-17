import SalesOrder, { PRE_RELEASE_STATUSES } from '../models/SalesOrder.js';
import OrderQuery, { dueFrom } from '../models/OrderQuery.js';
import User from '../models/User.js';
import { nextNumber } from './numbering.service.js';
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

/**
 * How many days past the date it was owed by, for saying so in the task.
 *
 * The same fallback the `isOverdue` virtual uses — the plant's agreed date when there is one,
 * the buyer's otherwise. Reading only `expectedCompletion` here produced `NaN days` on exactly
 * the lines the alarm had just been taught to catch.
 */
const daysLate = (line, now) => {
  /*
   * The *earliest* deadline that has passed, so the figure is how late the line actually is
   * rather than how late it is against whichever date was written last. Taking
   * `expectedCompletion` in preference reported a line five days past the buyer's promise as
   * not late at all once the plant pushed its own estimate out — see the note on `isOverdue`.
   */
  const dates = [line.dueToBuyer, line.production?.expectedCompletion]
    .filter(Boolean)
    .map((date) => new Date(date).getTime())
    .filter((time) => time < now);
  if (!dates.length) return 0;
  return Math.floor((now - Math.min(...dates)) / (24 * 60 * 60 * 1000));
};

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
   *
   * **Either date**, because a line the plant never planned carries no `expectedCompletion` at
   * all. Matching only on that one meant such an order was never even fetched, so the alarm was
   * silent for the lines least likely to be noticed any other way — the ones nobody had picked
   * up. The `$or` widens what is loaded; `isOverdue` below is still the only thing that decides,
   * so a line with an agreed date in the future stays quiet however old the buyer's date is.
   */
  const orders = await SalesOrder.find({
    status: { $nin: [...PRE_RELEASE_STATUSES, 'cancelled', 'closed'] },
    /* All three dates, because any of them passing can make a line late. `promisedDate` is the
       re-agreed one and it is the only one that can push a deadline *out* — a line loaded on
       the strength of its original delivery date is still judged by `isOverdue` below, which
       reads the re-agreed date when there is one. */
    $or: [
      { 'lines.production.expectedCompletion': { $lt: new Date(now) } },
      { 'lines.promisedDate': { $lt: new Date(now) } },
      { 'lines.deliveryDate': { $lt: new Date(now) } },
    ],
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

/**
 * The plant has just said it cannot make the buyer's date [§25].
 *
 * The escalation above rings when a date is *crossed*, which is the right trigger for a slip
 * nobody saw coming and the wrong one for a slip somebody typed. On an order due in five weeks,
 * a forecast that misses it by a fortnight was known on day one and announced on day thirty-five
 * — by which point the only thing left to do is apologise.
 *
 * So this is the same fact, at the moment it becomes a fact: raised as an **order query** rather
 * than a task, because it is a question with an answer somebody owes — expedite it, re-agree the
 * date with the buyer, or split the delivery — and a task is a reminder with nowhere to put the
 * reply. Asked of marketing, because they are the only people who can ring the buyer.
 *
 * `raisedBy` is the supervisor who recorded the forecast. That is honest and it is useful: the
 * question comes from a person, and the person who typed the date is who marketing will want to
 * talk to about whether it can be pulled in.
 */
export async function warnPromiseWillSlip(order, line, by) {
  const plant = line.production?.expectedCompletion;
  const owed = line.dueToBuyer;
  if (!plant || !owed) return null;

  const day = (value) => new Date(value).toISOString().slice(0, 10);
  const over = Math.round((new Date(plant) - new Date(owed)) / (24 * 60 * 60 * 1000));
  const model = line.modelNumber || 'a model';

  /*
   * One per line per forecast, so re-recording the same slip does not stack questions. The
   * date is in the key rather than only the line: a forecast that moves from a week late to a
   * month late is a new and worse fact, and silencing it because a question was already asked
   * about the first slip is how the second one goes unnoticed.
   */
  const marker = `promise-slip:${order._id}:${line._id}:${day(plant)}`;
  const already = await OrderQuery.findOne({ order: order._id, originKey: marker });
  if (already) return already;

  return OrderQuery.create({
    number: await nextNumber('QRY'),
    order: order._id,
    line: line._id,
    raisedBy: by?._id,
    askedOf: 'marketing',
    /* Urgent: the whole value of this is the head start, and a question that waits a day has
       spent part of what it was for. */
    urgency: 'urgent',
    dueBy: dueFrom('urgent'),
    originKey: marker,
    question:
      `The plant now expects ${model} on ${day(plant)}, which is ${over} day${over === 1 ? '' : 's'} ` +
      `past the ${day(owed)} the buyer is owed. ` +
      `${line.toMakeQty.toLocaleString('en-IN')} of ${line.quantity.toLocaleString('en-IN')} pieces still to make` +
      `${line.production?.holdReason ? ` · held: ${line.production.holdReason}` : ''}. ` +
      'Expedite it, re-agree the date with the buyer, or split the delivery.',
  });
}
