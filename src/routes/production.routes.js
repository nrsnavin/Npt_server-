import { Router } from 'express';
import {
  productionOrderCrud,
  issueMaterials,
  recordOutput,
  workload,
} from '../controllers/productionOrder.controller.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { productionOrderSchema } from '../validators/schemas.js';

const router = Router();
const production = authorize('production');

router.use(authenticate);

router.get('/production-orders/workload', workload);
router.get('/production-orders', productionOrderCrud.list);
router.post('/production-orders', production, validate(productionOrderSchema), productionOrderCrud.create);
router.get('/production-orders/:id', productionOrderCrud.getOne);
router.patch('/production-orders/:id', production, productionOrderCrud.update);
router.delete('/production-orders/:id', authorize('admin'), productionOrderCrud.remove);
router.post('/production-orders/:id/issue-materials', authorize('production', 'inventory'), issueMaterials);
router.post('/production-orders/:id/output', production, recordOutput);

export default router;
