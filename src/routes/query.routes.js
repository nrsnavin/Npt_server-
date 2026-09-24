import { Router } from 'express';
import {
  listQueries, getQuery, createQuery, addMessage,
  addParticipant, closeQuery, reopenQuery, participantOptions,
  readUrgency, suggestReply,
  markRead, addFile, setUrgent, setLabels, readSummaries,
} from '../controllers/query.controller.js';
import { singleDocument } from '../middleware/upload.js';
import { authenticate, requireModule } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  querySchema, messageSchema, participantSchema, urgencySchema, urgentSchema, labelsSchema,
} from '../validators/query.schemas.js';

/**
 * Queries: a threaded question about a buyer [queries].
 *
 * **Read is the only grant anything here asks for**, and that is the deliberate part. A query is
 * a conversation, not a record anybody owns — the whole point is that despatch, accounts and
 * marketing are in the same thread — so gating replies on `queries: write` would mean the
 * departments a question is *for* could not answer it unless an administrator had remembered to
 * give each of them a write grant they need for nothing else.
 *
 * What protects the thread is not the module grant, it is membership: `readableQuery` refuses
 * anybody not in the room, and the room is the participant list. So the rule reads: anybody who
 * may use queries at all may ask one, and may reply to the ones they are in.
 *
 * Closing is the exception the controller enforces rather than the router: only the asker, or an
 * administrator tidying up after somebody who has left.
 */
const router = Router();

router.use(authenticate);

/* Who a participant may be, for the picker — departments and the people in each. */
router.get('/queries/options', requireModule('queries'), participantOptions);

router.get('/queries', requireModule('queries'), listQueries);
/*
 * How pressing the page in view is, read by the model [queries].
 *
 * A POST because it carries the ids on screen and a list of forty would not fit comfortably in
 * a query string — it reads rather than writes, and writes nothing anywhere. The ids are
 * re-fetched through the list's own scope inside, so posting somebody else's id answers
 * nothing about it.
 */
router.post('/queries/urgency', requireModule('queries'), validate(urgencySchema), readUrgency);
/* A line per row, read after the list has drawn. Same ids shape as the urgency reading. */
router.post('/queries/summaries', requireModule('queries'), validate(urgencySchema), readSummaries);
router.post('/queries', requireModule('queries'), validate(querySchema), createQuery);
router.get('/queries/:id', requireModule('queries'), getQuery);

router.post('/queries/:id/messages', requireModule('queries'), validate(messageSchema), addMessage);
/* A photo or document into the thread, with an optional caption and tags. */
router.post('/queries/:id/files', requireModule('queries'), singleDocument('file'), addFile);
/* Flagging urgent — the controller holds that only an administrator may. */
router.post('/queries/:id/urgent', requireModule('queries'), validate(urgentSchema), setUrgent);
/* Filing under labels — anybody who can open the thread. */
router.put('/queries/:id/labels', requireModule('queries'), validate(labelsSchema), setLabels);
router.post(
  '/queries/:id/participants',
  requireModule('queries'),
  validate(participantSchema),
  addParticipant
);

/* A draft for the composer. Nothing is said in the thread until the person presses send. */
router.post('/queries/:id/draft-reply', requireModule('queries'), suggestReply);
/* Moves the reader's own cursor. A POST, so no prefetch can mark a thread read on their behalf. */
router.post('/queries/:id/read', requireModule('queries'), markRead);

router.post('/queries/:id/close', requireModule('queries'), closeQuery);
router.post('/queries/:id/reopen', requireModule('queries'), reopenQuery);

export default router;
