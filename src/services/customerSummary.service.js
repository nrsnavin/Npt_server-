import SalesOrder from '../models/SalesOrder.js';
import Receivable from '../models/Receivable.js';
import { applyPaymentPositions } from './paymentPosition.service.js';

export async function customerSummaries(customers) {
  if (!customers.length) return customers;
  const ids = customers.map(customer => customer._id);
  const [orders, receivables] = await Promise.all([
    SalesOrder.find({ customer: { $in: ids }, status: { $ne: 'cancelled' } }),
    Receivable.find({ customer: { $in: ids } }),
  ]);
  await applyPaymentPositions(receivables);
  const summaries = new Map(ids.map(id => [String(id), { totalBusinessValue: 0, outstandingAmount: 0, lastOrderDate: null }]));
  for (const order of orders) {
    const summary = summaries.get(String(order.customer));
    summary.totalBusinessValue += order.totalValue;
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
