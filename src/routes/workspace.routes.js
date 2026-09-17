import { Router } from 'express';
import {
  listTodos,
  createTodo,
  updateTodo,
  deleteTodo,
  escalateTodo,
  escalatedToMe,
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
import { authenticate, requireModule } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  todoSchema,
  todoUpdateSchema,
  todoEscalateSchema,
  noteSchema,
  noteUpdateSchema,
  announcementSchema,
} from '../validators/schemas.js';

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
router.get('/todos/escalated', escalatedToMe);
router.get('/todos', listTodos);
router.post('/todos', validate(todoSchema), createTodo);
router.patch('/todos/:id', validate(todoUpdateSchema), updateTodo);
router.post('/todos/:id/escalate', validate(todoEscalateSchema), escalateTodo);
router.delete('/todos/:id', deleteTodo);

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
