import Todo from '../models/Todo.js';
import Mould from '../models/Mould.js';
import MouldRun from '../models/MouldRun.js';
import WorkOrder from '../models/WorkOrder.js';
import { modelRows, productionTaken, summarise } from '../services/productionSummary.service.js';
import { CAPACITY_FIELDS, estimate } from '../services/capacity.service.js';
import { plantCalendar } from '../services/settings.service.js';
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
        select: 'number stage status customer assignedTo edd eddByModel requirement.modelNumber requirement.colour requirement.quantity requirement.mould items.modelNumber items.mould',
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
    }).select('enquiry kind status completed completedAt user dueDate updatedAt createdAt modelStatuses routing').populate('user', 'name').lean()
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

  /* The mould behind each row — the enquiry's own pick, or the register entry its model names — for the capacity estimate. */
  const plant = await plantCalendar();
  const mouldIds = mine.flatMap((task) => [task.enquiry.requirement?.mould, ...(task.enquiry.items || []).map((item) => item.mould)]).filter(Boolean);
  const codes = mine.map((task) => String(task.enquiry.requirement?.modelNumber || (task.enquiry.items || []).find((item) => item.modelNumber)?.modelNumber || task.brief?.model || '').trim().toUpperCase()).filter(Boolean);
  const moulds = (mouldIds.length || codes.length)
    ? await Mould.find({ $or: [{ _id: { $in: mouldIds } }, { mouldCode: { $in: codes } }] }).select(`mouldCode ${CAPACITY_FIELDS}`).lean()
    : [];
  const mouldOf = (task) => {
    const id = task.enquiry.requirement?.mould || (task.enquiry.items || []).find((item) => item.mould)?.mould;
    const byId = id && moulds.find((mould) => String(mould._id) === String(id));
    if (byId) return byId;
    const code = String(task.enquiry.requirement?.modelNumber || (task.enquiry.items || []).find((item) => item.modelNumber)?.modelNumber || task.brief?.model || '').trim().toUpperCase();
    return moulds.find((mould) => mould.mouldCode === code) || null;
  };
  const qtyOf = (value) => Number(String(value ?? '').replace(/[^\d.]/g, '')) || 0;

  /* What the floor is doing for each enquiry now — the press and mould running, and what its runs made [models/MouldRun.js]. */
  const [liveRuns, madeRows] = ids.length ? await Promise.all([
    MouldRun.find({ enquiry: { $in: ids }, status: 'running' }).select('enquiry number machine mould modelNumber startedAt plannedQuantity')
      .populate([{ path: 'machine', select: 'code' }, { path: 'mould', select: 'mouldCode' }]).lean(),
    MouldRun.aggregate([
      { $match: { enquiry: { $in: ids }, status: { $in: ['completed', 'aborted'] } } },
      { $group: { _id: '$enquiry', good: { $sum: { $ifNull: ['$goodPieces', 0] } }, rejected: { $sum: { $ifNull: ['$rejectedPieces', 0] } }, runs: { $sum: 1 } } },
    ]),
  ]) : [[], []];
  /* The work orders for each enquiry's released lines — the production record the queue links to [models/WorkOrder.js]. */
  const orders = ids.length
    ? await WorkOrder.find({ enquiry: { $in: ids }, status: { $ne: 'cancelled' } })
      .select('enquiry number status modelNumber quantity goodQty machine plannedStart').populate('machine', 'code').sort({ createdAt: 1 }).lean()
    : [];
  const workOrdersOf = (enquiryId) => orders.filter((wo) => String(wo.enquiry) === String(enquiryId)).map((wo) => ({
    _id: wo._id, number: wo.number, status: wo.status, modelNumber: wo.modelNumber || null,
    quantity: wo.quantity || 0, goodQty: wo.goodQty || 0, machine: wo.machine?.code || null, plannedStart: wo.plannedStart || null,
  }));
  const floorOf = (enquiryId) => ({
    running: liveRuns.filter((run) => String(run.enquiry) === String(enquiryId)).map((run) => ({
      _id: run._id, number: run.number, machine: run.machine?.code || null, mould: run.mould?.mouldCode || run.modelNumber || null, startedAt: run.startedAt, plannedQuantity: run.plannedQuantity || null,
    })),
    made: (({ good = 0, rejected = 0, runs = 0 } = {}) => ({ good, rejected, runs }))(madeRows.find((row) => String(row._id) === String(enquiryId))),
  });

  const rows = mine.map((task) => {
    const enquiry = task.enquiry;
    const edd = enquiry.edd?.date || null;
    const slot = teams.get(String(enquiry._id)) || {};
    const model = enquiry.requirement?.modelNumber || (enquiry.items || []).find((item) => item.modelNumber)?.modelNumber || task.brief?.model || null;
    const floor = floorOf(enquiry._id);
    const workOrders = workOrdersOf(enquiry._id);
    return {
      /* The state in at most thirty words, and the page where it is worked [web: pages/ProductionWorkflow.jsx]. */
      summary: summarise({ task, enquiry, teams: slot, floor, workOrders, edd }),
      models: modelRows({ task, enquiry, teams: slot, workOrders }),
      workOrders,
      /* In the production queue yet — added by Production, a press on it, or Production Started — and what says so. */
      production: productionTaken({ task, floor }),
      link: `/production/workflow/${task._id}`,
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
      /* Press days the quantity needs on its mould, and the day it would finish if started today [capacity.service]. */
      capacity: (() => {
        const mould = mouldOf(task);
        const quantity = qtyOf(task.brief?.quantity || enquiry.requirement?.quantity);
        if (!quantity) return null;
        return { ...estimate(quantity, mould, plant, now), mould: mould?.mouldCode || null, quantity };
      })(),
      band: bandOf(edd, now),
      /* Needs assembly: Production routed a model to it, ticked on an older task, or Assembly already has its task. */
      needsAssembly: (task.routing?.models || []).some((row) => row.assembly) || ticked(task.brief?.assembly) || Boolean(slot.assembling),
      needsPrinting: (task.routing?.models || []).some((row) => row.printing) || Boolean(slot.printing),
      /* What Production decided about printing and assembly, model by model — null until it has [handoff.service `decideRouting`]. */
      routing: task.routing?.decidedAt ? {
        models: task.routing.models || [], handsTo: task.routing.handsTo || [], handOverDate: task.routing.handOverDate || null,
      } : null,
      order: task.order ? { _id: task.order._id, number: task.order.number, status: task.order.status } : null,
      /* Moulding now on a press for this enquiry, and the pieces its runs have made. */
      floor,
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
        toRoute: count((row) => !row.routing),
        assemblyOpen: count((row) => row.teams.assembling && !row.teams.assembling.completed),
        qualityOpen: count((row) => row.teams.quality && !row.teams.quality.completed),
        dispatchWaiting: count((row) => row.teams.despatch && !row.teams.despatch.completed),
        issues: count((row) => row.task.issue),
        inProduction: count((row) => row.production.taken),
        notTaken: count((row) => !row.production.taken),
        moulding: count((row) => row.floor.running.length > 0),
        unclaimed: count((row) => !row.task.with),
        dueTomorrow: count((row) => row.edd?.date === indiaDay(new Date(now.getTime() + DAY_MS))),
      },
    },
  });
});

/**
 * One Production task as the workflow page works it [web: pages/ProductionWorkflow.jsx]: the task
 * whole (its per-model statuses, routing, EDD), the teams after it on the same enquiry — Printing,
 * Assembly, Quality, Dispatch — the model-by-model table, the work orders and runs, and the
 * thirty-word summary the queue shows. Read by whoever reads the queue; written through the
 * task's own endpoints, by its department.
 */
export const productionWorkflow = asyncHandler(async (req, res) => {
  if (!READERS.some((moduleKey) => canRead(req.user, moduleKey))) {
    throw ApiError.forbidden('The production workflow is read by the plant’s departments and marketing');
  }
  if (!/^[0-9a-f]{24}$/i.test(String(req.params.taskId))) throw ApiError.notFound('No Production task by that reference');
  const { TASK_POPULATE, floorOf: floorOfEnquiry } = await import('./handoff.controller.js');
  const task = await Todo.findOne({ _id: req.params.taskId, kind: 'ask_edd' }).populate(TASK_POPULATE);
  if (!task || !task.enquiry) throw ApiError.notFound('No Production task by that reference');
  const { default: Enquiry } = await import('../models/Enquiry.js');
  const enquiry = await Enquiry.findById(task.enquiry._id || task.enquiry)
    .select('number stage customer assignedTo edd eddByModel dispatchPlan requirement items.modelNumber items.quantity items.colour')
    .populate([{ path: 'customer', select: 'code name assignedTo' }, { path: 'assignedTo', select: 'name' }])
    .lean();
  if (!enquiry) throw ApiError.notFound('No Production task by that reference');
  if (isOwnershipScoped(req.user) && !ownsRecord(req.user, enquiry)) throw ApiError.notFound('No Production task by that reference');

  /* The teams after Production on this run of the enquiry: each kind's open task, else its latest. */
  const others = await Todo.find({ enquiry: enquiry._id, kind: { $in: SIBLING_KINDS }, createdAt: { $gte: task.createdAt } })
    .populate(TASK_POPULATE).sort({ createdAt: -1 });
  const teams = {};
  for (const other of others) {
    const team = TEAM_OF[other.kind];
    if (!teams[team] || (teams[team].completed && !other.completed)) teams[team] = other;
  }
  const floor = await floorOfEnquiry(enquiry._id);
  const workOrders = (floor.workOrders || []).map((wo) => ({
    _id: wo._id, number: wo.number, status: wo.status, modelNumber: wo.modelNumber || null,
    quantity: wo.quantity || 0, goodQty: wo.goodQty || 0, machine: wo.machine?.code || null,
    plannedStart: wo.plannedStart || null, plannedEnd: wo.plannedEnd || null,
  }));
  const edd = enquiry.edd?.date || null;
  /* What each model is made with, from its sales order: hook, clip, print and the print reference. */
  const { orderSpecsForEnquiry } = await import('../services/orderParts.service.js');
  const specs = await orderSpecsForEnquiry(enquiry._id);
  res.json({
    success: true,
    data: {
      task,
      enquiry: {
        _id: enquiry._id, number: enquiry.number, stage: enquiry.stage,
        customer: enquiry.customer ? { _id: enquiry.customer._id, name: enquiry.customer.name, code: enquiry.customer.code } : null,
        owner: person(enquiry.assignedTo), edd: enquiry.edd || null, dispatchPlan: enquiry.dispatchPlan?.mode || null,
      },
      band: bandOf(edd),
      summary: summarise({ task, enquiry, teams, floor: { ...floor, running: floor.running.map((run) => ({ ...run, machine: run.machine?.code, mould: run.mould?.mouldCode })) }, workOrders, edd }),
      models: modelRows({ task, enquiry, teams, workOrders }),
      teams,
      workOrders,
      specs,
      floor: { running: floor.running, made: floor.made },
    },
  });
});
