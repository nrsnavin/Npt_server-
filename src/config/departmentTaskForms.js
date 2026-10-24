import { FOLLOW_UP_STATUSES } from './paymentFollowUp.js';
import { SCHEDULE_CHOICES } from './deliveryUrgency.js';

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
 *              Dispatched raises Reception's LR copy; SO Prepared raises Production's EDD. If that
 *              task is already open (a second part load), it is told of this one instead
 *   readyForDispatch  reaching it tells the enquiry's open Dispatch request, which moves to
 *              Goods Ready — Waiting for Vehicle if it was still waiting on the goods
 *   tells      reaching it tells the enquiry's open task of that kind (Mould Ready → Production)
 *   recordsPayment  reaching it, with an order on the enquiry still held for its payment, gives
 *              whoever moved it a task to record the receipt in Payments
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

/**
 * QC compulsory before dispatch: marketing or Admin tick it when the job goes to Production (on
 * the SO request, or the Ask EDD form). Ticked, the goods go to Quality after the finishing
 * teams and only Quality's pass lets them go to Dispatch [services/qcGate.service.js].
 */
const QC_ASK = { key: 'qcRequired', label: 'QC compulsory before dispatch', type: 'check', from: 'qcRequired', hint: 'Ticked: Quality checks the goods after Production, Printing and Assembly, and Dispatch waits for its pass' };

/**
 * Printing's and Assembly's goods coming in [handoff.service `handOn`, `addToWorkQueue`]: Goods
 * Received is set when the team before hands them over — or by this team, when the goods came
 * without it — and In Work Queue when the team takes them on. A model routed here by Production
 * moves no further until its goods have come.
 */
const GOODS_IN = [
  { key: 'goods_received', label: 'Goods Received', receives: true },
  { key: 'in_queue', label: 'In Work Queue', queues: true },
];

/**
 * A readiness query — Printing, Assembly or Dispatch asking Production (or Dispatch asking
 * Assembly) when the goods will be ready [handoff.service `raiseQuery`]. Its own task beside the
 * order's, not a second run of the team's workflow: Query Received → Planning → Will Be Ready On
 * (with the date) → Ready Now, which answers it and closes it. The date answers the team that
 * asked; it is not the enquiry's EDD (`field: 'readyOn'`). On its own tab of the desk.
 */
const readinessQuery = (team, placeholder) => ({
  team,
  query: true,
  priority: true,
  requiredDate: true,
  asks: modelAndQuantity,
  remarkRequired: true,
  notifyStatus: true,
  statusDate: { label: 'Ready on', field: 'readyOn' },
  remark: { label: 'Remarks', placeholder },
  statuses: [
    { key: 'received', label: 'Query Received' },
    { key: 'planning', label: 'Planning' },
    { key: 'ready_on_date', label: 'Will Be Ready On', date: 'required' },
    { key: 'ready_now', label: 'Ready Now', done: true, answers: true },
  ],
});

/** The rows of a sample request: each model with its parts, the colour rule and how many. */
const SAMPLE_COLUMNS = [
  { key: 'model', label: 'Mould / model', required: true, register: 'moulds' },
  { key: 'material', label: 'Material', register: 'materials' },
  { key: 'colour', label: 'Colour' },
  { key: 'hook', label: 'Hook', register: 'hooks' },
  { key: 'clip', label: 'Clip', register: 'clips' },
  { key: 'print', label: 'Print', register: 'prints' },
  { key: 'colourType', label: 'Colour is', type: 'choice', options: ['Preferred colour', 'Compulsory colour'] },
  { key: 'quantity', label: 'Pcs', type: 'number', blank: '3' },
];

/** The rows of a sales order request: each model with its material and colour, its parts, how many, the price and the date it is due. */
const SO_COLUMNS = [
  { key: 'model', label: 'Model', required: true, register: 'moulds' },
  { key: 'material', label: 'Material & colour', register: 'materials' },
  { key: 'hook', label: 'Hook', register: 'hooks' },
  { key: 'clip', label: 'Clip', register: 'clips' },
  { key: 'print', label: 'Print', register: 'prints' },
  { key: 'quantity', label: 'Qty (pcs)', type: 'number' },
  { key: 'price', label: 'Price (₹ / pc)', type: 'number' },
  { key: 'edd', label: 'EDD', type: 'date' },
];

/** The rows of a quotation request: each model as the buyer wants it — material and colour, its parts, how many, and the price they hope for. */
const QUOTE_COLUMNS = [
  { key: 'model', label: 'Model', required: true, register: 'moulds' },
  { key: 'material', label: 'Material & colour', register: 'materials' },
  { key: 'hook', label: 'Hook', register: 'hooks' },
  { key: 'clip', label: 'Clip', register: 'clips' },
  { key: 'print', label: 'Print', register: 'prints' },
  { key: 'packing', label: 'Packing' },
  { key: 'quantity', label: 'Qty (pcs)', type: 'number' },
  { key: 'targetPrice', label: 'Target price (₹ / pc)', type: 'number' },
];

const PAYMENT_TERMS = [
  'Credit — nothing before dispatch', '100% advance', '50% advance, 50% against delivery',
  '50% advance, 50% before dispatch', '30% advance, 70% before dispatch', '100% against dispatch',
];

const DISPATCH_SCHEDULES = ['Today Dispatch', 'Today Evening Dispatch', 'Tomorrow Dispatch', 'Tomorrow First Dispatch', 'Top Most Urgent Dispatch'];

/**
 * The Quality team's workflow, on every Quality task — the plant's own list:
 * Complaint Received → Under Checking → Attended → Corrective Action → Replacement In Progress →
 * Replaced → Resolved → Task Closed. Each move with a remark, told to the enquiry's marketing
 * person and Admin. On a complaint (Quality Issue) the open statuses mark the enquiry as having an
 * issue until it is Resolved; a routine Quality Check runs the same steps without the flag.
 */
function qualityWorkflow({ complaint }) {
  const open = (key, label) => ({ key, label, ...(complaint ? { issue: true } : {}) });
  return {
    remarkRequired: true,
    notifyStatus: true,
    remark: { label: 'Remarks', placeholder: 'What was found, what was done for the buyer' },
    statuses: [
      open('received', 'Complaint Received'),
      open('checking', 'Under Checking'),
      open('attended', 'Attended'),
      open('corrective_action', 'Corrective Action'),
      open('replacement', 'Replacement In Progress'),
      open('replaced', 'Replaced'),
      { key: 'resolved', label: 'Resolved' },
      { key: 'closed', label: 'Task Closed', done: true },
    ],
  };
}

/**
 * Quality's check before dispatch [config/handoffs.js quality_check]: Goods Received for QC →
 * Under Checking → QC Passed (or Passed with Deviation), which finishes the task and lets the
 * goods go to Dispatch; QC Failed sends them back for rework — Admin, marketing and the teams that
 * made them are told — and Re-checking after Rework takes them through the check again. There is
 * no way to finish it but a pass: `result` is what the pass records [handoff.service
 * `setTaskStatus`; qcGate.service].
 */
const qcCheckWorkflow = {
  remarkRequired: true,
  notifyStatus: true,
  remark: { label: 'Remarks', placeholder: 'Pieces checked, what was found, the lot' },
  statuses: [
    { key: 'received', label: 'Goods Received for QC' },
    { key: 'checking', label: 'Under Checking' },
    { key: 'failed', label: 'QC Failed — Rework', issue: true, qcFailed: true },
    { key: 'rechecking', label: 'Re-checking after Rework' },
    { key: 'passed', label: 'QC Passed', done: true, result: 'Passed' },
    { key: 'passed_deviation', label: 'Passed with Deviation', done: true, result: 'Passed with deviation' },
  ],
};

/**
 * What a Quality task is about: one row per model with its material, the pieces concerned and
 * the complaint or check on that model, then the complaint received as a whole (required on a
 * Quality Issue) — beside the task's instruction. Filled from the enquiry's models; any number of
 * rows, so one task covers an order of several models.
 */
const QUALITY_COLUMNS = [
  { key: 'model', label: 'Model', required: true, register: 'moulds' },
  { key: 'material', label: 'Material & colour', register: 'materials' },
  { key: 'quantity', label: 'Qty (pcs)', type: 'number' },
  { key: 'complaint', label: 'Complaint / what to check on this model' },
];
const qualityAsks = ({ complaintRequired }) => [
  { key: 'items', label: 'Models for Quality', type: 'items', from: 'qualityItems', add: '+ Add Model', columns: QUALITY_COLUMNS },
  { key: 'problem', label: complaintRequired ? 'Complaint received' : 'Complaint received, if any', required: complaintRequired, placeholder: 'What the buyer reported, or what was found' },
];

/**
 * The Quotation team's workflow on a costing or a price negotiation — suggested steps, kept until
 * the plant sends its own: Request Received → Costing → Waiting for Admin Approval → Quote Sent →
 * Task Closed. Each move with a remark, told to the enquiry's marketing person and Admin.
 */
const quotationWorkflow = {
  remarkRequired: true,
  notifyStatus: true,
  remark: { label: 'Remarks', placeholder: 'Price worked out, what Admin said, when it went to the buyer' },
  statuses: [
    { key: 'received', label: 'Request Received' },
    { key: 'costing', label: 'Costing' },
    { key: 'approval', label: 'Waiting for Admin Approval' },
    { key: 'sent', label: 'Quote Sent' },
    { key: 'closed', label: 'Task Closed', done: true },
  ],
};

/**
 * Payment Collection's workflow on a follow-up — the phone half of the chase
 * [docs/PAYMENT-COLLECTION-WORKFLOW.md; handoff.service `setTaskStatus`, collections.service].
 * Beyond the flags every workflow has:
 *   followUp   the move is also a call on the receivable's log, with this follow-up status
 *              [config/paymentFollowUp.js] — so the chase screen and the task agree
 *   mode       how the buyer was reached, on that log entry (a visit, for PRT)
 *   promise    the date given with the move is the buyer's promise: the receivable's promised and
 *              next follow-up date, and the task's due date. Broken by the sweep when it passes
 *              with no money in [collections.service `runCollectionSweep`]
 *   recordsReceipt  money was taken: whoever moved it is asked to record the receipt in Payments
 */
const paymentFollowUp = {
  title: 'Payment Follow-up Tracker',
  submit: 'Save Follow-up',
  team: 'Payment Follow-up',
  option: 'team_payment_followup',
  priority: false,
  requiredDate: false,
  /* Every follow-up note reaches Admin and the enquiry's marketing person under "Needs your action". */
  notifyStatus: true,
  /* Due on the day the buyer asked to be called, when they said one. */
  dueFrom: 'callOn',
  note: { label: 'Follow-up note', placeholder: 'Payment discussion or follow-up note' },
  remarkRequired: true,
  statusDate: { label: 'Promised date', field: 'promisedDate' },
  remark: { label: 'Remarks', placeholder: 'Who you spoke to, what they said, what was agreed' },
  statuses: [
    { key: 'assigned', label: 'Assigned' },
    { key: 'contacted', label: 'Contacted', followUp: 'other' },
    { key: 'promised', label: 'Promised', date: 'required', promise: true, followUp: 'promised' },
    { key: 'part_paid', label: 'Part Paid', followUp: 'part_paid', recordsReceipt: true },
    /* Set by the sweep the morning after a promised date passes with nothing in; a person may set it too. */
    { key: 'promise_broken', label: 'Promise Broken', issue: true },
    { key: 'not_reachable', label: 'Not Reachable', followUp: 'no_answer' },
    /* The buyer argues the invoice: Accounts gets A/C Clarify, and marketing's list shows the issue. */
    { key: 'disputed', label: 'Disputed', comment: true, raises: 'ac_clarify', followUp: 'disputed', issue: true },
    /* Hand-over to the field: the PRT case is raised and this task closes with the reason. */
    { key: 'escalate_prt', label: 'Escalated to PRT', comment: true, raises: 'prt_recovery', done: true },
    { key: 'paid', label: 'Paid', followUp: 'payment_sent', recordsReceipt: true, done: true },
    /*
     * The money a sales order waits for before production (or dispatch) has come in: Payment
     * Collection logs it here — a receipt on the order's RCV — and Accounts gets a task to confirm
     * it in the bank. Once Accounts confirms and the stage is covered, this task closes and the SO
     * team and marketing are told to release the order [paymentGates.service `confirmInwardFromTask`].
     */
    {
      key: 'payment_inward', label: 'Payment Logged — Accounts to Confirm', confirmsInward: true,
      fields: [
        { key: 'amount', label: 'Amount received (₹)', type: 'number', required: true },
        { key: 'mode', label: 'Mode', options: ['NEFT', 'RTGS', 'UPI', 'Cheque', 'Cash', 'Other'], required: true },
        { key: 'reference', label: 'UTR / cheque number' },
      ],
    },
  ],
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

/** How a sample reaches the buyer, as the request form asks it [models/Sample.js HANDOVER_MODES]. */
export const HANDOVER_CHOICES = [
  { key: 'dispatch', label: 'Sent by the bench (courier or at the gate)' },
  { key: 'collect', label: 'Buyer collects at reception' },
  { key: 'in_person', label: 'I will hand it over on my visit (from the sample rack)' },
];

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
      /* Sent by the bench, kept at reception for the buyer to collect, or carried by the marketing person [models/Sample.js HANDOVER_MODES]. */
      { key: 'handover', label: 'How it reaches the buyer', type: 'choice', options: HANDOVER_CHOICES.map((entry) => entry.label) },
    ],
    /* The courier's receipt, kept on the task once the sample has gone — read from the enquiry's finished task. */
    documents: [{ type: 'courier_copy', label: 'Courier copy' }],
  },
  /*
   * Reception's desk flow for a sample the buyer collects at reception. Such a sample is an
   * internal one — it never goes to the sampling queue: Reception notes the request, gets the
   * piece ready (and the buyer is told it is waiting), hands it over and records who took it —
   * name, phone, pieces — with a photo of the signed slip beside it, then closes the task.
   */
  sample_collect: {
    team: 'Reception — Sample collection',
    /* Filled by the app from the sample, never typed: the record's id stays off the card. */
    asks: [
      { key: 'sample', label: 'Sample record', hidden: true },
      { key: 'sampleNumber', label: 'Sample' },
      { key: 'models', label: 'Models in the bag' },
      { key: 'pieces', label: 'Pieces' },
      { key: 'buyerContact', label: 'Buyer to call' },
    ],
    notifyStatus: true,
    remark: { label: 'Remarks', placeholder: 'Who you spoke to, when they said they would come' },
    statuses: [
      { key: 'noted', label: 'Noted' },
      /* The piece is at the desk: the sample reads ready, and the buyer hears it on WhatsApp and email, from the company number. */
      { key: 'ready', label: 'Sample ready', sampleReady: true, tellBuyer: 'sample_ready_collect' },
      {
        key: 'handed', label: 'Sample handed', handsOver: true,
        fields: [
          { key: 'collectorName', label: 'Received by (name)', required: true },
          { key: 'collectorPhone', label: 'Their phone' },
          { key: 'pieces', label: 'Pieces handed over', type: 'number' },
        ],
      },
      { key: 'closed', label: 'Task closed', done: true },
    ],
    documents: [{ type: 'handover_photo', label: 'Hand-over photo / signed slip' }],
  },
  create_quotation: {
    team: 'Quotation Team',
    ...quotationWorkflow,
    note: { label: 'Additional instruction / Question', placeholder: 'Target price, packing or anything the costing should know' },
    /* One row per model, so a quote for several is costed line by line, each with its own parts. */
    asks: [
      {
        key: 'items', label: 'Models to quote', type: 'items',
        from: 'quoteItems', add: '+ Add Model', columns: QUOTE_COLUMNS,
      },
    ],
  },
  price_negotiation: {
    team: 'Quotation Team',
    ...quotationWorkflow,
    note: { label: 'Additional instruction / Question', placeholder: 'What the buyer said about the price' },
    asks: [
      {
        key: 'items', label: 'Models in the negotiation', type: 'items',
        from: 'quoteItems', add: '+ Add Model', columns: QUOTE_COLUMNS,
      },
    ],
  },
  po_so: {
    team: 'SO Team',
    note: { label: 'Additional instruction / Question', placeholder: 'Prepare and send Sales Order to this company' },
    /* Every move says why, and the enquiry's marketing person and Admin are told of it. */
    remarkRequired: true,
    notifyStatus: true,
    remark: { label: 'Remarks', placeholder: 'What is done, what is missing, when the SO will go' },
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
      {
        key: 'items', label: 'Sales order details', section: 'Sales order details', type: 'items',
        from: 'orderItems', add: '+ Add Model', columns: SO_COLUMNS,
      },
      { key: 'paymentTerms', label: 'Payment terms', type: 'choice', options: PAYMENT_TERMS, from: 'order.paymentTerms', placeholder: 'Select payment terms' },
      { key: 'poNumber', label: 'Customer PO number', from: 'order.poNumber', placeholder: 'The buyer’s PO number, if there is one' },
      /*
       * Ticked: the SO prepared sends the order straight to Production. Unticked: it comes back
       * to marketing as a Production Holded Order, and Admin or the enquiry's marketing person
       * (or whoever it was delegated to) moves it to Production [config/handoffs.js po_so `holdUnless`].
       * The form starts ticked (`checked`); marketing unticks it to hold the order.
       */
      { key: 'productionConfirmed', label: 'Production confirmed — send to Production once the SO is prepared', type: 'check', checked: true },
      QC_ASK,
    ],
  },
  ask_edd: {
    team: 'Production Team',
    /*
     * Whether a model is printed or assembled after moulding is Production's call, made model by
     * model on the task before it gives any date [handoff.service `decideRouting`]: Printing's and
     * Assembly's tasks are raised from that, and the last team in the chain gives the EDD.
     */
    asks: [...modelAndQuantity, QC_ASK],
    routes: true,
    /* Every move says why, and the enquiry's marketing person and Admin are told of it. */
    remarkRequired: true,
    notifyStatus: true,
    /* Production's completion date (or hand-over date, where a model goes on) — never the EDD, which is marketing's [handoff.service `refreshModelEdds`]. */
    statusDate: { label: 'Completion date', field: 'edd' },
    remark: { label: 'Remarks', placeholder: 'Add production / assembling remark' },
    /*
     * Handed on from the Production desk: each raises that team's task on the enquiry, told back
     * here as it moves [handoff.service `askFromTask`]. None holds Production's own status —
     * the press keeps running while Assembly or Quality has its share.
     */
    actions: [
      { kind: 'ask_assembling_edd', label: 'Ask Assembly' },
      { kind: 'ask_printing', label: 'Ask Printing' },
      { kind: 'quality_check', label: 'Ask Quality' },
      { kind: 'invoice_dispatch', label: 'Send to Dispatch' },
    ],
    statuses: [
      { key: 'received', label: 'EDD Request Received' },
      /* `plans`: the Production in charge's moves (or Admin's), as the dates are [handoff.service `assertPlansProduction`]. */
      { key: 'accepted', label: 'EDD Accepted', plans: true },
      { key: 'planning', label: 'Planning', plans: true },
      { key: 'ready_tomorrow', label: 'Ready Tomorrow', date: 'tomorrow' },
      { key: 'ready_on_date', label: 'Ready on Selected Date', date: 'required' },
      { key: 'started', label: 'Production Started' },
      { key: 'part1_ready', label: 'Part 1 Ready' },
      { key: 'part2_ready', label: 'Part 2 Ready' },
      { key: 'mould_issue', label: 'Mould Issue', issue: true },
      { key: 'machine_not_allotted', label: 'Machine Not Allotted / Alternate Required', issue: true },
      { key: 'raw_material', label: 'Raw Material Not Available', issue: true },
      { key: 'completed', label: 'Production Completed' },
      /*
       * Moulding done for a model that goes on to Printing or Assembly: the goods are handed to that
       * team, whose task hears it [handoff.service `handOn`]. Offered only where Production routed
       * a model there.
       */
      { key: 'handed_printing', label: 'Handed to Printing', handsTo: 'printing' },
      { key: 'handed_assembly', label: 'Handed to Assembly', handsTo: 'assembling' },
      { key: 'assembling', label: 'Assembling' },
      /* Tells the enquiry's open Dispatch request, which moves to Goods Ready [handoff.service `tellDispatchReady`]. */
      { key: 'ready_dispatch', label: 'Ready for Dispatch', readyForDispatch: true },
      { key: 'closed', label: 'Task Closed', done: true },
    ],
  },
  ask_assembling_edd: {
    team: 'Assembly Team',
    asks: [...modelAndQuantity, { key: 'models', label: 'Models to assemble' }],
    remarkRequired: true,
    notifyStatus: true,
    /* Assembly's completion date, shown on the enquiry beside marketing's EDD. */
    statusDate: { label: 'Completion date', field: 'edd' },
    remark: { label: 'Remarks', placeholder: 'Add assembling / printing remark' },
    statuses: [
      { key: 'asked', label: 'Asked Assembling Readiness' },
      ...GOODS_IN,
      { key: 'started', label: 'Started' },
      { key: 'spares_ready', label: 'Spares Ready' },
      { key: 'part_ready', label: 'Part Quantity Ready' },
      { key: 'full_ready', label: 'Full Quantity Ready' },
      { key: 'ready_dispatch', label: 'Ready for Dispatch', readyForDispatch: true },
      { key: 'closed', label: 'Task Closed', done: true },
    ],
    /* Asking Production when its goods will come: a query of its own on Production's desk [readinessQuery]. */
    actions: [{ kind: 'production_query', label: 'Ask Production' }],
  },
  /* Printing sits with Quality and Assembly on one desk [config/modules.js DESK_GROUPS]; its task runs
     the same way as Assembly's, with its own header on that desk. */
  ask_printing: {
    team: 'Printing Team',
    asks: [...modelAndQuantity, { key: 'models', label: 'Models to print' }],
    remarkRequired: true,
    notifyStatus: true,
    statusDate: { label: 'Completion date', field: 'edd' },
    remark: { label: 'Remarks', placeholder: 'Add printing remark — artwork, colours, pieces done' },
    statuses: [
      { key: 'asked', label: 'Asked Printing Readiness' },
      ...GOODS_IN,
      { key: 'started', label: 'Started' },
      { key: 'part_ready', label: 'Part Quantity Ready' },
      { key: 'full_ready', label: 'Full Quantity Ready' },
      /* Printed, for a model that is assembled after: handed to Assembly, whose task hears it. */
      { key: 'handed_assembly', label: 'Handed to Assembly', handsTo: 'assembling' },
      { key: 'ready_dispatch', label: 'Ready for Dispatch', readyForDispatch: true },
      { key: 'closed', label: 'Task Closed', done: true },
    ],
    actions: [{ kind: 'production_query', label: 'Ask Production' }],
  },
  /* The readiness queries other teams send Production and Assembly — short, on their own desk tab [readinessQuery]. */
  production_query: readinessQuery('Production Team', 'What is planned, and when the goods will be ready'),
  assembling_query: readinessQuery('Assembly Team', 'What is planned, and when the assembled goods will be ready'),
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
      /* Tells the enquiry's open Production task the tool is back [handoff.service `tellOpenTasks`]. */
      { key: 'mould_ready', label: 'Mould Ready', tells: 'ask_edd' },
      { key: 'closed', label: 'Task Closed', done: true },
    ],
    asks: [
      { key: 'model', label: 'Model / mould', type: 'choice', optionsFrom: 'modelList', from: 'modelList.0', register: 'moulds', placeholder: 'Select the model' },
      { key: 'material', label: 'Material / colour', from: 'materials', register: 'materials' },
      { key: 'problem', label: 'What is wrong with the tool', required: true },
    ],
  },
  /*
   * The check before dispatch: the goods come to Quality, are checked, and pass — or fail and go
   * back for rework, to be checked again. Only a pass lets them go to Dispatch [qcGate.service]; a
   * complaint from the buyer is a Quality Issue, with its own workflow below.
   */
  quality_check: {
    team: 'Quality Team',
    note: { label: 'Additional instruction to Quality', placeholder: 'What to check, which lot, what the buyer said' },
    asks: qualityAsks({ complaintRequired: false }),
    ...qcCheckWorkflow,
  },
  quality_issue: {
    team: 'Quality Team',
    note: { label: 'Additional instruction to Quality', placeholder: 'What the buyer said, what they want done, by when' },
    asks: qualityAsks({ complaintRequired: true }),
    ...qualityWorkflow({ complaint: true }),
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
      { key: 'asked_assembling', label: 'Asked Assembling Readiness' },
      { key: 'not_ready', label: 'Goods Not Yet Ready', issue: true },
      { key: 'waiting_vehicle', label: 'Goods Ready — Waiting for Vehicle' },
      { key: 'party_collect', label: 'Party Will Collect' },
      /*
       * A part load has its own LR: Reception's LR copy task is raised, or told of the further load.
       * Which models went, so an order going out model by model reads which are sent and which
       * are still to come [handoff.service `modelReadiness`]; the enquiry reads Part sent.
       */
      {
        key: 'part_dispatched', label: 'Part Quantity Dispatched', next: 'lr_copy', marketing: 'part_sent',
        fields: [{ key: 'modelsSent', label: 'Models sent in this load', placeholder: 'CRF25, CRF30' }, { key: 'piecesSent', label: 'Pieces sent', type: 'number' }],
      },
      /* Gone: Reception gets the LR copy task, with the dispatch details. */
      { key: 'fully_dispatched', label: 'Fully Dispatched', next: 'lr_copy' },
      { key: 'dispatched', label: 'Dispatched', next: 'lr_copy' },
      { key: 'closed', label: 'Task Closed', done: true },
    ],
    /* Asked from the dispatch task itself: each raises a readiness query of its own [readinessQuery], and
       the request waits on it — nothing goes until the goods are ready [handoff.service `assertNotWaiting`].
       `was`: the kind the same ask raised before queries had their own task, still waited on while open. */
    actions: [
      { kind: 'production_query', label: 'Ask Production', status: 'asked_production', waits: true, was: 'ask_edd' },
      { kind: 'assembling_query', label: 'Ask Assembling Readiness', status: 'asked_assembling', waits: true, was: 'ask_assembling_edd' },
    ],
    asks: [
      ...modelAndQuantity,
      /* How soon the buyer needs it — the request's delivery urgency, which orders the Dispatch queue [config/deliveryUrgency.js]. */
      { key: 'schedule', label: 'Delivery urgency', type: 'choice', options: SCHEDULE_CHOICES },
      { key: 'booking', label: 'Booking / Collection', type: 'choice', options: ['Normal Booking', 'Book Before 4 PM', 'Book Before 7 PM', 'Party Will Collect', 'Local Delivery'] },
      { key: 'piNumber', label: 'PI Number (optional)', placeholder: 'Enter PI number' },
      { key: 'delivery', label: 'Delivery contact & vehicle route', type: 'info', from: 'customer.delivery' },
    ],
    /*
     * Papers the department uploads onto its task, which marketing can then attach when writing
     * to the buyer from the enquiry [services/enquiryDocuments.service.js]. Any number of each;
     * uploading one moves nothing.
     */
    documents: [
      { type: 'invoice', label: 'Invoice' },
      { type: 'dispatch_details', label: 'Dispatch details' },
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
    /* Reception keeps the dispatch papers after fulfilment, beside the LR copy above. */
    documents: [{ type: 'dispatch_details', label: 'Dispatch details' }],
  },

  team_payment_followup: paymentFollowUp,
  /* The raiser's own tracker: the same, but money in is confirmed by Payment Collection, not here. */
  my_payment_followup: { ...paymentFollowUp, statuses: paymentFollowUp.statuses.filter((step) => !step.confirmsInward) },
  /* Suggested steps, kept until the plant sends its own. A correction needed shows as an issue on the enquiry. */
  gst_invoice_audit: {
    team: 'Audit Team',
    asks: [{ key: 'invoiceNumber', label: 'Invoice number', from: 'order.invoiceNumber' }],
    remarkRequired: true,
    notifyStatus: true,
    remark: { label: 'Remarks', placeholder: 'What was checked, what has to be corrected' },
    statuses: [
      { key: 'received', label: 'Received' },
      { key: 'checking', label: 'Checking' },
      { key: 'correction', label: 'Correction Needed', issue: true },
      { key: 'corrected', label: 'Corrected' },
      { key: 'closed', label: 'Task Closed', done: true },
    ],
  },
  ac_clarify: {
    team: 'Accounts Team',
    remarkRequired: true,
    notifyStatus: true,
    remark: { label: 'Remarks', placeholder: 'Amount, reference, what the account shows' },
    statuses: [
      { key: 'approval_required', label: 'Payment Approval Required' },
      { key: 'confirmation_pending', label: 'Payment Confirmation Pending' },
      /* If an order on the enquiry is still held for its payment, whoever confirmed is asked to record the receipt. */
      { key: 'confirmed', label: 'Payment Confirmed', recordsPayment: true },
      { key: 'credit_approved', label: 'Credit Approved', recordsPayment: true },
      { key: 'statement_required', label: 'Statement Required' },
      { key: 'clarified', label: 'Account Clarified' },
      /* An account on hold holds the enquiry up — marketing's list shows it. */
      { key: 'hold', label: 'Hold', issue: true },
      { key: 'closed', label: 'Task Closed', done: true },
    ],
  },
  /*
   * The field half of the chase: the Payment Recovery Team's case [docs/PAYMENT-COLLECTION-WORKFLOW.md].
   * Raised by Payment Collection's "Escalated to PRT", or by Admin / marketing by hand. The
   * same flags as the follow-up above; a visit is a call on the receivable's log, mode `visit`.
   */
  prt_recovery: {
    team: 'Payment Recovery Team',
    title: 'PRT Recovery',
    submit: 'Send to PRT',
    note: { label: 'What to collect / discuss', placeholder: 'Amount due, invoices, what the buyer promised last time, why it is going to the field' },
    /* Due on the day of the visit when one is fixed. */
    dueFrom: 'visitDate',
    remarkRequired: true,
    notifyStatus: true,
    statusDate: { label: 'Visit / promised date', field: 'visitDate' },
    remark: { label: 'Remarks', placeholder: 'Who was met, what was paid or promised, the next date' },
    statuses: [
      { key: 'assigned', label: 'Assigned' },
      { key: 'visit_planned', label: 'Visit Planned', date: 'required', visit: true },
      { key: 'visited', label: 'Visited', followUp: 'other', mode: 'visit' },
      { key: 'collected', label: 'Collected', followUp: 'payment_sent', mode: 'visit', recordsReceipt: true },
      { key: 'part_collected', label: 'Part Collected', followUp: 'part_paid', mode: 'visit', recordsReceipt: true },
      { key: 'promised', label: 'Promised', date: 'required', promise: true, followUp: 'promised', mode: 'visit' },
      { key: 'promise_broken', label: 'Promise Broken', issue: true },
      /* PRT's recommendation: Admin decides — legal notice, write-off or a credit hold — on the customer. */
      { key: 'cannot_recover', label: 'Cannot Recover', comment: true, issue: true },
      { key: 'closed', label: 'Task Closed', done: true },
    ],
    asks: [
      /* Picked by whoever assigns it; the automation leaves it for the team to take. */
      { key: 'visitor', label: 'PRT member to visit', type: 'member', department: 'payment_recovery' },
      { key: 'visitDate', label: 'Visit date', type: 'date' },
      { key: 'contact', label: 'Contact person / WhatsApp', from: 'customer.whatsapp' },
      { key: 'address', label: 'Where', type: 'info', from: 'customer.delivery' },
    ],
  },
  /* The earlier PRT task, kept so what was raised on it still reads; new cases are `prt_recovery`. */
  request_prt_visit: {
    team: 'PRT — Payment Recovery Team',
    title: 'Request PRT Visit',
    submit: 'Assign PRT Visit',
    note: { label: 'What to collect / discuss', placeholder: 'Amount due, invoices, what the buyer promised last time' },
    dueFrom: 'visitDate',
    remarkRequired: true,
    notifyStatus: true,
    remark: { label: 'Remarks', placeholder: 'Who was met, what was paid or promised, the next date' },
    statuses: [
      { key: 'assigned', label: 'Visit Assigned' },
      { key: 'visited', label: 'Visited' },
      { key: 'collected', label: 'Collected' },
      { key: 'promised', label: 'Promised' },
      { key: 'closed', label: 'Task Closed', done: true },
    ],
    asks: [
      { key: 'visitor', label: 'PRT member to visit', type: 'member', department: 'payment_recovery', required: true },
      { key: 'visitDate', label: 'Visit date', type: 'date', required: true },
      { key: 'address', label: 'Where', type: 'info', from: 'customer.delivery' },
    ],
  },
};

/** A button's form, with the common fields' defaults. */
export const formFor = (key) => ({ ...PRIORITY_DEFAULTS, ...(TASK_FORMS[key] || {}) });

/**
 * The hanger's own details, which a task raised without them can be filled in with afterwards —
 * by the department working it, by whoever raised it, the enquiry's marketing person or Admin
 * [handoff.service `editTaskBrief`]. Picked from the registers like the forms' own questions.
 */
export const HANGER_DETAILS = [
  { key: 'model', label: 'Model', register: 'moulds' },
  { key: 'material', label: 'Material & colour', register: 'materials' },
  { key: 'hook', label: 'Hook', register: 'hooks' },
  { key: 'clip', label: 'Clip', register: 'clips' },
  { key: 'print', label: 'Print', register: 'prints' },
  { key: 'quantity', label: 'Quantity (pcs)', type: 'number' },
];

/** The tasks about making or moving hangers, which carry those details. */
export const HANGER_DETAIL_KINDS = [
  'ask_edd', 'ask_printing', 'ask_assembling_edd', 'mould_issue', 'quality_check', 'quality_issue',
  'invoice_dispatch', 'create_quotation', 'price_negotiation',
];
