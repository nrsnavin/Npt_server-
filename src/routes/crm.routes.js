import { Router } from 'express';
import Customer from '../models/Customer.js';
import crudController from '../controllers/crud.factory.js';
import {
  leadCrud,
  addActivity,
  convertToCustomer,
  pipeline,
} from '../controllers/lead.controller.js';
import { authenticate, authorize } from '../middleware/auth.js';

const customers = crudController(Customer, {
  searchFields: ['name', 'code', 'email', 'phone', 'gstin'],
  populate: [{ path: 'owner', select: 'name email' }],
  defaultSort: 'name',
});

const router = Router();
const sales = authorize('sales', 'accounts');

router.use(authenticate);

router.get('/customers', customers.list);
router.post('/customers', sales, customers.create);
router.get('/customers/:id', customers.getOne);
router.patch('/customers/:id', sales, customers.update);
router.delete('/customers/:id', authorize('admin'), customers.remove);

router.get('/leads/pipeline', pipeline);
router.get('/leads', leadCrud.list);
router.post('/leads', sales, leadCrud.create);
router.get('/leads/:id', leadCrud.getOne);
router.patch('/leads/:id', sales, leadCrud.update);
router.delete('/leads/:id', authorize('admin'), leadCrud.remove);
router.post('/leads/:id/activities', sales, addActivity);
router.post('/leads/:id/convert', sales, convertToCustomer);

export default router;
