import Quotation, { CLOSED_QUOTATION_STATUSES } from '../models/Quotation.js';

/**
 * The quotation an enquiry is priced on — raised when the enquiry needs a price, by the
 * "Create Quotation" button or by its status reaching pricing required [subscribers/pricing].
 *
 * One open quotation per enquiry: an enquiry that goes back and forth through pricing must not
 * leave a drawer of half-built quotations behind it. It arrives with a line per model the
 * enquiry asks about and waits for the Quotation department to cost it.
 */
export async function ensureCostingFor(enquiry) {
  /*
   * Written before the look, so two requests in the same instant collide on the enquiry and the
   * second, retried, finds the first's quotation — rather than relying on the quote counter
   * happening to be written in the same transaction.
   */
  const { default: Enquiry } = await import('../models/Enquiry.js');
  await Enquiry.updateOne({ _id: enquiry._id }, { $set: { quotationAskedAt: new Date() } }, { timestamps: false });
  const existing = await Quotation.findOne({ enquiry: enquiry._id, status: { $nin: CLOSED_QUOTATION_STATUSES } });
  if (existing) return { quotation: existing, created: false };

  const { newQuotation } = await import('../controllers/quotation.controller.js');
  const quotation = await newQuotation({ enquiry: enquiry._id }, null, { system: true });
  return { quotation, created: true };
}
