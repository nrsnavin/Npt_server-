import Todo from '../models/Todo.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { findHandoff } from '../config/handoffs.js';
import { canRead } from '../services/access.service.js';
import { isOwnershipScoped, ownsRecord } from '../services/ownership.service.js';

/**
 * The production queue, as every department reads it [web: pages/ProductionQueue.jsx].
 *
 * One row per open Production task, in the order the goods are due: the enquiry's EDD bands
 * the queue — late, due today, this week, later, and the undated last — and within a band the
 * nearest date comes first. Beside each row, the other teams on the same enquiry: Assembly,
 * Printing, Quality and Dispatch, each at its own status, so Dispatch can see what is still on
 * the press and Production can see who it is waiting for.
 *
 * Read by whoever works to the queue — Production, Assembly, Printing, Quality, Dispatch, the
 * order desk — and by marketing for their own buyers only, as everywhere else. Nothing here is
 * cost. Writing is the task's own: the row opens into the task, and the task's department works it.
 */

const SIBLING_KINDS = ['ask_assembling_edd', 'ask_printing', 'quality_check', 'invoice_dispatch'];
const TEAM_OF = { ask_assembling_edd: 'assembling', ask_printing: 'printing', quality_check: 'quality', invoice_dispatch: 'despatch' };
const READERS = ['production', 'dispatch', 'quality', 'orders', 'enquiries'];
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const indiaDay = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);

/** Which band an EDD falls in, against India's day. */
export function bandOf(edd, now = new Date()) {
  if (!edd) return 'none';
  const today = indiaDay(now);
  if (edd < today) return 'late';
  if (edd === today) return 'today';
  if (edd <= indiaDay(new Date(now.getTime() + WEEK_MS))) return 'week';
  return 'later';
}
const BAND_RANK = { late: 0, today: 1, week: 2, later: 3, none: 4 };

const statusLabelOf = (task) => (findHandoff(task.kind)?.form?.statuses || []).find((entry) => entry.key === task.status)?.label || null;
const issueOf = (task) => Boolean((findHandoff(task.kind)?.form?.statuses || []).find((entry) => entry.key === task.status)?.issue);
const person = (user) => (user && typeof user === 'object' ? { _id: user._id, name: user.name } : null);
const ticked = (value) => value === true || value === 'true' || value === 'Yes';

/** The last thing written on a task, for the row. */
const latestOf = (task) => {
  const last = (task.updates || []).at(-1);
  return last ? { note: last.note || last.text || null, at: last.at, by: person(last.by) } : null;
};
/** The last few, newest first, for the row opened on the board. */
const recentOf = (task) => (task.updates || []).slice(-4).reverse()
  .map((entry) => ({ note: entry.note || entry.text || null, statusLabel: entry.statusLabel || null, at: entry.at, by: person(entry.by) }));

export const listProductionQueue = asyncHandler(async (req, res) => {
  if (!READERS.some((moduleKey) => canRead(req.user, moduleKey))) {
    throw ApiError.forbidden('The production queue is read by the plant’s departments and marketing');
  }
  const now = new Date();
  const tasks = await Todo.find({ kind: 'ask_edd', completed: false })
    .populate([
      {
        path: 'enquiry',
        select: 'number stage status customer assignedTo edd requirement.modelNumber requirement.colour requirement.quantity items.modelNumber',
        populate: [{ path: 'customer', select: 'code name assignedTo' }, { path: 'assignedTo', select: 'name' }],
      },
      { path: 'user', select: 'name' },
      { path: 'createdBy', select: 'name department' },
      { path: 'order', select: 'number status' },
      { path: 'updates.by', select: 'name' },
    ])
    .lean();

  /* Marketing reads its own buyers' rows; the plant's departments read the whole queue. */
  const mine = tasks.filter((task) => task.enquiry && (!isOwnershipScoped(req.user) || ownsRecord(req.user, task.enquiry)));
  const ids = mine.map((task) => task.enquiry._id);
  const siblings = ids.length
    ? await Todo.find({
      enquiry: { $in: ids }, kind: { $in: SIBLING_KINDS },
      $or: [{ completed: false }, { completedAt: { $gte: new Date(now.getTime() - WEEK_MS) } }],
    }).select('enquiry kind status completed completedAt user dueDate updatedAt createdAt').populate('user', 'name').lean()
    : [];
  /* Per enquiry and team: the open task, or the one finished most lately. */
  const teams = new Map();
  for (const task of siblings) {
    const key = String(task.enquiry);
    const team = TEAM_OF[task.kind];
    const slot = teams.get(key) || {};
    const held = slot[team];
    const better = !held || (held.completed && !task.completed) || (held.completed === task.completed && new Date(task.updatedAt || 0) > new Date(held.updatedAt || 0));
    if (better) slot[team] = task;
    teams.set(key, slot);
  }
  const teamRow = (task) => (task ? {
    _id: task._id, kind: task.kind, status: task.status, label: statusLabelOf(task) || (task.completed ? 'Done' : 'Open'),
    completed: Boolean(task.completed), issue: !task.completed && issueOf(task), with: person(task.user), dueDate: task.dueDate || null,
  } : null);

  const rows = mine.map((task) => {
    const enquiry = task.enquiry;
    const edd = enquiry.edd?.date || null;
    const slot = teams.get(String(enquiry._id)) || {};
    const model = enquiry.requirement?.modelNumber || (enquiry.items || []).find((item) => item.modelNumber)?.modelNumber || task.brief?.model || null;
    return {
      task: {
        _id: task._id, status: task.status, statusLabel: statusLabelOf(task), issue: issueOf(task), with: person(task.user),
        dueDate: task.dueDate || null, late: Boolean(task.dueDate && task.dueDate < now), priority: task.priority || 'normal',
        brief: task.brief || {}, createdAt: task.createdAt, raisedBy: person(task.createdBy), latest: latestOf(task), recent: recentOf(task),
        attention: task.attention ? { note: task.attention.note, at: task.attention.at } : null,
      },
      enquiry: {
        _id: enquiry._id, number: enquiry.number, stage: enquiry.stage, model,
        colour: enquiry.requirement?.colour || task.brief?.material || null,
        quantity: task.brief?.quantity || enquiry.requirement?.quantity || null,
        customer: enquiry.customer ? { _id: enquiry.customer._id, name: enquiry.customer.name, code: enquiry.customer.code } : null,
        owner: person(enquiry.assignedTo),
      },
      edd: edd ? { date: edd, department: enquiry.edd.department || null, at: enquiry.edd.at || null } : null,
      band: bandOf(edd, now),
      /* Needs assembly: ticked when Production was tasked, or Assembly already has its task. */
      needsAssembly: ticked(task.brief?.assembly) || Boolean(slot.assembling),
      order: task.order ? { _id: task.order._id, number: task.order.number, status: task.order.status } : null,
      teams: {
        assembling: teamRow(slot.assembling), printing: teamRow(slot.printing),
        quality: teamRow(slot.quality), despatch: teamRow(slot.despatch),
      },
    };
  });
  rows.sort((a, b) => (BAND_RANK[a.band] - BAND_RANK[b.band])
    || String(a.edd?.date || '').localeCompare(String(b.edd?.date || ''))
    || (new Date(a.task.dueDate || 0) - new Date(b.task.dueDate || 0)));

  const count = (test) => rows.filter(test).length;
  res.json({
    success: true,
    data: rows,
    meta: {
      asOf: now, day: indiaDay(now),
      bands: Object.fromEntries(Object.keys(BAND_RANK).map((band) => [band, count((row) => row.band === band)])),
      teams: {
        needsAssembly: count((row) => row.needsAssembly && !row.teams.assembling),
        assemblyOpen: count((row) => row.teams.assembling && !row.teams.assembling.completed),
        qualityOpen: count((row) => row.teams.quality && !row.teams.quality.completed),
        dispatchWaiting: count((row) => row.teams.despatch && !row.teams.despatch.completed),
        issues: count((row) => row.task.issue),
        unclaimed: count((row) => !row.task.with),
        dueTomorrow: count((row) => row.edd?.date === indiaDay(new Date(now.getTime() + DAY_MS))),
      },
    },
  });
});
