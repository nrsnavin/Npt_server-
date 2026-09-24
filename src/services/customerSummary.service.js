import SalesOrder from '../models/SalesOrder.js';
import Receivable from '../models/Receivable.js';
import { MAYBE_OWING, applyPaymentPositions } from './paymentPosition.service.js';

const round2 = (value) => Math.round(value * 100) / 100;

/** An order's value with GST, as `SalesOrder#totalValue` works it out, from a plain object. */
function orderTotal(order) {
  const net = round2((order.lines || []).reduce(
    (sum, line) => sum + (line.unitPrice && line.quantity ? round2(line.unitPrice * line.quantity) : 0), 0));
  return order.isExport || !order.gstPercent ? net : round2(net * (1 + order.gstPercent / 100));
}

/**
 * Business and balance beside each customer on a list page.
 *
 * Every order and every receivable of the page's customers used to be loaded as full documents
 * — for a big buyer, years of orders — to add up two figures each. Now only the fields the sum
 * is made of, as plain objects, and only receivables that could still be owed.
 */
export async function customerSummaries(customers) {
  if (!customers.length) return customers;
  const ids = customers.map(customer => customer._id);
  const [orders, receivables] = await Promise.all([
    SalesOrder.find({ customer: { $in: ids }, status: { $ne: 'cancelled' } })
      .select('customer orderDate isExport gstPercent lines.unitPrice lines.quantity')
      .lean(),
    Receivable.find({ customer: { $in: ids }, ...MAYBE_OWING }),
  ]);
  await applyPaymentPositions(receivables);
  const summaries = new Map(ids.map(id => [String(id), { totalBusinessValue: 0, outstandingAmount: 0, lastOrderDate: null }]));
  for (const order of orders) {
    const summary = summaries.get(String(order.customer));
    summary.totalBusinessValue += orderTotal(order);
    if (!summary.lastOrderDate || order.orderDate > summary.lastOrderDate) summary.lastOrderDate = order.orderDate;
  }
  for (const row of receivables) summaries.get(String(row.customer)).outstandingAmount += row.balance;
  return customers.map(customer => {
    const summary = summaries.get(String(customer._id));
    summary.totalBusinessValue = Math.round(summary.totalBusinessValue * 100) / 100;
    summary.outstandingAmount = Math.round(summary.outstandingAmount * 100) / 100;
    return { ...customer.toObject(), ...summary };
  });
}
