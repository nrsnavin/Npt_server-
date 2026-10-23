import Customer from '../models/Customer.js';
import Enquiry, { CLOSED_STATUSES, checkPending } from '../models/Enquiry.js';
import Quotation, { CLOSED_QUOTATION_STATUSES, QUOTATION_STATUSES } from '../models/Quotation.js';
import Todo from '../models/Todo.js';
import { findHandoff } from '../config/handoffs.js';
import { marketingStatusLabel, marketingStatusOf } from '../config/marketingStatuses.js';
import { customerScope, isOwnershipScoped, ownershipFilter } from './ownership.service.js';
import { departmentsOf, isManagement } from '../utils/departments.js';
import { WAITING_ON_POPULATE, endOfDayIST, startOfDayIST } from './handoff.service.js';
import { DEPARTMENT_KEYS, deskOf } from '../config/modules.js';
import ApiError from '../utils/ApiError.js';

/**
 * The overview dashboard [web: pages/OverviewDashboard.jsx] — Admin's company-wide, a marketing
 * person's own: the figures across the top, the new enquiries to verify, the department tasks to
 * follow, and the customer / party master with where each one stands.
 *
 * Every read goes through the same ownership rules as the lists it summarises, so a marketing
 * person's figures are their own book and nobody else's.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Still being worked: not closed by Task Closed, not lost. */
/* Not closed, not lost, and not marked Task Closed by marketing — the Enquiries list's own Open [pipeline.controller]. */
const activeEnquiries = (user) => ({ ...ownershipFilter(user), stage: { $ne: 'closed' }, status: { $ne: 'lost' }, marketingStatus: { $ne: 'task_closed' } });

/*
 * Open for marketing — the Enquiries list's own "Open" and "Due now" [pipeline.controller]: not
 * closed, not lost. A won order is followed through the plant until its LR closes it, so it
 * counts until then. The tiles link to those lists — a tile saying 4 over a list of 3 reads as a bug.
 */
const openForMarketing = (user) => activeEnquiries(user);

/** Marketing's first step — an enquiry nobody has verified and moved on yet. */
const isNew = { $or: [{ marketingStatus: 'enquiry_received' }, { marketingStatus: null, status: { $in: ['new', 'requirement_clarification'] } }] };

/* Every status but the buyer's answer — from the model, so a new status is counted, not lost. */
const LIVE_QUOTES = QUOTATION_STATUSES.filter((status) => !CLOSED_QUOTATION_STATUSES.includes(status));

export async function overviewFor(user) {
  const tonight = endOfDayIST(new Date());
  const active = activeEnquiries(user);
  const open = openForMarketing(user);
  const [customers, dueToday, openCount, quotations, newCount, fresh] = await Promise.all([
    Customer.countDocuments(customerScope(user)),
    Enquiry.countDocuments({ ...open, nextFollowUpDate: { $lte: tonight } }),
    Enquiry.countDocuments(open),
    Quotation.countDocuments({ ...ownershipFilter(user), status: { $in: LIVE_QUOTES } }),
    Enquiry.countDocuments({ ...active, ...isNew }),
    Enquiry.find({ ...active, ...isNew })
      .select('number customer prospect.name assignedTo requirement.modelNumber enquiryDate createdAt checkedAt marketingStatus status stage')
      .populate([{ path: 'customer', select: 'name code' }, { path: 'assignedTo', select: 'name' }])
      .sort({ createdAt: -1 })
      .limit(20)
      .lean(),
  ]);
  return {
    figures: { customers, dueToday, activeEnquiries: openCount, quotations },
    /* Each says whether it still waits to be checked [Enquiry `checkPending`]. */
    newEnquiries: { total: newCount, rows: fresh.map((row) => ({ ...row, checkPending: checkPending(row) })) },
  };
}

/* ------------------------------ Department tasks to follow ------------------------------ */

/** Marketing's holding task is the enquiry itself, not a task anybody was asked to do. */
const NOT_THE_ENQUIRY = { $nor: [{ holds: true, kind: { $in: ['new_enquiry', 'back_to_marketing', 'my_payment_followup'] } }] };

export const TASK_STATES = ['open', 'done', 'all'];

/**
 * The department tasks this person follows: Admin every one; a marketing person those on their
 * own enquiries (and team tasks on their own customers), the ones they raised and the ones given
 * to them; anyone else their department's.
 *
 * Filtered by department and by state — open (the default), done, or all — so Admin can read
 * any one department's tasks, finished ones included. A department outside what this person
 * may see returns nothing rather than widening the scope.
 */
export async function trackedTasks(user, { department, state = 'open', limit = 300 } = {}) {
  if (!TASK_STATES.includes(state)) throw new ApiError(400, `State must be one of ${TASK_STATES.join(', ')}`);
  /* A department, or a desk shared by several [config/modules.js DESK_GROUPS] — every one of its queues. */
  const members = department ? (deskOf(department)?.key === department ? deskOf(department).departments : [department]) : [];
  if (department && !DEPARTMENT_KEYS.includes(department) && deskOf(department)?.key !== department) throw new ApiError(400, `Unknown department “${department}”`);
  const filter = { kind: { $exists: true }, ...NOT_THE_ENQUIRY };
  if (state === 'open') filter.completed = false;
  if (state === 'done') filter.completed = true;
  if (!isManagement(user)) {
    if (isOwnershipScoped(user)) {
      const [enquiries, customers] = await Promise.all([
        Enquiry.find(ownershipFilter(user)).distinct('_id'),
        Customer.find(customerScope(user)).distinct('_id'),
      ]);
      /*
       * Their own enquiries only. A task on a colleague's enquiry is not theirs to follow even
       * when the buyer is theirs or shared with them — a delegated enquiry leaves the customer
       * with its first owner [delegation.service], and every task on it then showed up on both
       * dashboards. The customer still decides a team task raised without an enquiry.
       */
      filter.$or = [
        { createdBy: user._id },
        { user: user._id },
        { enquiry: { $in: enquiries } },
        { enquiry: null, customer: { $in: customers } },
      ];
    } else {
      filter.department = { $in: departmentsOf(user) };
    }
  }
  if (department) {
    const allowed = filter.department ? members.filter((key) => filter.department.$in.includes(key)) : members;
    if (!allowed.length) return [];
    filter.department = { $in: allowed };
  }
  const tasks = await Todo.find(filter)
    /* Enough to work the task from the board, not only to list it: what was asked, every update
       with who wrote it, the PDF, the outcome [components/TaskPanel.jsx]. */
    .select('kind department fromDepartment title notes brief status dueDate priority user createdBy customer enquiry order createdAt updates attention completed completedAt holds attachment resultFile outcome suggestion')
    .populate([
      { path: 'customer', select: 'name code' },
      { path: 'enquiry', select: 'number requirement.modelNumber items.modelNumber' },
      { path: 'order', select: 'number' },
      { path: 'createdBy', select: 'name' },
      { path: 'user', select: 'name' },
      { path: 'updates.by', select: 'name' },
      { path: 'outcome.by', select: 'name' },
      { path: 'attachment', select: 'key filename size' },
      WAITING_ON_POPULATE,
    ])
    .sort(state === 'open' ? { dueDate: 1, createdAt: 1 } : { completed: 1, completedAt: -1, createdAt: -1 })
    .limit(Math.min(Math.max(Number(limit) || 300, 1), 500))
    .lean();
  return tasks.map((task) => {
    const handoff = findHandoff(task.kind);
    return { ...task, label: handoff?.label || task.title, team: handoff?.form?.team || null };
  });
}

/* ------------------------------ Customer / party master ------------------------------ */

const QUOTATION_STEPS = ['quotation_preparing', 'quotation_sent', 'pricing_discussion', 'price_approved'];
const SAMPLE_STEPS = ['sample_requested', 'sample_sent'];
const PLANT_STEPS = ['production', 'mould', 'assembling', 'qc', 'dispatch', 'lr_copy'];
const PAYMENT_STAGES = ['team_payment_followup', 'my_payment_followup'];

/** The chips over the list, each a test on a customer's row. */
const FILTERS = {
  all: () => true,
  new_enquiry: (row) => row.isNew,
  due_today: (row, ctx) => Boolean(row.followUp && row.followUp <= ctx.tonight),
  idle: (row, ctx) => !row.lastActivity || row.lastActivity < ctx.weekAgo,
  quotation: (row) => QUOTATION_STEPS.includes(row.statusKey),
  sampling: (row) => SAMPLE_STEPS.includes(row.statusKey),
  production: (row) => PLANT_STEPS.includes(row.statusKey),
  payment: (row) => PAYMENT_STAGES.includes(row.stage),
};
export const PARTY_FILTERS = Object.keys(FILTERS);

/**
 * The buyers allocated to this person, each with where its newest live enquiry stands — or that
 * it has none and wants a call. Counted per chip so the chips can say how many; paged.
 *
 * Their own, for everyone — Admin included. The dashboard is a day's work, and Admin's day is
 * the buyers on Admin's own list; every buyer, with delegation, is the Masters page. Admin may
 * ask for one colleague's list instead (`owner`), to see a marketing person's day as they see
 * it; anyone else asking is answered with their own.
 */
export async function partiesFor(user, { filter = 'all', page = 1, limit = 50, search = '', owner } = {}) {
  const now = new Date();
  const ctx = { tonight: endOfDayIST(now), weekAgo: new Date(now.getTime() - 7 * DAY_MS) };
  const named = String(search || '').trim();
  const match = named ? { name: new RegExp(named.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } : {};
  const whose = isManagement(user) && owner && /^[0-9a-f]{24}$/i.test(String(owner)) ? owner : user._id;
  const [customers, enquiries] = await Promise.all([
    Customer.find({ assignedTo: whose, ...match }).select('name code assignedTo updatedAt followUp').populate('assignedTo', 'name').sort({ name: 1 }).lean(),
    Enquiry.find(activeEnquiries(user))
      .select('customer marketingStatus status stage nextFollowUpDate nextAction requirement.modelNumber items.modelNumber updatedAt')
      .sort({ updatedAt: -1 })
      .lean(),
  ]);
  /*
   * The newest live enquiry per customer says where it stands; but any of its live enquiries can
   * make it due today or new — so the chips agree with the figures over the list.
   */
  const latest = new Map();
  const soonest = new Map();
  const fresh = new Set();
  for (const enquiry of enquiries) {
    const key = String(enquiry.customer);
    if (!latest.has(key)) latest.set(key, enquiry);
    /* Due like the Due now list: a won enquiry is not chased. */
    const due = enquiry.nextFollowUpDate && !CLOSED_STATUSES.includes(enquiry.status) ? new Date(enquiry.nextFollowUpDate) : null;
    if (due && (!soonest.has(key) || due < soonest.get(key))) soonest.set(key, due);
    if (marketingStatusOf(enquiry) === 'enquiry_received') fresh.add(key);
  }
  const rows = customers.map((customer) => {
    const enquiry = latest.get(String(customer._id));
    const statusKey = enquiry ? marketingStatusOf(enquiry) : null;
    const model = enquiry?.requirement?.modelNumber || enquiry?.items?.find((item) => item.modelNumber)?.modelNumber;
    const lastActivity = [customer.updatedAt, enquiry?.updatedAt].filter(Boolean).map((date) => new Date(date)).sort((a, b) => b - a)[0];
    return {
      _id: customer._id,
      name: customer.name,
      code: customer.code,
      owner: customer.assignedTo?.name || null,
      enquiry: enquiry ? enquiry._id : null,
      statusKey,
      stage: enquiry?.stage || null,
      status: enquiry ? marketingStatusLabel(statusKey) : 'Follow-up pending',
      line: enquiry ? (enquiry.nextAction || `Model: ${model || 'Not specified'}`) : 'Contact customer and update status',
      isNew: fresh.has(String(customer._id)),
      /* The sooner of the customer's own follow-up and any of its enquiries'. */
      followUp: [soonest.get(String(customer._id)), customer.followUp?.due && new Date(customer.followUp.due)]
        .filter(Boolean).sort((a, b) => a - b)[0] || null,
      customerFollowUp: customer.followUp ? { due: customer.followUp.due, note: customer.followUp.note || null, priority: customer.followUp.priority } : null,
      lastActivity: lastActivity || null,
    };
  });
  const counts = Object.fromEntries(PARTY_FILTERS.map((key) => [key, rows.filter((row) => FILTERS[key](row, ctx)).length]));
  const chosen = FILTERS[filter] ? filter : 'all';
  const kept = rows.filter((row) => FILTERS[chosen](row, ctx));
  const size = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const at = Math.max(Number(page) || 1, 1);
  return {
    rows: kept.slice((at - 1) * size, at * size),
    total: kept.length,
    page: at,
    pages: Math.max(1, Math.ceil(kept.length / size)),
    counts,
    filter: chosen,
  };
}

/* ------------------------------ Today's actions ------------------------------ */

const ACTION_TYPE_LABELS = { call: 'Call', whatsapp: 'WhatsApp', email: 'Email', meeting: 'Meeting', visit: 'Visit', send_quote: 'Pricing', send_sample: 'Sample' };

/**
 * The card beside the customer list: what this person has to chase — every open follow-up on
 * a customer assigned to them (set from the list, worked from the card), and the enquiries on
 * their customers (or handed to them) whose next action is due by tonight. Soonest first;
 * "pending" is what is due by tonight, overdue included.
 */
export async function followUpsFor(user, { limit = 60 } = {}) {
  const now = new Date();
  const tonight = endOfDayIST(now);
  const today = startOfDayIST(now);
  /*
   * Only this person's own: the customers assigned to them, and the enquiries on those customers
   * or handed to them (a delegated enquiry, a prospect). Admin too — the card is "what I have to
   * chase today", not a view of everybody's; the overview and the lists show the rest.
   */
  const mine = await Customer.distinct('_id', { assignedTo: user._id });
  const [customers, enquiries] = await Promise.all([
    Customer.find({ ...customerScope(user), assignedTo: user._id, 'followUp.due': { $exists: true } })
      .select('name code followUp')
      .sort({ 'followUp.due': 1 })
      .limit(200)
      .lean(),
    Enquiry.find({ $and: [openForMarketing(user), { nextFollowUpDate: { $lte: tonight } }, { $or: [{ assignedTo: user._id }, { customer: { $in: mine } }] }] })
      .select('number customer prospect nextAction nextActionType nextFollowUpDate requirement.modelNumber items.modelNumber')
      .populate('customer', 'name')
      .sort({ nextFollowUpDate: 1 })
      .limit(200)
      .lean(),
  ]);
  const when = (due) => (due < today ? 'overdue' : due <= tonight ? 'today' : 'upcoming');
  const items = [
    ...customers.map((customer) => {
      const due = new Date(customer.followUp.due);
      return {
        kind: 'customer',
        _id: `customer:${customer._id}`,
        customer: { _id: customer._id, name: customer.name, code: customer.code },
        title: customer.followUp.note || 'Follow up',
        context: customer.code,
        due,
        state: when(due),
        tag: customer.followUp.priority === 'high' ? 'High' : 'Follow-up',
      };
    }),
    ...enquiries.map((enquiry) => {
      const due = new Date(enquiry.nextFollowUpDate);
      const model = enquiry.requirement?.modelNumber || enquiry.items?.find((item) => item.modelNumber)?.modelNumber;
      return {
        kind: 'enquiry',
        _id: `enquiry:${enquiry._id}`,
        enquiry: { _id: enquiry._id, number: enquiry.number },
        customer: enquiry.customer ? { _id: enquiry.customer._id, name: enquiry.customer.name } : null,
        prospect: enquiry.customer ? null : enquiry.prospect?.name || null,
        title: enquiry.nextAction || 'Follow up',
        context: [enquiry.number, model].filter(Boolean).join(' · '),
        due,
        state: when(due),
        tag: ACTION_TYPE_LABELS[enquiry.nextActionType] || 'Enquiry',
      };
    }),
  ].sort((a, b) => a.due - b.due);
  return {
    pending: items.filter((item) => item.state !== 'upcoming').length,
    overdue: items.filter((item) => item.state === 'overdue').length,
    items: items.slice(0, Math.min(Math.max(Number(limit) || 60, 1), 200)),
    total: items.length,
  };
}
