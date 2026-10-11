import Enquiry from '../models/Enquiry.js';
import Todo from '../models/Todo.js';
import Attachment from '../models/Attachment.js';
import { put, remove } from '../services/storage.service.js';
import ApiError from '../utils/ApiError.js';
import { inDepartment, isManagement } from '../utils/departments.js';
import asyncHandler from '../utils/asyncHandler.js';
import { transactional } from '../utils/transaction.js';
import { STAGES, CLOSED_STAGE } from '../config/enquiryStages.js';
import { HANDOFFS, TILE_KIND } from '../config/handoffs.js';
import { DEPARTMENTS, DEPARTMENT_KEYS } from '../config/modules.js';
import {
  allDepartmentFigures, completeHandoff, departmentDashboard, enquiriesHeldBy, enquiriesAtStages, mayHandOff, mayMove,
  attentionFor, editTaskBrief, finishWithResult, markAttentionSeen, rescheduleHandoff, resultStepFor, returnHandoff, sendHandoff, setTaskStatus, taskPrefill,
  updateHandoff,
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
  { path: 'attachment', select: 'key filename size' },
  { path: 'resultFile', select: 'key filename size' },
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
      /* `kind` is the button a stage's tile sends, so clicking the department forwards the enquiry. */
      stages: [
        ...STAGES.map((stage) => ({ ...stage, kind: TILE_KIND[stage.key] || null })),
        { key: CLOSED_STAGE, number: null, label: 'Closed', department: null, kind: null },
      ],
      /* A button with a department raises that department's task; `hidden` ones are never drawn. */
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
  const task = await sendHandoff({
    enquiry, kind: req.body.kind, note: req.body.note, fields: req.body.fields, brief: req.body.brief,
    priority: req.body.priority, requiredDate: req.body.requiredDate || undefined, user: req.user,
  });
  res.status(201).json({
    success: true,
    data: { task: await task.populate(TASK_POPULATE), stage: enquiry.stage },
  });
}));

/**
 * The PDF sent with a department task, uploaded right after the task is raised. Only whoever
 * raised it (or Admin), and once: the file is part of what was asked.
 */
export const attachTaskPdf = asyncHandler(async (req, res) => {
  const enquiry = await enquiryFor(req);
  const task = await Todo.findOne({ _id: req.params.taskId, enquiry: enquiry._id, kind: { $exists: true } });
  if (!task) throw ApiError.notFound('Task not found');
  if (String(task.createdBy) !== String(req.user._id) && req.user.role !== 'admin') {
    throw ApiError.forbidden('Only whoever raised the task can attach its PDF');
  }
  if (task.attachment) throw ApiError.conflict('This task already has its PDF');
  if (!req.file) throw ApiError.badRequest('Attach a PDF');

  const key = await put({ buffer: req.file.buffer, mimeType: req.file.mimetype });
  let attachment;
  try {
    attachment = await Attachment.create({
      key, filename: req.file.originalname, mimeType: req.file.mimetype, size: req.file.size,
      uploadedBy: req.user._id, task: task._id,
    });
    task.attachment = attachment._id;
    await task.save();
  } catch (error) {
    /* A file with no row pointing at it is a file nobody can reach or delete. */
    await remove(key);
    if (attachment) await attachment.deleteOne();
    throw error;
  }
  res.status(201).json({ success: true, data: await task.populate(TASK_POPULATE) });
});

/** What a department task's form is filled from — the enquiry, its buyer and its order. */
export const enquiryTaskPrefill = asyncHandler(async (req, res) => {
  const enquiry = await enquiryFor(req);
  res.json({ success: true, data: await taskPrefill(enquiry._id) });
});

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

/** The department's own status on its task — SO Waiting, Preparing, Needs Clarification. */
export const handoffStatus = asyncHandler(transactional(async (req, res) => {
  const task = await setTaskStatus(await taskFor(req), req.user, req.body);
  await answer(res, task);
}));

/** "Got it" on an answer that came back — it leaves the top of the dashboard. */
export const handoffSeen = asyncHandler(async (req, res) => {
  const task = await markAttentionSeen(await taskFor(req), req.user);
  await answer(res, task);
});

/** The contact details the department corrects on its task. */
export const handoffBrief = asyncHandler(async (req, res) => {
  const task = await editTaskBrief(await taskFor(req), req.user, req.body);
  await answer(res, task);
});

/**
 * The work as a PDF — the sales order — which finishes the task and raises the next department's
 * (Production). Checked before the file is stored, so a refusal leaves nothing behind.
 */
export const handoffResult = asyncHandler(async (req, res) => {
  const task = await taskFor(req);
  resultStepFor(task, req.user);
  if (!req.file) throw ApiError.badRequest('Attach the PDF');
  const key = await put({ buffer: req.file.buffer, mimeType: req.file.mimetype });
  let attachment;
  try {
    attachment = await Attachment.create({
      key, filename: req.file.originalname, mimeType: req.file.mimetype, size: req.file.size, uploadedBy: req.user._id, task: task._id,
    });
    const { task: done, next, nextProblem } = await finishWithResult(task, req.user, { attachmentId: attachment._id, note: req.body?.note });
    res.json({ success: true, data: await done.populate(TASK_POPULATE), next: next ? { _id: next._id, title: next.title, department: next.department } : null, nextProblem });
  } catch (error) {
    await remove(key);
    if (attachment) await attachment.deleteOne();
    throw error;
  }
});

export const handoffReschedule = asyncHandler(async (req, res) => {
  const task = await rescheduleHandoff(await taskFor(req), req.user, req.body);
  await answer(res, task);
});

/* ------------------------------ Dashboards ------------------------------ */

/** Admin sees every department; everybody else, their own. */
const seesEveryDepartment = isManagement;

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
  /* Any department the person works in — their main one or an extra one. */
  if (!inDepartment(req.user, key) && !seesEveryDepartment(req.user)) {
    throw ApiError.forbidden('That is another department\'s dashboard');
  }
  /* The enquiries at this department's stages — only for someone who may open enquiries. */
  const [dashboard, atStages, held, attention] = await Promise.all([
    departmentDashboard(key),
    canRead(req.user, 'enquiries') ? enquiriesAtStages(key, ownershipFilter(req.user)) : [],
    /* The enquiries this department holds — its desk. */
    enquiriesHeldBy(key, req.user),
    /* Questions for this person, and answers back on this department's tasks — at the top. */
    attentionFor(req.user, key),
  ]);
  /* The queue less the enquiries themselves: side requests, like a PRT visit or photos sent. */
  const heldIds = new Set(held.map((row) => String(row.task._id)));
  const requests = dashboard.queue.filter((task) => !heldIds.has(String(task._id)));
  res.json({ success: true, data: { ...dashboard, requests, atStages, enquiries: held, attention } });
});
