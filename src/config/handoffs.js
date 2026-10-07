/**
 * The buttons on an enquiry that send work to a department — the plant's own list, in the
 * plant's own order (the enquiry screen it already uses).
 *
 * Each one:
 *   department   whose queue the task lands on; anyone in it may pick it up. `owner` is the
 *                marketing person who holds the enquiry, personally — "My" payment follow-up.
 *                Null for a button that records something rather than asking anybody.
 *   stage        where the enquiry is once it is sent [config/enquiryStages.js]; null leaves it.
 *   records      what the department fills in when it is done, beside the note — all optional,
 *                because the note is what is required and these are the details worth keeping.
 *   opens        the screen where the work itself is done, when there is one.
 *
 * These are a first reading of the role requirements (7 Oct 2026); what each department records
 * is meant to be corrected here as the departments say what they need.
 */
export const HANDOFFS = [
  {
    key: 'photos_sent', label: 'Photos Sent', department: null, stage: 'sample',
    hint: 'Record that sample photos went to the buyer',
  },
  {
    key: 'create_quotation', label: 'Create Quotation', department: 'quotation', stage: 'pricing_quote',
    hint: 'Cost the model and send back the quotation',
    records: [{ key: 'quotationNumber', label: 'Quotation number' }, { key: 'price', label: 'Price per piece (₹)' }],
    opens: 'pricings',
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
    opens: 'pricings',
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
    key: 'ask_assembling_edd', label: 'Ask Assembling EDD', department: 'assembling', stage: 'production_edd',
    hint: 'When will assembling finish?',
    records: [{ key: 'edd', label: 'Expected date', type: 'date' }, { key: 'pending', label: 'Pending quantity' }],
  },
  {
    key: 'mould_issue', label: 'Mould Issue', department: 'production', stage: 'mould',
    hint: 'Something is wrong with the mould',
    records: [{ key: 'readyBy', label: 'Fixed by', type: 'date' }],
  },
  {
    key: 'team_payment_followup', label: 'Team Payment Follow-up', department: 'accounts', stage: 'team_payment_followup',
    hint: 'Accounts to chase the payment',
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
    key: 'quality_issue', label: 'Quality Issue', department: 'quality', stage: 'quality',
    hint: 'Check a quality problem',
    records: [{ key: 'result', label: 'Finding' }, { key: 'correction', label: 'Correction needed' }],
  },
  {
    key: 'gst_invoice_audit', label: 'GST / Invoice Audit', department: 'accounts', stage: 'ac_clarify',
    hint: 'Check the GST or the invoice',
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
    key: 'task_closed', label: 'Task Closed', department: null, stage: 'closed',
    hint: 'Everything on this enquiry is done',
  },
];

export const HANDOFF_KEYS = HANDOFFS.map((handoff) => handoff.key);
export const findHandoff = (key) => HANDOFFS.find((handoff) => handoff.key === key);
