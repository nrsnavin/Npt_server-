/**
 * Where an enquiry is, as the plant reads it: the twelve stages on its own screen, numbered as
 * the plant numbers them, and the department each one sits with.
 *
 * Not a ladder. An enquiry moves to whichever stage the last task sent it to — a mould issue in
 * the middle of production, a quality issue after dispatch — so the number is a label, not a
 * rule about order. `closed` is where "Task Closed" puts it.
 *
 * Separate from the enquiry's sales `status` (new → … → won / lost), which still drives the
 * sample, costing and order automation. The first four stages follow that status while it is
 * in them (see `stageForStatus`); after PO & SO the stage is moved only by department tasks.
 */
export const STAGES = [
  { key: 'enquiry', number: 1, label: 'Enquiry', department: 'marketing' },
  { key: 'sample', number: 2, label: 'Sample', department: 'sampling' },
  { key: 'pricing_quote', number: 3, label: 'Pricing / Quote', department: 'quotation' },
  { key: 'po_so', number: 4, label: 'PO & SO', department: 'order_confirmation' },
  { key: 'production_edd', number: 5, label: 'Production / EDD', department: 'production' },
  /* Not on the plant's original screen: Assembling's own stage, so its work is counted as its own. */
  { key: 'assembling', number: '5A', label: 'Assembling', department: 'assembling' },
  { key: 'mould', number: 6, label: 'Mould', department: 'production' },
  { key: 'team_payment_followup', number: 7, label: 'Team Payment Follow-up', department: 'accounts' },
  { key: 'invoice_dispatch', number: 8, label: 'Invoice & Dispatch', department: 'despatch' },
  { key: 'lr_copy', number: 9, label: 'LR Copy', department: 'despatch' },
  { key: 'quality', number: 10, label: 'Quality', department: 'quality' },
  { key: 'ac_clarify', number: 11, label: 'A/C Clarify', department: 'accounts' },
  { key: 'my_payment_followup', number: 12, label: 'My Payment Follow-up', department: 'marketing' },
];

export const CLOSED_STAGE = 'closed';

export const STAGE_KEYS = [...STAGES.map((stage) => stage.key), CLOSED_STAGE];

export const stageLabel = (key) =>
  key === CLOSED_STAGE ? 'Closed' : STAGES.find((stage) => stage.key === key)?.label || key;

/** The stages the sales status speaks for. Past these, only department tasks move the stage. */
const SALES_STAGES = ['enquiry', 'sample', 'pricing_quote', 'po_so'];

const FROM_STATUS = {
  new: 'enquiry',
  requirement_clarification: 'enquiry',
  sample_required: 'sample',
  sample_feedback_pending: 'sample',
  pricing_required: 'pricing_quote',
  quote_submitted: 'pricing_quote',
  negotiation: 'pricing_quote',
  customer_decision_pending: 'pricing_quote',
  po_expected: 'po_so',
  won: 'po_so',
};

/**
 * The stage a change of sales status implies, or null to leave it alone: only while the
 * enquiry is still in the sales stages, so a requote never drags a job back out of production.
 */
export function stageForStatus(status, currentStage) {
  const next = FROM_STATUS[status];
  if (!next) return null;
  if (currentStage && !SALES_STAGES.includes(currentStage)) return null;
  return next;
}
