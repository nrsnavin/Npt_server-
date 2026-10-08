import Enquiry from '../models/Enquiry.js';
import Todo from '../models/Todo.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { transactional } from '../utils/transaction.js';
import { STAGES, CLOSED_STAGE } from '../config/enquiryStages.js';
import { HANDOFFS, movesEnquiry } from '../config/handoffs.js';
import { DEPARTMENTS, DEPARTMENT_KEYS } from '../config/modules.js';
import {
  allDepartmentFigures, completeHandoff, departmentDashboard, enquiriesAtStages, mayHandOff, mayMove,
  rescheduleHandoff, returnHandoff, sendHandoff, updateHandoff,
} from '../services/handoff.service.js';
import { canRead } from '../services/access.service.js';
import { ownershipFilter } from '../services/ownership.service.js';

/**
 * Department tasks about an enquiry [config/handoffs.js, services/handoff.service.js]: the
 * buttons, sending one, the enquiry's list of what was asked, and what a department does with
 * a task — done, sent back, re-dated. Picking one up and passing it to another department are
 * the ordinary task actions (`PATCH /workspace/todos/:id`, `POST …/escalate`).
 */

const TASK_POPULATE = [
  { path: 'createdBy', select: 'name department' },
  { path: 'user', select: 'name department' },
  { path: 'completedBy', select: 'name' },
  { path: 'outcome.by', select: 'name' },
  { path: 'updates.by', select: 'name' },
  { path: 'reschedules.by', select: 'name' },
  { path: 'escalation.by', select: 'name department' },
];

/** The buttons, the twelve stages and the departments, so the screen draws what the server knows. */
export const handoffCatalogue = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: {
      stages: [...STAGES, { key: CLOSED_STAGE, number: null, label: 'Closed', department: null }],
      /* `moves` says whether a button hands the enquiry over; `hidden` ones are never drawn. */
      buttons: HANDOFFS.map((button) => ({ ...button, moves: movesEnquiry(button) })),
      departments: DEPARTMENTS.map(({ key, label }) => ({ key, label })),
    },
  });
});

async function enquiryFor(req) {
  const enquiry = await Enquiry.findById(req.params.id).populate('customer', 'code name');
  if (!enquiry) throw ApiError.notFound('Enquiry not found');
  if (!(await mayHandOff(req.user, enquiry))) throw ApiError.notFound('Enquiry not found');
  return enquiry;
}

export const sendEnquiryHandoff = asyncHandler(transactional(async (req, res) => {
  const enquiry = await enquiryFor(req);
  const task = await sendHandoff({ enquiry, kind: req.body.kind, note: req.body.note, fields: req.body.fields, user: req.user });
  res.status(201).json({
    success: true,
    data: { task: await task.populate(TASK_POPULATE), stage: enquiry.stage },
  });
}));

/** Everything asked about this enquiry, newest first, with what came of each. */
export const listEnquiryHandoffs = asyncHandler(async (req, res) => {
  const enquiry = await enquiryFor(req);
  const tasks = await Todo.find({ enquiry: enquiry._id, kind: { $exists: true } })
    .populate(TASK_POPULATE)
    .sort({ createdAt: -1 })
    .limit(200);
  /* Who has it now, and whether this person may move it on — the screen offers the buttons only then. */
  const holder = tasks.find((task) => task.holds && !task.completed) || null;
  res.json({
    success: true,
    data: tasks,
    stage: enquiry.stage,
    stageHistory: enquiry.stageHistory,
    holder,
    mayMove: enquiry.stage !== CLOSED_STAGE && (await mayMove(req.user, enquiry, holder)),
  });
});

async function taskFor(req) {
  const task = await Todo.findById(req.params.id);
  if (!task) throw ApiError.notFound('Task not found');
  return task;
}

const answer = async (res, task) => res.json({ success: true, data: await task.populate(TASK_POPULATE) });

export const handoffDone = asyncHandler(transactional(async (req, res) => {
  const task = await completeHandoff(await taskFor(req), req.user, req.body);
  await answer(res, task);
}));

export const handoffUpdate = asyncHandler(async (req, res) => {
  const task = await updateHandoff(await taskFor(req), req.user, req.body);
  await answer(res, task);
});

export const handoffSendBack = asyncHandler(transactional(async (req, res) => {
  const task = await returnHandoff(await taskFor(req), req.user, req.body);
  await answer(res, task);
}));

export const handoffReschedule = asyncHandler(async (req, res) => {
  const task = await rescheduleHandoff(await taskFor(req), req.user, req.body);
  await answer(res, task);
});

/* ------------------------------ Dashboards ------------------------------ */

/** Admin sees every department; everybody else, their own. */
const seesEveryDepartment = (user) => user.role === 'admin' || user.department === 'management';

/** Every department side by side: open, unclaimed, late, due today, done this week. */
export const departmentsOverview = asyncHandler(async (req, res) => {
  if (!seesEveryDepartment(req.user)) {
    throw ApiError.forbidden('Only Admin sees every department — open your own department instead');
  }
  res.json({ success: true, data: await allDepartmentFigures(DEPARTMENT_KEYS) });
});

/** One department's dashboard — its own people, or Admin. */
export const departmentDashboardFor = asyncHandler(async (req, res) => {
  const key = req.params.key === 'mine' ? req.user.department : req.params.key;
  if (!DEPARTMENT_KEYS.includes(key)) throw ApiError.notFound('No such department');
  if (key !== req.user.department && !seesEveryDepartment(req.user)) {
    throw ApiError.forbidden('That is another department\'s dashboard');
  }
  /* The enquiries at this department's stages — only for someone who may open enquiries. */
  const [dashboard, atStages] = await Promise.all([
    departmentDashboard(key),
    canRead(req.user, 'enquiries') ? enquiriesAtStages(key, ownershipFilter(req.user)) : [],
  ]);
  res.json({ success: true, data: { ...dashboard, atStages } });
});
