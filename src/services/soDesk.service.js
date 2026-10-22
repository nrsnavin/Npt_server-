import Todo from '../models/Todo.js';
import Enquiry from '../models/Enquiry.js';
import SalesOrder, { OPEN_ORDER_STATUSES, PRE_RELEASE_STATUSES } from '../models/SalesOrder.js';
import Receivable from '../models/Receivable.js';
import Customer from '../models/Customer.js';
import { enquiriesHeldBy } from './handoff.service.js';
import { creditStatusOf } from './collections.service.js';
import { paymentStanding } from './paymentGates.service.js';

/**
 * The SO team's desk, read at a glance [web: components/SoDesk.jsx]. Every open SO request with
 * what the team needs to decide what to do with it:
 *
 *   readiness   whether the request can be prepared as it stands — the lines, pieces and price
 *               on every model and the payment terms — or what is still missing to ask for
 *   size        models, pieces and value (pieces × price), so an order is sized before it is read
 *   edd         the earliest date a line promises, and whether it is close with no SO yet
 *   buyer       the last order's number, date and terms, the credit status and what is overdue
 *   duplicate   an order already open on the enquiry, or another SO request for it
 *   question    a Needs Clarification: what was asked, and the answer if it came
 *
 * and, beside the queue, what the week booked and where it went (Production, held, awaiting the
 * advance), and every prepared order still not in production.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const SOON_DAYS = 7;
const WEEK_MS = 7 * DAY_MS;

const number = (value) => {
  const n = Number(String(value ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const blank = (value) => String(value ?? '').trim() === '';
const dayOf = (value) => (value ? String(value).slice(0, 10) : '');

/** The request's lines as sized: models, pieces, value, the earliest EDD. */
export function sizeOf(brief = {}) {
  const lines = Array.isArray(brief.items) ? brief.items.filter((row) => row && Object.values(row).some((cell) => !blank(cell))) : [];
  let pieces = 0;
  let value = 0;
  let priced = 0;
  let earliest = '';
  for (const row of lines) {
    const qty = number(row.quantity);
    const price = number(row.price);
    pieces += qty;
    if (qty && price) { value += qty * price; priced += 1; }
    const edd = dayOf(row.edd);
    if (edd && (!earliest || edd < earliest)) earliest = edd;
  }
  return { models: lines.length, pieces, value: Math.round(value), priced, earliestEdd: earliest || null, lines };
}

/**
 * What stops the SO being prepared as the request stands [config/departmentTaskForms.js po_so]:
 * no line, a line with no model, pieces or price, no payment terms. The PO number and the contact
 * are wanted but do not block — the SO team can still prepare and chase them.
 */
export function readinessOf(brief = {}) {
  const { lines } = sizeOf(brief);
  const missing = [];
  const soft = [];
  if (!lines.length) missing.push('the models to order');
  lines.forEach((row, at) => {
    const name = blank(row.model) ? `row ${at + 1}` : String(row.model).trim();
    if (blank(row.model)) missing.push(`model on row ${at + 1}`);
    if (!number(row.quantity)) missing.push(`pieces for ${name}`);
    if (!number(row.price)) missing.push(`price for ${name}`);
  });
  if (blank(brief.paymentTerms)) missing.push('payment terms');
  if (blank(brief.poNumber)) soft.push('PO number');
  if (blank(brief.contactPerson) && blank(brief.mobile)) soft.push('contact person');
  return { ready: missing.length === 0, missing, soft };
}

/** "20 Oct 2026" */
const prettyDay = (day) => (day ? new Date(`${day}T00:00:00+05:30`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

/** The value and pieces of an order's lines. */
const orderSize = (order) => (order?.lines || []).reduce((sum, line) => ({
  pieces: sum.pieces + (line.quantity || 0),
  value: sum.value + (line.quantity || 0) * (line.unitPrice || 0),
}), { pieces: 0, value: 0 });

/** Where a prepared order stands: in production, held with marketing, waiting for the advance, or on its checks. */
async function whereItWent(order, enquiry) {
  if (!order) return { key: 'none', label: 'No order booked' };
  if (order.releasedAt || !PRE_RELEASE_STATUSES.includes(order.status)) return { key: 'production', label: 'In production' };
  if (enquiry?.stage === 'production_hold') return { key: 'held', label: 'Held — Production not confirmed' };
  const standing = await paymentStanding(order).catch(() => null);
  const advance = standing?.production;
  if (advance && advance.required > 0 && !advance.met && !advance.waived) return { key: 'advance', label: `Awaiting advance — ₹${Math.round(advance.short).toLocaleString('en-IN')} short` };
  return { key: 'checks', label: 'Checks pending before release' };
}

/** The buyer as the SO team should know them before preparing: last order and its terms, credit, what is overdue. */
async function buyerOf(customerId, now) {
  if (!customerId) return null;
  const [customer, last, receivables] = await Promise.all([
    Customer.findById(customerId).select('name credit paymentTermsDays').lean(),
    SalesOrder.findOne({ customer: customerId, status: { $ne: 'cancelled' } }).sort({ createdAt: -1 }).select('number createdAt paymentTerms status releasedAt').lean(),
    Receivable.find({ customer: customerId, balance: { $gt: 0 } }).select('balance dueBy status').lean(),
  ]);
  if (!customer) return null;
  const overdue = receivables.filter((row) => row.status === 'overdue' || (row.dueBy && new Date(row.dueBy) < now)).reduce((sum, row) => sum + (row.balance || 0), 0);
  const outstanding = receivables.reduce((sum, row) => sum + (row.balance || 0), 0);
  const status = creditStatusOf(customer.credit);
  return {
    name: customer.name,
    lastOrder: last ? { number: last.number, date: last.createdAt, terms: last.paymentTerms || null } : null,
    usualTerms: last?.paymentTerms || null,
    credit: { status, reason: customer.credit?.override?.reason || customer.credit?.derived?.reason || null },
    overdue: Math.round(overdue),
    outstanding: Math.round(outstanding),
  };
}

/** A Needs Clarification: the question, and the answer if marketing gave it. */
async function questionOf(task) {
  /* Shown while the request waits on the answer, and after it comes until the team says Got it. */
  if (task.status !== 'clarification' && task.attention?.kind !== 'reply') return null;
  const asked = [...(task.statusHistory || [])].reverse().find((entry) => entry.status === 'clarification');
  const child = await Todo.findOne({ kind: 'so_clarification', parentTask: task._id }).sort({ createdAt: -1 })
    .select('completed completedAt outcome user createdAt').populate('user', 'name').lean();
  const reply = task.attention?.kind === 'reply' ? task.attention : null;
  return {
    question: asked?.note || task.updates?.findLast?.((entry) => entry.status === 'clarification')?.text || '',
    askedAt: asked?.at || null,
    answer: reply ? { text: reply.note, at: reply.at } : child?.completed ? { text: child.outcome?.note || '', at: child.completedAt } : null,
    waitingOn: !reply && child && !child.completed ? { name: child.user?.name || 'marketing', since: child.createdAt } : null,
  };
}

export async function soDesk(user, { now = new Date() } = {}) {
  const held = await enquiriesHeldBy('order_confirmation', user, { now });
  const requests = held.filter((row) => row.task.kind === 'po_so');
  const enquiryIds = requests.map((row) => row.enquiry?._id).filter(Boolean);
  const [openOrders, otherRequests] = await Promise.all([
    enquiryIds.length ? SalesOrder.find({ enquiry: { $in: enquiryIds }, status: { $in: OPEN_ORDER_STATUSES } }).select('enquiry number status').lean() : [],
    enquiryIds.length ? Todo.find({ enquiry: { $in: enquiryIds }, kind: 'po_so', completed: false }).select('enquiry createdAt').lean() : [],
  ]);
  const buyers = new Map();
  const rows = [];
  for (const row of requests) {
    const brief = row.task.brief || {};
    const size = sizeOf(brief);
    const readiness = readinessOf(brief);
    const customerId = row.enquiry?.customer?._id || row.task.customer?._id || row.task.customer || null;
    const key = customerId ? String(customerId) : null;
    if (key && !buyers.has(key)) buyers.set(key, await buyerOf(customerId, now));
    const enquiryKey = row.enquiry ? String(row.enquiry._id) : null;
    const openOrder = enquiryKey ? openOrders.find((order) => String(order.enquiry) === enquiryKey) : null;
    const others = enquiryKey ? otherRequests.filter((other) => String(other.enquiry) === enquiryKey && String(other._id) !== String(row.task._id)) : [];
    const prepared = row.task.status === 'prepared';
    const daysToEdd = size.earliestEdd ? Math.ceil((new Date(`${size.earliestEdd}T00:00:00+05:30`).getTime() - now.getTime()) / DAY_MS) : null;
    rows.push({
      ...row,
      so: {
        lane: row.task.status || 'waiting',
        size: { ...size, lines: undefined },
        lines: size.lines,
        readiness,
        edd: size.earliestEdd ? { date: size.earliestEdd, pretty: prettyDay(size.earliestEdd), days: daysToEdd, urgent: !prepared && daysToEdd != null && daysToEdd <= SOON_DAYS } : null,
        buyer: key ? buyers.get(key) : null,
        duplicate: openOrder || others.length
          ? { order: openOrder ? { _id: openOrder._id, number: openOrder.number, status: openOrder.status } : null, requests: others.length }
          : null,
        question: await questionOf(row.task),
        terms: brief.paymentTerms || null,
        poNumber: brief.poNumber || null,
      },
    });
  }
  /* Ready first, then by the earliest EDD, then by when it came. */
  rows.sort((a, b) => Number(b.so.readiness.ready) - Number(a.so.readiness.ready)
    || (a.so.edd?.date || '9999').localeCompare(b.so.edd?.date || '9999')
    || new Date(a.since) - new Date(b.since));

  /* The week's SOs prepared, and where each went. */
  const week = new Date(now.getTime() - WEEK_MS);
  const done = await Todo.find({ kind: 'po_so', department: 'order_confirmation', completed: true, completedAt: { $gte: week } })
    .sort({ completedAt: -1 }).limit(40).select('enquiry order customer completedAt completedBy brief').populate('customer', 'name').lean();
  const booked = [];
  for (const task of done) {
    const order = task.order
      ? await SalesOrder.findById(task.order).select('number status releasedAt lines customer enquiry').lean()
      : task.enquiry ? await SalesOrder.findOne({ enquiry: task.enquiry, status: { $ne: 'cancelled' } }).sort({ createdAt: -1 }).select('number status releasedAt lines customer enquiry').lean() : null;
    const enquiry = task.enquiry ? await Enquiry.findById(task.enquiry).select('number stage customer').populate('customer', 'name').lean() : null;
    const went = await whereItWent(order, enquiry);
    const size = order ? orderSize(order) : sizeOf(task.brief || {});
    booked.push({
      task: { _id: task._id, completedAt: task.completedAt },
      enquiry: enquiry ? { _id: enquiry._id, number: enquiry.number } : null,
      customer: enquiry?.customer?.name || task.customer?.name || null,
      order: order ? { _id: order._id, number: order.number, status: order.status } : null,
      pieces: size.pieces, value: Math.round(size.value), went,
    });
  }

  /* Every prepared order not yet in production — the ones the team is asked about. */
  const pending = await SalesOrder.find({ status: { $in: PRE_RELEASE_STATUSES } }).sort({ createdAt: -1 }).limit(50)
    .select('number status lines customer enquiry createdAt').populate('customer', 'name').lean();
  const heldOrders = [];
  for (const order of pending) {
    const enquiry = order.enquiry ? await Enquiry.findById(order.enquiry).select('number stage').lean() : null;
    const went = await whereItWent(order, enquiry);
    if (went.key === 'production') continue;
    const size = orderSize(order);
    heldOrders.push({ order: { _id: order._id, number: order.number, status: order.status, createdAt: order.createdAt }, enquiry: enquiry ? { _id: enquiry._id, number: enquiry.number } : null, customer: order.customer?.name || null, pieces: size.pieces, value: Math.round(size.value), went });
  }

  const lanes = { waiting: 0, preparing: 0, clarification: 0, prepared: 0 };
  for (const row of rows) lanes[row.so.lane] = (lanes[row.so.lane] || 0) + 1;
  return {
    rows,
    others: held.filter((row) => row.task.kind !== 'po_so'),
    summary: {
      requests: rows.length,
      ready: rows.filter((row) => row.so.readiness.ready).length,
      missing: rows.filter((row) => !row.so.readiness.ready).length,
      value: rows.reduce((sum, row) => sum + row.so.size.value, 0),
      pieces: rows.reduce((sum, row) => sum + row.so.size.pieces, 0),
      eddSoon: rows.filter((row) => row.so.edd?.urgent).length,
      lanes,
      bookedValue: booked.reduce((sum, row) => sum + row.value, 0),
      bookedCount: booked.length,
      heldCount: heldOrders.length,
    },
    booked,
    held: heldOrders,
  };
}
