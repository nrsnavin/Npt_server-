import { FOLLOW_UP_STATUSES } from './paymentFollowUp.js';

/**
 * The form each department task opens with, when somebody clicks a department on an enquiry
 * [web: components/DepartmentTaskDialog.jsx, services/handoff.service.js].
 *
 * THE LIST TO EDIT. One entry per button in config/handoffs.js; a button without one asks only
 * for the common fields. Every form also has, unless it says otherwise:
 *   priority       Low / Normal / High                       (`priority: false` to leave out)
 *   required date  the task's due date, never in the past     (`requiredDate: false`)
 *   attach PDF     optional, 1 MB at most
 *   instruction    the note to the department, with `note` as its label and placeholder
 *
 * Each question in `asks`:
 *   key, label     how it is stored on the task (its brief) and what the form says
 *   type           text · number · date · choice (with `options`) · check · items · info · kind
 *                  `items` is a table of rows (`columns`, each a question of its own);
 *                  `info` is shown, never asked; `kind` switches between two buttons
 *                  (My / Team Payment Follow-up) and is not stored
 *   required       must be answered (a person raising it; the automations are not asked)
 *   from           where the answer is filled from — a path into the enquiry's prefill
 *                  [handoff.service `taskPrefill`]: customer.contactPerson, models, materials,
 *                  quantity, order.paymentTerms, items (rows), modelList (choices) …
 *   optionsFrom    a choice whose options come from the prefill (the enquiry's own models)
 *   section        a heading drawn before the question
 *
 * `team` names the department in the form's Workflow / Department list; `option` makes two
 * buttons one entry there (the follow-up owner then picks between them).
 */

const PRIORITY_DEFAULTS = { priority: true, requiredDate: true };

const modelAndQuantity = [
  { key: 'model', label: 'Model name', type: 'choice', optionsFrom: 'modelList', placeholder: 'Select model only if required' },
  { key: 'quantity', label: 'Quantity', type: 'number', from: 'quantity', placeholder: 'Example: 10,000 pcs' },
];

/** The rows of a sample request: each model with its parts, the colour rule and how many. */
const SAMPLE_COLUMNS = [
  { key: 'model', label: 'Mould / model', required: true },
  { key: 'material', label: 'Material' },
  { key: 'colour', label: 'Colour' },
  { key: 'hook', label: 'Hook' },
  { key: 'clip', label: 'Clip' },
  { key: 'print', label: 'Print' },
  { key: 'colourType', label: 'Colour is', type: 'choice', options: ['Preferred colour', 'Compulsory colour'] },
  { key: 'quantity', label: 'Pcs', type: 'number' },
];

const PAYMENT_TERMS = [
  'Credit — nothing before dispatch', '100% advance', '50% advance, 50% against delivery',
  '50% advance, 50% before dispatch', '30% advance, 70% before dispatch', '100% against dispatch',
];

const paymentFollowUp = {
  title: 'Payment Follow-up Tracker',
  submit: 'Save Follow-up',
  team: 'Payment Follow-up',
  option: 'team_payment_followup',
  priority: false,
  requiredDate: false,
  /* Due on the day the buyer asked to be called, when they said one. */
  dueFrom: 'callOn',
  note: { label: 'Follow-up note', placeholder: 'Payment discussion or follow-up note' },
  asks: [
    { key: 'contact', label: 'Contact person / WhatsApp', from: 'customer.whatsapp' },
    {
      key: 'status', label: 'Follow-up status', type: 'choice',
      options: FOLLOW_UP_STATUSES.map((status) => (status.key === 'tpcf' ? 'TPCF — To Be Closed Follow-up' : status.label)),
    },
    {
      key: 'owner', label: 'Follow-up owner', type: 'kind',
      options: [
        { kind: 'my_payment_followup', label: 'My Payment Follow-up — Marketing person' },
        { kind: 'team_payment_followup', label: 'Team Payment Follow-up — Payment Collection' },
      ],
    },
    { key: 'commitment', label: 'Commitment period', type: 'choice', options: ['This Week', 'Next Week', 'This Month', 'Next Month'] },
    { key: 'callOn', label: 'Customer asked to call on', type: 'date' },
    { key: 'promisedDate', label: 'Promised payment date', type: 'date' },
    { key: 'vigorous', label: 'Vigorous follow-up required', type: 'check' },
  ],
};

export const TASK_FORMS = {
  sample_request: {
    team: 'Sampling Team',
    note: { label: 'Additional instruction / Question', placeholder: 'Required when any sample quantity is more than 3 pcs' },
    /* More than three pieces of a sample is a cost somebody should explain. */
    noteRequired: { items: 'items', column: 'quantity', above: 3, message: 'Say why more than 3 pcs are needed' },
    asks: [
      {
        key: 'items', label: 'Sample models & colour instruction', type: 'items', required: true,
        from: 'items', add: '+ Add Model', columns: SAMPLE_COLUMNS,
      },
    ],
  },
  create_quotation: {
    team: 'Quotation Team',
    note: { label: 'Additional instruction / Question', placeholder: 'Target price, packing or anything the costing should know' },
    asks: [
      { key: 'models', label: 'Hanger model(s)', from: 'models' },
      { key: 'material', label: 'Material / colour / quality', from: 'materials' },
      { key: 'quantity', label: 'Quantity', type: 'number', from: 'quantity' },
      { key: 'targetPrice', label: 'Buyer’s target price (₹ per piece)', type: 'number', from: 'targetPrice' },
    ],
  },
  price_negotiation: {
    team: 'Quotation Team',
    note: { label: 'Additional instruction / Question', placeholder: 'What the buyer said about the price' },
    asks: [
      { key: 'models', label: 'Hanger model(s)', from: 'models' },
      { key: 'targetPrice', label: 'Buyer’s target price (₹ per piece)', type: 'number', from: 'targetPrice' },
    ],
  },
  po_so: {
    team: 'SO Team',
    note: { label: 'Additional instruction / Question', placeholder: 'Prepare and send Sales Order to this company' },
    asks: [
      { key: 'contactPerson', label: 'Contact person', section: 'Company & contact details', from: 'customer.contactPerson', placeholder: 'Name of person to call for SO / GST' },
      { key: 'mobile', label: 'Mobile number', from: 'customer.mobile' },
      { key: 'models', label: 'Hanger model(s)', section: 'Sales order details', from: 'models' },
      { key: 'material', label: 'Material / colour / quality', from: 'materials', placeholder: 'Material from enquiry; editable' },
      { key: 'quantity', label: 'Order quantity', type: 'number', from: 'quantity', placeholder: 'Quantity from enquiry; editable' },
      { key: 'paymentTerms', label: 'Payment terms', type: 'choice', options: PAYMENT_TERMS, from: 'order.paymentTerms', placeholder: 'Select payment terms' },
    ],
  },
  ask_edd: { team: 'Production Team', asks: modelAndQuantity },
  ask_assembling_edd: { team: 'Assembly Team', asks: modelAndQuantity },
  mould_issue: {
    team: 'Mould Team',
    asks: [
      { key: 'model', label: 'Model / mould', type: 'choice', optionsFrom: 'modelList', placeholder: 'Select the model' },
      { key: 'problem', label: 'What is wrong with the tool', required: true },
    ],
  },
  quality_check: { team: 'Quality Team', asks: modelAndQuantity },
  quality_issue: {
    team: 'Quality Team',
    asks: [...modelAndQuantity, { key: 'problem', label: 'The problem', required: true }],
  },
  invoice_dispatch: {
    title: 'Send Dispatch Request',
    submit: 'Send to Dispatch Team',
    team: 'Dispatch Team',
    priority: false,
    note: { label: 'Dispatch instruction / vehicle details', placeholder: 'Transport, delivery point or special dispatch instruction' },
    asks: [
      ...modelAndQuantity,
      { key: 'schedule', label: 'Dispatch schedule', type: 'choice', options: ['Today Dispatch', 'Tomorrow Dispatch', 'This Week', 'On the required date'] },
      { key: 'booking', label: 'Booking / Collection', type: 'choice', options: ['Normal Booking', 'Door Delivery', 'Customer Collection', 'Courier'] },
      { key: 'piNumber', label: 'PI Number', placeholder: 'Enter PI number' },
      { key: 'delivery', label: 'Delivery contact & vehicle route', type: 'info', from: 'customer.delivery' },
    ],
  },
  lr_copy: {
    team: 'Dispatch Team — LR Copy',
    asks: [{ key: 'invoiceNumber', label: 'Invoice number', from: 'order.invoiceNumber' }],
  },
  team_payment_followup: paymentFollowUp,
  my_payment_followup: paymentFollowUp,
  gst_invoice_audit: { team: 'Audit Team', asks: [{ key: 'invoiceNumber', label: 'Invoice number', from: 'order.invoiceNumber' }] },
  ac_clarify: { team: 'Accounts Team' },
  request_prt_visit: { team: 'Admin', asks: [{ key: 'visitDate', label: 'Visit date', type: 'date' }] },
};

/** A button's form, with the common fields' defaults. */
export const formFor = (key) => ({ ...PRIORITY_DEFAULTS, ...(TASK_FORMS[key] || {}) });
