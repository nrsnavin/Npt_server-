import OrderEscalation, {
  ESCALATION_KINDS, ESCALATION_SEVERITY,
} from '../models/OrderEscalation.js';
import SalesOrder from '../models/SalesOrder.js';
import Dispatch from '../models/Dispatch.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { nextNumber } from '../services/numbering.service.js';
import { listParams, paginated } from '../utils/query.js';
import { ownershipFilter, ownsRecord } from '../services/ownership.service.js';
import { raiseTask } from '../services/task.service.js';
import { findDepartment } from '../config/modules.js';

/**
 * Orders the floor has stopped on [BLUEPRINT §25 by extension].
 *
 * The alarm only ran one way before this. Marketing could pull an order forward and the plant
 * and the yard saw it on their day screens; the plant and the yard had no way back. A stopped
 * order looked exactly like a running one to everybody not standing next to the machine, and
 * the buyer found out from their own delivery date.
 *
 * **Who may raise one** is the same rule queries settled on, and for the same reason: anyone who
 * may read the order. Nothing here writes to the order, marketing holds `orders` at read, and a
 * rule tied to `orders: write` would exclude the departments the feature exists for — production
 * and despatch hold that module at write, not this one. Ownership still applies underneath,
 * through the order.
 *
 * **Who may resolve one** is deliberately narrower, and it is not whoever fixed it. An
 * escalation closes on a claim about the world — the resin arrived, the tool is back — and the
 * person entitled to make that claim is the one who said they were stopped. Purchase believing
 * the drum was delivered is not the plant being able to run. So: the raiser, anybody in the
 * department that raised it, or an administrator when that department has nobody at a screen.
 * Everyone else posts an update saying what they did, which is what the raiser resolves on.
 */

const POPULATE = [
  { path: 'raisedBy', select: 'name department' },
  { path: 'dispatch', select: 'number status transporter lrNumber' },
  { path: 'updates.by', select: 'name department' },
  { path: 'resolvedBy', select: 'name department' },
];

const WITH_ORDER = [
  ...POPULATE,
  { path: 'order', select: 'number status priority deliveryDate assignedTo customer' },
];

/** The order this is about, or a refusal that gives nothing away about it existing. */
async function readableOrder(id, user) {
  const order = await SalesOrder.findById(id);
  if (!order) throw ApiError.notFound('Order not found');
  if (!ownsRecord(user, order)) throw ApiError.notFound('Order not found');
  return order;
}

/**
 * Worst first, then oldest.
 *
 * Severity before age because a stoppage this morning outranks a warning from Tuesday, and age
 * within it because of the two stoppages the older one has already cost more. Sorting by date
 * alone buries today's stopped machine under last week's paperwork note, which is the failure
 * that makes people stop reading a list.
 */
const WORST_FIRST = { blocking: 0, warning: 1 };
const byUrgency = (a, b) =>
  WORST_FIRST[a.severity] - WORST_FIRST[b.severity] || new Date(a.createdAt) - new Date(b.createdAt);

/* --------------------------------- Reading --------------------------------- */

/** Everything raised on one order, open first. */
export const listOrderEscalations = asyncHandler(async (req, res) => {
  const order = await readableOrder(req.params.id, req.user);

  const rows = await OrderEscalation.find({ order: order._id }).populate(POPULATE);

  const open = rows.filter((row) => row.status === 'open').sort(byUrgency);
  const done = rows
    .filter((row) => row.status === 'resolved')
    .sort((a, b) => new Date(b.resolvedAt || b.createdAt) - new Date(a.resolvedAt || a.createdAt));

  res.json({
    success: true,
    data: [...open, ...done],
    meta: {
      open: open.length,
      blocking: open.filter((row) => row.severity === 'blocking').length,
    },
  });
});

/**
 * The feed every day screen reads.
 *
 * Deliberately not scoped by department. The point of an escalation is that the fix often
 * belongs to somebody the raiser could not have named — a plant that cannot run for want of
 * resin needs purchasing, and a yard short of paperwork needs accounts — so a list narrowed to
 * "what my department raised" would show each department its own problems and nobody else's,
 * which is the phone call with extra steps.
 *
 * What it *is* scoped by is the order behind it [§29], through exactly the filter the orders
 * list uses. That leaves the serving departments seeing the whole plant, which is right, and a
 * marketing person seeing escalations on their own customers' orders rather than a colleague's.
 */
export const listEscalationFeed = asyncHandler(async (req, res) => {
  const { page, limit, filter } = listParams(req.query, {
    searchFields: ['number', 'detail'],
    defaultSort: '-createdAt',
  });

  const scope = ownershipFilter(req.user);
  if (Object.keys(scope).length) {
    const owned = await SalesOrder.find(scope).select('_id');
    filter.order = { $in: owned.map((order) => order._id) };
  }

  /* Open is the default view, because a feed of settled problems is not a feed. */
  if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };
  else if (req.query.all !== 'true') filter.status = 'open';

  if (req.query.severity) filter.severity = req.query.severity;
  if (req.query.kind) filter.kind = req.query.kind;
  /* `mine=true` is "what my department raised", for somebody checking their own list. */
  if (req.query.mine === 'true') filter.raisedByDepartment = req.user.department;

  const [rows, total] = await Promise.all([
    OrderEscalation.find(filter)
      .populate(WITH_ORDER)
      .populate({ path: 'order', populate: { path: 'customer', select: 'name' } }),
    OrderEscalation.countDocuments(filter),
  ]);

  /* Sorted in memory rather than by the index, because "worst first" is severity then age and
     Mongo cannot express that ordering over an enum without a stored rank nobody would read. */
  const sorted = rows.sort(byUrgency).slice((page - 1) * limit, page * limit);

  paginated(res, sorted, { page, limit, total }, {
    meta: {
      open: rows.filter((row) => row.status === 'open').length,
      blocking: rows.filter((row) => row.status === 'open' && row.severity === 'blocking').length,
      /* What the reader's own department is being looked to for, when anybody named them. */
      onUs: rows.filter((row) => row.status === 'open' && row.needsFrom === req.user.department)
        .length,
      mine: rows.filter(
        (row) => row.status === 'open' && row.raisedByDepartment === req.user.department
      ).length,
    },
  });
});

/** The categories and severities, so the form is built from the server's list rather than a copy. */
export const escalationOptions = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: { kinds: ESCALATION_KINDS, severities: ESCALATION_SEVERITY },
  });
});

/* --------------------------------- Writing --------------------------------- */

export const raiseEscalation = asyncHandler(async (req, res) => {
  const order = await readableOrder(req.params.id, req.user);

  const { line, dispatch, kind, severity = 'blocking', detail, needsFrom } = req.body;

  /* A line that is not on this order is refused rather than quietly dropped — the same reason a
     query refuses one: an alarm about "line 2" that silently became an alarm about the order
     gets acted on, about the wrong model, and nobody notices. */
  if (line && !order.lines.id(line)) {
    throw ApiError.badRequest('That line is not on this order');
  }

  if (dispatch) {
    const consignment = await Dispatch.findById(dispatch).select('order');
    if (!consignment || String(consignment.order) !== String(order._id)) {
      throw ApiError.badRequest('That consignment is not on this order');
    }
  }

  if (needsFrom && !findDepartment(needsFrom)) {
    throw ApiError.badRequest(`There is no ${needsFrom} department to look to`);
  }

  const escalation = await OrderEscalation.create({
    number: await nextNumber('ESC'),
    order: order._id,
    line: line || undefined,
    dispatch: dispatch || undefined,
    raisedBy: req.user._id,
    raisedByDepartment: req.user.department,
    kind,
    severity,
    detail,
    needsFrom: needsFrom || undefined,
  });

  /*
   * The order's owner is told, when somebody else raised it [§29, §31].
   *
   * Every department reads the feed, which is a pull and is right for a list somebody works
   * from. The owner is the exception for the same reason they are on a query: they are the one
   * who has to ring the buyer, and a stoppage they learn about from the buyer is the failure
   * this whole feature exists to remove. Dated today, because an undated task sits only in the
   * to-do rail and My day would call their day clear.
   */
  const ownerId = String(order.assignedTo?._id || order.assignedTo || '');

  if (ownerId && ownerId !== String(req.user._id)) {
    const from = findDepartment(req.user.department)?.label || req.user.department;
    await raiseTask({
      user: ownerId,
      title: `${from} escalated ${order.number}: ${escalation.kindLabel}`,
      notes: String(detail).slice(0, 500),
      dueDate: new Date(),
      priority: severity === 'blocking' ? 'high' : 'normal',
      link: `/orders/${order._id}`,
      originKey: `order-escalated:${escalation._id}`,
    }).catch(() => null);
  }

  await escalation.populate(POPULATE);
  res.status(201).json({ success: true, data: escalation });
});

/** The escalation, loaded and gated through the order it is about. */
async function readableEscalation(id, user) {
  const escalation = await OrderEscalation.findById(id);
  if (!escalation) throw ApiError.notFound('Escalation not found');
  await readableOrder(escalation.order, user);
  return escalation;
}

/**
 * Saying what you did about it.
 *
 * Open to anybody who may read the order, because the person who chased the supplier is very
 * often not in the department that was stopped. It is also what stops three people ringing the
 * same supplier on the same morning.
 */
export const addEscalationUpdate = asyncHandler(async (req, res) => {
  const escalation = await readableEscalation(req.params.escalationId, req.user);

  if (escalation.status === 'resolved') {
    throw ApiError.badRequest('This was resolved — raise a new one if it has come back');
  }

  escalation.updates.push({
    body: req.body.body,
    by: req.user._id,
    byDepartment: req.user.department,
  });
  await escalation.save();

  /*
   * Tell whoever raised it, unless they wrote the update themselves.
   *
   * They are the one waiting to be told they can run again, and an update they have to go
   * looking for is a fix nobody acts on. Keyed on the escalation rather than the update, so a
   * second update while the first is unread does not stack a second copy — the task says go and
   * read it, and one of those is enough.
   */
  if (String(escalation.raisedBy) !== String(req.user._id)) {
    const order = await SalesOrder.findById(escalation.order).select('number');
    await raiseTask({
      user: escalation.raisedBy,
      title: `Somebody answered on ${order?.number || 'your escalation'} — ${escalation.number}`,
      notes: String(req.body.body).slice(0, 500),
      dueDate: new Date(),
      link: `/orders/${escalation.order}`,
      originKey: `escalation-update:${escalation._id}`,
    }).catch(() => null);
  }

  await escalation.populate(POPULATE);
  res.json({ success: true, data: escalation });
});

/**
 * Marking it resolved.
 *
 * The raiser's department, or an administrator. See the note at the top of the file: this closes
 * on a claim about the world, and the party entitled to make it is the one that said it was
 * stopped. A resolution sentence is required for the same reason — a tick lets an escalation
 * close on nothing having changed, and the next person to hit the same problem has no idea
 * whether it was fixed or given up on.
 */
export const resolveEscalation = asyncHandler(async (req, res) => {
  const escalation = await readableEscalation(req.params.escalationId, req.user);

  if (escalation.status === 'resolved') {
    throw ApiError.badRequest(`${escalation.number} is already resolved`);
  }

  const isRaiser = String(escalation.raisedBy) === String(req.user._id);
  const sameDepartment =
    Boolean(escalation.raisedByDepartment) &&
    escalation.raisedByDepartment === req.user.department;

  if (!isRaiser && !sameDepartment && req.user.role !== 'admin') {
    const raiser = findDepartment(escalation.raisedByDepartment)?.label || 'whoever raised it';
    throw ApiError.forbidden(
      `${raiser} raised this, so ${raiser.toLowerCase()} says when it is clear. ` +
        'Add an update saying what you did and they will close it.'
    );
  }

  escalation.status = 'resolved';
  escalation.resolution = req.body.resolution;
  escalation.resolvedBy = req.user._id;
  escalation.resolvedAt = new Date();
  await escalation.save();

  /*
   * Tell the order's owner it is clear.
   *
   * They were told it was stopped, so leaving them to discover it is running again is the same
   * failure pointed the other way: they carry on telling the buyer about a problem that ended
   * on Tuesday. Undated — it is news, not work — so it sits in the to-do rail rather than
   * claiming a slot on somebody's day.
   */
  const order = await SalesOrder.findById(escalation.order).select('number assignedTo');
  const ownerId = String(order?.assignedTo || '');

  if (ownerId && ownerId !== String(req.user._id)) {
    await raiseTask({
      user: ownerId,
      title: `${order.number} is clear again — ${escalation.kindLabel.toLowerCase()} resolved`,
      notes: String(req.body.resolution).slice(0, 500),
      link: `/orders/${escalation.order}`,
      originKey: `escalation-resolved:${escalation._id}`,
    }).catch(() => null);
  }

  await escalation.populate(POPULATE);
  res.json({ success: true, data: escalation });
});
