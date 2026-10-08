import { Router } from 'express';
import {
  listQuotations, getQuotation, createQuotation, updateQuotation, costLine, decideLine,
  reviseQuotation, sendQuotation, respondToQuotation, quotationPdf, sendPreview,
} from '../controllers/quotation.controller.js';
import { authenticate, authorize, requireModule } from '../middleware/auth.js';
import { getQuoteNumbering, setQuoteNumbering } from '../controllers/quoteNumbering.controller.js';
import { validate } from '../middleware/validate.js';
import {
  quotationCostSchema, quotationDecisionSchema, quotationSchema, quotationUpdateSchema, quotationRevisionSchema,
  quotationSendSchema, quotationResponseSchema, quoteNumberingSchema,
} from '../validators/pricing.schemas.js';

const router = Router();

router.use(authenticate);

/*
 * Phase 3 [§39]: pricing and quoting — one module, three levels.
 *
 * The grants here are coarser than the rules inside the module, on purpose. `pricing: quote` is
 * what marketing holds — enough to open a costing, see the price they may quote, and raise the
 * document — while §8's field split decides what actually comes back and `assertMayCost`
 * decides who may build the sheet. A route-level grant cannot express "you may see this record
 * but not four of its fields", so it does not try.
 *
 * Which is why the costing routes below ask only for `read` at the door and check again inside:
 * the door cannot tell a costing clerk from a marketing person opening the same sheet.
 */

router.get('/quotations', requireModule('pricing'), listQuotations);
/* Where the quote sequence stands; only an administrator moves it. Before `/quotations/:id`. */
router.get('/quotations/numbering', requireModule('pricing'), getQuoteNumbering);
router.put('/quotations/numbering', authorize('admin'), validate(quoteNumberingSchema), setQuoteNumbering);
router.post('/quotations', requireModule('pricing', 'quote'), validate(quotationSchema), createQuotation);
router.get('/quotations/:id', requireModule('pricing'), getQuotation);
/** The document the customer receives, rendered from the record on demand. */
router.get('/quotations/:id/pdf', requireModule('pricing'), quotationPdf);
router.get('/quotations/:id/send-preview', requireModule('pricing', 'quote'), sendPreview);
router.patch('/quotations/:id', requireModule('pricing', 'quote'), validate(quotationUpdateSchema), updateQuotation);
/*
 * Costing a line, and Admin's sign-off on a price under its minimum [§7, §9]. Read at the door;
 * the controller checks `pricing: write` (costing) and Admin (sign-off) inside, because the door
 * cannot tell a costing clerk from a marketing person opening the same quotation.
 */
router.patch('/quotations/:id/lines/:lineId/cost', requireModule('pricing'), validate(quotationCostSchema), costLine);
router.post('/quotations/:id/lines/:lineId/decision', requireModule('pricing'), validate(quotationDecisionSchema), decideLine);
/** A new price keeps the old one [§10]. */
router.post('/quotations/:id/revisions', requireModule('pricing', 'quote'), validate(quotationRevisionSchema), reviseQuotation);
/** Putting it in front of the customer — the moment §9's gate applies. */
router.post('/quotations/:id/send', requireModule('pricing', 'quote'), validate(quotationSendSchema), sendQuotation);
router.post('/quotations/:id/response', requireModule('pricing', 'quote'), validate(quotationResponseSchema), respondToQuotation);

export default router;
