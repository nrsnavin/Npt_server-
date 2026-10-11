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
 *                  `info` is shown, never asked; `member` picks a person of `department`
 *                  (the task becomes theirs by name); `kind` switches between two buttons
 *                  (My / Team Payment Follow-up) and is not stored
 *   required       must be answered (a person raising it; the automations are not asked)
 *   from           where the answer is filled from — a path into the enquiry's prefill
 *                  [handoff.service `taskPrefill`]: customer.contactPerson, models, materials,
 *                  quantity, order.paymentTerms, items (rows), modelList (choices), modelList.0
 *                  (the first model) …
 *   optionsFrom    a choice whose options come from the prefill (the enquiry's own models)
 *   register       a list from a register — moulds, materials, hooks, clips, prints — offered
 *                  as a dropdown when there is no enquiry to fill it from (a team task)
 *   section        a heading drawn before the question
 *
 * `team` names the department in the form's Workflow / Department list; `option` makes two
 * buttons one entry there (the follow-up owner then picks between them).
 *
 * `statuses` is the department's own workflow on the task — the Status update list on its
 * dashboard, first one where a new task starts [handoff.service `setTaskStatus`]. Each may say:
 *   comment    a comment is needed to choose it
 *   raises     a task it raises for the enquiry's marketing person, with the comment — their
 *              reply comes back onto this task and the status returns to where it was
 *   pdf        it is reached only by uploading the PDF of the work (the sales order)
 *   sent       it is reached when the uploaded work has gone to the customer (`sendResult`)
 *   done       reaching it finishes the task
 *   next       the department task raised once it is reached (the enquiry moves on to it) —
 *              Dispatched raises Reception's LR copy; SO Prepared raises Production's EDD
 *   issue      while the task is at it, the enquiry shows it as an issue (marketing's list)
 *   date       `required` — a ready date must be given with it; `tomorrow` — it is tomorrow
 *              unless another is given. Any other status takes the date if one is given.
 * With the statuses, a form may say:
 *   remarkRequired  every move along them needs a remark (`remark` labels the box)
 *   statusDate      a ready date may go with a move (`label`); `field` says what it is on the
 *                   enquiry — `edd` (Production's) or `erd` (the mould's ready date)
 *   notifyStatus    every move is shown to the enquiry's marketing person and every Admin,
 *                   under "Needs your action" [models/TaskNotice.js]
 *   actions         buttons on the task that raise another department's task on the enquiry
 *                   (Dispatch's Ask Production) — `kind`, `label`, and the `status` it moves to
 * A question marked `editable` may be corrected by the department working the task (`editLabel`
 * names the button — "Edit dispatch details").
 */

const PRIORITY_DEFAULTS = { priority: true, requiredDate: true };

/* The enquiry's first model, its material and colour, and the order's quantity — all editable. */
const modelAndQuantity = [
  { key: 'model', label: 'Model name', type: 'choice', optionsFrom: 'modelList', from: 'modelList.0', register: 'moulds', placeholder: 'Select model only if required' },
  { key: 'material', label: 'Material / colour', from: 'materials', register: 'materials', placeholder: 'Material and colour from the enquiry' },
  { key: 'quantity', label: 'Quantity', type: 'number', from: 'quantity', placeholder: 'Example: 10,000 pcs' },
];

/** The rows of a sample request: each model with its parts, the colour rule and how many. */
const SAMPLE_COLUMNS = [
  { key: 'model', label: 'Mould / model', required: true, register: 'moulds' },
  { key: 'material', label: 'Material', register: 'materials' },
  { key: 'colour', label: 'Colour' },
  { key: 'hook', label: 'Hook', register: 'hooks' },
  { key: 'clip', label: 'Clip', register: 'clips' },
  { key: 'print', label: 'Print', register: 'prints' },
  { key: 'colourType', label: 'Colour is', type: 'choice', options: ['Preferred colour', 'Compulsory colour'] },
  { key: 'quantity', label: 'Pcs', type: 'number' },
];

const PAYMENT_TERMS = [
  'Credit — nothing before dispatch', '100% advance', '50% advance, 50% against delivery',
  '50% advance, 50% before dispatch', '30% advance, 70% before dispatch', '100% against dispatch',
];

const DISPATCH_SCHEDULES = ['Today Dispatch', 'Today Evening Dispatch', 'Tomorrow Dispatch', 'Tomorrow First Dispatch', 'Top Most Urgent Dispatch'];

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
        { kind: 'my_payment_followup', label: 'My Payment Follow-up — on my tasks' },
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
      { key: 'models', label: 'Hanger model(s)', from: 'models', register: 'moulds' },
      { key: 'material', label: 'Material / colour / quality', from: 'materials', register: 'materials' },
      { key: 'quantity', label: 'Quantity', type: 'number', from: 'quantity' },
      { key: 'targetPrice', label: 'Buyer’s target price (₹ per piece)', type: 'number', from: 'targetPrice' },
    ],
  },
  price_negotiation: {
    team: 'Quotation Team',
    note: { label: 'Additional instruction / Question', placeholder: 'What the buyer said about the price' },
    asks: [
      { key: 'models', label: 'Hanger model(s)', from: 'models', register: 'moulds' },
      { key: 'targetPrice', label: 'Buyer’s target price (₹ per piece)', type: 'number', from: 'targetPrice' },
    ],
  },
  po_so: {
    team: 'SO Team',
    note: { label: 'Additional instruction / Question', placeholder: 'Prepare and send Sales Order to this company' },
    statuses: [
      { key: 'waiting', label: 'SO Waiting' },
      { key: 'preparing', label: 'SO Preparing' },
      { key: 'clarification', label: 'Needs Clarification', comment: true, raises: 'so_clarification' },
      { key: 'prepared', label: 'SO Prepared', pdf: true, done: true, next: 'ask_edd' },
    ],
    resultLabel: 'Upload Sales Order PDF',
    /* What the uploaded PDF is called where the enquiry shows it. */
    resultTitle: 'Sales order',
    asks: [
      { key: 'contactPerson', label: 'Contact person', section: 'Company & contact details', from: 'customer.contactPerson', placeholder: 'Name of person to call for SO / GST', editable: true },
      { key: 'mobile', label: 'Mobile number', from: 'customer.mobile', editable: true },
      { key: 'models', label: 'Hanger model(s)', section: 'Sales order details', from: 'models', register: 'moulds' },
      { key: 'material', label: 'Material / colour / quality', from: 'materials', register: 'materials', placeholder: 'Material from enquiry; editable' },
      { key: 'quantity', label: 'Order quantity', type: 'number', from: 'quantity', placeholder: 'Quantity from enquiry; editable' },
      { key: 'paymentTerms', label: 'Payment terms', type: 'choice', options: PAYMENT_TERMS, from: 'order.paymentTerms', placeholder: 'Select payment terms' },
    ],
  },
  ask_edd: {
    team: 'Production Team',
    asks: modelAndQuantity,
    /* Every move says why, and the enquiry's marketing person and Admin are told of it. */
    remarkRequired: true,
    notifyStatus: true,
    /* Production's ready date — the enquiry's EDD [handoff.service `productionDates`]. */
    statusDate: { label: 'ERD / Ready date', field: 'edd' },
    remark: { label: 'Remarks', placeholder: 'Add production / assembling remark' },
    statuses: [
      { key: 'received', label: 'EDD Request Received' },
      { key: 'accepted', label: 'EDD Accepted' },
      { key: 'planning', label: 'Planning' },
      { key: 'ready_tomorrow', label: 'Ready Tomorrow', date: 'tomorrow' },
      { key: 'ready_on_date', label: 'Ready on Selected Date', date: 'required' },
      { key: 'started', label: 'Production Started' },
      { key: 'part1_ready', label: 'Part 1 Ready' },
      { key: 'part2_ready', label: 'Part 2 Ready' },
      { key: 'mould_issue', label: 'Mould Issue', issue: true },
      { key: 'machine_not_allotted', label: 'Machine Not Allotted / Alternate Required', issue: true },
      { key: 'raw_material', label: 'Raw Material Not Available', issue: true },
      { key: 'completed', label: 'Production Completed' },
      { key: 'assembling', label: 'Assembling' },
      { key: 'ready_dispatch', label: 'Ready for Dispatch' },
      { key: 'closed', label: 'Task Closed', done: true },
    ],
  },
  ask_assembling_edd: {
    team: 'Assembly Team',
    asks: modelAndQuantity,
    remarkRequired: true,
    notifyStatus: true,
    /* Assembly's ready date is the enquiry's EDD, as Production's is. */
    statusDate: { label: 'ERD / Ready date', field: 'edd' },
    remark: { label: 'Remarks', placeholder: 'Add assembling / printing remark' },
    statuses: [
      { key: 'asked', label: 'Asked Assembling Readiness' },
      { key: 'started', label: 'Started' },
      { key: 'spares_ready', label: 'Spares Ready' },
      { key: 'part_ready', label: 'Part Quantity Ready' },
      { key: 'full_ready', label: 'Full Quantity Ready' },
      { key: 'ready_dispatch', label: 'Ready for Dispatch' },
      { key: 'closed', label: 'Task Closed', done: true },
    ],
  },
  mould_issue: {
    team: 'Mould Team',
    remarkRequired: true,
    notifyStatus: true,
    /* The mould's expected ready date — the enquiry's ERD. */
    statusDate: { label: 'EDR / Mould ready date', field: 'erd' },
    remark: { label: 'Remarks', placeholder: 'Add mould development / rework remark' },
    statuses: [
      { key: 'development', label: 'Development' },
      { key: 'development_edr', label: 'Development EDR', date: 'required' },
      { key: 'rework', label: 'Rework', issue: true },
      { key: 'rework_edr', label: 'Rework EDR', date: 'required', issue: true },
      { key: 'mould_ready', label: 'Mould Ready' },
      { key: 'closed', label: 'Task Closed', done: true },
    ],
    asks: [
      { key: 'model', label: 'Model / mould', type: 'choice', optionsFrom: 'modelList', from: 'modelList.0', register: 'moulds', placeholder: 'Select the model' },
      { key: 'material', label: 'Material / colour', from: 'materials', register: 'materials' },
      { key: 'problem', label: 'What is wrong with the tool', required: true },
    ],
  },
  quality_check: { team: 'Quality Team', asks: modelAndQuantity },
  quality_issue: {
    team: 'Quality Team',
    asks: [...modelAndQuantity, { key: 'problem', label: 'The problem', required: true }],
    remarkRequired: true,
    notifyStatus: true,
    remark: { label: 'Remarks', placeholder: 'What was found, what was done for the buyer' },
    /* A complaint is an issue on the enquiry until it is resolved. */
    statuses: [
      { key: 'received', label: 'Complaint Received', issue: true },
      { key: 'checking', label: 'Under Checking', issue: true },
      { key: 'attended', label: 'Attended', issue: true },
      { key: 'corrective_action', label: 'Corrective Action', issue: true },
      { key: 'replacement', label: 'Replacement In Progress', issue: true },
      { key: 'replaced', label: 'Replaced', issue: true },
      { key: 'resolved', label: 'Resolved' },
      { key: 'closed', label: 'Task Closed', done: true },
    ],
  },
  invoice_dispatch: {
    title: 'Send Dispatch Request',
    submit: 'Send to Dispatch Team',
    team: 'Dispatch Team',
    priority: false,
    note: { label: 'Dispatch instruction / vehicle details', placeholder: 'Transport, delivery point or special dispatch instruction' },
    remarkRequired: true,
    notifyStatus: true,
    remark: { label: 'Remarks', placeholder: 'Vehicle, LR, quantity sent or what is holding it' },
    statuses: [
      { key: 'received', label: 'Dispatch Request Received' },
      ...DISPATCH_SCHEDULES.map((label) => ({ key: label.toLowerCase().replace(/[^a-z]+/g, '_'), label })),
      { key: 'asked_production', label: 'Asked Production Readiness' },
      { key: 'not_ready', label: 'Goods Not Yet Ready', issue: true },
      { key: 'waiting_vehicle', label: 'Goods Ready — Waiting for Vehicle' },
      { key: 'party_collect', label: 'Party Will Collect' },
      { key: 'part_dispatched', label: 'Part Quantity Dispatched' },
      /* Gone: Reception gets the LR copy task, with the dispatch details. */
      { key: 'fully_dispatched', label: 'Fully Dispatched', next: 'lr_copy' },
      { key: 'dispatched', label: 'Dispatched', next: 'lr_copy' },
      { key: 'closed', label: 'Task Closed', done: true },
    ],
    /* Asked from the dispatch task itself: each raises that department's task on the enquiry. */
    actions: [
      { kind: 'ask_edd', label: 'Ask Production', status: 'asked_production' },
      { kind: 'ask_assembling_edd', label: 'Ask Assembling Readiness' },
    ],
    asks: [
      ...modelAndQuantity,
      { key: 'schedule', label: 'Dispatch schedule', type: 'choice', options: DISPATCH_SCHEDULES },
      { key: 'booking', label: 'Booking / Collection', type: 'choice', options: ['Normal Booking', 'Book Before 4 PM', 'Book Before 7 PM', 'Party Will Collect', 'Local Delivery'] },
      { key: 'piNumber', label: 'PI Number (optional)', placeholder: 'Enter PI number' },
      { key: 'delivery', label: 'Delivery contact & vehicle route', type: 'info', from: 'customer.delivery' },
    ],
  },
  lr_copy: {
    team: 'Reception — LR Copy',
    /* The dispatch details after fulfilment: filled from the dispatch, kept up to date by Reception. */
    asks: [
      { key: 'invoiceNumber', label: 'Invoice number', from: 'order.invoiceNumber', editable: true },
      { key: 'lrNumber', label: 'LR / docket number', editable: true },
      { key: 'transporter', label: 'Transporter / courier', editable: true },
      { key: 'vehicleNumber', label: 'Vehicle number', editable: true },
      { key: 'dispatchedOn', label: 'Dispatched on', type: 'date', editable: true },
      { key: 'quantity', label: 'Quantity sent', type: 'number', from: 'quantity', editable: true },
      { key: 'delivery', label: 'Delivery contact & route', type: 'info', from: 'customer.delivery' },
    ],
    editLabel: 'Edit dispatch details',
    remarkRequired: true,
    notifyStatus: true,
    remark: { label: 'Remarks', placeholder: 'LR number, transporter, what the buyer said' },
    statuses: [
      { key: 'awaiting', label: 'LR Copy Awaiting' },
      { key: 'received', label: 'LR Copy Received', pdf: true },
      { key: 'sent', label: 'LR Copy Sent to Customer', sent: true },
      { key: 'in_transit', label: 'In Transit' },
      { key: 'delivered', label: 'Delivered' },
      { key: 'closed', label: 'Task Closed', done: true },
    ],
    resultLabel: 'Upload LR Copy',
    resultTitle: 'LR copy',
    /* A PDF or a photo of the LR, 1 MB at most. */
    resultTypes: ['application/pdf', 'image/jpeg', 'image/png'],
    /* Uploaded, it goes to the buyer by email and WhatsApp, and the task moves to the `sent` status. */
    sendResult: { whatsappTemplate: 'lr_copy' },
  },

  team_payment_followup: paymentFollowUp,
  my_payment_followup: paymentFollowUp,
  gst_invoice_audit: { team: 'Audit Team', asks: [{ key: 'invoiceNumber', label: 'Invoice number', from: 'order.invoiceNumber' }] },
  ac_clarify: {
    team: 'Accounts Team',
    remarkRequired: true,
    notifyStatus: true,
    remark: { label: 'Remarks', placeholder: 'Amount, reference, what the account shows' },
    statuses: [
      { key: 'approval_required', label: 'Payment Approval Required' },
      { key: 'confirmation_pending', label: 'Payment Confirmation Pending' },
      { key: 'confirmed', label: 'Payment Confirmed' },
      { key: 'credit_approved', label: 'Credit Approved' },
      { key: 'statement_required', label: 'Statement Required' },
      { key: 'clarified', label: 'Account Clarified' },
      /* An account on hold holds the enquiry up — marketing's list shows it. */
      { key: 'hold', label: 'Hold', issue: true },
      { key: 'closed', label: 'Task Closed', done: true },
    ],
  },
  request_prt_visit: {
    team: 'PRT — Payment Recovery Team',
    title: 'Request PRT Visit',
    submit: 'Assign PRT Visit',
    note: { label: 'What to collect / discuss', placeholder: 'Amount due, invoices, what the buyer promised last time' },
    /* Due on the day of the visit. */
    dueFrom: 'visitDate',
    asks: [
      /* The member is picked by the person assigning it; the task is theirs by name. */
      { key: 'visitor', label: 'PRT member to visit', type: 'member', department: 'payment_collection', required: true },
      { key: 'visitDate', label: 'Visit date', type: 'date', required: true },
      { key: 'address', label: 'Where', type: 'info', from: 'customer.delivery' },
    ],
  },
};

/** A button's form, with the common fields' defaults. */
export const formFor = (key) => ({ ...PRIORITY_DEFAULTS, ...(TASK_FORMS[key] || {}) });
