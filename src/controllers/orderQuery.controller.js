import OrderQuery, { QUERY_URGENCY } from '../models/OrderQuery.js';
import SalesOrder from '../models/SalesOrder.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { nextNumber } from '../services/numbering.service.js';
import { listParams, paginated } from '../utils/query.js';
import { ownsRecord } from '../services/ownership.service.js';
import { findDepartment } from '../config/modules.js';

/**
 * Questions asked against a sales order [BLUEPRINT §12 by extension, §25 for the clock].
 *
 * **Who may ask, and who may answer, is the only interesting access question here**, and the
 * answer is not the obvious one. Raising a query is a write — but a write to the *query*, not
 * to the order, and marketing holds `orders` at read. Gating this on `orders: write` would mean
 * the one department the feature exists for could not use it: marketing is who asks, order
 * confirmation is who owns the module, and they are not the same people.
 *
 * So the rule is the one the record actually implies: **anyone who may read the order may ask a
 * question about it, and may answer one put to their own department.** Nothing here changes the
 * order, and a question is not a secret from somebody already entitled to read what it is
 * about. Ownership still applies underneath — a marketing person cannot open a colleague's
 * order, so they cannot ask about it either, which falls out of the same check the order does.
 *
 * The one thing that is *not* open: closing. Only the asker closes, because `answered` and
 * `closed` are two people's judgements and letting the answerer do both is letting them mark
 * their own work.
 */

const POPULATE = [
  { path: 'raisedBy', select: 'name department' },
  { path: 'answers.by', select: 'name department' },
  { path: 'closedBy', select: 'name' },
];

/** The order this question is about, or a refusal that gives nothing away about it existing. */
async function readableOrder(id, user) {
  const order = await SalesOrder.findById(id);
  if (!order) throw ApiError.notFound('Order not found');
  if (!ownsRecord(user, order)) throw ApiError.notFound('Order not found');
  return order;
}

/** Where the clock is set from — see `QUERY_URGENCY` for why these hours and not §25's. */
const dueFrom = (urgency) => {
  const tier = QUERY_URGENCY.find((entry) => entry.key === urgency) || QUERY_URGENCY[0];
  return new Date(Date.now() + tier.hours * 3600000);
};

/* --------------------------------- Reading --------------------------------- */

/**
 * The questions on one order.
 *
 * Ordered so the panel reads the way somebody actually scans it: what is still waiting, then
 * what has been answered and not yet closed, then the settled ones. Sorting by date alone would
 * bury an unanswered question from Tuesday under three closed ones from this morning, which is
 * the exact failure this feature exists to fix.
 */
export const listOrderQueries = asyncHandler(async (req, res) => {
  const order = await readableOrder(req.params.id, req.user);

  const queries = await OrderQuery.find({ order: order._id })
    .populate(POPULATE)
    .sort({ createdAt: -1 });

  const rank = { open: 0, answered: 1, closed: 2 };
  queries.sort((a, b) => rank[a.status] - rank[b.status]);

  res.json({
    success: true,
    data: queries,
    meta: {
      open: queries.filter((query) => query.status === 'open').length,
      overdue: queries.filter((query) => query.isOverdue).length,
    },
  });
});

/**
 * The queue: what is being asked of a department, across every order.
 *
 * Defaults to the caller's own department, because "what am I being asked" is the question this
 * screen exists for and typing your own department into a filter to see your own work is a
 * step nobody should have to take. An explicit `askedOf` still works — a manager looking across
 * the plant is a real reader of this list.
 */
export const listQueryQueue = asyncHandler(async (req, res) => {
  const { page, limit, sort, filter } = listParams(req.query, {
    searchFields: ['number', 'question'],
    defaultSort: 'dueBy',
  });

  filter.askedOf = req.query.askedOf || req.user.department;

  if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };
  /* The default view: what is still owed. A queue of settled questions is not a queue. */
  else if (req.query.all !== 'true') filter.status = { $in: ['open', 'answered'] };

  if (req.query.overdue === 'true') {
    filter.status = 'open';
    filter.dueBy = { $lt: new Date() };
  }

  const [data, total] = await Promise.all([
    OrderQuery.find(filter)
      .populate([...POPULATE, { path: 'order', select: 'number customer status' }])
      .populate({ path: 'order', populate: { path: 'customer', select: 'name' } })
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit),
    OrderQuery.countDocuments(filter),
  ]);

  paginated(res, data, { page, limit, total });
});

/* --------------------------------- Writing --------------------------------- */

export const raiseOrderQuery = asyncHandler(async (req, res) => {
  const order = await readableOrder(req.params.id, req.user);

  const { line, askedOf, question, urgency = 'normal' } = req.body;

  /*
   * A line that is not on this order is refused rather than quietly dropped. A question about
   * "line 2" that silently became a question about the whole order is worse than a refusal:
   * it gets answered, about the wrong thing, and nobody notices.
   */
  if (line && !order.lines.id(line)) {
    throw ApiError.badRequest('That line is not on this order');
  }
  if (!findDepartment(askedOf)) {
    throw ApiError.badRequest(`There is no ${askedOf} department to ask`);
  }

  const query = await OrderQuery.create({
    number: await nextNumber('QRY'),
    order: order._id,
    line: line || undefined,
    raisedBy: req.user._id,
    askedOf,
    question,
    urgency,
    dueBy: dueFrom(urgency),
  });

  await query.populate(POPULATE);
  res.status(201).json({ success: true, data: query });
});

/**
 * Answering.
 *
 * Appends rather than replaces, so a follow-up question and its second answer stay readable as
 * an exchange. The status moves to `answered` and stops there — closing is the asker's, and a
 * second answer on an already-answered question reopens nothing: it is more of the same
 * conversation, and forcing it back to `open` would restart a clock the plant already met.
 */
export const answerOrderQuery = asyncHandler(async (req, res) => {
  const query = await OrderQuery.findById(req.params.queryId);
  if (!query) throw ApiError.notFound('Question not found');

  /* The order still gates it: answering a question about an order you may not read is reading it. */
  await readableOrder(query.order, req.user);

  if (query.status === 'closed') {
    throw ApiError.badRequest('This question has been closed — raise a new one');
  }

  query.answers.push({ body: req.body.body, by: req.user._id });
  if (query.status === 'open') query.status = 'answered';
  await query.save();

  await query.populate(POPULATE);
  res.json({ success: true, data: query });
});

/**
 * Closing, which only the asker may do.
 *
 * The whole reason `answered` and `closed` are two states. An answer that did not answer is the
 * common case — "when will it be ready?" / "soon" — and a plant that could close its own
 * questions would have a queue that empties itself while nobody learns anything.
 *
 * The exception is an administrator, because somebody has to be able to tidy up after a person
 * who has left, and the alternative is a question that can never be closed by anyone.
 */
export const closeOrderQuery = asyncHandler(async (req, res) => {
  const query = await OrderQuery.findById(req.params.queryId);
  if (!query) throw ApiError.notFound('Question not found');

  await readableOrder(query.order, req.user);

  const asker = String(query.raisedBy) === String(req.user._id);
  if (!asker && req.user.role !== 'admin') {
    throw ApiError.forbidden('Only whoever asked can close a question — say so in an answer instead');
  }
  if (query.status === 'closed') throw ApiError.badRequest('This question is already closed');

  if (!query.answers.length && !req.body.note?.trim()) {
    /*
     * Closing something nobody answered is legitimate — the buyer withdrew the question, or it
     * answered itself — but it needs a reason, or the record says a question was resolved when
     * what happened is that it was abandoned.
     */
    throw ApiError.badRequest('Nothing has been answered — say why this is being closed');
  }

  query.status = 'closed';
  query.closedBy = req.user._id;
  query.closedAt = new Date();
  if (req.body.note?.trim()) {
    query.answers.push({ body: req.body.note, by: req.user._id });
  }
  await query.save();

  await query.populate(POPULATE);
  res.json({ success: true, data: query });
});
