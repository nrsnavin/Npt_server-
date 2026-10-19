import Enquiry, { checkPending } from '../models/Enquiry.js';
import Quotation, { CLOSED_QUOTATION_STATUSES } from '../models/Quotation.js';
import Todo from '../models/Todo.js';
import Attachment from '../models/Attachment.js';
import Sample from '../models/Sample.js';
import MouldRun from '../models/MouldRun.js';
import WorkOrder from '../models/WorkOrder.js';
import mongoose from 'mongoose';
import { journeyOf } from '../services/journey.service.js';
import { readSalesOrder } from '../services/soRead.llm.js';
import SalesOrder, { PRE_RELEASE_STATUSES, VERIFICATION_CHECKS } from '../models/SalesOrder.js';
import { bufferOf, put, remove, safeFilename } from '../services/storage.service.js';
import { sendResultToCustomer } from '../services/taskResultMessage.service.js';
import { publicApiBase, signatureValid } from '../utils/signedLink.js';
import ApiError from '../utils/ApiError.js';
import { inDepartment, isManagement } from '../utils/departments.js';
import asyncHandler from '../utils/asyncHandler.js';
import { inTransaction, transactional } from '../utils/transaction.js';
import { retryOnConflict } from '../utils/concurrency.js';
import { STAGES, CLOSED_STAGE } from '../config/enquiryStages.js';
import { HANDOFFS, TILE_KIND, findHandoff } from '../config/handoffs.js';
import { DEPARTMENTS, DEPARTMENT_KEYS, deskOf } from '../config/modules.js';
import {
  allDepartmentFigures, completeHandoff, departmentDashboard, enquiriesHeldBy, enquiriesAtStages, mayHandOff, mayMove,
  WAITING_ON_POPULATE, askFromTask, attentionFor, dispatchBaskets, raiseTeamTask, teamTaskPrefill, markResultSent, dismissNotice, editTaskBrief, noticesFor, readNotice, productionDates, finishWithResult, markAttentionSeen, rescheduleHandoff, resultStepFor, returnHandoff, sendHandoff, setTaskEdd, setTaskStatus, taskPrefill,
  updateHandoff, mayWorkOnHandoff, mayReleaseHeld, modelReadiness, raiseAssemblyWith, routingFor, decideRouting,
} from '../services/handoff.service.js';
import { canRead, canWrite } from '../services/access.service.js';
import { ownershipFilter } from '../services/ownership.service.js';

/**
 * Department tasks about an enquiry [config/handoffs.js, services/handoff.service.js]: the
 * buttons, sending one, the enquiry's list of what was asked, and what a department does with
 * a task — done, sent back, re-dated. Picking one up and passing it to another department are
 * the ordinary task actions (`PATCH /workspace/todos/:id`, `POST …/escalate`).
 */

const TASK_POPULATE = [
  WAITING_ON_POPULATE,
  { path: 'attachment', select: 'key filename size' },
  { path: 'resultFile', select: 'key filename size' },
  { path: 'createdBy', select: 'name department' },
  { path: 'user', select: 'name department' },
  { path: 'completedBy', select: 'name' },
  { path: 'outcome.by', select: 'name' },
  { path: 'updates.by', select: 'name' },
  { path: 'reschedules.by', select: 'name' },
  { path: 'escalation.by', select: 'name department' },
  /* The enquiry's EDD travels with its tasks, so a card can show it or ask for it [web: components/TaskEdd.jsx]. */
  { path: 'enquiry', select: 'number edd eddByModel' },
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
  /* Nothing goes to a department on details nobody has checked [Enquiry `checkPending`]. */
  if (checkPending(enquiry)) {
    throw ApiError.conflict(`Check ${enquiry.number} first — correct the details and press Save & Mark as Checked`);
  }
  const task = await sendHandoff({
    enquiry, kind: req.body.kind, note: req.body.note, fields: req.body.fields, brief: req.body.brief,
    priority: req.body.priority, requiredDate: req.body.requiredDate || undefined, addToOpen: req.body.addToOpen === true, order: req.body.order, user: req.user,
  });
  /* A hanger that needs assembly: Assembly is tasked beside Production, on the same enquiry. */
  const assembly = req.body.kind === 'ask_edd' ? await raiseAssemblyWith(task, req.user) : null;
  /*
   * Create Quotation raises the costing sheet on the enquiry [handoff `openWorkRecord`]. The
   * reply names it, so somebody who costs quotations themselves can be taken straight to it.
   */
  const quotation = req.body.kind === 'create_quotation'
    ? await Quotation.findOne({ enquiry: enquiry._id, status: { $nin: CLOSED_QUOTATION_STATUSES } }).select('_id number status').lean()
    : null;
  res.status(201).json({
    success: true,
    /* `addedTo`: the department already had this task open, and the request went onto it. */
    data: {
      task: await task.populate(TASK_POPULATE), stage: enquiry.stage, addedTo: Boolean(task.$locals?.addedTo),
      ...(quotation ? { quotation } : {}),
      ...(assembly ? { assembly: { _id: assembly._id, department: assembly.department, addedTo: Boolean(assembly.$locals?.addedTo) } } : {}),
    },
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
  await storeTaskPdf(req, res, task);
});

/** A team task's PDF — one raised without an enquiry [raiseTeamTask]. */
export const attachTeamTaskPdf = asyncHandler(async (req, res) => {
  const task = await Todo.findOne({ _id: req.params.id, kind: { $exists: true }, enquiry: { $exists: false } });
  if (!task) throw ApiError.notFound('Task not found');
  await storeTaskPdf(req, res, task);
});

/** Raising a department task for a team with no enquiry behind it — Admin and marketing. */
export const createTeamTask = asyncHandler(transactional(async (req, res) => {
  const task = await raiseTeamTask({ ...req.body, user: req.user });
  res.status(201).json({ success: true, data: { task: await task.populate(TASK_POPULATE) } });
}));

/** The team task form's answers without an enquiry: members to pick, the named customer's contact. */
export const teamTaskFormPrefill = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await teamTaskPrefill(req.query.customer, req.user) });
});

async function storeTaskPdf(req, res, task) {
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
}

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
  const floor = await floorOf(enquiry._id);
  res.json({
    success: true,
    data: tasks,
    stage: enquiry.stage,
    stageHistory: enquiry.stageHistory,
    holder,
    mayMove: enquiry.stage !== CLOSED_STAGE && (await mayMove(req.user, enquiry, holder)),
    /* An LR has been uploaded: the screen offers to close the enquiry [web: CloseAfterLr]. */
    lrUploaded: tasks.some((task) => task.kind === 'lr_copy' && task.resultFile),
    /* When the goods will be ready — Production's EDD and the order lines' own dates. */
    production: await productionDates(enquiry._id),
    /* Its sales orders and whether each has gone to the plant — released here or on the Sales orders screen. */
    orders: await ordersOnEnquiry(enquiry, req.user),
    /* What the floor is doing for it now, and the journey from SO to LR as steps [journey.service]. */
    floor,
    journey: journeyOf(tasks, { running: floor.running }),
    /* How a several-model order goes out, and which models are ready [handoff.service `modelReadiness`]. */
    dispatchPlan: enquiry.dispatchPlan?.mode ? enquiry.dispatchPlan : null,
    readiness: await modelReadiness(enquiry._id),
  });
});

/**
 * The floor's work for an enquiry: the moulds running for it now (press, mould, since when, pieces
 * so far by the counter), what its runs have made, and its work orders' progress.
 */
export async function floorOf(enquiryId) {
  const [running, totals, workOrders] = await Promise.all([
    MouldRun.find({ enquiry: enquiryId, status: 'running' })
      .select('number machine mould modelNumber colour startedAt plannedQuantity counterStart counterLog cavitiesRunning')
      .populate([{ path: 'machine', select: 'code name' }, { path: 'mould', select: 'mouldCode name' }])
      .lean(),
    MouldRun.aggregate([
      { $match: { enquiry: new mongoose.Types.ObjectId(String(enquiryId)), status: { $in: ['completed', 'aborted'] } } },
      { $group: { _id: null, good: { $sum: { $ifNull: ['$goodPieces', 0] } }, rejected: { $sum: { $ifNull: ['$rejectedPieces', 0] } }, runs: { $sum: 1 } } },
    ]),
    WorkOrder.find({ enquiry: enquiryId, status: { $ne: 'cancelled' } })
      .select('number status modelNumber quantity goodQty machine plannedStart plannedEnd')
      .populate('machine', 'code')
      .sort({ createdAt: 1 })
      .lean(),
  ]);
  return {
    running: running.map((run) => {
      const counter = (run.counterLog || []).at(-1)?.counter;
      const soFar = counter != null && run.counterStart != null ? Math.max(0, counter - run.counterStart) * (run.cavitiesRunning || 1) : null;
      return {
        _id: run._id, number: run.number, machine: run.machine, mould: run.mould, modelNumber: run.modelNumber, colour: run.colour,
        startedAt: run.startedAt, plannedQuantity: run.plannedQuantity || null, piecesSoFar: soFar,
      };
    }),
    made: totals[0] ? { good: totals[0].good, rejected: totals[0].rejected, runs: totals[0].runs } : { good: 0, rejected: 0, runs: 0 },
    workOrders,
  };
}

/**
 * The enquiry's sales orders as the enquiry screen shows them: released (when, by whom), or
 * waiting — with the checks still short — and whether this person may press Release to
 * production. A Production Holded Order is Admin's or its marketing person's to release.
 */
async function ordersOnEnquiry(enquiry, user) {
  const orders = await SalesOrder.find({ enquiry: enquiry._id, status: { $ne: 'cancelled' } })
    .select('number status customerPo releasedAt releasedBy verification updatedAt lines.quantity')
    .populate('releasedBy', 'name')
    .sort({ createdAt: -1 })
    .limit(20);
  const mayWriteOrders = canWrite(user, 'orders');
  const heldOk = enquiry.stage !== 'production_hold' || mayReleaseHeld(user, enquiry);
  return orders.map((order) => {
    const short = VERIFICATION_CHECKS.filter((check) => !order.verification?.[check.key]?.by).map((check) => check.label);
    const waiting = PRE_RELEASE_STATUSES.includes(order.status);
    return {
      _id: order._id,
      number: order.number,
      status: order.status,
      poNumber: order.customerPo?.number || null,
      quantity: (order.lines || []).reduce((sum, line) => sum + (line.quantity || 0), 0),
      released: order.releasedAt ? { at: order.releasedAt, by: order.releasedBy?.name || null } : null,
      waiting,
      checksShort: waiting ? short : [],
      mayRelease: waiting && !short.length && mayWriteOrders && heldOk,
      updatedAt: order.updatedAt,
    };
  });
}

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

/*
 * An update only adds a line. Two people writing on the same task in the same instant both
 * loaded version n; the second save is refused by the version check, though it overwrote
 * nothing. So the whole block — load, append, commit — runs again on the task as it now stands
 * [utils/concurrency.js `retryOnConflict`], outside the transaction, which read a snapshot.
 */
const againOnConflict = (handler) => (req, res) => retryOnConflict(() => handler(req, res));

export const handoffUpdate = asyncHandler(againOnConflict(transactional(async (req, res) => {
  const task = await updateHandoff(await taskFor(req), req.user, req.body);
  await answer(res, task);
})));

export const handoffSendBack = asyncHandler(transactional(async (req, res) => {
  const task = await returnHandoff(await taskFor(req), req.user, req.body);
  await answer(res, task);
}));

/** The expected delivery date, given from the Production / Assembly / Printing task without a status move. */
export const handoffEdd = asyncHandler(transactional(async (req, res) => {
  const task = await setTaskEdd(await taskFor(req), req.user, req.body);
  await answer(res, task);
}));

/** The models on a Production task, with what Production decided about printing and assembly. */
export const handoffRouting = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await routingFor(await taskFor(req), req.user) });
});

/** Production's call, model by model: Printing's and Assembly's tasks are raised from it. */
export const handoffRoute = asyncHandler(transactional(async (req, res) => {
  const { task, raised } = await decideRouting(await taskFor(req), req.user, req.body);
  const populated = await task.populate(TASK_POPULATE);
  res.json({
    success: true,
    data: populated,
    raised: Object.fromEntries(Object.entries(raised).map(([team, entry]) => [team, { _id: entry._id, department: entry.department }])),
  });
}));

/** The department's own status on its task — SO Waiting, Preparing, Needs Clarification. */
export const handoffStatus = asyncHandler(transactional(async (req, res) => {
  const task = await setTaskStatus(await taskFor(req), req.user, req.body);
  await answer(res, task);
}));

/** A task's uploaded work behind a signed link — what WhatsApp fetches. No session: the signature is the permission. */
export const publicTaskFile = asyncHandler(async (req, res) => {
  const { id, expires, signature } = req.params;
  if (!signatureValid('task-file', id, expires, signature)) {
    console.warn(`[public-link] task file ${id} refused: ${Number(expires) > Date.now() ? 'signature does not match — the link was made under another JWT_SECRET' : 'link past its date'}`);
    throw ApiError.notFound('This link has expired.');
  }
  const attachment = await Attachment.findById(id).catch(() => null);
  if (!attachment?.task) throw ApiError.notFound('This link has expired.');
  const buffer = await bufferOf(attachment.key);
  if (!buffer) throw ApiError.notFound('This link has expired.');
  res.setHeader('Content-Type', attachment.mimeType);
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('Content-Disposition', `inline; filename="${safeFilename(attachment.filename)}"`);
  res.send(buffer);
});

/**
 * A paper a department keeps on its task — Dispatch's invoice and dispatch details, Reception's
 * dispatch details [config/departmentTaskForms.js `documents`]. Moves nothing; marketing attaches
 * it when writing to the buyer from the enquiry. Open or closed: the invoice often follows the goods.
 */
export const handoffDocument = asyncHandler(async (req, res) => {
  const task = await taskFor(req);
  const kinds = findHandoff(task.kind)?.form?.documents || [];
  const kind = kinds.find((entry) => entry.type === req.body?.docType);
  if (!kinds.length) throw ApiError.badRequest('This task does not keep documents');
  if (!kind) throw ApiError.badRequest(`Say which paper this is — ${kinds.map((entry) => entry.label).join(' or ')}`);
  if (!mayWorkOnHandoff(req.user, task)) throw ApiError.forbidden(`This task is on the ${DEPARTMENTS.find((entry) => entry.key === task.department)?.label || task.department} queue`);
  if (!req.file) throw ApiError.badRequest('Attach the file');
  if (!['application/pdf', 'image/jpeg', 'image/png'].includes(req.file.mimetype)) throw ApiError.badRequest('Attach a PDF, or a JPEG / PNG photo');
  const key = await put({ buffer: req.file.buffer, mimeType: req.file.mimetype });
  try {
    /* The file is on disk already; its row and the task's line commit together, and a clash with
       somebody else's line on the task is tried again on the task as it now stands. */
    const attachment = await retryOnConflict(() => inTransaction(async () => {
      const fresh = await taskFor(req);
      const [made] = await Attachment.create([{
        key, filename: req.file.originalname, mimeType: req.file.mimetype, size: req.file.size,
        uploadedBy: req.user._id, task: fresh._id, docType: kind.type, title: kind.label,
      }]);
      fresh.updates = [...(fresh.updates || []), { kind: 'uploaded', statusLabel: `${kind.label} uploaded`, text: req.file.originalname, note: `${kind.label} uploaded: ${req.file.originalname}`, by: req.user._id, at: new Date() }];
      await fresh.save();
      /* Reception's hand-over photo is the sample's too, whenever it is uploaded — before or after "Buyer collected". */
      if (fresh.kind === 'sample_collect' && kind.type === 'handover_photo' && fresh.brief?.sample) {
        await Sample.updateOne({ _id: fresh.brief.sample }, { $set: { 'collection.photo': made._id } }, { keepVersion: true });
      }
      return made;
    }, { label: 'task document' }));
    res.status(201).json({ success: true, data: attachment });
  } catch (error) {
    await remove(key);
    throw error;
  }
});

/** The papers on a task, newest first — for whoever may see the task. */
export const handoffDocuments = asyncHandler(async (req, res) => {
  const task = await taskFor(req);
  if (!mayWorkOnHandoff(req.user, task) && String(task.createdBy) !== String(req.user._id)) throw ApiError.notFound('Task not found');
  const files = await Attachment.find({ task: task._id, docType: { $exists: true } })
    .select('key filename mimeType size docType title createdAt uploadedBy').populate('uploadedBy', 'name').sort({ createdAt: -1 }).lean();
  res.json({ success: true, data: files });
});

/* Dispatch's "Ask Production": that department's task, raised from this one. */
export const handoffAsk = asyncHandler(transactional(async (req, res) => {
  const { task, raised, addedTo } = await askFromTask(await taskFor(req), req.user, req.body);
  res.json({
    success: true,
    data: await task.populate(TASK_POPULATE),
    raised: { _id: raised._id, title: raised.title, department: raised.department },
    addedTo,
  });
}));

/* A department's moves on this person's enquiries [handoff.service `noticeStatus`]. */
export const listNotices = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await noticesFor(req.user) });
});

export const markNoticeRead = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await readNotice(req.user, req.params.id) });
});

export const removeNotice = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await dismissNotice(req.user, req.params.id) });
});

/** "Got it" on an answer that came back — it leaves the top of the dashboard. */
export const handoffSeen = asyncHandler(async (req, res) => {
  const task = await markAttentionSeen(await taskFor(req), req.user);
  await answer(res, task);
});

/** The contact details the department corrects on its task. */
export const handoffBrief = asyncHandler(transactional(async (req, res) => {
  const task = await editTaskBrief(await taskFor(req), req.user, req.body);
  await answer(res, task);
}));

/**
 * The work as a PDF — the sales order — which finishes the task and raises the next department's
 * (Production). Checked before the file is stored, so a refusal leaves nothing behind.
 */
export const handoffResult = asyncHandler(async (req, res) => {
  const task = await taskFor(req);
  resultStepFor(task, req.user);
  const form = findHandoff(task.kind)?.form || {};
  if (!req.file) throw ApiError.badRequest(form.resultTypes ? 'Attach the file' : 'Attach the PDF');
  /* The SO is a PDF; the LR copy may be a photo of it [config/departmentTaskForms.js `resultTypes`]. */
  if (!(form.resultTypes || ['application/pdf']).includes(req.file.mimetype)) {
    throw ApiError.badRequest(form.resultTypes ? 'Attach a PDF, or a JPEG / PNG photo' : 'Attach a PDF');
  }
  /*
   * The SO read before anything is written — the sales order is drafted from the document itself
   * [services/soRead.llm.js], outside the transaction so no lock waits on the model.
   */
  const read = findHandoff(task.kind)?.booksOrder && task.enquiry
    ? await readSalesOrder({ buffer: req.file.buffer, mimeType: req.file.mimetype })
    : { reading: null, problem: null };
  const key = await put({ buffer: req.file.buffer, mimeType: req.file.mimetype });
  let attachment;
  try {
    /* The file's row, the task's finish and the next department's task commit together, or none
       of them do; the messages to the buyer go only once that has landed. */
    let { task: done, next, nextProblem, held, order } = await inTransaction(async () => {
      const fresh = await taskFor(req);
      [attachment] = await Attachment.create([{
        key, filename: req.file.originalname, mimeType: req.file.mimetype, size: req.file.size, uploadedBy: req.user._id, task: fresh._id,
      }]);
      return finishWithResult(fresh, req.user, { attachmentId: attachment._id, note: req.body?.note, reading: read.reading, readProblem: read.problem });
    }, { label: 'task result' });
    /* The LR copy goes on to the buyer, by email and WhatsApp, and the task says it went. */
    let sent = null;
    if (form.sendResult) {
      const baseUrl = publicApiBase(req);
      sent = await sendResultToCustomer({ task: done, attachment, user: req.user, baseUrl });
      done = await markResultSent(done, req.user, sent);
    }
    res.json({
      success: true,
      data: await done.populate(TASK_POPULATE),
      next: next ? { _id: next._id, title: next.title, department: next.department } : null,
      nextProblem,
      /* The SO is prepared but the order waits with marketing — Production was not confirmed. */
      held: Boolean(held),
      /* The sales order the SO request booked (or was linked to), and whether it went to the plant. */
      order: order || null,
      ...(sent ? { sent: sent.map((entry) => ({ channel: entry.channel, status: entry.status, recipient: entry.recipient, reason: entry.skipReason || entry.error })) } : {}),
    });
  } catch (error) {
    await remove(key);
    if (attachment) await attachment.deleteOne();
    throw error;
  }
});

/* The new date and the notice of it commit together. */
export const handoffReschedule = asyncHandler(transactional(async (req, res) => {
  const task = await rescheduleHandoff(await taskFor(req), req.user, req.body);
  await answer(res, task);
}));

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
  /*
   * One desk for Quality, Assembly and Printing [config/modules.js DESK_GROUPS]: each department's
   * queue is read on its own — the screen shows each under its own header — and the figures are
   * the desk's together. A department of its own is the one-member case of the same thing.
   */
  const desk = deskOf(key);
  const members = desk ? desk.departments : [key];
  const perDepartment = await Promise.all(members.map(async (member) => {
    const [dashboard, atStages, held] = await Promise.all([
      departmentDashboard(member),
      /* The enquiries at this department's stages — only for someone who may open enquiries. */
      canRead(req.user, 'enquiries') ? enquiriesAtStages(member, ownershipFilter(req.user)) : [],
      /* The enquiries this department holds — its desk. */
      enquiriesHeldBy(member, req.user),
    ]);
    return { dashboard, atStages, held };
  }));
  /* Questions for this person, and answers back on this desk's tasks — at the top. */
  const attention = await attentionFor(req.user, desk ? members : key);
  const dashboard = mergeDashboards(perDepartment.map((row) => row.dashboard), { key, label: desk?.label });
  const atStages = perDepartment.flatMap((row) => row.atStages);
  /* A person's own payment follow-up is on every member's desk list — once on the merged desk. */
  const held = uniqueTasks(perDepartment.flatMap((row) => row.held), (row) => row.task._id);
  /* The queue less the enquiries themselves: side requests, like a PRT visit or photos sent. */
  const heldIds = new Set(held.map((row) => String(row.task._id)));
  const requests = dashboard.queue.filter((task) => !heldIds.has(String(task._id)));
  /* Dispatch plans vehicles by place: the open requests in baskets of the same landmark / PIN. */
  const baskets = key === 'despatch' ? await dispatchBaskets() : undefined;
  res.json({ success: true, data: { ...dashboard, requests, atStages, enquiries: held, attention, baskets, ...(desk ? { desk } : {}) } });
});

const uniqueTasks = (rows, idOf) => {
  const seen = new Set();
  return rows.filter((row) => {
    const id = String(idOf(row));
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

/** Several departments' dashboards as one desk's: counts added, lists joined in their own order. */
function mergeDashboards(dashboards, { key, label }) {
  if (dashboards.length === 1) return dashboards[0];
  const sum = (field) => dashboards.reduce((total, row) => total + (row.figures[field] || 0), 0);
  const mean = (field) => {
    const values = dashboards.map((row) => row.figures[field]).filter((value) => value !== null && value !== undefined);
    return values.length ? Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 10) / 10 : null;
  };
  const byDue = (a, b) => new Date(a.dueDate || 8640000000000000) - new Date(b.dueDate || 8640000000000000);
  const byDone = (a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0);
  return {
    figures: {
      department: key,
      label,
      open: sum('open'), unclaimed: sum('unclaimed'), late: sum('late'), dueToday: sum('dueToday'),
      doneThisWeek: sum('doneThisWeek'), sentBackThisWeek: sum('sentBackThisWeek'),
      averageHoursToDone: mean('averageHoursToDone'),
      onTimePercent: mean('onTimePercent') === null ? null : Math.round(mean('onTimePercent')),
    },
    queue: uniqueTasks(dashboards.flatMap((row) => row.queue), (task) => task._id).sort(byDue),
    recentlyDone: dashboards.flatMap((row) => row.recentlyDone).sort(byDone),
    waitingOnOthers: uniqueTasks(dashboards.flatMap((row) => row.waitingOnOthers), (task) => task._id).sort(byDue),
    cameBack: uniqueTasks(dashboards.flatMap((row) => row.cameBack), (task) => task._id).sort(byDone),
  };
}
