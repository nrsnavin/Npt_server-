import SalesOrder, { PRE_RELEASE_STATUSES, CLOSED_ORDER_STATUSES } from '../models/SalesOrder.js';
import Dispatch, { ARRIVED_DISPATCH_STATUSES, CLOSED_DISPATCH_STATUSES } from '../models/Dispatch.js';
import OrderQuery from '../models/OrderQuery.js';
import Receivable from '../models/Receivable.js';
import Todo from '../models/Todo.js';
import { stockFor } from './dispatchStock.service.js';
import { over, since, plural } from '../utils/phrases.js';

/**
 * Everything actually wrong in the plant right now, as a closed list [BLUEPRINT §25].
 *
 * This is the fact layer under the review in `plantReview.llm.js`, and the division between the
 * two is the whole safety property. **Every figure, name, date and record link in a review comes
 * from here** — from a Mongo query, under the reader's own department. The model is handed this
 * list and does exactly one thing with it: decides what leads. It cannot invent a problem, a
 * quantity or a customer, because it is never asked for one.
 *
 * That matters more here than anywhere else in the app. A model asked to "find the important
 * problems" from raw records would produce findings that read perfectly and are false — "SCM is
 * 40,000 pieces short" when they are 400 — and nobody reading the sentence could tell. Here the
 * worst a bad review does is put the second-most-important thing first.
 *
 * **Not a seventh alarm.** The plant already has six sweeps raising tasks: late production,
 * undispatched stock, stalled samples, unanswered queries, overdue money, quiet leads. The
 * problem this addresses is not that nothing is flagged — it is that six sweeps produce a pile
 * and nobody can tell which of it matters before nine o'clock. So this *reads the same ground
 * they cover* and ranks it. Nothing here raises anything by itself.
 *
 * Each finding carries:
 *
 * | `id`          | Stable within one review, so the model can name a pick without quoting it |
 * | `kind`        | What sort of problem, from a fixed list — the screen groups on it         |
 * | `department`  | Who can actually clear it. Not who noticed it                             |
 * | `headline`    | The fact, with its real numbers, written here and never by the model      |
 * | `detail`      | The consequence, in the plant's own terms                                 |
 * | `severity`    | 0–100, computed. The fallback ranking, and a floor under a bad review      |
 * | `count`       | How many records — one finding may stand for four consignments            |
 * | `link`        | Where to go and fix it                                                    |
 * | `value`       | Rupees at stake where there are any, for management's ordering            |
 */

const DAY = 24 * 60 * 60 * 1000;

/**
 * Elapsed whole days, and never below zero.
 *
 * The clamp is not tidiness. A seeded or back-dated record timestamped later today reads as
 * `-1`, and the brief said *"came from production -1 days ago"* — which is the kind of sentence
 * that costs a screen its credibility in one glance, however right everything round it is.
 */
const daysSince = (date) => Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / DAY));

/**
 * The day-count wording, re-exported from `utils/phrases.js`.
 *
 * It was written here and its edges were found here — "1 days over", "-1 days ago", "today ago",
 * three wrong sentences in five lines, every one caught by reading a screen. It moved because
 * the lead coach then grew the same class of bug independently in its own summary. Re-exported
 * so the test that pins those edges still reads against the feature that earned them.
 */
export { over, since };

/** In rupees, the way the plant says them: 2.15L rather than 215000. */
const lakh = (value) =>
  value >= 100000 ? `₹${(value / 100000).toFixed(2)}L` : `₹${Math.round(value).toLocaleString('en-IN')}`;



/**
 * Severity, computed and not asked for.
 *
 * It does two jobs. It is the ranking when there is no model — which is most of the time, since
 * a key is optional here. And it is a floor under the model: a review that buries a 40-day
 * overdue payment behind a two-day-old query is visibly wrong against this, which is what makes
 * the ranking checkable rather than something to be taken on faith.
 *
 * The scale is deliberately blunt. Anything finer would be false precision on top of judgements
 * that are themselves approximate — what matters is that a lorry at the gate outranks a query
 * nobody has answered, not that it scores 84 rather than 81.
 */
const severity = ({ base, days = 0, count = 1, value = 0, pieces = 0 }) =>
  Math.min(
    100,
    Math.round(
      base +
        /* Age, tapering: the difference between one day and four is large, between forty and
           forty-four is not, and a linear term would let one ancient row dominate for ever. */
        Math.min(25, Math.sqrt(Math.max(0, days)) * 6) +
        /* Breadth: four consignments with no POD is a worse morning than one. */
        Math.min(10, (count - 1) * 2.5) +
        /* And money, where there is any. Capped, so a big invoice cannot outrank a stopped line. */
        Math.min(15, (value / 100000) * 3) +
        /*
         * Goods, where the problem is a quantity rather than a sum.
         *
         * Added after reading the real ranking: on the seeded plant, 25,000 finished pieces
         * nobody had sent came *fifth* — below a consignment one day late — because the score
         * treated "stock is standing" as one problem however much of it there was. Thirty
         * thousand pieces made and not moving is the most expensive shape a delay takes [§17–19]:
         * the buyer is waiting for something that already exists, so every day is pure loss.
         *
         * Its own term rather than smuggled through `value`, because pieces are not rupees and
         * an expression that converts between them to reuse a cap is arithmetic nobody can read.
         * Capped at 12 so a large backlog lifts a finding without swamping a stopped line.
         */
        Math.min(12, (pieces / 10000) * 5)
    )
  );

/* ------------------------------ Production's ground ------------------------------ */

/**
 * Lines past the date somebody was given, and lines the plant has said it will miss.
 *
 * Two findings rather than one, because they want different actions: the first is an apology to
 * make, the second is a plan to change while there is still time.
 */
async function productionFindings() {
  const orders = await SalesOrder.find({
    status: { $nin: [...PRE_RELEASE_STATUSES, ...CLOSED_ORDER_STATUSES] },
  })
    .populate('customer', 'name')
    .select('number customer lines status priority');

  const late = [];
  const willMiss = [];
  const held = [];

  for (const order of orders) {
    for (const line of order.lines || []) {
      const row = {
        order: order.number,
        orderId: order._id,
        customer: order.customer?.name,
        model: line.modelNumber || 'a model',
        owed: line.toMakeQty,
        days: line.dueToBuyer ? daysSince(line.dueToBuyer) : 0,
      };
      if (line.isOverdue) late.push(row);
      else if (line.willMissPromise) willMiss.push(row);
      if (line.production?.holdReason) held.push({ ...row, why: line.production.holdReason });
    }
  }

  const findings = [];

  if (late.length) {
    const worst = late.sort((a, b) => b.days - a.days)[0];
    const pieces = late.reduce((sum, row) => sum + (row.owed || 0), 0);
    findings.push({
      kind: 'production_late',
      department: 'production',
      headline: `${plural(late.length, 'line is', 'lines are')} past the date the buyer was given`,
      detail:
        `${plural(pieces, 'piece', 'pieces')} still to make. The worst is ${worst.model} on ` +
        `${worst.order}${worst.customer ? ` for ${worst.customer}` : ''}, ${over(worst.days)}.`,
      severity: severity({ base: 55, days: worst.days, count: late.length }),
      count: late.length,
      link: `/orders/${worst.orderId}`,
    });
  }

  if (willMiss.length) {
    findings.push({
      kind: 'production_will_miss',
      department: 'production',
      headline: `${plural(willMiss.length, 'line', 'lines')} the plant already expects to miss`,
      detail:
        'The forecast is past the date the buyer holds, and nothing has passed yet — this is the ' +
        'window where expediting or re-agreeing the date still works.',
      severity: severity({ base: 40, count: willMiss.length }),
      count: willMiss.length,
      link: '/production',
    });
  }

  if (held.length) {
    const worst = held.sort((a, b) => b.days - a.days)[0];
    findings.push({
      kind: 'production_held',
      department: 'production',
      headline: `${plural(held.length, 'line is', 'lines are')} held and not running`,
      detail: `The longest-standing reason: “${worst.why}” on ${worst.model}, ${worst.order}.`,
      severity: severity({ base: 45, days: worst.days, count: held.length }),
      count: held.length,
      link: '/production',
    });
  }

  return findings;
}

/* ------------------------------- Despatch's ground ------------------------------- */

/**
 * Goods made and still standing, consignments past their date, and proof that never came back.
 *
 * The first of those is the one worth leading with and the one no screen used to ask about: an
 * order made on time and never sent is a failure where everything the customer is waiting for
 * has already been done, which is the most expensive shape a delay can take.
 */
async function despatchFindings() {
  const findings = [];

  /* Consignments past the date they are judged against, still on the road. */
  const onRoad = await Dispatch.find({
    status: { $nin: [...CLOSED_DISPATCH_STATUSES] },
  })
    .populate('customer', 'name')
    .select('number customer status expectedDeliveryDate promise deliveredAt pod dispatchDate');

  const overdue = onRoad.filter((row) => row.isOverdue);
  if (overdue.length) {
    const worst = overdue.sort((a, b) => daysSince(b.dueDate) - daysSince(a.dueDate))[0];
    findings.push({
      kind: 'dispatch_overdue',
      department: 'despatch',
      headline: `${plural(overdue.length, 'consignment is', 'consignments are')} past the date it was owed`,
      detail:
        `${worst.number}${worst.customer?.name ? ` for ${worst.customer.name}` : ''} is ` +
        `${over(daysSince(worst.dueDate))}` +
        `${worst.dueDateIsPromise ? ' against a date promised to the buyer' : ''}.`,
      severity: severity({ base: 50, days: daysSince(worst.dueDate), count: overdue.length }),
      count: overdue.length,
      link: `/dispatches/${worst._id}`,
    });
  }

  /* Delivered, and nobody has the signed copy. Accounts cannot answer a dispute on any of them. */
  /*
   * `ARRIVED_DISPATCH_STATUSES` includes `cancelled`, because for the *stock* arithmetic a
   * cancelled consignment has stopped holding pieces. It is the wrong list here: a cancelled
   * load has no proof of delivery because it was never delivered, and flagging it would put a
   * permanent row on the card that nobody can ever clear.
   */
  const noPod = await Dispatch.find({
    status: { $in: ARRIVED_DISPATCH_STATUSES.filter((status) => status !== 'cancelled') },
    'pod.attachment': { $exists: false },
    'closedWithoutPod.reason': { $exists: false },
  })
    .select('number deliveredAt dispatchDate')
    .limit(200);

  if (noPod.length) {
    const oldest = noPod
      .map((row) => ({ row, days: daysSince(row.deliveredAt || row.dispatchDate || Date.now()) }))
      .sort((a, b) => b.days - a.days)[0];
    findings.push({
      kind: 'dispatch_no_pod',
      department: 'despatch',
      headline: `${plural(noPod.length, 'delivery has', 'deliveries have')} no proof on file`,
      detail:
        'Accounts cannot answer a buyer who disputes receiving the load. The oldest arrived ' +
        `${since(oldest.days)}.`,
      severity: severity({ base: 35, days: oldest.days, count: noPod.length }),
      count: noPod.length,
      link: '/dispatches',
    });
  }

  /*
   * Made, packed, free to send, and nobody has raised a consignment for it.
   *
   * Computed from the same stock arithmetic the despatch screens use, so this cannot disagree
   * with what a clerk sees when they open the queue.
   */
  const released = await SalesOrder.find({
    status: { $nin: [...PRE_RELEASE_STATUSES, ...CLOSED_ORDER_STATUSES] },
  })
    .populate('customer', 'name')
    .select('number customer lines status');

  const standing = [];
  for (const order of released) {
    const stock = await stockFor(order);
    /*
     * Zipped back against the order line by index, because `stockOf` returns the arithmetic and
     * not the line: `productionStatus` and the buyer's date are read off the line itself. Read
     * from the stock row they were both `undefined`, which made the test for a finished line
     * always false — this finding existed and never once fired.
     */
    stock.forEach((claim, index) => {
      const line = order.lines?.[index];
      if (!line || claim.available <= 0) return;
      if (line.production?.status !== 'completed') return;

      standing.push({
        order: order.number,
        orderId: order._id,
        customer: order.customer?.name,
        model: claim.modelNumber,
        pieces: claim.available,
        days: line.dueToBuyer ? daysSince(line.dueToBuyer) : 0,
      });
    });
  }

  if (standing.length) {
    const worst = standing.sort((a, b) => b.pieces - a.pieces)[0];
    const pieces = standing.reduce((sum, row) => sum + row.pieces, 0);
    findings.push({
      kind: 'dispatch_stock_standing',
      department: 'despatch',
      headline: `${plural(pieces, 'finished piece is', 'finished pieces are')} made and not sent`,
      detail:
        `The largest is ${plural(worst.pieces, 'piece', 'pieces')} of ${worst.model} on ` +
        `${worst.order}${worst.customer ? ` for ${worst.customer}` : ''}. Everything the buyer ` +
        'is waiting for is already made.',
      /* Weighted by how much is standing — see the `pieces` term, which exists for this. */
      severity: severity({ base: 48, days: worst.days, count: standing.length, pieces }),
      count: standing.length,
      link: '/dispatches',
    });
  }

  return findings;
}

/* -------------------------- Everybody else's, in brief -------------------------- */

/** Questions with a clock on them that nobody has answered [§25]. */
async function queryFindings() {
  const open = await OrderQuery.find({ status: 'open', dueBy: { $lt: new Date() } })
    .select('number askedOf dueBy question order')
    .limit(200);
  if (!open.length) return [];

  const byDepartment = new Map();
  for (const query of open) {
    if (!byDepartment.has(query.askedOf)) byDepartment.set(query.askedOf, []);
    byDepartment.get(query.askedOf).push(query);
  }

  return [...byDepartment].map(([department, rows]) => {
    const oldest = rows.sort((a, b) => new Date(a.dueBy) - new Date(b.dueBy))[0];
    return {
      kind: 'query_unanswered',
      department,
      headline: `${plural(rows.length, 'question is', 'questions are')} past the time they were promised an answer`,
      detail:
        `The oldest is ${oldest.number}, ${over(daysSince(oldest.dueBy))}: ` +
        `“${String(oldest.question || '').slice(0, 120)}”`,
      severity: severity({ base: 30, days: daysSince(oldest.dueBy), count: rows.length }),
      count: rows.length,
      link: `/orders/${oldest.order}`,
    };
  });
}

/** Money owed, and promises about money that have been broken [§25]. */
async function moneyFindings() {
  const open = await Receivable.find({ balance: { $gt: 0 } })
    .populate('customer', 'name')
    .select('number customer amount balance dueDate followUps judgement order')
    .limit(500);

  const overdue = open.filter((row) => row.isOverdue);
  if (!overdue.length) return [];

  const owed = overdue.reduce((sum, row) => sum + row.balance, 0);
  const broken = overdue.filter((row) => row.promise?.broken);
  const worst = overdue.sort((a, b) => b.balance - a.balance)[0];

  const findings = [{
    kind: 'money_overdue',
    department: 'accounts',
    headline: `${lakh(owed)} is overdue across ${plural(overdue.length, 'invoice', 'invoices')}`,
    detail:
      `The largest is ${worst.number}, ${lakh(worst.balance)} from ` +
      `${worst.customer?.name || 'a customer'}.`,
    severity: severity({ base: 40, days: daysSince(worst.dueDate), count: overdue.length, value: owed }),
    count: overdue.length,
    value: owed,
    link: '/payments',
  }];

  if (broken.length) {
    findings.push({
      kind: 'money_promise_broken',
      department: 'accounts',
      headline: `${plural(broken.length, 'buyer has', 'buyers have')} broken a promise to pay`,
      detail:
        'They named a date and it has gone. This is the only kind of chase with something to ' +
        'hold them to, so it is the call to make first.',
      severity: severity({ base: 50, count: broken.length, value: broken.reduce((s, r) => s + r.balance, 0) }),
      count: broken.length,
      value: broken.reduce((sum, row) => sum + row.balance, 0),
      link: '/payments',
    });
  }

  return findings;
}

/**
 * Work handed to a department that nobody there has picked up [§35].
 *
 * The one finding about the app's own queues rather than the plant's goods, and it earns its
 * place: an escalation nobody claims is the failure mode of the handover feature itself. If
 * despatch has four jobs production stopped on and none has been taken, that is worth saying
 * before anybody looks at a consignment.
 */
async function queueFindings() {
  const unclaimed = await Todo.find({
    completed: false,
    user: { $exists: false },
    'escalation.at': { $exists: true },
    'escalation.acknowledgedAt': { $exists: false },
  })
    .select('department escalation title')
    .limit(200);

  const byDepartment = new Map();
  for (const task of unclaimed) {
    if (!byDepartment.has(task.department)) byDepartment.set(task.department, []);
    byDepartment.get(task.department).push(task);
  }

  return [...byDepartment].map(([department, rows]) => {
    const oldest = rows.sort((a, b) => new Date(a.escalation.at) - new Date(b.escalation.at))[0];
    return {
      kind: 'queue_unclaimed',
      department,
      headline: `${plural(rows.length, 'job', 'jobs')} another department handed over, nobody has taken`,
      detail:
        `The oldest came from ${String(oldest.escalation.from || '').replace(/_/g, ' ')} ` +
        `${since(daysSince(oldest.escalation.at))}: “${oldest.title}”`,
      severity: severity({ base: 38, days: daysSince(oldest.escalation.at), count: rows.length }),
      count: rows.length,
      link: '/',
    };
  });
}

/**
 * The whole picture, or one department's slice of it.
 *
 * `department` narrows to what that department can actually clear — which is the right cut for
 * their own screen, because a despatch clerk cannot do anything about a held press and a list
 * that tells them about one is a list they stop reading. Management and admins get everything.
 *
 * Ordered by computed severity before anything else sees it, so the fallback ranking is already
 * in place and a review that fails leaves a sensible list rather than an arbitrary one.
 */
export async function gatherFindings({ department } = {}) {
  const [production, despatch, queries, money, queues] = await Promise.all([
    productionFindings(),
    despatchFindings(),
    queryFindings(),
    moneyFindings(),
    queueFindings(),
  ]);

  const all = [...production, ...despatch, ...queries, ...money, ...queues]
    .filter((finding) => !department || finding.department === department)
    .sort((a, b) => b.severity - a.severity)
    /*
     * Identified by position *after* sorting, so an id is stable within one review and means
     * nothing outside it. The model names picks by id rather than quoting them back, which is
     * what stops a rephrased headline reaching a screen as though it were the record.
     */
    .map((finding, index) => ({ ...finding, id: `f${index + 1}` }));

  return all;
}
