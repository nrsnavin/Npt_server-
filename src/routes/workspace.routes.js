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
  handoffBrief, handoffDone, handoffEdd, handoffRouting, handoffRoute, handoffQueue, handoffSeen, handoffReschedule, handoffResult, handoffSendBack, handoffStatus, handoffUpdate, listNotices, markNoticeRead, removeNotice, handoffAsk, createTeamTask, teamTaskFormPrefill, taskRegisters, attachTeamTaskPdf, handoffDocument, handoffDocuments,
} from '../controllers/handoff.controller.js';
import {
  handoffDoneSchema, handoffUpdateSchema, handoffRescheduleSchema, handoffReturnSchema, taskAskSchema, teamTaskSchema, taskBriefSchema, taskEddSchema, taskRoutingSchema, taskStatusSchema, productionQueueAddSchema,
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
router.post('/todos/:id/reschedule', validate(handoffRescheduleSchema), handoffReschedule);
router.post('/todos/:id/status', validate(taskStatusSchema), handoffStatus);
/* The EDD from the Production / Assembly / Printing task, without a status move. */
router.post('/todos/:id/edd', validate(taskEddSchema), handoffEdd);
/* Production decides, model by model, what follows moulding: printing, assembly, both or neither. */
router.get('/todos/:id/routing', handoffRouting);
router.post('/todos/:id/routing', validate(taskRoutingSchema), handoffRoute);
router.post('/todos/:id/production-queue', validate(productionQueueAddSchema), handoffQueue);
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
