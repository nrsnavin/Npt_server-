import Dispatch, { GONE_DISPATCH_STATUSES } from '../models/Dispatch.js';
import SalesOrder from '../models/SalesOrder.js';
import { raiseForDispatch } from './receivable.service.js';
import { rollUpDispatchStatus, stockFor } from './dispatchStock.service.js';
import { withOperationLock } from './operationLock.service.js';

/** Called with the order lock held. The dispatch is the durable retry record. */
export async function completeDispatchEffects(dispatch, user) {
  if (GONE_DISPATCH_STATUSES.includes(dispatch.status) && !dispatch.accountingCompletedAt) {
    const receivable = await raiseForDispatch(dispatch, { by: user });
    if (!receivable) throw new Error(`Dispatch ${dispatch.number} needs a valid invoice before accounting can complete`);
    if (receivable.invoice.value !== dispatch.invoice.value || receivable.invoice.number !== dispatch.invoice.number ||
        +new Date(receivable.invoice.date) !== +new Date(dispatch.invoice.date)) {
      throw new Error(`Dispatch ${dispatch.number} has an invoice mismatch requiring accounts review`);
    }
    dispatch.accountingPending = false;
    dispatch.accountingCompletedAt = new Date();
  }
  const order = await SalesOrder.findById(dispatch.order);
  const moved = order ? rollUpDispatchStatus(order, await stockFor(order), user) : null;
  if (moved) await order.save();
  dispatch.orderSyncPending = false;
  if (dispatch.isModified()) await dispatch.save();
  return moved;
}

export async function reconcileDispatches({ onError = error => console.error('Dispatch recovery:', error.message) } = {}) {
  const pending = await Dispatch.find({ $or: [
    { orderSyncPending: true }, { accountingPending: true },
    { status: { $in: GONE_DISPATCH_STATUSES }, accountingCompletedAt: { $exists: false } },
  ] }).select('_id order');
  let completed = 0;
  for (const row of pending) {
    try {
      await withOperationLock(`order:${row.order}`, async () => {
        const dispatch = await Dispatch.findById(row._id);
        if (dispatch) await completeDispatchEffects(dispatch);
      });
      completed++;
    } catch (error) { if (error.statusCode !== 409) onError(error); }
  }
  return { checked: pending.length, completed };
}
