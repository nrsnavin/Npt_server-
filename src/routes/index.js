import { Router } from 'express';

import authRoutes from './auth.routes.js';
import userRoutes from './user.routes.js';
import workspaceRoutes from './workspace.routes.js';
import pipelineRoutes from './pipeline.routes.js';
import pricingRoutes from './pricing.routes.js';
import sampleRoutes from './sample.routes.js';
import { downloadAttachment } from '../controllers/sampleLog.controller.js';
import { globalSearch } from '../controllers/search.controller.js';
import { recordHistory } from '../controllers/audit.controller.js';
import { ask, status as jarvisStatus } from '../controllers/jarvis.controller.js';
import { listStates, listCities } from '../controllers/place.controller.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/workspace', workspaceRoutes);
router.use('/samples', sampleRoutes);
/*
 * One search across everything [§32]. Not inside a module's routes because it belongs to no
 * module — it decides per record type what the caller may read, and returns only those.
 */
router.get('/search', authenticate, globalSearch);
/*
 * Ask Jarvis. Administrators only — it answers across every module at once, which is a
 * management view of the plant rather than anybody's own screen.
 *
 * The per-subject grant checks and ownership filters inside the answers stay all the same.
 * An administrator bypasses both, so today they change nothing; the day this opens wider they
 * are already right. Adding a permission model to a feature that has run without one is how
 * somebody's book ends up in a colleague's answer.
 */
router.post('/jarvis/ask', authenticate, authorize('admin'), ask);
router.get('/jarvis/status', authenticate, authorize('admin'), jarvisStatus);
/*
 * States and towns, suggested as somebody types one. Behind `authenticate` but on no module
 * grant: a place name belongs to no module, and everybody who fills in an address needs them.
 */
router.get('/places/states', authenticate, listStates);
router.get('/places/cities', authenticate, listCities);
// Who changed what, on one record. Gated on the record, not on the log — see the controller.
router.get('/history/:model/:id', authenticate, recordHistory);
// Files are addressed by key rather than through the record they hang off, but the record is
// still what decides who may read one — see downloadAttachment.
router.get('/files/:key', authenticate, downloadAttachment);
// Phase 3 [§39]: costings and quotations. Mounted before the catch-all pipeline routes so
// their literal segments win.
router.use('/', pricingRoutes);
router.use('/', pipelineRoutes);

export default router;
