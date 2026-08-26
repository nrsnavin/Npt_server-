import { Router } from 'express';

import authRoutes from './auth.routes.js';
import userRoutes from './user.routes.js';
import workspaceRoutes from './workspace.routes.js';
import pipelineRoutes from './pipeline.routes.js';
import sampleRoutes from './sample.routes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/workspace', workspaceRoutes);
router.use('/samples', sampleRoutes);
router.use('/', pipelineRoutes);

export default router;
