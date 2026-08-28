import { Router } from 'express';
import {
  listPricings, getPricing, createPricing, updatePricing, costPricing, decidePricing,
  quoteFromPricing, pricingQuotations,
} from '../controllers/pricing.controller.js';
import {
  listQuotations, getQuotation, createQuotation, updateQuotation,
  reviseQuotation, sendQuotation, respondToQuotation, quotationPdf,
} from '../controllers/quotation.controller.js';
import { authenticate, requireModule } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  pricingSchema, pricingUpdateSchema, pricingCostSchema, pricingDecisionSchema, pricingQuoteSchema,
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
/** What the costing is *of* — the job. The prices have their own door below. */
router.patch('/pricings/:id', requireModule('pricing'), validate(pricingUpdateSchema), updatePricing);
router.patch('/pricings/:id/cost', requireModule('pricing'), validate(pricingCostSchema), costPricing);
router.post('/pricings/:id/decision', requireModule('pricing'), validate(pricingDecisionSchema), decidePricing);

/*
 * The join between the two modules [§7 → §10].
 *
 * Guarded on `quotations: write` rather than on pricing: the thing being created is a
 * quotation, and whether you may raise one is a question about quoting, not about costing.
 * Marketing holds pricing at read and quotations at write, which is exactly the person this
 * route is for — they may turn an approved price into a quote without ever seeing the cost
 * behind it.
 */
router.post('/pricings/:id/quotation', requireModule('quotations', 'write'), validate(pricingQuoteSchema), quoteFromPricing);
/** The reverse view: what this sheet was quoted at, and how often. */
router.get('/pricings/:id/quotations', requireModule('pricing'), pricingQuotations);

// Quotations [§10]
router.get('/quotations', requireModule('quotations'), listQuotations);
router.post('/quotations', requireModule('quotations', 'write'), validate(quotationSchema), createQuotation);
router.get('/quotations/:id', requireModule('quotations'), getQuotation);
/** The document the customer receives, rendered from the record on demand. */
router.get('/quotations/:id/pdf', requireModule('quotations'), quotationPdf);
router.patch('/quotations/:id', requireModule('quotations', 'write'), validate(quotationUpdateSchema), updateQuotation);
/** A new price keeps the old one [§10]. */
router.post('/quotations/:id/revisions', requireModule('quotations', 'write'), validate(quotationRevisionSchema), reviseQuotation);
/** Putting it in front of the customer — the moment §9's gate applies. */
router.post('/quotations/:id/send', requireModule('quotations', 'write'), validate(quotationSendSchema), sendQuotation);
router.post('/quotations/:id/response', requireModule('quotations', 'write'), validate(quotationResponseSchema), respondToQuotation);

export default router;
