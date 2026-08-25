import { Router } from 'express';
import {
  stockLevels,
  movements,
  adjust,
  reorderReport,
} from '../controllers/inventory.controller.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { stockAdjustmentSchema } from '../validators/schemas.js';

const router = Router();

router.use(authenticate);

router.get('/stock', stockLevels);
router.get('/stock/movements', movements);
router.get('/stock/reorder', reorderReport);
router.post('/stock/adjust', authorize('inventory'), validate(stockAdjustmentSchema), adjust);

export default router;
