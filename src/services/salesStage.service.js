import Enquiry from '../models/Enquiry.js';
import Sample from '../models/Sample.js';
import Quotation from '../models/Quotation.js';

/**
 * The sales stage (the enquiry's `status`) kept in step with the stage its tasks put it at
 * [config/enquiryStages.js]. While the enquiry is in the sales stages it mirrors the task stage —
 * back as well as forward — and says how far the stage's own work went:
 *
 *   Enquiry         New / Clarifying requirement (as it is), else Clarifying requirement
 *   Sample          Sample required until the latest sample has gone, then Sample feedback
 *   Pricing / Quote Pricing required until a quote has gone, then Quote submitted (or
 *                   marketing's Negotiation / Awaiting decision, kept)
 *   PO & SO         PO expected
 *
 * Past PO & SO the plant's stage is what the screens show [web: utils/salesStage.js]; the status
 * is left alone there — Won is still the SO uploaded's alone [handoff.service `moveStage`].
 * Won, Lost and On hold are never changed here.
 */

const SENT_SAMPLE = ['dispatched', 'delivered', 'customer_feedback_pending', 'approved', 'modification_required', 'rejected'];
const AFTER_QUOTE = ['quote_submitted', 'negotiation', 'customer_decision_pending'];
const LEFT_ALONE = ['won', 'lost', 'hold'];

/** The sales status the enquiry's stage calls for, or null when it already says it (or is left alone). */
export async function salesStatusFor(enquiry) {
  const status = enquiry.status;
  if (LEFT_ALONE.includes(status)) return null;
  let wanted = null;
  switch (enquiry.stage) {
    case 'enquiry':
      wanted = ['new', 'requirement_clarification'].includes(status) ? status : 'requirement_clarification';
      break;
    case 'sample': {
      const latest = await Sample.findOne({ enquiry: enquiry._id, status: { $ne: 'cancelled' } }).sort({ createdAt: -1 }).select('status dispatchedAt').lean();
      const sent = Boolean(latest && (SENT_SAMPLE.includes(latest.status) || latest.dispatchedAt));
      wanted = sent ? 'sample_feedback_pending' : 'sample_required';
      break;
    }
    case 'pricing_quote': {
      const sent = await Quotation.exists({ enquiry: enquiry._id, sentAt: { $ne: null } });
      if (!sent) wanted = 'pricing_required';
      else wanted = AFTER_QUOTE.includes(status) ? status : 'quote_submitted';
      break;
    }
    case 'po_so':
      wanted = 'po_expected';
      break;
    default:
      return null;
  }
  return wanted && wanted !== status ? wanted : null;
}

/**
 * Brings one enquiry's sales status in line with its stage, with the move in its history. Written
 * as a plain update — no status automation runs, the task that moved the stage already did the
 * work — and without touching updatedAt, like the stage move itself. `enquiry` in hand is updated too.
 */
export async function syncSalesStatus(enquiry, { by, note = 'Follows the task stage' } = {}) {
  const fresh = enquiry?.stage !== undefined && enquiry?.status !== undefined
    ? enquiry
    : await Enquiry.findById(enquiry?._id || enquiry).select('stage status').lean();
  if (!fresh) return null;
  const to = await salesStatusFor(fresh);
  if (!to) return null;
  await Enquiry.updateOne(
    { _id: fresh._id, status: fresh.status },
    { $set: { status: to }, $push: { statusHistory: { from: fresh.status, to, at: new Date(), by: by || undefined, note } } },
    { timestamps: false, keepVersion: true },
  );
  if (typeof enquiry?.unmarkModified === 'function') {
    enquiry.status = to;
    enquiry.unmarkModified('status');
  }
  return { from: fresh.status, to };
}

/** Every enquiry still in the sales stages, brought in line once at start [background.js]. Idempotent. */
export async function realignSalesStatuses() {
  const open = await Enquiry.find({ stage: { $in: ['enquiry', 'sample', 'pricing_quote', 'po_so'] }, status: { $nin: LEFT_ALONE } })
    .select('stage status').lean();
  let moved = 0;
  for (const enquiry of open) {
    if (await syncSalesStatus(enquiry, { note: 'Brought in line with the task stage' })) moved += 1;
  }
  return { moved };
}
