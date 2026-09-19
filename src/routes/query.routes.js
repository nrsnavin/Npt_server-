import { Router } from 'express';
import {
  listQueries, getQuery, createQuery, addMessage,
  addParticipant, closeQuery, reopenQuery, participantOptions,
} from '../controllers/query.controller.js';
import { authenticate, requireModule } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { querySchema, messageSchema, participantSchema } from '../validators/query.schemas.js';

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
router.post('/queries', requireModule('queries'), validate(querySchema), createQuery);
router.get('/queries/:id', requireModule('queries'), getQuery);

router.post('/queries/:id/messages', requireModule('queries'), validate(messageSchema), addMessage);
router.post(
  '/queries/:id/participants',
  requireModule('queries'),
  validate(participantSchema),
  addParticipant
);

router.post('/queries/:id/close', requireModule('queries'), closeQuery);
router.post('/queries/:id/reopen', requireModule('queries'), reopenQuery);

export default router;
