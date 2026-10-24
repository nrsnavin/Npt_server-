import Todo from '../models/Todo.js';
import Enquiry from '../models/Enquiry.js';
import ApiError from '../utils/ApiError.js';
import { inDepartment, isManagement } from '../utils/departments.js';
import { raiseTask, resolveTasks } from './task.service.js';
import { EVENTS, publish } from './events.service.js';

/**
 * The EDD asked for wherever work starts without one. The EDD — the date the buyer is promised —
 * is marketing's [Enquiry `edd`], and the Production, Printing, Assembly and Dispatch queues run
 * in its order; a task on one of those queues with no EDD has no place in it. So:
 *
 *   - the person raising such a task (marketing or Admin) is asked for it on the form, and gives
 *     it there [handoff.service `sendHandoff`, `raiseTeamTask`];
 *   - a task raised with none — by the app (SO prepared → Production, Quality passed → Dispatch,
 *     Production's routing → Printing / Assembly) or by somebody who does not set it — gives the
 *     enquiry's marketing person (on a job with no enquiry, whoever raised the job) a To-do,
 *     "Set the EDD", due today, once per job; and the enquiry and task pages ask for it too;
 *   - setting it answers the To-do.
 *
 * A job with no enquiry — raised from the customer — keeps its EDD on its tasks, every task of the
 * job's chain alike [Todo `jobEdd`, `chain`].
 */

/** The tasks on the queues the EDD orders. */
export const EDD_ASK_KINDS = ['ask_edd', 'ask_printing', 'ask_assembling_edd', 'invoice_dispatch'];

const idOf = (value) => String(value?._id || value || '');
const chainOf = (task) => idOf(task.chain || task._id);
const DAY_MS = 24 * 60 * 60 * 1000;
const indiaDay = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
const prettyDay = (day) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${day}T00:00:00.000+05:30`));

/** The To-do asking for a job's EDD: one per enquiry, or per job with no enquiry. */
export const askKeyFor = ({ enquiry, chain }) => (enquiry ? `edd-needed:e:${idOf(enquiry)}` : `edd-needed:c:${idOf(chain)}`);
const askKeyOf = (task) => askKeyFor(task.enquiry ? { enquiry: task.enquiry } : { chain: chainOf(task) });

/** Who sets the EDD: Admin and the marketing team. */
export const setsEdd = (user) => Boolean(user) && (isManagement(user) || inDepartment(user, 'marketing'));

/** A date given as a calendar day, checked: today or later. */
export function eddDayOf(date, label = 'The EDD') {
  const given = String(date || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(given) || Number.isNaN(Date.parse(given))) throw ApiError.badRequest(`Give ${label.toLowerCase()} as a calendar date`);
  if (given < indiaDay(new Date())) throw ApiError.badRequest(`${label} cannot be in the past`);
  return given;
}

/** The job's EDD: the enquiry's, or — raised from the customer — the one on the job's tasks. */
export async function eddOfJob(task) {
  if (task.enquiry) {
    const enquiry = task.enquiry?.edd !== undefined ? task.enquiry : await Enquiry.findById(idOf(task.enquiry)).select('edd').lean();
    return enquiry?.edd?.date || null;
  }
  if (task.jobEdd?.date) return task.jobEdd.date;
  const other = await Todo.findOne({ chain: chainOf(task), 'jobEdd.date': { $exists: true } }).select('jobEdd').lean();
  return other?.jobEdd?.date || null;
}

/**
 * A task on one of the queues has just been raised: with no EDD on its job, its marketing person
 * is asked for one — a To-do, due today, once per job. Safe to run again.
 */
export async function askForEdd(task) {
  if (!task || task.completed || !EDD_ASK_KINDS.includes(task.kind)) return null;
  if (await eddOfJob(task)) return null;
  let owner = null;
  let about = task.title?.split(' — ').slice(1).join(' — ') || task.title;
  let link = '/departments/mine';
  if (task.enquiry) {
    const enquiry = await Enquiry.findById(idOf(task.enquiry)).select('number assignedTo customer').populate('customer', 'name').lean();
    if (!enquiry) return null;
    owner = enquiry.assignedTo;
    about = [enquiry.number, enquiry.customer?.name].filter(Boolean).join(' · ');
    link = `/enquiries/${enquiry._id}`;
  } else {
    const root = idOf(task.chain) && idOf(task.chain) !== idOf(task._id) ? await Todo.findById(task.chain).select('createdBy').lean() : null;
    owner = root?.createdBy || task.createdBy;
  }
  if (!owner) return null;
  return raiseTask({
    user: owner,
    title: `Set the EDD — ${about}`,
    notes: 'Work has started on this order with no EDD. The EDD is the date the buyer is promised: the Production, Printing, Assembly and Dispatch queues run in its order, so the order has no place in them until it is set. Set it on the enquiry (or on the task, for a job raised from the customer).',
    dueDate: new Date(Date.now() + DAY_MS / 24),
    priority: 'high',
    link,
    originKey: askKeyOf(task),
  });
}

/** The EDD was set: the To-do asking for it is answered. */
export async function eddGiven({ enquiry, chain }) {
  return resolveTasks(askKeyFor(enquiry ? { enquiry } : { chain }));
}

/**
 * The EDD of a job raised from the customer, set by marketing or Admin from any of its tasks:
 * written on every task of the job, said on the open ones that work to it, the To-do answered.
 */
export async function setJobEdd(task, user, { date, note } = {}) {
  if (task.enquiry) throw ApiError.badRequest('This task is on an enquiry — set the EDD on the enquiry');
  if (!setsEdd(user)) throw ApiError.forbidden('The EDD is set by the marketing team or Admin');
  const day = eddDayOf(date);
  const text = String(note || '').trim();
  const chain = chainOf(task);
  const jobEdd = { date: day, by: user._id, at: new Date(), department: 'marketing', ...(text ? { note: text } : {}) };
  await Todo.updateMany({ $or: [{ chain }, { _id: chain }] }, { $set: { jobEdd } });
  const said = `EDD ${prettyDay(day)} set by ${user.name} (marketing)${text ? `: ${text}` : ''}`;
  const open = await Todo.find({ $or: [{ chain }, { _id: chain }], kind: { $in: EDD_ASK_KINDS }, completed: false });
  for (const entry of open) {
    entry.updates = [...(entry.updates || []), { kind: 'note', text: said, note: said, date: day, dateLabel: 'EDD', by: user._id, at: new Date() }];
    await entry.save();
    await publish(EVENTS.HANDOFF_UPDATED, { task: entry, by: user });
  }
  await eddGiven({ chain });
  return Todo.findById(task._id);
}
