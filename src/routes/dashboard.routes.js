import { Router } from 'express';
import { summary, salesTrend, topProducts } from '../controllers/dashboard.controller.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);
router.get('/summary', summary);
router.get('/sales-trend', salesTrend);
router.get('/top-products', topProducts);

export default router;
