import Customer from '../models/Customer.js';
import Enquiry from '../models/Enquiry.js';
import Quotation from '../models/Quotation.js';
import Todo from '../models/Todo.js';
import { findHandoff } from '../config/handoffs.js';
import { marketingStatusLabel, marketingStatusOf } from '../config/marketingStatuses.js';
import { customerScope, isOwnershipScoped, ownershipFilter } from './ownership.service.js';
import { departmentsOf, isManagement } from '../utils/departments.js';
import { endOfDayIST } from './handoff.service.js';
import { DEPARTMENT_KEYS } from '../config/modules.js';
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
const activeEnquiries = (user) => ({ ...ownershipFilter(user), stage: { $ne: 'closed' }, status: { $ne: 'lost' } });

/** Marketing's first step — an enquiry nobody has verified and moved on yet. */
const isNew = { $or: [{ marketingStatus: 'enquiry_received' }, { marketingStatus: null, status: { $in: ['new', 'requirement_clarification'] } }] };

const LIVE_QUOTES = ['costing', 'draft', 'approval_pending', 'approved', 'sent', 'revised'];

export async function overviewFor(user) {
  const tonight = endOfDayIST(new Date());
  const active = activeEnquiries(user);
  const [customers, dueToday, open, quotations, newCount, fresh] = await Promise.all([
    Customer.countDocuments(customerScope(user)),
    Enquiry.countDocuments({ ...active, nextFollowUpDate: { $lte: tonight } }),
    Enquiry.countDocuments(active),
    Quotation.countDocuments({ ...ownershipFilter(user), status: { $in: LIVE_QUOTES } }),
    Enquiry.countDocuments({ ...active, ...isNew }),
    Enquiry.find({ ...active, ...isNew })
      .select('number customer assignedTo requirement.modelNumber enquiryDate createdAt')
      .populate([{ path: 'customer', select: 'name code' }, { path: 'assignedTo', select: 'name' }])
      .sort({ createdAt: -1 })
      .limit(6)
      .lean(),
  ]);
  return {
    figures: { customers, dueToday, activeEnquiries: open, quotations },
    newEnquiries: { total: newCount, rows: fresh },
  };
}

/* ------------------------------ Department tasks to follow ------------------------------ */

/** Marketing's holding task is the enquiry itself, not a task anybody was asked to do. */
const NOT_THE_ENQUIRY = { $nor: [{ holds: true, kind: { $in: ['new_enquiry', 'back_to_marketing', 'my_payment_followup'] } }] };

export const TASK_STATES = ['open', 'done', 'all'];

/**
 * The department tasks this person follows: Admin every one; a marketing person those on their
 * own enquiries and customers, and the ones they raised; anyone else their department's.
 *
 * Filtered by department and by state — open (the default), done, or all — so Admin can read
 * any one department's tasks, finished ones included. A department outside what this person
 * may see returns nothing rather than widening the scope.
 */
export async function trackedTasks(user, { department, state = 'open', limit = 300 } = {}) {
  if (!TASK_STATES.includes(state)) throw new ApiError(400, `State must be one of ${TASK_STATES.join(', ')}`);
  if (department && !DEPARTMENT_KEYS.includes(department)) throw new ApiError(400, `Unknown department “${department}”`);
  const filter = { kind: { $exists: true }, ...NOT_THE_ENQUIRY };
  if (state === 'open') filter.completed = false;
  if (state === 'done') filter.completed = true;
  if (!isManagement(user)) {
    if (isOwnershipScoped(user)) {
      const [enquiries, customers] = await Promise.all([
        Enquiry.find(ownershipFilter(user)).distinct('_id'),
        Customer.find(customerScope(user)).distinct('_id'),
      ]);
      filter.$or = [{ createdBy: user._id }, { user: user._id }, { enquiry: { $in: enquiries } }, { customer: { $in: customers } }];
    } else {
      filter.department = { $in: departmentsOf(user) };
    }
  }
  if (department) {
    if (filter.department && !filter.department.$in.includes(department)) return [];
    filter.department = department;
  }
  const tasks = await Todo.find(filter)
    .select('kind department title notes brief status dueDate priority user createdBy customer enquiry createdAt updates attention completed completedAt')
    .populate([
      { path: 'customer', select: 'name code' },
      { path: 'enquiry', select: 'number requirement.modelNumber items.modelNumber' },
      { path: 'createdBy', select: 'name' },
      { path: 'user', select: 'name' },
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
 * Every customer this person may see, each with where its newest live enquiry stands — or that
 * it has none and wants a call. Counted per chip so the chips can say how many; paged.
 */
export async function partiesFor(user, { filter = 'all', page = 1, limit = 50, search = '' } = {}) {
  const now = new Date();
  const ctx = { tonight: endOfDayIST(now), weekAgo: new Date(now.getTime() - 7 * DAY_MS) };
  const named = String(search || '').trim();
  const match = named ? { name: new RegExp(named.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } : {};
  const [customers, enquiries] = await Promise.all([
    Customer.find({ ...customerScope(user), ...match }).select('name code assignedTo updatedAt').populate('assignedTo', 'name').sort({ name: 1 }).lean(),
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
    const due = enquiry.nextFollowUpDate ? new Date(enquiry.nextFollowUpDate) : null;
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
      followUp: soonest.get(String(customer._id)) || null,
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
