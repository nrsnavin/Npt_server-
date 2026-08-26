import { Router } from 'express';

import authRoutes from './auth.routes.js';
import userRoutes from './user.routes.js';
import workspaceRoutes from './workspace.routes.js';
import pipelineRoutes from './pipeline.routes.js';
import sampleRoutes from './sample.routes.js';
import { downloadAttachment } from '../controllers/sampleLog.controller.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/workspace', workspaceRoutes);
router.use('/samples', sampleRoutes);
// Files are addressed by key rather than through the record they hang off, but the record is
// still what decides who may read one — see downloadAttachment.
router.get('/files/:key', authenticate, downloadAttachment);
router.use('/', pipelineRoutes);

export default router;
