import { Router } from 'express';
import {
  listProducts, getProduct, createProduct, updateProduct,
  listCustomers, getCustomer, createCustomer, updateCustomer, checkDuplicateCustomer,
  listLeads, getLead, createLead, updateLead, addLeadActivity, convertLead,
  suggestLeadNextStep, leadLogAnalytics, leadFollowUps, leadScoreboard,
  listEnquiries, getEnquiry, createEnquiry, createEnquiryGroup, updateEnquiry,
  setEnquiryStatus, promoteToProduct, enquiryPipeline,
  exportCustomers,
  exportLeads,
  exportEnquiries,
  exportProducts,
  bulkReassign,
} from '../controllers/pipeline.controller.js';
import { marketingDashboard } from '../controllers/marketingDashboard.controller.js';
import { addDocument, listDocuments, removeDocument } from '../controllers/document.controller.js';
import { singleDocument } from '../middleware/upload.js';
import { authenticate, requireModule } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  productSchema, productUpdateSchema,
  customerSchema, customerUpdateSchema,
  leadSchema, leadUpdateSchema, leadActivitySchema, convertLeadSchema,
  enquirySchema, enquiryUpdateSchema, enquiryGroupSchema, enquiryStatusSchema,
  promoteProductSchema, bulkReassignSchema,
} from '../validators/pipeline.schemas.js';

const router = Router();

router.use(authenticate);

/*
 * Module access decides whether you may use these at all; record ownership decides whose
 * records you see, and is applied inside the controllers because it varies by department
 * — see services/ownership.service.js.
 */

// Products
// Above `/:id` so the literal segment wins; on the read grant, because an export is a read.
router.get('/products/export', requireModule('products'), exportProducts);
router.get('/products', requireModule('products'), listProducts);
router.post('/products', requireModule('products', 'write'), validate(productSchema), createProduct);
router.get('/products/:id', requireModule('products'), getProduct);
router.patch('/products/:id', requireModule('products', 'write'), validate(productUpdateSchema), updateProduct);

// Customers
router.get('/customers/export', requireModule('customers'), exportCustomers);
router.get('/customers/check-duplicate', requireModule('customers'), checkDuplicateCustomer);
router.get('/customers', requireModule('customers'), listCustomers);
router.post('/customers', requireModule('customers', 'write'), validate(customerSchema), createCustomer);
router.get('/customers/:id', requireModule('customers'), getCustomer);
router.patch('/customers/:id', requireModule('customers', 'write'), validate(customerUpdateSchema), updateCustomer);

// Leads
router.get('/leads/export', requireModule('enquiries'), exportLeads);
/*
 * Whose leads need somebody today. Above `/:id` so the literal segment wins, and on the read
 * grant — knowing what is waiting is not changing anything.
 */
router.get('/leads/follow-ups', requireModule('enquiries'), leadFollowUps);
router.get('/leads/scoreboard', requireModule('enquiries'), leadScoreboard);
router.get('/leads', requireModule('enquiries'), listLeads);
router.post('/leads', requireModule('enquiries', 'write'), validate(leadSchema), createLead);
router.get('/leads/:id', requireModule('enquiries'), getLead);
router.patch('/leads/:id', requireModule('enquiries', 'write'), validate(leadUpdateSchema), updateLead);
router.post('/leads/:id/activities', requireModule('enquiries', 'write'), validate(leadActivitySchema), addLeadActivity);
router.get('/leads/:id/log-analytics', requireModule('enquiries'), leadLogAnalytics);
/*
 * Reads the log and proposes a next step. On the write grant despite writing nothing: it is
 * offered to the person who will act on it, and it costs a model call — neither belongs to a
 * reader who cannot do anything with the answer.
 */
router.post('/leads/:id/suggest', requireModule('enquiries', 'write'), suggestLeadNextStep);
// Conversion writes a customer as well, so it needs write on both.
router.post(
  '/leads/:id/convert',
  requireModule('enquiries', 'write'),
  requireModule('customers', 'write'),
  validate(convertLeadSchema),
  convertLead
);

// Enquiries
router.get('/enquiries/export', requireModule('enquiries'), exportEnquiries);
/*
 * Moving a batch to another owner. One route rather than four, because the rule and the
 * audit trail are identical and only the collection differs.
 */
router.post(
  '/bulk/:collection/reassign',
  requireModule('users', 'write'),
  validate(bulkReassignSchema),
  bulkReassign
);

/*
 * Documents on the records that have them [§27]. One set of routes rather than a pair per
 * collection: the rule is the record's own access, and only the collection differs.
 */
router.get('/:collection/:id/documents', authenticate, listDocuments);
router.post('/:collection/:id/documents', authenticate, singleDocument('file'), addDocument);
router.delete('/:collection/:id/documents/:documentId', authenticate, removeDocument);

router.get('/enquiries/pipeline', requireModule('enquiries'), enquiryPipeline);
// Marketing's own dashboard [§21]. On the enquiries grant, since that is the module it is
// mostly built from; ownership then decides whose figures it shows.
router.get('/dashboard/marketing', requireModule('enquiries'), marketingDashboard);
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
