import { Router } from 'express';

import authRoutes from './auth.routes.js';
import userRoutes from './user.routes.js';
import crmRoutes from './crm.routes.js';
import catalogRoutes from './catalog.routes.js';
import salesRoutes from './sales.routes.js';
import productionRoutes from './production.routes.js';
import purchasingRoutes from './purchasing.routes.js';
import inventoryRoutes from './inventory.routes.js';
import accountsRoutes from './accounts.routes.js';
import dashboardRoutes from './dashboard.routes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/', crmRoutes);
router.use('/', catalogRoutes);
router.use('/', salesRoutes);
router.use('/', productionRoutes);
router.use('/', purchasingRoutes);
router.use('/', inventoryRoutes);
router.use('/', accountsRoutes);
router.use('/dashboard', dashboardRoutes);

export default router;
