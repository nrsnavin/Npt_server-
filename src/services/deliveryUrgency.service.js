import Todo from '../models/Todo.js';
import Enquiry from '../models/Enquiry.js';
import ApiError from '../utils/ApiError.js';
import { isManagement } from '../utils/departments.js';
import { DELIVERY_URGENCIES, dueByFor, urgencyFromSchedule, urgencyOf } from '../config/deliveryUrgency.js';
import { raiseTask, resolveTasks } from './task.service.js';
import { EVENTS, publish } from './events.service.js';

/**
 * Delivery urgency on a Dispatch request, and the queue it orders [config/deliveryUrgency.js].
 *
 * Marketing (the enquiry's marketing person, or whoever raised a team task) or Admin says how
 * soon the buyer needs the goods: Top Most Urgent, Today Morning, Today Evening, Today or
 * Tomorrow. A request raised with a Dispatch schedule takes it from there; one the app raises by
 * itself (Assembly ready, Quality done) asks the marketing person with a To-do. Dispatch is never
 * held for it: a request with no urgency yet stands at the foot of the queue, marked so, and can
 * be packed and sent all the same.
 */

const idOf = (value) => String(value?._id || value || '');
const askKey = (task) => `delivery-urgency:${idOf(task._id)}`;

/** The marketing person a request's urgency is asked of: the enquiry's, or the team task's raiser. */
async function ownerOf(task) {
  if (task.enquiry) {
    const enquiry = await Enquiry.findById(idOf(task.enquiry)).select('assignedTo number customer').populate('customer', 'name').lean();
    return { owner: enquiry?.assignedTo || null, enquiry };
  }
  const root = task.chain && idOf(task.chain) !== idOf(task._id) ? await Todo.findById(task.chain).select('createdBy').lean() : null;
  return { owner: root?.createdBy || task.createdBy || null, enquiry: null };
}

/** Whether this person may give or change a request's urgency: Admin, or its marketing person. */
async function mayAnswer(user, task) {
  if (isManagement(user)) return true;
  const { owner } = await ownerOf(task);
  return Boolean(owner) && idOf(owner) === idOf(user?._id);
}

/** What the request is about, in a few words, for the To-do and the queue. */
const aboutOf = (task, enquiry) => [enquiry?.number, enquiry?.customer?.name || task.brief?.customer, task.brief?.model].filter(Boolean).join(' · ') || task.title;

/**
 * Gives or changes a request's delivery urgency. A change says why; Dispatch hears either,
 * and the To-do asking for it is done.
 */
export async function setDeliveryUrgency(task, user, { urgency, note } = {}, { system = false } = {}) {
  if (task.kind !== 'invoice_dispatch') throw ApiError.badRequest('Delivery urgency is given on a Dispatch request');
  if (task.completed) throw ApiError.conflict('That request is already finished');
  const chosen = urgencyOf(urgency);
  if (!chosen) throw ApiError.badRequest(`Pick one of: ${DELIVERY_URGENCIES.map((entry) => entry.label).join(', ')}`);
  if (!system && !(await mayAnswer(user, task))) {
    throw ApiError.forbidden('The delivery urgency is given by the enquiry’s marketing person or Admin');
  }
  const text = String(note || '').trim();
  const before = task.delivery?.urgency ? urgencyOf(task.delivery.urgency) : null;
  if (before && !system && text.length < 3) throw ApiError.badRequest('Say why the urgency is changing');
  if (before?.key === chosen.key && !text) return task;

  const at = new Date();
  const dueBy = dueByFor(chosen.key, at);
  task.delivery = { urgency: chosen.key, label: chosen.label, dueBy, note: text || undefined, by: user?._id, at };
  task.markModified('delivery');
  const said = before ? `Delivery urgency changed: ${before.label} → ${chosen.label}` : `Delivery urgency: ${chosen.label}`;
  task.updates = [...(task.updates || []), {
    kind: 'note', statusLabel: before ? 'Urgency changed' : 'Delivery urgency', text: text || undefined,
    note: text ? `${said} — ${text}` : said, by: user?._id, at,
  }];
  await task.save();
  await resolveTasks(askKey(task));
  if (!system) {
    /* Dispatch, whose queue it orders, hears it; marketing and Admin are the ones who said it. */
    const { noticeStatus, peopleOn } = await import('./handoff.service.js');
    await noticeStatus(task, user, { step: { key: 'delivery_urgency', label: said }, note: text || undefined, date: dueBy || undefined, also: await peopleOn(task), onlyAlso: true });
  }
  await publish(EVENTS.HANDOFF_UPDATED, { task, by: user });
  return task;
}

/**
 * A Dispatch request has just been raised: its urgency from its own Dispatch schedule, or a
 * To-do for its marketing person to give one. Safe to run again — once set, nothing happens.
 */
export async function askForUrgency(task) {
  if (!task || task.kind !== 'invoice_dispatch' || task.completed || task.delivery?.urgency) return null;
  const fromForm = urgencyFromSchedule(task.brief?.schedule);
  if (fromForm) return setDeliveryUrgency(task, { _id: task.createdBy }, { urgency: fromForm }, { system: true });
  const { owner, enquiry } = await ownerOf(task);
  if (!owner) return null;
  return raiseTask({
    user: owner,
    title: `Set delivery urgency — ${aboutOf(task, enquiry)}`,
    notes: 'The goods are with Dispatch. Say how soon the buyer needs them — Top Most Urgent, Today Morning, Today Evening, Today or Tomorrow — so Dispatch can queue the delivery.',
    dueDate: new Date(),
    priority: 'high',
    link: enquiry ? `/enquiries/${idOf(enquiry._id)}` : '/departments/mine',
    originKey: askKey(task),
  });
}

/**
 * The Dispatch desk's delivery queue: every open request, the most pressing first —
 *   1. late (past its cut-off), the most overdue first;
 *   2. Top Most Urgent;
 *   3. then by cut-off (Today Morning by noon, Today Evening and Today by 7 PM, Tomorrow by 7 PM
 *      tomorrow), the stronger urgency first where two share a cut-off;
 *   4. last, the requests nobody has given an urgency yet, oldest first.
 */
export async function deliveryQueue({ now = new Date() } = {}) {
  const tasks = await Todo.find({ kind: 'invoice_dispatch', completed: false })
    .select('title enquiry customer brief status statusHistory user createdAt createdBy delivery priority chain')
    .populate([
      { path: 'enquiry', select: 'number customer assignedTo', populate: [{ path: 'customer', select: 'name code city' }, { path: 'assignedTo', select: 'name' }] },
      { path: 'customer', select: 'name code city' },
      { path: 'user', select: 'name' },
      { path: 'createdBy', select: 'name' },
    ])
    .lean();
  const { default: User } = await import('../models/User.js');
  const setters = new Map((await User.find({ _id: { $in: tasks.map((task) => task.delivery?.by).filter(Boolean) } }).select('name').lean())
    .map((person) => [idOf(person._id), person.name]));
  const { findHandoff } = await import('../config/handoffs.js');
  const statuses = findHandoff('invoice_dispatch')?.form?.statuses || [];
  const rows = tasks.map((task) => {
    const urgency = task.delivery?.urgency ? urgencyOf(task.delivery.urgency) : null;
    const dueBy = task.delivery?.dueBy ? new Date(task.delivery.dueBy) : null;
    const late = Boolean(dueBy && dueBy < now);
    const customer = task.enquiry?.customer || task.customer || null;
    return {
      task: {
        _id: task._id, title: task.title, status: task.status,
        statusLabel: statuses.find((entry) => entry.key === task.status)?.label || null,
        with: task.user ? { _id: task.user._id, name: task.user.name } : null, createdAt: task.createdAt,
      },
      enquiry: task.enquiry ? { _id: task.enquiry._id, number: task.enquiry.number } : null,
      customer: customer ? { _id: customer._id, name: customer.name, code: customer.code, city: customer.city } : null,
      owner: task.enquiry?.assignedTo ? { _id: task.enquiry.assignedTo._id, name: task.enquiry.assignedTo.name } : task.createdBy ? { _id: task.createdBy._id, name: task.createdBy.name } : null,
      model: task.brief?.model || null,
      quantity: task.brief?.quantity || null,
      delivery: urgency
        ? { urgency: urgency.key, label: urgency.label, rank: urgency.rank, dueBy, late, note: task.delivery.note || null, by: setters.get(idOf(task.delivery.by)) || null, at: task.delivery.at }
        : null,
      link: task.enquiry ? `/enquiries/${task.enquiry._id}` : '/departments/despatch',
    };
  });
  const band = (row) => {
    if (!row.delivery) return 3;
    if (row.delivery.late) return 0;
    if (row.delivery.urgency === 'top_urgent') return 1;
    return 2;
  };
  rows.sort((a, b) => band(a) - band(b)
    || (a.delivery?.dueBy && b.delivery?.dueBy ? a.delivery.dueBy - b.delivery.dueBy : 0)
    || (a.delivery?.rank ?? 9) - (b.delivery?.rank ?? 9)
    || new Date(a.task.createdAt) - new Date(b.task.createdAt));
  return rows;
}
