import Customer from '../models/Customer.js';
import { isManagement } from '../utils/departments.js';
import Dispatch from '../models/Dispatch.js';
import Enquiry, { checkPending } from '../models/Enquiry.js';
import { CLOSED_STAGE } from '../config/enquiryStages.js';
import Quotation from '../models/Quotation.js';
import Receivable from '../models/Receivable.js';
import SalesOrder from '../models/SalesOrder.js';
import Sample from '../models/Sample.js';
import Todo from '../models/Todo.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import { afterCommit } from '../utils/transaction.js';
import { marketingTeam } from './assignment.service.js';
import { sendPush } from './push.service.js';

/**
 * Handing an enquiry to another marketing person, an Admin, or taking it yourself, at any stage.
 *
 * Admin does it — for an owner going on leave, a buyer in a colleague's area, too much on one
 * desk. The owner asks Admin; they cannot pass it on themselves. What moves is everything that decides whose queue the work sits in:
 *
 * - the enquiry's owner, and a line in its `handovers` saying who passed it, to whom and why;
 * - the open tasks about it that were the old owner's (marketing's holding task among them);
 * - its samples, quotations and orders, and those orders' dispatches and receivables, while
 *   they are the old owner's — otherwise the new owner holds an enquiry whose sample and price
 *   they cannot open;
 * - the buyer is shared with the new owner, so the customer page opens for them. The buyer's
 *   own owner does not change: their other enquiries stay where they are.
 *
 * Who did what stays put: the history, the call log and every "by" field still name whoever
 * did it.
 */

const isAdmin = isManagement;
const idOf = (value) => String(value?._id || value || '');

/**
 * Admin, always: handing a worked enquiry to someone else is Admin's decision, not its owner's.
 * And the owner of a draft still being checked [`checkPending`]: an enquiry read off a photo
 * lands on whoever captured it, and the person checking it says whose it really is — the
 * buyer's marketing person, or a colleague — on the draft screen itself, before any department
 * is asked for anything. Once checked, it is Admin's call again.
 */
export const mayDelegate = (user, enquiry) =>
  isAdmin(user) || Boolean(enquiry && checkPending(enquiry) && idOf(enquiry.assignedTo) === idOf(user?._id));

/**
 * Who an enquiry may go to: everyone on the marketing team, every Admin, and the person handing
 * it over themselves (an Admin taking it on) — all but its current owner. Each says which it is,
 * so the screen can group them.
 */
export async function delegationTargets(enquiry, user) {
  const [team, admins] = await Promise.all([
    marketingTeam(),
    User.find({ role: 'admin', isActive: { $ne: false } }).sort({ createdAt: 1, _id: 1 }).select('_id name'),
  ]);
  const seen = new Set([idOf(enquiry.assignedTo)]);
  const people = [];
  const add = (person, group) => {
    if (seen.has(idOf(person._id))) return;
    seen.add(idOf(person._id));
    people.push({ _id: person._id, name: person.name, group, self: idOf(person._id) === idOf(user?._id) });
  };
  team.forEach((person) => add(person, 'marketing'));
  admins.forEach((person) => add(person, 'admin'));
  if (user && mayDelegate(user, enquiry)) add(user, isAdmin(user) ? 'admin' : 'marketing');
  return people;
}

/**
 * Everything on the enquiry that was the old owner's, now the new one's: the open tasks on
 * their list (the holding task among them), the samples, quotations, orders, consignments and
 * receivables — so nothing of the enquiry stays on a list its new owner cannot see. Used by
 * delegation and by a change of owner on the enquiry itself.
 */
export async function moveWorkWith({ enquiry, from, to }) {
  const moved = { tasks: 0, samples: 0, quotations: 0, orders: 0, dispatches: 0, receivables: 0 };
  const previous = idOf(from);
  if (!previous || previous === idOf(to)) return moved;
  const mine = (field) => ({ [field]: previous });
  moved.tasks = (await Todo.updateMany(
    { enquiry: enquiry._id, completed: false, ...mine('user') },
    { $set: { user: to } }
  )).modifiedCount;
  moved.samples = (await Sample.updateMany({ enquiry: enquiry._id, ...mine('requestedBy') }, { $set: { requestedBy: to } })).modifiedCount;
  moved.quotations = (await Quotation.updateMany({ enquiry: enquiry._id, ...mine('assignedTo') }, { $set: { assignedTo: to } })).modifiedCount;

  const orders = (await SalesOrder.find({ enquiry: enquiry._id }).select('_id')).map((row) => row._id);
  if (orders.length) {
    moved.orders = (await SalesOrder.updateMany({ _id: { $in: orders }, ...mine('assignedTo') }, { $set: { assignedTo: to } })).modifiedCount;
    moved.dispatches = (await Dispatch.updateMany({ order: { $in: orders }, ...mine('assignedTo') }, { $set: { assignedTo: to } })).modifiedCount;
    moved.receivables = (await Receivable.updateMany({ order: { $in: orders }, ...mine('assignedTo') }, { $set: { assignedTo: to } })).modifiedCount;
  }
  return moved;
}

export async function delegateEnquiry({ enquiry, to, note, user }) {
  if (!mayDelegate(user, enquiry)) {
    throw ApiError.forbidden('Only Admin can hand an enquiry to someone else — or its owner, while the draft is still being checked');
  }
  const from = idOf(enquiry.assignedTo);
  if (idOf(to) === from) throw ApiError.badRequest('It is already theirs');

  const target = (await delegationTargets(enquiry, user)).find((person) => idOf(person._id) === idOf(to));
  if (!target) {
    throw ApiError.badRequest('An enquiry can only be handed to an active marketing person, an Admin, or yourself');
  }

  enquiry.assignedTo = target._id;
  enquiry.handovers.push({ from: from || undefined, to: target._id, by: user._id, note: note || undefined });
  await enquiry.save();

  const moved = await moveWorkWith({ enquiry, from, to: target._id });

  afterCommit(async () => {
    if (idOf(target._id) === idOf(user._id)) return;
    const buyer = await Customer.findById(enquiry.customer?._id || enquiry.customer).select('name');
    await sendPush([target._id], {
      title: `${enquiry.number} is yours now`,
      body: `${user.name || 'Admin'} handed you ${buyer?.name ? `${buyer.name}'s enquiry` : 'this enquiry'}${note ? ` — ${note.slice(0, 200)}` : ''}`,
      link: `/enquiries/${enquiry._id}`,
    }).catch((error) => console.error(`[delegation] push not sent: ${error.message}`));
  });

  const previous = from ? await User.findById(from).select('name') : null;
  return { enquiry, to: { _id: target._id, name: target.name }, from: previous, moved };
}

/**
 * Handing a buyer to another marketing person — the customer and every enquiry of theirs still
 * being worked [web: components/CustomerPanel.jsx]. Admin's decision, as for one enquiry.
 *
 * Each open enquiry goes through `delegateEnquiry`, so its tasks, samples, quotations, orders and
 * the rest move exactly as they would one at a time; a lost or closed enquiry stays where it was,
 * with the person who worked it. The customer's own follow-up goes with the customer.
 */
export async function delegateCustomer({ customer, to, note, user }) {
  if (!mayDelegate(user)) throw ApiError.forbidden('Only Admin can hand a customer to someone else');
  const from = idOf(customer.assignedTo);
  if (idOf(to) === from) throw ApiError.badRequest('They already hold this customer');

  const target = (await delegationTargets({ assignedTo: customer.assignedTo }, user)).find((person) => idOf(person._id) === idOf(to));
  if (!target) {
    throw ApiError.badRequest('A customer can only be handed to an active marketing person, an Admin, or yourself');
  }

  customer.assignedTo = target._id;
  customer.sharedWith = (customer.sharedWith || []).filter((shared) => idOf(shared) !== idOf(target._id));
  await customer.save();
  /* The buyer's own open tasks on the old owner's list — a follow-up raised on the buyer alone — go too. */
  if (from) await Todo.updateMany({ customer: customer._id, enquiry: null, completed: false, user: from }, { $set: { user: target._id } });

  const open = await Enquiry.find({ customer: customer._id, status: { $ne: 'lost' }, stage: { $ne: CLOSED_STAGE } });
  const enquiries = [];
  for (const enquiry of open) {
    if (idOf(enquiry.assignedTo) === idOf(target._id)) continue;
    await delegateEnquiry({ enquiry, to: target._id, note, user });
    enquiries.push(enquiry.number);
  }

  afterCommit(async () => {
    if (idOf(target._id) === idOf(user._id)) return;
    await sendPush([target._id], {
      title: `${customer.name} is yours now`,
      body: `${user.name || 'Admin'} handed you ${customer.name}${enquiries.length ? ` and ${enquiries.length} open ${enquiries.length === 1 ? 'enquiry' : 'enquiries'}` : ''}${note ? ` — ${note.slice(0, 200)}` : ''}`,
      link: `/customers/${customer._id}`,
    }).catch((error) => console.error(`[delegation] push not sent: ${error.message}`));
  });

  const previous = from ? await User.findById(from).select('name') : null;
  return { customer, to: { _id: target._id, name: target.name }, from: previous, enquiries };
}
