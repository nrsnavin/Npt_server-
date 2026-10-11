/**
 * Where the conversation with the buyer stands, in marketing's own words — the "Current
 * Marketing Status" on every enquiry.
 *
 * THE LIST TO EDIT. Order matters: it is the order the dropdown shows, and the automation only
 * ever moves an enquiry *forward* along it.
 *
 * Separate from the enquiry's sales `status` (new → … → won / lost), which drives the sample,
 * quotation and order automation. The two are tied in three ways:
 *
 *   - `salesMove`: choosing this marketing status also moves the sales status there, which is
 *     what raises the sample request or opens the quotation. Only forward, never back.
 *   - `FROM_SALES_STATUS`: when the sales status moves (by hand or by automation — a sample
 *     dispatched, a quote sent, an order booked), the marketing status follows if that is
 *     forward of where it is.
 *   - the same table answers for an enquiry that has never had a marketing status set.
 */
export const MARKETING_STATUSES = [
  { key: 'enquiry_received', label: 'Enquiry received' },
  { key: 'photos_to_send', label: 'Photos to send' },
  { key: 'photos_sent', label: 'Photos sent' },
  { key: 'model_selection_requested', label: 'Model selection requested' },
  { key: 'sample_requested', label: 'Sample requested', salesMove: 'sample_required' },
  { key: 'sample_sent', label: 'Sample sent' },
  { key: 'quotation_preparing', label: 'Quotation preparing', salesMove: 'pricing_required' },
  { key: 'quotation_sent', label: 'Quotation sent' },
  { key: 'pricing_discussion', label: 'Pricing discussion' },
  { key: 'price_approved', label: 'Price approved' },
  { key: 'po_awaiting', label: 'PO awaiting' },
  { key: 'po_received', label: 'PO received' },
  { key: 'sales_order_sent', label: 'Sales order sent' },
  /* With the plant — followed from the department asked (`FROM_STAGE`), or chosen by hand. */
  { key: 'production', label: 'Production' },
  { key: 'mould', label: 'Mould' },
  { key: 'assembling', label: 'Assembling' },
  { key: 'qc', label: 'QC' },
  { key: 'dispatch', label: 'Dispatch' },
  { key: 'lr_copy', label: 'LR Copy' },
  { key: 'task_closed', label: 'Task Closed' },
];

export const MARKETING_STATUS_KEYS = MARKETING_STATUSES.map((entry) => entry.key);

export const marketingStatusLabel = (key) =>
  MARKETING_STATUSES.find((entry) => entry.key === key)?.label || key;

export const marketingRank = (key) => MARKETING_STATUS_KEYS.indexOf(key);

/** What a sales status means in marketing's words. `hold` says nothing, so it is absent. */
export const FROM_SALES_STATUS = {
  new: 'enquiry_received',
  requirement_clarification: 'enquiry_received',
  sample_required: 'sample_requested',
  sample_feedback_pending: 'sample_sent',
  pricing_required: 'quotation_preparing',
  quote_submitted: 'quotation_sent',
  negotiation: 'pricing_discussion',
  customer_decision_pending: 'pricing_discussion',
  po_expected: 'po_awaiting',
  won: 'po_received',
  lost: 'task_closed',
};

/**
 * The department task raised, in marketing's words [services/handoff.service `moveStage`]. The
 * sales ones only ever move the marketing status forward, as the sales status does. The plant's
 * six follow whichever task was raised last, in any order — a mould raised during production
 * reads Mould — but never pull an enquiry back out of Task Closed or into the sales ones.
 */
export const FROM_TASK = {
  sample_request: 'sample_requested',
  create_quotation: 'quotation_preparing',
  price_negotiation: 'pricing_discussion',
  po_so: 'po_received',
  ask_edd: 'production',
  mould_issue: 'mould',
  ask_assembling_edd: 'assembling',
  quality_check: 'qc',
  invoice_dispatch: 'dispatch',
  lr_copy: 'lr_copy',
};
export const PLANT_STATUSES = ['production', 'mould', 'assembling', 'qc', 'dispatch', 'lr_copy'];

/** The marketing status a task raised moves the enquiry to, or null when it stays. */
export function followTask(kind, current) {
  const follows = FROM_TASK[kind];
  if (!follows || follows === current) return null;
  if (marketingRank(follows) > marketingRank(current)) return follows;
  /* Back and forth inside the plant's six, by whichever department was asked last. */
  if (PLANT_STATUSES.includes(follows) && PLANT_STATUSES.includes(current)) return follows;
  return null;
}

/** The sales statuses that read as one of these marketing statuses, for a list filter. */
export const salesStatusesFor = (keys) =>
  Object.entries(FROM_SALES_STATUS).filter(([, key]) => keys.includes(key)).map(([status]) => status);

/** The enquiry's marketing status: the one set, or what its sales status says. */
export const marketingStatusOf = (enquiry) =>
  enquiry?.marketingStatus || FROM_SALES_STATUS[enquiry?.status] || 'enquiry_received';
