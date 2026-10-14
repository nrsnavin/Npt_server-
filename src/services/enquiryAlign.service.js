import Enquiry from '../models/Enquiry.js';
import { CLOSED_STAGE } from '../config/enquiryStages.js';
import { STAGE_FOR_MARKETING, marketingStatusOf } from '../config/marketingStatuses.js';

/**
 * Brings the enquiries already on the books into line with their marketing status
 * [scripts/realign-enquiries.js] — the same rule the app now applies as it goes
 * [config/marketingStatuses.js STAGE_FOR_MARKETING]: an order status puts the enquiry at that
 * stage. A closed enquiry keeps its stage; a lost one stays lost. It never marks an enquiry Won —
 * only the sales order uploaded does [config/handoffs.js po_so].
 */

/** What would change on each enquiry: `{ id, number, marketing, stage: [from, to]?, status: [from, to]? }`. */
export async function planRealign() {
  const enquiries = await Enquiry.find({}).select('number stage status marketingStatus statusHistory').lean();
  const plan = [];
  for (const enquiry of enquiries) {
    const marketing = marketingStatusOf(enquiry);
    const change = { id: enquiry._id, number: enquiry.number, marketing };
    const stage = STAGE_FOR_MARKETING[marketing];
    if (stage && enquiry.stage !== CLOSED_STAGE && enquiry.stage !== stage) change.stage = [enquiry.stage, stage];
    if (change.stage || change.status) plan.push(change);
  }
  return plan;
}

/** Writes a plan, each move recorded in the enquiry's own history. */
export async function applyRealign(plan, { note = 'Realigned with the marketing status' } = {}) {
  const at = new Date();
  for (const change of plan) {
    const set = {};
    const push = {};
    if (change.stage) {
      set.stage = change.stage[1];
      push.stageHistory = { from: change.stage[0], to: change.stage[1], at, note };
    }
    if (change.status) {
      set.status = change.status[1];
      push.statusHistory = { from: change.status[0], to: change.status[1], at, note };
    }
    await Enquiry.updateOne({ _id: change.id }, { $set: set, $push: push }, { timestamps: false });
  }
  return { updated: plan.length };
}
