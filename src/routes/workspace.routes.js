import { Router } from 'express';
import {
  listTodos,
  createTodo,
  updateTodo,
  deleteTodo,
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
  noteSchema,
  noteUpdateSchema,
  announcementSchema,
} from '../validators/schemas.js';

const router = Router();

router.use(authenticate);

/*
 * Tasks and notes are personal, so they need no module grant — every signed-in user has
 * their own and can never see anyone else's. Announcements are organisational, so they
 * go through the module the same way any other shared data does.
 */
router.get('/todos/reminders', reminders);
router.get('/todos', listTodos);
router.post('/todos', validate(todoSchema), createTodo);
router.patch('/todos/:id', validate(todoUpdateSchema), updateTodo);
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
