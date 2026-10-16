import Quotation, { CLOSED_QUOTATION_STATUSES } from '../models/Quotation.js';
import { resolveTasks } from './task.service.js';
import { EVENTS, publish } from './events.service.js';

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

/** The newest answered or withdrawn quotation on the enquiry — what the next one is costed from. */
export async function lastClosedQuotationFor(enquiryId) {
  if (!enquiryId) return null;
  return Quotation.findOne({ enquiry: enquiryId, status: { $in: CLOSED_QUOTATION_STATUSES } }).sort({ createdAt: -1 });
}

/** Every handover a quotation can have queued [subscribers/pricing, subscribers/quotation]. */
const QUOTATION_TASK_KINDS = (quotation) => [
  `pricing:${quotation._id}:approval`,
  `pricing:${quotation._id}:ready`,
  `quotation:${quotation._id}:follow-up`,
  `quotation:${quotation._id}:refused`,
  ...(quotation.lines || []).map((line) => `pricing:${quotation._id}:refused:${line._id}`),
];

/**
 * The enquiry is over — closed, or lost — and its quotation goes with it.
 *
 * One still being costed, waiting on Admin's signature or ready to send is **withdrawn**: the
 * plant pulled it, the buyer never answered, and the record says so rather than "rejected". Admin
 * is no longer asked to sign it, the Quotation department no longer sees it on the queue, and the
 * owner's "price ready" task is cleared. One the buyer already holds keeps its status — what was
 * offered is a fact — but nobody is asked to chase it any more.
 */
export async function withdrawQuotationsFor(enquiry, { note, by } = {}) {
  const open = await Quotation.find({ enquiry: enquiry._id, status: { $nin: CLOSED_QUOTATION_STATUSES } });
  const withdrawn = [];
  for (const quotation of open) {
    for (const key of QUOTATION_TASK_KINDS(quotation)) await resolveTasks(key);
    if (quotation.sentAt) continue;
    const from = quotation.status;
    quotation.status = 'withdrawn';
    quotation.statusHistory.push({ from, to: 'withdrawn', by: by?._id, note });
    quotation.respondedAt = new Date();
    await quotation.save();
    await publish(EVENTS.QUOTATION_WITHDRAWN, { quotation, by });
    withdrawn.push(quotation);
  }
  return withdrawn;
}
