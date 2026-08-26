import { Router } from 'express';
import {
  listProducts, getProduct, createProduct, updateProduct,
  listCustomers, getCustomer, createCustomer, updateCustomer, checkDuplicateCustomer,
  listLeads, getLead, createLead, updateLead, addLeadActivity, convertLead,
  listEnquiries, getEnquiry, createEnquiry, createEnquiryGroup, updateEnquiry,
  setEnquiryStatus, promoteToProduct, enquiryPipeline,
} from '../controllers/pipeline.controller.js';
import { authenticate, requireModule } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  productSchema, productUpdateSchema,
  customerSchema, customerUpdateSchema,
  leadSchema, leadUpdateSchema, leadActivitySchema, convertLeadSchema,
  enquirySchema, enquiryUpdateSchema, enquiryGroupSchema, enquiryStatusSchema,
  promoteProductSchema,
} from '../validators/pipeline.schemas.js';

const router = Router();

router.use(authenticate);

/*
 * Module access decides whether you may use these at all; record ownership decides whose
 * records you see, and is applied inside the controllers because it varies by department
 * — see services/ownership.service.js.
 */

// Products
router.get('/products', requireModule('products'), listProducts);
router.post('/products', requireModule('products', 'write'), validate(productSchema), createProduct);
router.get('/products/:id', requireModule('products'), getProduct);
router.patch('/products/:id', requireModule('products', 'write'), validate(productUpdateSchema), updateProduct);

// Customers
router.get('/customers/check-duplicate', requireModule('customers'), checkDuplicateCustomer);
router.get('/customers', requireModule('customers'), listCustomers);
router.post('/customers', requireModule('customers', 'write'), validate(customerSchema), createCustomer);
router.get('/customers/:id', requireModule('customers'), getCustomer);
router.patch('/customers/:id', requireModule('customers', 'write'), validate(customerUpdateSchema), updateCustomer);

// Leads
router.get('/leads', requireModule('enquiries'), listLeads);
router.post('/leads', requireModule('enquiries', 'write'), validate(leadSchema), createLead);
router.get('/leads/:id', requireModule('enquiries'), getLead);
router.patch('/leads/:id', requireModule('enquiries', 'write'), validate(leadUpdateSchema), updateLead);
router.post('/leads/:id/activities', requireModule('enquiries', 'write'), validate(leadActivitySchema), addLeadActivity);
// Conversion writes a customer as well, so it needs write on both.
router.post(
  '/leads/:id/convert',
  requireModule('enquiries', 'write'),
  requireModule('customers', 'write'),
  validate(convertLeadSchema),
  convertLead
);

// Enquiries
router.get('/enquiries/pipeline', requireModule('enquiries'), enquiryPipeline);
router.get('/enquiries', requireModule('enquiries'), listEnquiries);
router.post('/enquiries', requireModule('enquiries', 'write'), validate(enquirySchema), createEnquiry);
router.post('/enquiries/group', requireModule('enquiries', 'write'), validate(enquiryGroupSchema), createEnquiryGroup);
router.get('/enquiries/:id', requireModule('enquiries'), getEnquiry);
router.patch('/enquiries/:id', requireModule('enquiries', 'write'), validate(enquiryUpdateSchema), updateEnquiry);
router.post('/enquiries/:id/status', requireModule('enquiries', 'write'), validate(enquiryStatusSchema), setEnquiryStatus);
router.post(
  '/enquiries/:id/promote-product',
  requireModule('enquiries', 'write'),
  requireModule('products', 'write'),
  validate(promoteProductSchema),
  promoteToProduct
);

export default router;
