import { Router } from 'express';

import authRoutes from './auth.routes.js';
import userRoutes from './user.routes.js';
import workspaceRoutes from './workspace.routes.js';
import pipelineRoutes from './pipeline.routes.js';
import sampleRoutes from './sample.routes.js';
import { downloadAttachment } from '../controllers/sampleLog.controller.js';
import { globalSearch } from '../controllers/search.controller.js';
import { recordHistory } from '../controllers/audit.controller.js';
import { authenticate } from '../middleware/auth.js';

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
// Who changed what, on one record. Gated on the record, not on the log — see the controller.
router.get('/history/:model/:id', authenticate, recordHistory);
// Files are addressed by key rather than through the record they hang off, but the record is
// still what decides who may read one — see downloadAttachment.
router.get('/files/:key', authenticate, downloadAttachment);
router.use('/', pipelineRoutes);

export default router;
