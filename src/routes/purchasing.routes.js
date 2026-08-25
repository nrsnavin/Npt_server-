import { Router } from 'express';
import { purchaseOrderCrud, receive } from '../controllers/purchaseOrder.controller.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { purchaseOrderSchema } from '../validators/schemas.js';

const router = Router();
const purchasing = authorize('inventory', 'accounts');

router.use(authenticate);

router.get('/purchase-orders', purchaseOrderCrud.list);
router.post('/purchase-orders', purchasing, validate(purchaseOrderSchema), purchaseOrderCrud.create);
router.get('/purchase-orders/:id', purchaseOrderCrud.getOne);
router.patch('/purchase-orders/:id', purchasing, purchaseOrderCrud.update);
router.delete('/purchase-orders/:id', authorize('admin'), purchaseOrderCrud.remove);
router.post('/purchase-orders/:id/receive', authorize('inventory'), receive);

export default router;
