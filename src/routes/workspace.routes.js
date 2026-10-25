import { Router } from 'express';
import {
  listTodos,
  freshTodos,
  createTodo,
  updateTodo,
  deleteTodo,
  escalateTodo,
  needsMeToday,
  suggestRoutingFor,
  reminders,
  listNotes,
  createNote,
  updateNote,
  deleteNote,
  listAnnouncements,
  createAnnouncement,
  markAnnouncementRead,
  deleteAnnouncement,
} from '../controllers/workspace.controller.js';
import { plantReview, raiseFinding } from '../controllers/review.controller.js';
import { adminOnly, authenticate, requireModule } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  todoSchema,
  todoUpdateSchema,
  todoEscalateSchema,
  raiseFindingSchema,
  noteSchema,
  noteUpdateSchema,
  announcementSchema,
  savedViewSchema,
  savedViewUpdateSchema,
  pushRenewSchema,
  pushSubscribeSchema,
  pushUnsubscribeSchema,
} from '../validators/schemas.js';
import { notificationStatus, pushKey, renewPush, sendTestNotification, subscribePush, unsubscribePush } from '../controllers/push.controller.js';
import { createView, deleteView, listViews, updateView } from '../controllers/savedView.controller.js';
import {
  handoffBrief, handoffDone, handoffEdd, handoffConfirmEdd, productionInChargeList, handoffRouting, handoffRoute, handoffQueue, handoffWorkQueue, handoffSeen, handoffReschedule, handoffResult, handoffSendBack, handoffAdminClose, handoffEscalate, handoffResolveEscalation, handoffDeliveryUrgency, handoffStatus, handoffUpdate, listNotices, markNoticeRead, removeNotice, handoffAsk, createTeamTask, setTaskJobEdd, teamTaskFormPrefill, taskRegisters, attachTeamTaskPdf, handoffDocument, handoffDocuments, listTaskPdfs, handoffDispatchSheet, handoffDispatchLoad, handoffLoadProof, handoffReceipts, handoffSendResult, handoffShipments, handoffDues, handoffLinkOptions, handoffLinkEnquiry, handoffStartFrom, listTeamJobsHandler, teamJobHandler, shipmentPaper,
} from '../controllers/handoff.controller.js';
import {
  handoffDoneSchema, handoffUpdateSchema, handoffRescheduleSchema, handoffReturnSchema, handoffAdminCloseSchema, handoffEscalateSchema, handoffEscalationResolveSchema, deliveryUrgencySchema, taskAskSchema, teamTaskSchema, taskBriefSchema, taskEddSchema, jobEddSchema, taskRoutingSchema, taskStatusSchema, productionQueueAddSchema, workQueueAddSchema,
} from '../validators/handoff.schemas.js';
import { singlePdf, singleTaskResult } from '../middleware/upload.js';

const router = Router();

/* The service worker re-registering a device the browser gave a new subscription — it has no sign-in. */
router.post('/push/renew', validate(pushRenewSchema), renewPush);

router.use(authenticate);

/*
 * Tasks need no module grant, and that is still right even now they are shared: the scoping is
 * the *department*, which every signed-in user has one of, rather than a grant somebody can be
 * given or refused. A person sees their own work and their own department's queue; marketing
 * additionally sees tasks on the buyers they own, which the controller reads off the customer
 * so §29 decides it rather than a second copy of the rule living here. Notes stay personal.
 * Announcements are organisational, so they go through the module like any other shared data.
 *
 * The two literal paths sit above `/todos/:id` so they are matched as themselves rather than
 * as a task called "reminders".
 */
/* The PDFs on tasks, for the sample, quotation, sales order and production pages [taskPdfs.service]. */
router.get('/task-pdfs', listTaskPdfs);
router.get('/todos/reminders', reminders);
router.get('/todos/needs-me', needsMeToday);
router.get('/todos', listTodos);
router.post('/todos', validate(todoSchema), createTodo);
router.patch('/todos/:id', validate(todoUpdateSchema), updateTodo);
/*
 * Whose job is this — asked of the model, answered by keyword rules when there is no key.
 *
 * A GET, because it reads and proposes and changes nothing: the escalation below still needs
 * its own press. Behind the same door as the task itself, so a suggestion cannot be used to
 * learn about a task the asker may not see.
 */
router.get('/todos/fresh', freshTodos);
router.get('/todos/:id/suggest', suggestRoutingFor);
router.post('/todos/:id/escalate', validate(todoEscalateSchema), escalateTodo);
/* A department task about an enquiry: done, sent back to whoever asked, or re-dated. */
router.post('/todos/:id/done', validate(handoffDoneSchema), handoffDone);
router.post('/todos/:id/update', validate(handoffUpdateSchema), handoffUpdate);
router.post('/todos/:id/send-back', validate(handoffReturnSchema), handoffSendBack);
router.post('/todos/:id/admin-close', validate(handoffAdminCloseSchema), handoffAdminClose);
/* An issue on the task goes to Admin alone, under "Needs your action"; Admin's answer comes back to whoever raised it. */
router.post('/todos/:id/escalate-admin', validate(handoffEscalateSchema), handoffEscalate);
router.post('/todos/:id/escalate-admin/resolve', validate(handoffEscalationResolveSchema), handoffResolveEscalation);
router.post('/todos/:id/delivery', validate(deliveryUrgencySchema), handoffDeliveryUrgency);
router.post('/todos/:id/reschedule', validate(handoffRescheduleSchema), handoffReschedule);
router.post('/todos/:id/status', validate(taskStatusSchema), handoffStatus);
/* The EDD from the Production / Assembly / Printing task, without a status move. */
router.post('/todos/:id/edd', validate(taskEddSchema), handoffEdd);
/* A job raised from the customer: marketing or Admin set its EDD from any of its tasks [eddAsk.service]. */
router.post('/todos/:id/job-edd', validate(jobEddSchema), setTaskJobEdd);
/* The Production in charge confirms the EDD Printing or Assembly gave. */
router.post('/todos/:id/edd/confirm', handoffConfirmEdd);
/* Who is Production in charge: the desks say it, and warn when nobody is. */
router.get('/production-in-charge', productionInChargeList);
/* Production decides, model by model, what follows moulding: printing, assembly, both or neither. */
router.get('/todos/:id/routing', handoffRouting);
router.post('/todos/:id/routing', validate(taskRoutingSchema), handoffRoute);
/* A Production task with no enquiry: join the buyer's enquiry, or start each model from where it is [teamProduction.service]. */
/* Team jobs: the tasks Admin and marketing gave with no enquiry, each read whole [teamJobs.service]. */
router.get('/team-jobs', listTeamJobsHandler);
router.get('/team-jobs/:id', teamJobHandler);
router.get('/todos/:id/link-options', handoffLinkOptions);
router.post('/todos/:id/link-enquiry', handoffLinkEnquiry);
router.post('/todos/:id/start-from', handoffStartFrom);
router.post('/todos/:id/production-queue', validate(productionQueueAddSchema), handoffQueue);
/* Printing and Assembly take the goods that came into their work queue. */
router.post('/todos/:id/work-queue', validate(workQueueAddSchema), handoffWorkQueue);
router.post('/todos/:id/brief', validate(taskBriefSchema), handoffBrief);
router.post('/todos/:id/seen', handoffSeen);
router.post('/todos/:id/ask', validate(taskAskSchema), handoffAsk);
/* A department task for a team, with no enquiry behind it — Admin and marketing. */
router.get('/team-tasks/prefill', teamTaskFormPrefill);
router.get('/registers', taskRegisters);
router.post('/team-tasks', validate(teamTaskSchema), createTeamTask);
router.post('/team-tasks/:id/attachment', singlePdf('file'), attachTeamTaskPdf);
/* What departments did on my enquiries — read, then dismissed (or cleared a day after reading). */
router.get('/notices', listNotices);
router.post('/notices/:id/read', markNoticeRead);
router.delete('/notices/:id', removeNotice);
router.post('/todos/:id/result', singleTaskResult('file'), handoffResult);
router.post('/todos/:id/result/send', handoffSendResult);
router.get('/todos/:id/dispatch', handoffDispatchSheet);
/* The job's shipments, each with its own LR — Reception uploads and sends one a shipment [handoff.service `shipmentsOf`]. */
router.get('/todos/:id/shipments', handoffShipments);
/* The payments behind a Payment Collection, PRT or A/C Clarify task, by RCV number, for Accounts to confirm. */
router.get('/todos/:id/receipts', handoffReceipts);
/* The buyer's dues a payment on the task can go against, or on account [paymentGates `duesOfTask`]. */
router.get('/todos/:id/dues', handoffDues);
router.post('/todos/:id/dispatch', singleTaskResult('file'), handoffDispatchLoad);
/* The LR copy / proof and details added to a load already gone — the paper often comes after the goods. */
router.post('/todos/:id/loads/:loadId', singleTaskResult('file'), handoffLoadProof);
/* One shipment's proof of delivery or LR, from anywhere it is seen — Dispatch or Reception [shipmentPaper]. */
router.post('/loads/:loadId/paper', singleTaskResult('file'), shipmentPaper);
/* Papers a department keeps on its task — the invoice, dispatch details — for marketing to attach. */
router.get('/todos/:id/documents', handoffDocuments);
router.post('/todos/:id/documents', singleTaskResult('file'), handoffDocument);
router.delete('/todos/:id', deleteTodo);

/*
 * The review [§25]: what matters now, across the plant for management and inside their own
 * department for everybody else.
 *
 * No module grant. The scoping is the *department*, as with tasks — and the findings are built
 * from queries the reader's own screens already run, so the brief cannot show somebody a figure
 * they could not reach by navigating. Management and admins get the whole plant, which is the
 * audience §25's red flag names.
 */
router.get('/review', plantReview);
/* And handing one of them to the department that can clear it — an ordinary task, raised by the
   person who pressed it. The finding is re-derived server side, never accepted from the body. */
router.post('/review/raise', validate(raiseFindingSchema), raiseFinding);

/* Notifications on this device — the installed app's pushes. */
router.get('/push/key', pushKey);
router.post('/push/subscribe', validate(pushSubscribeSchema), subscribePush);
router.post('/push/unsubscribe', validate(pushUnsubscribeSchema), unsubscribePush);
/* Whether notifications are set up, and a test sent to myself. */
router.get('/notifications/status', notificationStatus);
router.post('/notifications/test', sendTestNotification);

/* Saved views — somebody's named filter sets, pinned in their sidebar. */
router.get('/views', listViews);
router.post('/views', validate(savedViewSchema), createView);
router.patch('/views/:id', validate(savedViewUpdateSchema), updateView);
router.delete('/views/:id', deleteView);

router.get('/notes', listNotes);
router.post('/notes', validate(noteSchema), createNote);
router.patch('/notes/:id', validate(noteUpdateSchema), updateNote);
router.delete('/notes/:id', deleteNote);

router.get('/announcements', requireModule('announcements'), listAnnouncements);
router.post(
  '/announcements',
  requireModule('announcements', 'write'),
  validate(announcementSchema),
  createAnnouncement
);
router.post('/announcements/:id/read', requireModule('announcements'), markAnnouncementRead);
router.delete('/announcements/:id', requireModule('announcements', 'write'), adminOnly, deleteAnnouncement);

export default router;
