/**
 * The buttons on an enquiry that send work to a department — the plant's own list, in the
 * plant's own order (the enquiry screen it already uses).
 *
 * Each one:
 *   department   whose queue the task lands on; anyone in it may pick it up. `owner` is the
 *                marketing person who holds the enquiry, personally — "My" payment follow-up.
 *                Null for a button that records something rather than asking anybody.
 *   stage        where the enquiry is once it is sent [config/enquiryStages.js]; null leaves it.
 *                A button with both a department and a stage *moves* the enquiry: that
 *                department now holds it, and the one that had it is done with it. A button
 *                with a department and no stage is a side request — the enquiry stays put.
 *   hidden       not offered as a button (the task every new enquiry starts with).
 *   records      what the department fills in when it is done, beside the note — all optional,
 *                because the note is what is required and these are the details worth keeping.
 *                `type` is `date`, `choice` (with `options`) or plain text.
 *   opens        the screen where the work itself is done, when there is one.
 *
 * These are a first reading of the role requirements (7 Oct 2026); what each department records
 * is meant to be corrected here as the departments say what they need.
 */
export const HANDOFFS = [
  {
    key: 'photos_sent', label: 'Photos Sent', department: null, stage: null,
    hint: 'Record that sample photos went to the buyer',
  },
  {
    key: 'create_quotation', label: 'Create Quotation', department: 'quotation', stage: 'pricing_quote',
    hint: 'Cost the model and send back the quotation',
    records: [{ key: 'quotationNumber', label: 'Quotation number' }, { key: 'price', label: 'Price per piece (₹)' }],
    opens: 'quotations',
  },
  {
    key: 'sample_request', label: 'Sample Request', department: 'sampling', stage: 'sample',
    hint: 'Make the sample and send it out',
    records: [
      { key: 'courier', label: 'Courier' },
      { key: 'awbNumber', label: 'AWB number' },
      { key: 'pieces', label: 'Pieces sent' },
    ],
    opens: 'samples',
  },
  {
    key: 'price_negotiation', label: 'Price Negotiation', department: 'quotation', stage: 'pricing_quote',
    hint: 'The buyer is asking for a better price',
    records: [{ key: 'price', label: 'Revised price per piece (₹)' }],
    opens: 'quotations',
  },
  {
    key: 'po_so', label: 'PO & SO', department: 'order_confirmation', stage: 'po_so',
    hint: 'The buyer’s PO is in — raise and send the sales order',
    records: [{ key: 'poNumber', label: 'Customer PO number' }, { key: 'soNumber', label: 'Sales order number' }],
    opens: 'orders',
  },
  {
    key: 'ask_edd', label: 'Ask EDD', department: 'production', stage: 'production_edd',
    hint: 'When will production finish?',
    records: [{ key: 'edd', label: 'Expected date', type: 'date' }, { key: 'pending', label: 'Pending quantity' }],
  },
  {
    key: 'ask_assembling_edd', label: 'Ask Assembly EDD', department: 'assembling', stage: 'assembling',
    hint: 'When will assembly finish?',
    records: [{ key: 'edd', label: 'Expected date', type: 'date' }, { key: 'pending', label: 'Pending quantity' }],
  },
  {
    key: 'mould_issue', label: 'Mould Issue', department: 'production', stage: 'mould',
    hint: 'Something is wrong with the mould',
    records: [{ key: 'readyBy', label: 'Fixed by', type: 'date' }],
  },
  {
    key: 'team_payment_followup', label: 'Team Payment Follow-up', department: 'payment_collection', stage: null,
    /*
     * A side request, not a move: Payment Collection chases the money while Production or
     * Dispatch keeps the enquiry — two departments at once on one job, which a stage move
     * cannot express.
     */
    hint: 'Payment Collection to chase the payment',
    records: [
      { key: 'paymentStatus', label: 'Payment status' },
      { key: 'commitmentDate', label: 'Commitment date', type: 'date' },
    ],
  },
  {
    key: 'invoice_dispatch', label: 'Invoice & Dispatch', department: 'despatch', stage: 'invoice_dispatch',
    hint: 'Invoice the goods and send them out',
    records: [
      { key: 'invoiceNumber', label: 'Invoice number' },
      { key: 'quantitySent', label: 'Quantity sent' },
      { key: 'transporter', label: 'Transporter / courier' },
    ],
    opens: 'dispatches',
  },
  {
    key: 'lr_copy', label: 'LR Copy', department: 'despatch', stage: 'lr_copy',
    hint: 'Send the LR / docket copy',
    records: [{ key: 'lrNumber', label: 'LR / docket number' }],
  },
  {
    /*
     * The check before goods go. Invoice & Dispatch is refused until Quality has passed the job
     * here (or by a final inspection in the Quality module) [services/handoff.service.js].
     */
    key: 'quality_check', label: 'Quality Check', department: 'quality', stage: 'quality',
    hint: 'Check the goods before they are invoiced and sent',
    records: [
      { key: 'result', label: 'Result', type: 'choice', options: ['Passed', 'Failed'] },
      { key: 'passedQty', label: 'Passed quantity' },
      { key: 'correction', label: 'Correction needed' },
    ],
  },
  {
    key: 'quality_issue', label: 'Quality Issue', department: 'quality', stage: 'quality',
    hint: 'Check a quality problem',
    records: [{ key: 'result', label: 'Finding' }, { key: 'correction', label: 'Correction needed' }],
  },
  {
    key: 'gst_invoice_audit', label: 'GST / Invoice Audit', department: 'audit', stage: 'audit',
    hint: 'The Audit team checks the GST or the invoice',
    records: [
      { key: 'result', label: 'Result', type: 'choice', options: ['Correct', 'Correction needed'] },
      { key: 'correction', label: 'What to correct' },
    ],
  },
  {
    key: 'ac_clarify', label: 'A/C Clarify', department: 'accounts', stage: 'ac_clarify',
    hint: 'Accounts to clarify the account',
  },
  {
    key: 'request_prt_visit', label: 'Request PRT Visit', department: 'management', stage: null,
    hint: 'Ask for a visit',
    records: [{ key: 'visitDate', label: 'Visit date', type: 'date' }],
  },
  {
    key: 'my_payment_followup', label: 'My Payment Follow-up', department: 'owner', stage: 'my_payment_followup',
    hint: 'A payment reminder for whoever holds the enquiry',
    records: [{ key: 'promisedDate', label: 'Promised payment date', type: 'date' }],
  },
  {
    key: 'back_to_marketing', label: 'Back to Marketing', department: 'owner', stage: 'enquiry',
    hint: 'Hand it back to the marketing person who holds the buyer',
  },
  {
    key: 'new_enquiry', label: 'New enquiry', department: 'owner', stage: 'enquiry', hidden: true,
    hint: 'Follow up with the buyer and send it on',
  },
  {
    key: 'task_closed', label: 'Task Closed', department: null, stage: 'closed',
    hint: 'Everything on this enquiry is done',
  },
];

export const HANDOFF_KEYS = HANDOFFS.map((handoff) => handoff.key);
export const findHandoff = (key) => HANDOFFS.find((handoff) => handoff.key === key);

/** Moves the enquiry: a department takes it over at a stage. */
export const movesEnquiry = (handoff) => Boolean(handoff?.department && handoff?.stage && handoff.stage !== 'closed');

/** The buttons a department may move an enquiry on with — what "where next" offers. */
export const NEXT_STEPS = HANDOFFS.filter((handoff) => movesEnquiry(handoff) && !handoff.hidden);

/**
 * The task an enquiry already at a stage is held under, for enquiries that got there before
 * there were holding tasks (and for the status changes that move it): the stage's own button.
 */
export const KIND_FOR_STAGE = {
  enquiry: 'new_enquiry',
  sample: 'sample_request',
  pricing_quote: 'create_quotation',
  po_so: 'po_so',
  production_edd: 'ask_edd',
  assembling: 'ask_assembling_edd',
  mould: 'mould_issue',
  team_payment_followup: 'team_payment_followup',
  invoice_dispatch: 'invoice_dispatch',
  lr_copy: 'lr_copy',
  quality: 'quality_issue',
  ac_clarify: 'ac_clarify',
  audit: 'gst_invoice_audit',
  my_payment_followup: 'my_payment_followup',
};
