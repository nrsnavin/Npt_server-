import Enquiry from '../models/Enquiry.js';
import SalesOrder from '../models/SalesOrder.js';
import Todo from '../models/Todo.js';
import { CLOSED_STAGE } from '../config/enquiryStages.js';
import { HANDOFFS } from '../config/handoffs.js';

/**
 * Undoing what the earlier rules did to enquiries on their own [scripts/reopen-lr-closed.js].
 *
 * Before October 2026 an LR uploaded closed the enquiry, and several automatic moves (the LR,
 * Production asked, a marketing status picked by hand, the realign script) marked it Won. Now an
 * LR closes nothing — a person closes it — and only the sales order uploaded marks an order Won
 * [config/handoffs.js po_so]. This finds the enquiries the old rules moved and puts them back:
 *
 *   closed by an LR    the close was the system's own Task Closed, raised by an LR upload — not a
 *                      person's, and not "paid in full". Reopened at the stage it was closed from.
 *   Won without an SO  Won by one of those automatic moves, with no sales order on record. Put
 *                      back to the sales stage it had. A Won a person set on the sales stage
 *                      itself, or one with a sales order behind it, is left alone.
 *
 * Tasks the automatic close completed stay completed: raise again whatever is still needed.
 */

/* What the automatic moves wrote as the reason: a task's own title, the hand-set status, the realign. */
const SO_LABEL = HANDOFFS.find((handoff) => handoff.key === 'po_so')?.label;
const AUTOMATIC = [
  /^Marketing status: /,
  /^Realigned with the marketing status/,
  ...HANDOFFS.filter((handoff) => handoff.label !== SO_LABEL).map((handoff) => new RegExp(`^${handoff.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)),
];
const isAutomatic = (note) => AUTOMATIC.some((pattern) => pattern.test(String(note || '')));
const LR_LABEL = HANDOFFS.find((handoff) => handoff.key === 'lr_copy')?.label || 'LR Copy';

/** What would change: `[{ id, number, stage?: [from, to], status?: [from, to], why }]`. */
export async function planLrReopen() {
  const enquiries = await Enquiry.find({ $or: [{ stage: CLOSED_STAGE }, { status: 'won' }] })
    .select('number stage status stageHistory statusHistory')
    .lean();
  if (!enquiries.length) return [];
  const ids = enquiries.map((row) => row._id);

  const [orders, closers, lrs] = await Promise.all([
    SalesOrder.distinct('enquiry', { enquiry: { $in: ids } }),
    Todo.find({ enquiry: { $in: ids }, kind: 'task_closed', system: true }).select('_id enquiry notes').lean(),
    Todo.distinct('enquiry', { enquiry: { $in: ids }, kind: 'lr_copy', resultFile: { $exists: true } }),
  ]);
  const withOrder = new Set(orders.map(String));
  const withLr = new Set(lrs.map(String));
  const systemClose = new Map(closers.map((row) => [String(row._id), row]));

  const plan = [];
  for (const enquiry of enquiries) {
    const change = { id: enquiry._id, number: enquiry.number, why: [] };

    if (enquiry.stage === CLOSED_STAGE) {
      const closing = [...(enquiry.stageHistory || [])].reverse().find((entry) => entry.to === CLOSED_STAGE);
      const closer = closing?.task && systemClose.get(String(closing.task));
      const paidInFull = /^Paid in full/.test(String(closer?.notes || closing?.note || ''));
      if (closer && !paidInFull && withLr.has(String(enquiry._id))) {
        const back = closing.from && closing.from !== CLOSED_STAGE ? closing.from : 'lr_copy';
        change.stage = [CLOSED_STAGE, back];
        change.why.push(`closed by the ${LR_LABEL} upload`);
      }
    }

    if (enquiry.status === 'won' && !withOrder.has(String(enquiry._id))) {
      const winning = [...(enquiry.statusHistory || [])].reverse().find((entry) => entry.to === 'won');
      if (winning && isAutomatic(winning.note)) {
        const back = winning.from && winning.from !== 'won' ? winning.from : 'po_expected';
        change.status = ['won', back];
        change.why.push(`Won by "${String(winning.note).slice(0, 60)}" with no sales order`);
      }
    }

    if (change.stage || change.status) plan.push(change);
  }
  return plan;
}

/** Writes a plan, each move recorded in the enquiry's own history. */
export async function applyLrReopen(plan, { note = 'Reopened — moved by an automatic rule the app no longer has' } = {}) {
  const at = new Date();
  let updated = 0;
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
    /* Only if it is still as planned: an enquiry a person moved meanwhile is left as they left it. */
    const still = {
      _id: change.id,
      ...(change.stage ? { stage: change.stage[0] } : {}),
      ...(change.status ? { status: change.status[0] } : {}),
    };
    const result = await Enquiry.updateOne(still, { $set: set, $push: push }, { timestamps: false });
    updated += result.modifiedCount;
  }
  return { updated };
}
