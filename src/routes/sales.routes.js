import { Router } from 'express';
import { quotationCrud, convertToSalesOrder } from '../controllers/quotation.controller.js';
import {
  salesOrderCrud,
  planProduction,
  dispatch,
} from '../controllers/salesOrder.controller.js';
import { createFromSalesOrder } from '../controllers/invoice.controller.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { quotationSchema, salesOrderSchema } from '../validators/schemas.js';

const router = Router();
const sales = authorize('sales');

router.use(authenticate);

router.get('/quotations', quotationCrud.list);
router.post('/quotations', sales, validate(quotationSchema), quotationCrud.create);
router.get('/quotations/:id', quotationCrud.getOne);
router.patch('/quotations/:id', sales, quotationCrud.update);
router.delete('/quotations/:id', authorize('admin'), quotationCrud.remove);
router.post('/quotations/:id/convert', sales, convertToSalesOrder);

router.get('/sales-orders', salesOrderCrud.list);
router.post('/sales-orders', sales, validate(salesOrderSchema), salesOrderCrud.create);
router.get('/sales-orders/:id', salesOrderCrud.getOne);
router.patch('/sales-orders/:id', sales, salesOrderCrud.update);
router.delete('/sales-orders/:id', authorize('admin'), salesOrderCrud.remove);
router.post('/sales-orders/:id/plan-production', authorize('sales', 'production'), planProduction);
router.post('/sales-orders/:id/dispatch', authorize('sales', 'inventory'), dispatch);
router.post('/sales-orders/:id/invoice', authorize('sales', 'accounts'), createFromSalesOrder);

export default router;
