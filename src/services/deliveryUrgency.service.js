import Todo from '../models/Todo.js';
import Enquiry from '../models/Enquiry.js';
import ApiError from '../utils/ApiError.js';
import { isManagement } from '../utils/departments.js';
import { DEFAULT_URGENCY, DELIVERY_URGENCIES, defaultDueBy, dueByFor, urgencyFromSchedule, urgencyOf } from '../config/deliveryUrgency.js';
import { raiseTask, resolveTasks } from './task.service.js';
import { EVENTS, publish } from './events.service.js';

/**
 * Delivery urgency on a Dispatch request, and the queue it orders [config/deliveryUrgency.js].
 *
 * Marketing (the enquiry's marketing person, or whoever raised a team task) or Admin says how
 * soon the buyer needs the goods: Top Most Urgent, Today Morning, Today Evening, Today or
 * Tomorrow — never Dispatch, whose queue it orders. A request raised with a Dispatch schedule
 * takes it from there. One the app raises by itself (Assembly ready, Quality passed) starts at
 * the default — Today, the day it reached Dispatch [config/deliveryUrgency `defaultDueBy`] — and
 * asks the marketing person, on a To-do and on the enquiry and task pages, to confirm or change
 * it. Confirming or changing the default needs no reason; changing an urgency somebody gave does.
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
export async function setDeliveryUrgency(task, user, { urgency, note } = {}, { system = false, byDefault = false } = {}) {
  if (task.kind !== 'invoice_dispatch') throw ApiError.badRequest('Delivery urgency is given on a Dispatch request');
  if (task.completed) throw ApiError.conflict('That request is already finished');
  const chosen = urgencyOf(urgency);
  if (!chosen) throw ApiError.badRequest(`Pick one of: ${DELIVERY_URGENCIES.map((entry) => entry.label).join(', ')}`);
  if (!system && !(await mayAnswer(user, task))) {
    throw ApiError.forbidden('The delivery urgency is given by the enquiry’s marketing person or Admin');
  }
  const text = String(note || '').trim();
  const before = task.delivery?.urgency ? urgencyOf(task.delivery.urgency) : null;
  /* The default is the app's, not a person's: confirming or changing it needs no reason. */
  const wasDefault = Boolean(task.delivery?.default);
  if (before && !wasDefault && !system && text.length < 3) throw ApiError.badRequest('Say why the urgency is changing');
  if (before?.key === chosen.key && !text && !wasDefault) return task;
  const confirming = wasDefault && before?.key === chosen.key && !byDefault;

  const at = new Date();
  /* Confirmed as it stood: the default's due time stands. The default itself: the day it reached Dispatch. */
  const dueBy = confirming ? task.delivery.dueBy : byDefault ? defaultDueBy(task.createdAt || at) : dueByFor(chosen.key, at);
  task.delivery = { urgency: chosen.key, label: chosen.label, dueBy, note: text || undefined, by: user?._id, at, ...(byDefault ? { default: true } : {}) };
  task.markModified('delivery');
  const said = byDefault ? `Delivery urgency: ${chosen.label} (default — the day it reached Dispatch); marketing to confirm`
    : confirming ? `Delivery urgency confirmed: ${chosen.label}`
      : before ? `Delivery urgency ${wasDefault ? 'set' : 'changed'}: ${before.label} → ${chosen.label}` : `Delivery urgency: ${chosen.label}`;
  task.updates = [...(task.updates || []), {
    /* The default is said in words on the line — nobody chose it, so the line says what it is. */
    kind: 'note', statusLabel: before ? 'Urgency changed' : 'Delivery urgency', text: text || (byDefault ? said : undefined),
    note: text ? `${said} — ${text}` : said, by: user?._id, at,
  }];
  await task.save();
  /* The default still waits on marketing's word; anything else answers the To-do. */
  if (!byDefault) await resolveTasks(askKey(task));
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
  /* Given by a person already: it stands. The default gives way to a schedule marketing adds later. */
  if (!task || task.kind !== 'invoice_dispatch' || task.completed || (task.delivery?.urgency && !task.delivery.default)) return null;
  const fromForm = urgencyFromSchedule(task.brief?.schedule);
  if (fromForm) return setDeliveryUrgency(task, { _id: task.createdBy }, { urgency: fromForm }, { system: true });
  if (task.delivery?.default) return null;
  /* Until marketing says: Today, the day it reached Dispatch — the queue never holds a request with none. */
  await setDeliveryUrgency(task, null, { urgency: DEFAULT_URGENCY }, { system: true, byDefault: true });
  const { owner, enquiry } = await ownerOf(task);
  if (!owner) return null;
  return raiseTask({
    user: owner,
    title: `Confirm delivery urgency — ${aboutOf(task, enquiry)}`,
    notes: 'The goods are with Dispatch, queued for Today (the day they reached Dispatch) until you say otherwise. Confirm it, or change it to Top Most Urgent, Today Morning, Today Evening or Tomorrow, so Dispatch queues the delivery right.',
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
 * A request whose urgency nobody has given reads the default — Today, the day it reached
 * Dispatch — and sorts with the rest by that cut-off, marked as the default.
 */
export async function deliveryQueue({ now = new Date(), user = null } = {}) {
  const tasks = await Todo.find({ kind: 'invoice_dispatch', completed: false })
    .select('title kind department fromDepartment notes enquiry customer order brief status statusHistory updates user createdAt createdBy delivery priority chain dueDate completed modelStatuses')
    .populate([
      { path: 'order', select: 'number' },
      { path: 'updates.by', select: 'name' },
      { path: 'enquiry', select: 'number customer assignedTo edd', populate: [{ path: 'customer', select: 'name code city' }, { path: 'assignedTo', select: 'name' }] },
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
    /* A request from before the default: Today, the day it reached Dispatch, read the same way. */
    const given = task.delivery?.urgency ? task.delivery : { urgency: DEFAULT_URGENCY, dueBy: defaultDueBy(task.createdAt), default: true };
    const urgency = urgencyOf(given.urgency);
    const dueBy = given.dueBy ? new Date(given.dueBy) : null;
    const late = Boolean(dueBy && dueBy < now);
    const customer = task.enquiry?.customer || task.customer || null;
    return {
      /*
       * The request whole, as the task panel opened from the row needs it to move its status
       * [web: components/DeliveryQueue.jsx "Update status"]: what was asked, everything said since.
       */
      task: {
        ...task,
        statusLabel: statuses.find((entry) => entry.key === task.status)?.label || null,
        with: task.user ? { _id: task.user._id, name: task.user.name } : null,
        enquiry: task.enquiry ? { _id: task.enquiry._id, number: task.enquiry.number, edd: task.enquiry.edd || null } : null,
        customer: customer ? { _id: customer._id, name: customer.name } : null,
      },
      /* Only Admin or the request's marketing person gives the urgency — Dispatch reads it. */
      maySetUrgency: Boolean(user) && (isManagement(user) || idOf(task.enquiry?.assignedTo?._id || task.createdBy?._id) === idOf(user._id)),
      enquiry: task.enquiry ? { _id: task.enquiry._id, number: task.enquiry.number } : null,
      customer: customer ? { _id: customer._id, name: customer.name, code: customer.code, city: customer.city } : null,
      owner: task.enquiry?.assignedTo ? { _id: task.enquiry.assignedTo._id, name: task.enquiry.assignedTo.name } : task.createdBy ? { _id: task.createdBy._id, name: task.createdBy.name } : null,
      model: task.brief?.model || null,
      quantity: task.brief?.quantity || null,
      /* `default`: Today, the day it reached Dispatch, until marketing or Admin confirms or changes it. */
      delivery: { urgency: urgency.key, label: urgency.label, rank: urgency.rank, dueBy, late, default: Boolean(given.default), note: given.note || null, by: given.default ? null : setters.get(idOf(given.by)) || null, at: given.at || null },
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
