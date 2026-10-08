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
  const existing = await Quotation.findOne({ enquiry: enquiry._id, status: { $nin: CLOSED_QUOTATION_STATUSES } });
  if (existing) return { quotation: existing, created: false };

  const { newQuotation } = await import('../controllers/quotation.controller.js');
  const quotation = await newQuotation({ enquiry: enquiry._id }, null, { system: true });
  return { quotation, created: true };
}
