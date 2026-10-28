import SalesOrder from '../models/SalesOrder.js';
import Enquiry from '../models/Enquiry.js';
import Todo from '../models/Todo.js';
import User from '../models/User.js';
import TaskNotice from '../models/TaskNotice.js';
import ApiError from '../utils/ApiError.js';
import { afterCommit } from '../utils/transaction.js';
import { MANAGEMENT_QUERY, inDepartment, isManagement } from '../utils/departments.js';
import { draftWaitsWords } from './soFromTask.service.js';

/**
 * The sales order the SO team's upload drafted [soFromTask.service] is read by two people before
 * the plant sees it: the SO team verifies it against the SO they sent the buyer, and the enquiry's
 * marketing person or Admin confirms it is the buyer's order — on the enquiry page, the SO task or
 * the order itself. Until both, the order is not released and Production is not asked, whatever
 * the request said; with both it goes on as the upload would have [handoff.service
 * `continueAfterDraft`]: released and Production asked when Production was confirmed on the
 * request, else waiting for Move to Production. Each side is told when the other has done its part.
 */

const idOf = (value) => String(value?._id || value || '');

/** The SO team (Sales / SO), or Admin. */
export const mayVerifyDraft = (user) => isManagement(user) || inDepartment(user, 'order_confirmation');

/** Admin, or the enquiry's marketing person — whoever it is with now; the order's owner when there is no enquiry. */
export const mayConfirmDraft = (user, { enquiry, order }) => {
  if (isManagement(user)) return true;
  const owner = enquiry?.assignedTo ? idOf(enquiry.assignedTo) : idOf(order?.assignedTo);
  return Boolean(owner) && owner === idOf(user?._id);
};

/** What the screens show of the review: who has read it, who still must, and what this person may do. */
export async function draftReviewOf(order, user) {
  if (!order?.drafted?.from) return null;
  const enquiry = order.enquiry ? await Enquiry.findById(idOf(order.enquiry)).select('number assignedTo stage').lean() : null;
  const names = async (check) => (check?.by ? { by: (await User.findById(check.by).select('name').lean())?.name || null, at: check.at, note: check.note || null } : null);
  const pending = order.draftPending;
  return {
    pending,
    from: order.drafted.from,
    soNumber: order.drafted.soNumber || null,
    soDate: order.drafted.soDate || null,
    differences: order.drafted.differences || [],
    readProblem: order.drafted.readProblem || null,
    draftedAt: order.drafted.at || null,
    verified: await names(order.drafted.verified),
    confirmed: await names(order.drafted.confirmed),
    mayVerify: pending && !order.drafted.verified?.by && mayVerifyDraft(user),
    mayConfirm: pending && !order.drafted.confirmed?.by && mayConfirmDraft(user, { enquiry, order }),
    waits: pending ? draftWaitsWords(order) : null,
    enquiry: enquiry ? { _id: enquiry._id, number: enquiry.number, stage: enquiry.stage } : null,
  };
}

async function recipientsFor(order, { skip } = {}) {
  const [enquiry, admins] = await Promise.all([
    order.enquiry ? Enquiry.findById(idOf(order.enquiry)).select('assignedTo').lean() : null,
    User.find({ ...MANAGEMENT_QUERY, isActive: { $ne: false } }).select('_id').lean(),
  ]);
  const marketing = idOf(enquiry?.assignedTo || order.assignedTo);
  const uploader = order.sourceTask ? idOf((await Todo.findById(idOf(order.sourceTask)).select('user createdBy').lean())?.user) : '';
  const all = new Set([marketing, uploader, ...admins.map((person) => idOf(person._id))].filter(Boolean));
  if (skip) all.delete(idOf(skip));
  return { all: [...all], marketing, uploader, admins: admins.map((person) => idOf(person._id)) };
}

/** A line under "Needs your action", and on the phone, about the draft — to the people named. */
async function tellAbout(order, recipients, { by, status, label, note, link }) {
  const ids = [...new Set(recipients.filter(Boolean).map(String))];
  if (!ids.length) return;
  const enquiryId = order.enquiry ? idOf(order.enquiry) : undefined;
  await TaskNotice.insertMany(ids.map((recipient) => ({
    recipient, order: order._id, task: order.sourceTask || undefined, enquiry: enquiryId, customer: idOf(order.customer) || undefined,
    department: 'order_confirmation', kind: 'sales_order', status, statusLabel: label, note: note || undefined, by: by?._id || undefined, at: new Date(),
  })));
  afterCommit(() => import('./push.service.js')
    .then(({ sendPush }) => sendPush(ids, { title: `Sales / SO: ${label}`, body: String(note || '').slice(0, 200), link: link || `/orders/${order._id}`, kind: 'order' }))
    .catch((error) => console.error(`[orders] draft push not sent: ${error.message}`)));
}

/** The draft just made: the SO team to verify it, marketing or Admin to confirm it. */
export async function noticeDraft(order, { by } = {}) {
  const { all } = await recipientsFor(order);
  const lines = (order.lines || []).map((line) => `${line.modelNumber || 'a model'} ${Number(line.quantity || 0).toLocaleString('en-IN')} pcs`).join(' · ');
  await tellAbout(order, all, {
    by, status: 'draft_to_review', label: `Sales order ${order.number} drafted — to verify and confirm`,
    note: [lines, order.drafted?.differences?.length && `differs from the request: ${order.drafted.differences.join('; ')}`].filter(Boolean).join(' — '),
    link: order.enquiry ? `/enquiries/${idOf(order.enquiry)}` : `/orders/${order._id}`,
  });
}

async function record(order, user, which, note) {
  if (!order.drafted?.from) throw ApiError.badRequest(`${order.number} is not a draft — it was booked on the Sales orders screen`);
  if (!order.draftPending) throw ApiError.conflict(`${order.number} is already verified and confirmed`);
  if (order.drafted[which]?.by) throw ApiError.conflict(`${order.number} is already ${which}`);
  order.drafted[which] = { by: user._id, at: new Date(), note: String(note || '').trim() || undefined };
  order.markModified('drafted');
  order.statusHistory.push({ from: order.status, to: order.status, by: user._id, note: `Draft ${which} by ${user.name}${note ? `: ${String(note).trim()}` : ''}` });
  await order.save();
}

/**
 * Both read it: the order goes on as the upload would have [handoff.service `continueAfterDraft`].
 * One of them: the other side is told it is their turn.
 */
async function afterReview(order, user) {
  const { all, marketing, uploader, admins } = await recipientsFor(order, { skip: user });
  if (order.draftPending) {
    const verified = Boolean(order.drafted.verified?.by);
    const turn = verified ? [marketing, ...admins] : [uploader, ...admins];
    await tellAbout(order, turn.filter((id) => all.includes(id)), {
      by: user, status: verified ? 'draft_verified' : 'draft_confirmed',
      label: verified ? `Sales order ${order.number} verified by the SO team — confirm it` : `Sales order ${order.number} confirmed by ${user.name} — verify it`,
      note: order.drafted[verified ? 'verified' : 'confirmed']?.note,
      link: verified && order.enquiry ? `/enquiries/${idOf(order.enquiry)}` : `/orders/${order._id}`,
    });
    return { pending: true };
  }
  const { continueAfterDraft } = await import('./handoff.service.js');
  const outcome = await continueAfterDraft(order, user);
  await tellAbout(order, all, {
    by: user, status: 'draft_approved',
    label: `Sales order ${order.number} verified and confirmed`,
    note: outcome.said,
    link: order.enquiry ? `/enquiries/${idOf(order.enquiry)}` : `/orders/${order._id}`,
  });
  return { pending: false, ...outcome };
}

/** The SO team's reading of the draft against the SO they sent. */
export async function verifyDraft(order, user, { note } = {}) {
  if (!mayVerifyDraft(user)) throw ApiError.forbidden('Only the Sales / SO team or Admin verifies a drafted sales order');
  await record(order, user, 'verified', note);
  return afterReview(order, user);
}

/** Marketing's (or Admin's) word that this is the buyer's order. */
export async function confirmDraft(order, user, { note } = {}) {
  const enquiry = order.enquiry ? await Enquiry.findById(idOf(order.enquiry)).select('assignedTo').lean() : null;
  if (!mayConfirmDraft(user, { enquiry, order })) throw ApiError.forbidden('Only Admin or the enquiry’s marketing person confirms a drafted sales order');
  await record(order, user, 'confirmed', note);
  return afterReview(order, user);
}

/** The order behind a review call, fresh. */
export const draftOrder = async (id) => {
  const order = await SalesOrder.findById(id);
  if (!order) throw ApiError.notFound('Order not found');
  return order;
};
