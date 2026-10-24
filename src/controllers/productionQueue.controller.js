import Todo from '../models/Todo.js';
import Mould from '../models/Mould.js';
import MouldRun from '../models/MouldRun.js';
import WorkOrder from '../models/WorkOrder.js';
import { modelRows, productionTaken, summarise } from '../services/productionSummary.service.js';
import { CAPACITY_FIELDS, estimate } from '../services/capacity.service.js';
import { deliveryRiskFor } from '../services/deliveryRisk.service.js';
import { RISK_LEVELS, riskOf } from '../services/eddRisk.service.js';
import { plantCalendar } from '../services/settings.service.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { findHandoff } from '../config/handoffs.js';
import { canRead } from '../services/access.service.js';
import { isOwnershipScoped, ownsRecord } from '../services/ownership.service.js';
import { departmentsOf, isProductionInCharge } from '../utils/departments.js';

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

/*
 * Who reads the whole queue: everyone but a salesperson — and a salesperson too when they work
 * to it, as the Production in charge [utils/departments.js `isProductionInCharge`] or from a
 * plant desk beside marketing. Scoping them by their main department hid the queue from an in
 * charge who is marketing first: the desk counted the tasks, the queue showed none.
 */
export const readsWholeQueue = (user) => !isOwnershipScoped(user) || isProductionInCharge(user)
  || departmentsOf(user).some((key) => key !== 'marketing');

const statusLabelOf = (task) => (findHandoff(task.kind)?.form?.statuses || []).find((entry) => entry.key === task.status)?.label || null;
const issueOf = (task) => Boolean((findHandoff(task.kind)?.form?.statuses || []).find((entry) => entry.key === task.status)?.issue);
const person = (user) => (user && typeof user === 'object' ? { _id: user._id, name: user.name } : null);
const ticked = (value) => value === true || value === 'true' || value === 'Yes';

/*
 * A Production task raised from the customer with no enquiry [handoff.service `raiseTeamTask`]
 * stands in the queue as its own job: the buyer, who asked, the model it names, and the EDD its
 * teams gave — the latest date on any task of its chain [Todo `chain`, `modelDates`].
 */
const chainKey = (task) => `chain:${String(task.chain || task._id)}`;
const jobKey = (task) => (task.enquiry?._team ? chainKey(task) : String(task.enquiry?._id || ''));
function teamJob(task, chainTasks = []) {
  /* The job's EDD — marketing's, on its tasks [eddAsk.service] — else the latest date its teams gave. */
  const jobEdd = [task, ...chainTasks].map((entry) => entry.jobEdd).find((entry) => entry?.date) || null;
  const dates = [task, ...chainTasks].flatMap((entry) => (entry.modelDates || []).map((row) => row.date)).filter(Boolean).sort();
  const latest = jobEdd?.date || dates.at(-1) || null;
  return {
    _id: null, _team: true, number: null, stage: null,
    customer: task.customer && typeof task.customer === 'object' ? task.customer : null,
    assignedTo: task.createdBy && typeof task.createdBy === 'object' ? task.createdBy : null,
    edd: latest ? { date: latest, department: jobEdd ? 'marketing' : null, at: jobEdd?.at || null } : null,
    eddByModel: [], items: [],
    requirement: { modelNumber: task.brief?.model || null, quantity: task.brief?.quantity || null, colour: task.brief?.material || null },
  };
}

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
        select: 'number stage status customer assignedTo edd eddByModel qcRequired requirement.modelNumber requirement.colour requirement.quantity requirement.mould items.modelNumber items.mould',
        populate: [{ path: 'customer', select: 'code name assignedTo' }, { path: 'assignedTo', select: 'name' }],
      },
      { path: 'user', select: 'name' },
      { path: 'createdBy', select: 'name department' },
      { path: 'customer', select: 'code name assignedTo' },
      { path: 'order', select: 'number status' },
      { path: 'updates.by', select: 'name' },
    ])
    .lean();

  /* The Production tasks raised from a customer with no enquiry, each with the rest of its chain. */
  const teamTasks = tasks.filter((task) => !task.enquiry);
  const chainIds = teamTasks.map((task) => task.chain || task._id);
  const chainTasks = chainIds.length
    ? await Todo.find({ chain: { $in: chainIds }, kind: { $in: [...SIBLING_KINDS, 'ask_edd'] } })
      .select('chain kind status completed completedAt user dueDate updatedAt createdAt modelStatuses modelDates routing jobEdd').populate('user', 'name').lean()
    : [];
  for (const task of teamTasks) {
    task.enquiry = teamJob(task, chainTasks.filter((entry) => String(entry.chain) === String(task.chain || task._id)));
  }
  /* Marketing reads its own buyers' rows (and the team tasks it raised); whoever works to the queue reads the whole of it. */
  const mayRead = (task) => readsWholeQueue(req.user)
    || (task.enquiry._team
      ? String(task.createdBy?._id || task.createdBy) === String(req.user._id) || (task.customer && ownsRecord(req.user, task.customer))
      : ownsRecord(req.user, task.enquiry));
  const mine = tasks.filter((task) => task.enquiry && mayRead(task));
  const ids = mine.filter((task) => !task.enquiry._team).map((task) => task.enquiry._id);
  const siblings = ids.length
    ? await Todo.find({
      enquiry: { $in: ids }, kind: { $in: SIBLING_KINDS },
      $or: [{ completed: false }, { completedAt: { $gte: new Date(now.getTime() - WEEK_MS) } }],
    }).select('enquiry kind status completed completedAt user dueDate updatedAt createdAt modelStatuses routing').populate('user', 'name').lean()
    : [];
  /* Per enquiry and team: the open task, or the one finished most lately. */
  const teams = new Map();
  const chained = chainTasks.filter((task) => SIBLING_KINDS.includes(task.kind) && (!task.completed || new Date(task.completedAt || 0) >= new Date(now.getTime() - WEEK_MS)));
  for (const task of [...siblings, ...chained]) {
    const key = task.chain && !task.enquiry ? `chain:${String(task.chain)}` : String(task.enquiry);
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
    const slot = teams.get(jobKey(task)) || {};
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
        _id: enquiry._id, number: enquiry.number, stage: enquiry.stage, model, team: Boolean(enquiry._team),
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
      /*
       * Will it make the EDD, from the quantity: the pieces still to mould against the days left
       * [eddRisk.service] — red past the EDD, orange when the press days run past it,
       * yellow close to it, green otherwise.
       */
      risk: (() => {
        const quantity = qtyOf(task.brief?.quantity || enquiry.requirement?.quantity);
        const left = Math.max(0, quantity - (floor.made?.good || 0));
        const est = quantity ? estimate(left, mouldOf(task), plant, now) : null;
        return riskOf({ edd, left: quantity ? left : 0, est, status: task.status, now });
      })(),
      /* QC compulsory before dispatch, and whether Quality has passed it [qcGate.service]. */
      qc: { required: Boolean(enquiry.qcRequired) || ticked(task.brief?.qcRequired), cleared: Boolean(slot.quality?.completed && !issueOf(slot.quality)) },
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
  /* Will each order make marketing's EDD, all its models and teams counted [deliveryRisk.service]. */
  const deliveries = await deliveryRiskFor(rows.map((row) => row.enquiry?._id));
  for (const row of rows) row.delivery = (row.enquiry?._id && deliveries.get(String(row.enquiry._id))) || null;
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
      /* Red, orange, yellow, green: how many rows at each reading [eddRisk.service]. */
      risk: Object.fromEntries(RISK_LEVELS.map((level) => [level, count((row) => row.risk?.level === level)])),
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
  if (!task) throw ApiError.notFound('No Production task by that reference');
  const { default: Enquiry } = await import('../models/Enquiry.js');
  /* Raised from the customer with no enquiry: the job is the task's chain [Todo `chain`]. */
  const team = !task.enquiry;
  if (team) await task.populate([{ path: 'customer', select: 'code name assignedTo' }]);
  const chainTasks = team
    ? await Todo.find({ chain: task.chain || task._id, kind: { $in: SIBLING_KINDS } }).populate(TASK_POPULATE).sort({ createdAt: -1 })
    : [];
  const enquiry = team
    ? teamJob(task.toObject(), chainTasks.map((entry) => entry.toObject()))
    : await Enquiry.findById(task.enquiry._id || task.enquiry)
      .select('number stage customer assignedTo edd eddByModel dispatchPlan requirement items.modelNumber items.quantity items.colour')
      .populate([{ path: 'customer', select: 'code name assignedTo' }, { path: 'assignedTo', select: 'name' }])
      .lean();
  if (!enquiry) throw ApiError.notFound('No Production task by that reference');
  const mayRead = readsWholeQueue(req.user) || (team
    ? String(task.createdBy?._id || task.createdBy) === String(req.user._id) || (task.customer && ownsRecord(req.user, task.customer))
    : ownsRecord(req.user, enquiry));
  if (!mayRead) throw ApiError.notFound('No Production task by that reference');

  /* The teams after Production on this run of the enquiry (or on the chain): each kind's open task, else its latest. */
  const others = team
    ? chainTasks
    : await Todo.find({ enquiry: enquiry._id, kind: { $in: SIBLING_KINDS }, createdAt: { $gte: task.createdAt } })
      .populate(TASK_POPULATE).sort({ createdAt: -1 });
  const teams = {};
  for (const other of others) {
    const team = TEAM_OF[other.kind];
    if (!teams[team] || (teams[team].completed && !other.completed)) teams[team] = other;
  }
  const floor = team ? { running: [], made: { good: 0, rejected: 0, runs: 0 }, workOrders: [] } : await floorOfEnquiry(enquiry._id);
  const workOrders = (floor.workOrders || []).map((wo) => ({
    _id: wo._id, number: wo.number, status: wo.status, modelNumber: wo.modelNumber || null,
    quantity: wo.quantity || 0, goodQty: wo.goodQty || 0, machine: wo.machine?.code || null,
    plannedStart: wo.plannedStart || null, plannedEnd: wo.plannedEnd || null,
  }));
  const edd = enquiry.edd?.date || null;
  /* What each model is made with, from its sales order: hook, clip, print and the print reference. */
  const { orderSpecsForEnquiry } = await import('../services/orderParts.service.js');
  const specs = team ? [] : await orderSpecsForEnquiry(enquiry._id);
  /* Each task says whether it may be closed now — the page offers the dialog on that [taskClosable.service]. */
  const { withClosable } = await import('../services/taskClosable.service.js');
  const [taskOut, ...teamsOut] = await withClosable([task, ...Object.values(teams)]);
  const teamsWithClosable = Object.fromEntries(Object.keys(teams).map((team, at) => [team, teamsOut[at]]));
  res.json({
    success: true,
    data: {
      task: taskOut,
      enquiry: {
        _id: enquiry._id, number: enquiry.number, stage: enquiry.stage, team,
        customer: enquiry.customer ? { _id: enquiry.customer._id, name: enquiry.customer.name, code: enquiry.customer.code } : null,
        owner: person(enquiry.assignedTo), edd: enquiry.edd || null, dispatchPlan: enquiry.dispatchPlan?.mode || null,
      },
      band: bandOf(edd),
      /* Will the order make marketing's EDD, every model and team counted [deliveryRisk.service]. */
      delivery: team ? null : (await deliveryRiskFor([enquiry._id])).get(String(enquiry._id)) || null,
      summary: summarise({ task, enquiry, teams, floor: { ...floor, running: floor.running.map((run) => ({ ...run, machine: run.machine?.code, mould: run.mould?.mouldCode })) }, workOrders, edd }),
      models: modelRows({ task, enquiry, teams, workOrders }),
      teams: teamsWithClosable,
      workOrders,
      specs,
      floor: { running: floor.running, made: floor.made },
    },
  });
});

/**
 * Every open order in danger of missing marketing's EDD, worst first [deliveryRisk.service
 * `ordersAtRisk`]: late, will miss (a team's own date is after it), at risk, and those in the
 * warning window — an order of several models enters it well before one of one model. Read by
 * whoever reads the queue; a marketing person sees their own buyers' only.
 */
export const listOrdersAtRisk = asyncHandler(async (req, res) => {
  if (!READERS.some((moduleKey) => canRead(req.user, moduleKey))) throw ApiError.forbidden('The orders at risk are read by the plant’s departments and marketing');
  const { ordersAtRisk } = await import('../services/deliveryRisk.service.js');
  const { ownershipFilter } = await import('../services/ownership.service.js');
  const scope = readsWholeQueue(req.user) ? {} : ownershipFilter(req.user);
  const rows = await ordersAtRisk({ scope });
  const count = (level) => rows.filter((row) => row.risk.level === level).length;
  res.json({ success: true, data: rows, meta: { late: count('late'), willMiss: count('will_miss'), atRisk: count('at_risk'), watch: count('watch') } });
});
