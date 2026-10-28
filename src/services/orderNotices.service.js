import { afterCommit } from '../utils/transaction.js';
import { MANAGEMENT_QUERY } from '../utils/departments.js';

/**
 * A sales order booked — from the Sales orders screen, off an accepted quotation, or from the SO
 * team's request [order.controller `createOrder`, `orderFromQuotation`; soFromTask.service] —
 * is news for every Admin and the buyer's marketing person: under "Needs your action"
 * [models/TaskNotice.js], and on their phones. Whoever booked it is not told of their own move.
 * Never fails the booking.
 */
export async function noticeOrderBooked(order, { by } = {}) {
  /* A draft from the SO team's upload is told as a draft to read, not as an order booked [soDraftReview.service `noticeDraft`]. */
  if (order?.drafted?.from) return;
  try {
    const [{ default: TaskNotice }, { default: User }, { default: Enquiry }, { default: Customer }] = await Promise.all([
      import('../models/TaskNotice.js'), import('../models/User.js'), import('../models/Enquiry.js'), import('../models/Customer.js'),
    ]);
    const [enquiry, customer, admins] = await Promise.all([
      order.enquiry ? Enquiry.findById(order.enquiry?._id || order.enquiry).select('number assignedTo').lean() : null,
      order.customer ? Customer.findById(order.customer?._id || order.customer).select('name assignedTo').lean() : null,
      User.find({ ...MANAGEMENT_QUERY, isActive: { $ne: false } }).select('_id').lean(),
    ]);
    /* The enquiry's marketing person, else the buyer's, else whoever the order names. */
    const owner = enquiry?.assignedTo || customer?.assignedTo || order.assignedTo;
    const recipients = new Set([owner, ...admins.map((person) => person._id)].filter(Boolean).map(String));
    if (by?._id) recipients.delete(String(by._id));
    if (!recipients.size) return;

    const lines = (order.lines || []).map((line) => `${line.modelNumber || 'a model'} ${Number(line.quantity || 0).toLocaleString('en-IN')} pcs`);
    const pieces = (order.lines || []).reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);
    const note = [
      lines.join(' · '),
      order.customerPo?.number && `PO ${order.customerPo.number}`,
      order.paymentTerms && `terms: ${order.paymentTerms}`,
    ].filter(Boolean).join(' — ');
    const statusLabel = `Sales order ${order.number} created`;
    const at = new Date();
    await TaskNotice.insertMany([...recipients].map((recipient) => ({
      recipient, order: order._id, enquiry: enquiry?._id, customer: customer?._id || order.customer,
      department: 'order_confirmation', kind: 'sales_order', status: 'order_booked', statusLabel,
      note: note || undefined, by: by?._id || undefined, at,
    })));

    const title = `Sales / SO: ${statusLabel}`;
    const body = [customer?.name, `${pieces.toLocaleString('en-IN')} pcs on ${lines.length} ${lines.length === 1 ? 'model' : 'models'}`, by?.name && `by ${by.name}`].filter(Boolean).join(' — ').slice(0, 200);
    const link = `/orders/${order._id}`;
    afterCommit(() => import('./push.service.js')
      .then(({ sendPush }) => sendPush([...recipients], { title, body, link, kind: 'order' }))
      .catch((error) => console.error(`[orders] booked push not sent: ${error.message}`)));
  } catch (error) {
    console.error(`[orders] ${order?.number || 'order'} booked — notice not sent: ${error.message}`);
  }
}
