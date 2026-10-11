import SalesOrder from '../models/SalesOrder.js';
import { stockFor } from './dispatchStock.service.js';

/**
 * Where an enquiry may not simply move on: Dispatch cannot close its task while one of the
 * enquiry's sales orders still has pieces to send — answered from the enquiry's own records, so
 * the refusal says exactly what is left. (Dispatch used to wait for a Quality pass as well; the
 * plant dropped that lock — Quality is asked when the goods should be checked.)
 */

/** The open (not closed, not cancelled) sales orders raised on this enquiry. */
const openOrders = (enquiryId) =>
  SalesOrder.find({ enquiry: enquiryId, status: { $nin: ['closed', 'cancelled'] } });

/**
 * What is still to be sent on the enquiry's open orders: `[{ number, pieces }]`, empty when
 * everything has gone. A line the plant called finished and shipped in full counts as sent
 * (`stockOf.fullyShipped`), so the ±5% a quotation allows never leaves a balance for ever.
 */
export async function dispatchBalance(enquiryId) {
  const orders = await openOrders(enquiryId);
  const left = [];
  for (const order of orders) {
    const stock = await stockFor(order);
    const pieces = stock
      .filter((line) => !line.fullyShipped)
      .reduce((sum, line) => sum + Math.max(0, (line.quantity || 0) - (line.dispatched || 0)), 0);
    if (pieces > 0) left.push({ number: order.number, pieces });
  }
  return left;
}

export const describeBalance = (left) =>
  left.map((row) => `${row.number} has ${row.pieces.toLocaleString('en-IN')} pcs`).join(', ');
