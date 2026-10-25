import Todo from '../models/Todo.js';
import Customer from '../models/Customer.js';
import ApiError from '../utils/ApiError.js';
import { findHandoff } from '../config/handoffs.js';
import { findDepartment } from '../config/modules.js';
import { isManagement } from '../utils/departments.js';

/**
 * Team jobs [web: pages/TeamJobs.jsx, TeamJobDetail.jsx] — a task Admin or marketing gave a team
 * with no enquiry behind it, read the way an enquiry is: what was asked, where it is now, the
 * steps each team took, and what each did. A job is its first task (`chain` is its own id,
 * numbered `JOB-…`) and every task raised from it on the same chain — Production → Printing →
 * Dispatch → LR, Payment Collection → PRT, A/C Clarify.
 *
 * Who reads which: Admin every job; anyone else the jobs they gave, and a marketing person the
 * jobs for buyers assigned to them too.
 */

const idOf = (value) => String(value?._id || value || '');
const ROOT = { enquiry: null, $expr: { $eq: ['$chain', '$_id'] } };

const stepLabel = (task) => (findHandoff(task.kind)?.form?.statuses || []).find((entry) => entry.key === task.status)?.label || (task.status ? String(task.status).replace(/_/g, ' ') : 'Received');
const taskLabel = (task) => findHandoff(task.kind)?.label || task.title || 'Task';
const teamOf = (task) => findDepartment(task.department)?.label || String(task.department || 'Team').replace(/_/g, ' ');

/** Jobs raised before they were numbered get their number the first time they are read. */
async function numberOldJobs() {
  const old = await Todo.find({ ...ROOT, kind: { $exists: true }, jobNumber: null }).select('_id createdAt').sort({ createdAt: 1 }).limit(200).lean();
  if (!old.length) return;
  const { nextNumber } = await import('./numbering.service.js');
  for (const row of old) await Todo.updateOne({ _id: row._id, jobNumber: null }, { $set: { jobNumber: await nextNumber('JOB', row.createdAt) } }, { keepVersion: true });
}

/** Which jobs this person reads [see the head of this file]. */
async function scopeFor(user) {
  if (isManagement(user)) return {};
  const mine = await Customer.find({ assignedTo: user._id }).distinct('_id');
  return { $or: [{ createdBy: user._id }, ...(mine.length ? [{ customer: { $in: mine } }] : [])] };
}

/** Where a job is now, in one line: the team holding it and its status — or done, with how it ended. */
function nowOf(tasks) {
  const open = tasks.filter((task) => !task.completed);
  if (!open.length) {
    const last = [...tasks].sort((a, b) => new Date(b.completedAt || b.updatedAt) - new Date(a.completedAt || a.updatedAt))[0];
    return { done: true, words: `Done — ${teamOf(last)}: ${stepLabel(last)}`, team: last?.department || null };
  }
  /* The newest open task is the furthest along — Printing after Production, PRT after Payment Collection. */
  const furthest = [...open].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  const others = open.length > 1 ? ` · ${open.length} teams working` : '';
  return { done: false, words: `${teamOf(furthest)}: ${stepLabel(furthest)}${others}`, team: furthest.department };
}

const modelsOf = (task) => {
  const items = Array.isArray(task.brief?.items) ? task.brief.items.map((item) => item.model) : [];
  return [...new Set([...String(task.brief?.models || task.brief?.model || '').split(','), ...items].map((model) => String(model || '').trim()).filter(Boolean))];
};

/** The jobs this person gave or follows, newest move first: open ones by default, or done. */
export async function listTeamJobs(user, { state = 'open', search = '', limit = 200 } = {}) {
  await numberOldJobs();
  const scope = await scopeFor(user);
  const roots = await Todo.find({ ...ROOT, kind: { $exists: true }, ...scope })
    .select('jobNumber kind department title notes brief customer createdBy createdAt jobEdd completed status')
    .populate([{ path: 'customer', select: 'name' }, { path: 'createdBy', select: 'name' }])
    .sort({ createdAt: -1 }).limit(500).lean();
  if (!roots.length) return [];
  const all = await Todo.find({ chain: { $in: roots.map((root) => root._id) } })
    .select('chain kind department status completed completedAt createdAt updatedAt').lean();
  const byJob = new Map();
  for (const task of all) {
    const key = idOf(task.chain);
    if (!byJob.has(key)) byJob.set(key, []);
    byJob.get(key).push(task);
  }
  const needle = String(search || '').trim().toLowerCase();
  const rows = roots.map((root) => {
    const tasks = byJob.get(idOf(root._id)) || [root];
    const now = nowOf(tasks);
    return {
      _id: root._id,
      number: root.jobNumber || null,
      customer: root.customer ? { _id: root.customer._id, name: root.customer.name } : null,
      asked: { team: teamOf(root), what: taskLabel(root), note: String(root.notes || '').split('\n')[0].slice(0, 160), models: modelsOf(root) },
      raisedBy: root.createdBy?.name || null,
      raisedAt: root.createdAt,
      edd: root.jobEdd?.date || null,
      now,
      teams: [...new Set(tasks.map(teamOf))],
      openTasks: tasks.filter((task) => !task.completed).length,
      lastMoveAt: tasks.reduce((latest, task) => (new Date(task.updatedAt || task.createdAt) > latest ? new Date(task.updatedAt || task.createdAt) : latest), new Date(root.createdAt)),
    };
  });
  return rows
    .filter((row) => (state === 'done' ? row.now.done : state === 'all' ? true : !row.now.done))
    .filter((row) => !needle || [row.number, row.customer?.name, row.asked.what, row.asked.note, row.asked.models.join(' '), row.raisedBy].some((value) => String(value || '').toLowerCase().includes(needle)))
    .sort((a, b) => b.lastMoveAt - a.lastMoveAt)
    .slice(0, limit);
}

/**
 * One job, read whole: what was asked; where it is now; each team's task with its status, who
 * has it and when it moved; every move and update in plain words, newest first; and — where the
 * job has them — each model's journey, the payments logged and what Accounts said, the shipments
 * with their LR, and the files on any of its tasks.
 */
export async function teamJob(user, id) {
  await numberOldJobs();
  const root = await Todo.findOne({ _id: id, ...ROOT, ...(await scopeFor(user)) })
    .populate([{ path: 'customer', select: 'name mobile' }, { path: 'createdBy', select: 'name' }]);
  if (!root) throw ApiError.notFound('Job not found');
  const tasks = await Todo.find({ chain: root._id }).sort({ createdAt: 1 })
    .populate([{ path: 'user', select: 'name' }, { path: 'updates.by', select: 'name' }, { path: 'createdBy', select: 'name' }]);
  const steps = tasks.map((task) => ({
    _id: task._id, kind: task.kind, team: teamOf(task), department: task.department, what: taskLabel(task),
    status: task.status || null, statusLabel: stepLabel(task), completed: Boolean(task.completed), completedAt: task.completedAt || null,
    with: task.user?.name || null, raisedAt: task.createdAt, lastMoveAt: task.updatedAt,
    modelStatuses: (task.modelStatuses || []).map((row) => ({ model: row.model, status: row.status, label: (findHandoff(task.kind)?.form?.statuses || []).find((entry) => entry.key === row.status)?.label || row.status })),
  }));
  /* Every move and update, the asking itself first in time — newest shown first. */
  const timeline = [];
  for (const task of tasks) {
    timeline.push({ at: task.createdAt, team: teamOf(task), what: `${taskLabel(task)} asked`, text: task._id.equals(root._id) ? String(task.notes || '') : String(task.notes || '').slice(0, 400), by: task.createdBy?.name || null, kind: 'asked' });
    for (const line of task.updates || []) {
      timeline.push({ at: line.at, team: teamOf(task), what: line.statusLabel || (line.kind === 'status' ? stepLabel({ ...task.toObject(), status: line.status }) : 'Update'), text: line.text || line.note || '', by: line.by?.name || null, kind: line.kind || 'note' });
    }
    if (task.completed) timeline.push({ at: task.completedAt || task.updatedAt, team: teamOf(task), what: `${taskLabel(task)} closed`, text: [task.outcome?.result, task.outcome?.note].filter((part) => typeof part === 'string' && part).join(' — '), by: null, kind: 'closed' });
  }
  timeline.sort((a, b) => new Date(b.at) - new Date(a.at));

  const handoff = await import('./handoff.service.js');
  const production = tasks.find((task) => task.kind === 'ask_edd');
  const journeys = production ? await handoff.modelJourneys(null, { task: production }).catch(() => []) : [];
  const shipments = tasks.some((task) => ['invoice_dispatch', 'lr_copy'].includes(task.kind)) ? await handoff.shipmentsOf(root).catch(() => []) : [];
  /* Money taken on any of its Payment Collection or PRT tasks, and what Accounts said of it. */
  const { receiptsOfTask } = await import('./paymentGates.service.js');
  const payments = [];
  for (const task of tasks.filter((entry) => ['team_payment_followup', 'prt_recovery', 'ac_clarify'].includes(entry.kind))) {
    for (const row of await receiptsOfTask(task).catch(() => [])) if (!payments.some((seen) => idOf(seen._id) === idOf(row._id))) payments.push({ ...row, team: teamOf(task) });
  }
  const { default: Attachment } = await import('../models/Attachment.js');
  const files = await Attachment.find({ task: { $in: tasks.map((task) => task._id) } }).select('key filename mimeType title docType task createdAt').sort({ createdAt: -1 }).lean();
  const documents = files.map((file) => {
    const task = tasks.find((entry) => idOf(entry._id) === idOf(file.task));
    return { _id: file._id, key: file.key, filename: file.filename, mimeType: file.mimeType, title: file.title || file.filename, at: file.createdAt, team: task ? teamOf(task) : null };
  });
  return {
    _id: root._id,
    number: root.jobNumber || null,
    customer: root.customer ? { _id: root.customer._id, name: root.customer.name, mobile: root.customer.mobile || null } : null,
    asked: { team: teamOf(root), what: taskLabel(root), note: root.notes || '', models: modelsOf(root), brief: root.brief || {} },
    raisedBy: root.createdBy?.name || null,
    raisedAt: root.createdAt,
    edd: root.jobEdd?.date || null,
    now: nowOf(tasks),
    steps, timeline, journeys, shipments, payments, documents,
  };
}
