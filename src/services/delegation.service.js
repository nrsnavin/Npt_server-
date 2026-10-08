import Customer from '../models/Customer.js';
import Dispatch from '../models/Dispatch.js';
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
 * Handing an enquiry to another marketing person, at any stage.
 *
 * The owner does it themselves (going on leave, a buyer in a colleague's area, too much on) or
 * Admin does it for them. What moves is everything that decides whose queue the work sits in:
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

const isAdmin = (user) => user?.role === 'admin' || user?.department === 'management';
const idOf = (value) => String(value?._id || value || '');

/** The owner, or Admin. */
export const mayDelegate = (user, enquiry) =>
  isAdmin(user) || idOf(enquiry.assignedTo) === idOf(user?._id);

/** The marketing people an enquiry may go to: everyone on the team but its current owner. */
export async function delegationTargets(enquiry) {
  const team = await marketingTeam();
  return team.filter((person) => idOf(person._id) !== idOf(enquiry.assignedTo));
}

export async function delegateEnquiry({ enquiry, to, note, user }) {
  if (!mayDelegate(user, enquiry)) {
    throw ApiError.forbidden('Only the enquiry’s owner or Admin can hand it to someone else');
  }
  const from = idOf(enquiry.assignedTo);
  if (idOf(to) === from) throw ApiError.badRequest('It is already theirs');

  const team = await marketingTeam();
  const target = team.find((person) => idOf(person._id) === idOf(to));
  if (!target) {
    throw ApiError.badRequest('An enquiry can only be handed to an active marketing person who can work enquiries');
  }

  enquiry.assignedTo = target._id;
  enquiry.handovers.push({ from: from || undefined, to: target._id, by: user._id, note: note || undefined });
  await enquiry.save();

  const moved = { tasks: 0, samples: 0, quotations: 0, orders: 0, dispatches: 0, receivables: 0 };
  if (from) {
    const mine = (field) => ({ [field]: from });
    moved.tasks = (await Todo.updateMany(
      { enquiry: enquiry._id, completed: false, ...mine('user') },
      { $set: { user: target._id } }
    )).modifiedCount;
    moved.samples = (await Sample.updateMany({ enquiry: enquiry._id, ...mine('requestedBy') }, { $set: { requestedBy: target._id } })).modifiedCount;
    moved.quotations = (await Quotation.updateMany({ enquiry: enquiry._id, ...mine('assignedTo') }, { $set: { assignedTo: target._id } })).modifiedCount;

    const orders = (await SalesOrder.find({ enquiry: enquiry._id }).select('_id')).map((row) => row._id);
    if (orders.length) {
      moved.orders = (await SalesOrder.updateMany({ _id: { $in: orders }, ...mine('assignedTo') }, { $set: { assignedTo: target._id } })).modifiedCount;
      moved.dispatches = (await Dispatch.updateMany({ order: { $in: orders }, ...mine('assignedTo') }, { $set: { assignedTo: target._id } })).modifiedCount;
      moved.receivables = (await Receivable.updateMany({ order: { $in: orders }, ...mine('assignedTo') }, { $set: { assignedTo: target._id } })).modifiedCount;
    }
  }
  await Customer.updateOne(
    { _id: enquiry.customer?._id || enquiry.customer, assignedTo: { $ne: target._id } },
    { $addToSet: { sharedWith: target._id } }
  );

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
