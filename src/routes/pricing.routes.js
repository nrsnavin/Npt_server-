import { Router } from 'express';
import {
  listPricings, getPricing, createPricing, costPricing, decidePricing,
} from '../controllers/pricing.controller.js';
import {
  listQuotations, getQuotation, createQuotation, updateQuotation,
  reviseQuotation, sendQuotation, respondToQuotation,
} from '../controllers/quotation.controller.js';
import { authenticate, requireModule } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  pricingSchema, pricingCostSchema, pricingDecisionSchema,
  quotationSchema, quotationUpdateSchema, quotationRevisionSchema,
  quotationSendSchema, quotationResponseSchema,
} from '../validators/pricing.schemas.js';

const router = Router();

router.use(authenticate);

/*
 * Phase 3 [§39]: pricing and quoting.
 *
 * The grants here are coarser than the rules inside the module, on purpose. `pricing: read` is
 * what marketing holds — enough to open a costing and see the price they may quote — while §8's
 * field split decides what actually comes back, and `assertMayCost` decides who may write. A
 * route-level grant cannot express "you may see this record but not four of its fields", so it
 * does not try.
 */

// Costings [§7, §9]
router.get('/pricings', requireModule('pricing'), listPricings);
router.post('/pricings', requireModule('pricing'), validate(pricingSchema), createPricing);
router.get('/pricings/:id', requireModule('pricing'), getPricing);
/*
 * Building the sheet and ruling on a price below the floor are both costing's work, and both
 * check `pricing: write` inside the controller as well — the second check is what keeps the
 * rule true if this route is ever loosened.
 */
router.patch('/pricings/:id/cost', requireModule('pricing'), validate(pricingCostSchema), costPricing);
router.post('/pricings/:id/decision', requireModule('pricing'), validate(pricingDecisionSchema), decidePricing);

// Quotations [§10]
router.get('/quotations', requireModule('quotations'), listQuotations);
router.post('/quotations', requireModule('quotations', 'write'), validate(quotationSchema), createQuotation);
router.get('/quotations/:id', requireModule('quotations'), getQuotation);
router.patch('/quotations/:id', requireModule('quotations', 'write'), validate(quotationUpdateSchema), updateQuotation);
/** A new price keeps the old one [§10]. */
router.post('/quotations/:id/revisions', requireModule('quotations', 'write'), validate(quotationRevisionSchema), reviseQuotation);
/** Putting it in front of the customer — the moment §9's gate applies. */
router.post('/quotations/:id/send', requireModule('quotations', 'write'), validate(quotationSendSchema), sendQuotation);
router.post('/quotations/:id/response', requireModule('quotations', 'write'), validate(quotationResponseSchema), respondToQuotation);

export default router;
