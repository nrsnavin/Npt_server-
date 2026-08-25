import { Router } from 'express';
import Payment from '../models/Payment.js';
import crudController from '../controllers/crud.factory.js';
import { invoiceCrud, recordPayment, ageing } from '../controllers/invoice.controller.js';
import { authenticate, authorize } from '../middleware/auth.js';

const payments = crudController(Payment, {
  searchFields: ['number', 'referenceNumber'],
  populate: [
    { path: 'customer', select: 'code name' },
    { path: 'invoice', select: 'number grandTotal' },
  ],
});

const router = Router();
const accounts = authorize('accounts');

router.use(authenticate);

router.get('/invoices/ageing', ageing);
router.get('/invoices', invoiceCrud.list);
router.post('/invoices', accounts, invoiceCrud.create);
router.get('/invoices/:id', invoiceCrud.getOne);
router.patch('/invoices/:id', accounts, invoiceCrud.update);
router.delete('/invoices/:id', authorize('admin'), invoiceCrud.remove);
router.post('/invoices/:id/payments', accounts, recordPayment);

router.get('/payments', payments.list);
router.get('/payments/:id', payments.getOne);

export default router;
