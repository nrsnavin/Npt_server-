import { Router } from 'express';
import {
  listTodos,
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
import { authenticate, requireModule } from '../middleware/auth.js';
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
  pushSubscribeSchema,
  pushUnsubscribeSchema,
} from '../validators/schemas.js';
import { pushKey, subscribePush, unsubscribePush } from '../controllers/push.controller.js';
import { createView, deleteView, listViews, updateView } from '../controllers/savedView.controller.js';

const router = Router();

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
router.get('/todos/:id/suggest', suggestRoutingFor);
router.post('/todos/:id/escalate', validate(todoEscalateSchema), escalateTodo);
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
router.delete('/announcements/:id', requireModule('announcements', 'write'), deleteAnnouncement);

export default router;
