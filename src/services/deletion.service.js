import mongoose from 'mongoose';
import Todo from '../models/Todo.js';
import Enquiry from '../models/Enquiry.js';
import ApiError from '../utils/ApiError.js';
import { afterCommit } from '../utils/transaction.js';
import { isManagement } from '../utils/departments.js';

/**
 * Admin deleting a task, or an enquiry with everything raised on it [web: "Delete task", "Delete
 * enquiry"]. For mistakes and junk — a duplicate enquiry, a test, a task given to the wrong team —
 * so the lists stop carrying them.
 *
 * What is a record of something that happened is never deleted with them: money (a receipt, an
 * invoice owed), a sales order still alive, goods dispatched, presses run, quality checks, trips,
 * traded purchases. Those are cancelled or closed instead, and the refusal says which and where.
 *
 *   previewTaskDeletion / deleteTask        the task — a team job's first task takes its whole job
 *   previewEnquiryDeletion / deleteEnquiry  the enquiry and every task, sample, quotation, unrun
 *                                           work order, notice and file on it
 *
 * Both run inside the caller's transaction: all of it goes, or none of it. Stored files are
 * removed after the commit. Each deletion is written to the audit trail with what went.
 */

const idOf = (value) => String(value?._id || value || '');
const ids = (rows) => rows.map((row) => row._id);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
/* The models a deletion touches, loaded on first use (several import this service back). */
const FILES = ['Attachment', 'BuyerCard', 'CustomerMessage', 'Dispatch', 'Mould', 'MouldRun', 'PlanDecision', 'QcRecord', 'Quotation', 'Receivable', 'SalesOrder', 'Sample', 'TaskNotice', 'TradeOrder', 'Trip', 'WhatsappThread', 'WorkOrder'];
let loaded = null;
const loadModels = async () => {
  if (!loaded) loaded = Promise.all(FILES.map((file) => import(`../models/${file}.js`)));
  await loaded;
};
const model = (name) => mongoose.model(name);

function assertAdmin(user) {
  if (!isManagement(user)) throw ApiError.forbidden('Only Admin deletes tasks and enquiries. Close or cancel it instead.');
}

/* Files stored for these attachment rows go once the deletion has committed. */
async function dropAttachments(filter) {
  const Attachment = model('Attachment');
  const rows = await Attachment.find(filter).select('key').lean();
  if (!rows.length) return 0;
  await Attachment.deleteMany({ _id: { $in: ids(rows) } });
  const keys = rows.map((row) => row.key).filter(Boolean);
  afterCommit(async () => {
    const { remove } = await import('./storage.service.js');
    for (const key of keys) await remove(key).catch((error) => console.error(`[delete] file ${key} not removed: ${error.message}`));
  });
  return rows.length;
}

/* ------------------------------------------------------------------ tasks */

/** The tasks a deletion takes: the task, or — a team job's first task — every task of its job. */
async function tasksTaken(task) {
  const root = !task.enquiry && idOf(task.chain) === idOf(task._id);
  return root ? Todo.find({ $or: [{ chain: task._id }, { _id: task._id }] }) : [task];
}

/** Why these tasks cannot go — each a record of something that happened. Empty when they can. */
async function taskBlockers(tasks) {
  const taskIds = ids(tasks);
  const out = [];
  for (const task of tasks) {
    if (task.holds && !task.completed) out.push(`${task.title} holds its enquiry — delete the enquiry, or close it`);
    if (task.kind === 'invoice_dispatch' && (task.loads || []).length) out.push(`${task.title} has ${plural(task.loads.length, 'load')} dispatched on it — the shipments are its record; close it instead`);
  }
  const money = await model('Receivable').find({ $or: [{ 'receipts.loggedFrom': { $in: taskIds } }, { 'rejectedReceipts.loggedFrom': { $in: taskIds } }, { task: { $in: taskIds } }] }).select('number').lean();
  if (money.length) out.push(`money was logged from it (${money.map((row) => row.number).join(', ')}) — the receipts keep their record; close the task instead`);
  const [trades, trips] = await Promise.all([
    model('TradeOrder').countDocuments({ task: { $in: taskIds } }),
    model('Trip').countDocuments({ task: { $in: taskIds } }),
  ]);
  if (trades) out.push(`${plural(trades, 'traded purchase')} was raised from it`);
  if (trips) out.push(`it is on ${plural(trips, 'delivery trip')}`);
  return out;
}

/** What deleting this task would take, and what stops it — for the confirmation [web]. */
export async function previewTaskDeletion(task, user) {
  assertAdmin(user);
  await loadModels();
  const tasks = await tasksTaken(task);
  return {
    tasks: tasks.map((row) => ({ _id: row._id, title: row.title, kind: row.kind || null, completed: Boolean(row.completed) })),
    job: tasks.length > 1 || (!task.enquiry && idOf(task.chain) === idOf(task._id)) ? { number: task.jobNumber || null } : null,
    blockers: await taskBlockers(tasks),
  };
}

/**
 * The task gone, with what hangs on it alone: its notices, files, plan decisions, a team job's
 * sample, the reminders about it, its unrun work orders (a run one keeps its history, unlinked).
 */
export async function deleteTask(task, user, { reason } = {}) {
  assertAdmin(user);
  await loadModels();
  const tasks = await tasksTaken(task);
  const blockers = await taskBlockers(tasks);
  if (blockers.length) throw ApiError.conflict(`This task cannot be deleted: ${blockers.join('; ')}.`, { code: 'DELETE_BLOCKED', blockers });
  const taskIds = ids(tasks);
  const WorkOrder = model('WorkOrder');
  const { OPEN_WORK_ORDER_STATUSES } = await import('../models/WorkOrder.js');
  const unrun = await WorkOrder.deleteMany({ task: { $in: taskIds }, status: { $in: OPEN_WORK_ORDER_STATUSES.filter((status) => status !== 'running') } });
  await WorkOrder.updateMany({ task: { $in: taskIds } }, { $unset: { task: 1 } });
  const notices = await model('TaskNotice').deleteMany({ task: { $in: taskIds } });
  const files = await dropAttachments({ task: { $in: taskIds } });
  await model('PlanDecision').deleteMany({ task: { $in: taskIds } });
  await model('CustomerMessage').updateMany({ task: { $in: taskIds } }, { $unset: { task: 1 } });
  await model('QcRecord').updateMany({ task: { $in: taskIds } }, { $unset: { task: 1 } });
  const samples = await model('Sample').deleteMany({ job: { $in: taskIds }, status: { $nin: ['dispatched', 'delivered', 'feedback_received', 'approved', 'rejected'] } });
  /* The reminders about this job — name its buyer, give its EDD — have nothing left to ask about. */
  const root = tasks.find((row) => !row.enquiry && idOf(row.chain) === idOf(row._id));
  if (root) {
    const { resolveTasks } = await import('./task.service.js');
    const { askKeyFor } = await import('./eddAsk.service.js');
    await resolveTasks(`job-buyer:${root._id}`);
    await resolveTasks(askKeyFor({ chain: root._id }));
  }
  await Todo.deleteMany({ _id: { $in: taskIds } });
  const { recordChange } = await import('./audit.service.js');
  const words = `${tasks.length > 1 ? `Job ${task.jobNumber || ''} — ${plural(tasks.length, 'task')}` : task.title} deleted${reason ? `: ${reason}` : ''}`;
  await recordChange({ model: 'Todo', doc: task, by: user, action: 'deleted', note: words, label: task.jobNumber || task.title });
  return { deleted: { tasks: tasks.length, workOrders: unrun.deletedCount || 0, notices: notices.deletedCount || 0, files, samples: samples.deletedCount || 0 } };
}

/* ---------------------------------------------------------------- enquiries */

/** Why the enquiry cannot go — what happened on it that must stay on record. Empty when it can. */
async function enquiryBlockers(enquiry) {
  const id = enquiry._id;
  const out = [];
  const orders = await model('SalesOrder').find({ enquiry: id }).select('number status').lean();
  const live = orders.filter((row) => row.status !== 'cancelled');
  if (live.length) out.push(`${live.map((row) => row.number).join(', ')} ${live.length === 1 ? 'is' : 'are'} on it — cancel the order first`);
  const orderIds = ids(orders);
  const money = await model('Receivable').find({ $or: [{ enquiry: id }, ...(orderIds.length ? [{ order: { $in: orderIds } }] : [])] }).select('number').lean();
  if (money.length) out.push(`money is on record for it (${money.map((row) => row.number).join(', ')})`);
  const [dispatches, runs, checks, trades, trips] = await Promise.all([
    orderIds.length ? model('Dispatch').countDocuments({ order: { $in: orderIds } }) : 0,
    model('MouldRun').countDocuments({ enquiry: id }),
    model('QcRecord').countDocuments({ enquiry: id }),
    model('TradeOrder').countDocuments({ enquiry: id }),
    model('Trip').countDocuments({ enquiry: id }),
  ]);
  if (dispatches) out.push(`${plural(dispatches, 'consignment')} went out on it`);
  if (runs) out.push(`the presses ran ${plural(runs, 'job')} for it`);
  if (checks) out.push(`${plural(checks, 'quality check')} ${checks === 1 ? 'is' : 'are'} recorded on it`);
  if (trades) out.push(`${plural(trades, 'traded purchase')} ${trades === 1 ? 'was' : 'were'} made for it`);
  if (trips) out.push(`it is on ${plural(trips, 'delivery trip')}`);
  const loaded = await Todo.countDocuments({ enquiry: id, kind: 'invoice_dispatch', 'loads.0': { $exists: true } });
  if (loaded) out.push('goods were dispatched on it');
  return out;
}

/** What deleting the enquiry would take, and what stops it — for the confirmation [web]. */
export async function previewEnquiryDeletion(enquiry, user) {
  assertAdmin(user);
  await loadModels();
  const id = enquiry._id;
  const [tasks, samples, quotations, workOrders, files] = await Promise.all([
    Todo.countDocuments({ enquiry: id }),
    model('Sample').countDocuments({ enquiry: id }),
    model('Quotation').countDocuments({ enquiry: id }),
    model('WorkOrder').countDocuments({ enquiry: id }),
    model('Attachment').countDocuments({ enquiry: id }),
  ]);
  return { number: enquiry.number, takes: { tasks, samples, quotations, workOrders, files }, blockers: await enquiryBlockers(enquiry) };
}

/**
 * The enquiry gone, and every task on it — held, open or done — with their notices, files and
 * plan decisions; its samples, quotations, cancelled orders, unrun work orders and messages. The
 * buyer stays; a WhatsApp thread, a buyer card or a mould that named it keeps itself, unlinked.
 */
export async function deleteEnquiry(enquiryId, user, { reason } = {}) {
  assertAdmin(user);
  await loadModels();
  const enquiry = await Enquiry.findById(enquiryId);
  if (!enquiry) throw ApiError.notFound('Enquiry not found');
  const blockers = await enquiryBlockers(enquiry);
  if (blockers.length) throw ApiError.conflict(`${enquiry.number} cannot be deleted: ${blockers.join('; ')}.`, { code: 'DELETE_BLOCKED', blockers });
  const id = enquiry._id;
  const tasks = await Todo.find({ enquiry: id }).select('_id').lean();
  const taskIds = ids(tasks);
  const samples = await model('Sample').find({ enquiry: id }).select('_id').lean();
  const quotations = await model('Quotation').find({ enquiry: id }).select('_id').lean();
  const linked = [...taskIds, ...ids(samples), ...ids(quotations)];
  const files = await dropAttachments({ $or: [{ enquiry: id }, { task: { $in: taskIds } }] });
  await model('TaskNotice').deleteMany({ $or: [{ enquiry: id }, { task: { $in: taskIds } }] });
  await model('PlanDecision').deleteMany({ task: { $in: taskIds } });
  await model('CustomerMessage').deleteMany({ $or: [{ enquiry: id }, { task: { $in: taskIds } }] });
  await model('WorkOrder').deleteMany({ enquiry: id });
  await model('SalesOrder').deleteMany({ enquiry: id, status: 'cancelled' });
  await model('Sample').deleteMany({ enquiry: id });
  await model('Quotation').deleteMany({ enquiry: id });
  await Todo.deleteMany({ enquiry: id });
  await model('WhatsappThread').updateMany({ enquiry: id }, { $unset: { enquiry: 1 } });
  await model('BuyerCard').updateMany({ enquiry: id }, { $unset: { enquiry: 1 } });
  await model('Mould').updateMany({ developedFromEnquiry: id }, { $unset: { developedFromEnquiry: 1 } });
  await enquiry.deleteOne();
  const { recordChange } = await import('./audit.service.js');
  await recordChange({
    model: 'Enquiry', doc: enquiry, by: user, action: 'deleted',
    note: `${enquiry.number} deleted with ${plural(tasks.length, 'task')}, ${plural(samples.length, 'sample')}, ${plural(quotations.length, 'quotation')}${reason ? ` — ${reason}` : ''}`,
  });
  return { number: enquiry.number, deleted: { tasks: tasks.length, samples: samples.length, quotations: quotations.length, files, linked: linked.length } };
}
