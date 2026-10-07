import Enquiry from '../models/Enquiry.js';
import Todo from '../models/Todo.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { transactional } from '../utils/transaction.js';
import { STAGES, CLOSED_STAGE } from '../config/enquiryStages.js';
import { HANDOFFS } from '../config/handoffs.js';
import { DEPARTMENTS } from '../config/modules.js';
import {
  completeHandoff, mayHandOff, rescheduleHandoff, returnHandoff, sendHandoff,
} from '../services/handoff.service.js';

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
  { path: 'reschedules.by', select: 'name' },
  { path: 'escalation.by', select: 'name department' },
];

/** The buttons, the twelve stages and the departments, so the screen draws what the server knows. */
export const handoffCatalogue = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: {
      stages: [...STAGES, { key: CLOSED_STAGE, number: null, label: 'Closed', department: null }],
      buttons: HANDOFFS,
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
  const task = await sendHandoff({ enquiry, kind: req.body.kind, note: req.body.note, user: req.user });
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
  res.json({
    success: true,
    data: tasks,
    stage: enquiry.stage,
    stageHistory: enquiry.stageHistory,
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

export const handoffSendBack = asyncHandler(transactional(async (req, res) => {
  const task = await returnHandoff(await taskFor(req), req.user, req.body);
  await answer(res, task);
}));

export const handoffReschedule = asyncHandler(async (req, res) => {
  const task = await rescheduleHandoff(await taskFor(req), req.user, req.body);
  await answer(res, task);
});
