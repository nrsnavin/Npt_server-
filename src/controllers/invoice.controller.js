import Invoice from '../models/Invoice.js';
import Payment from '../models/Payment.js';
import SalesOrder from '../models/SalesOrder.js';
import Customer from '../models/Customer.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import crudController from './crud.factory.js';
import { calculateTotals, round2 } from '../utils/money.js';
import { nextNumber } from '../services/numbering.service.js';

const withTotals = (body) => {
  const { lines, subtotal, discountTotal, taxTotal, grandTotal } = calculateTotals(body.lines || []);
  return { ...body, lines, subtotal, discountTotal, taxTotal, grandTotal };
};

/** Keeps the customer's receivable balance in step with their open invoices. */
async function refreshOutstanding(customerId) {
  const [summary] = await Invoice.aggregate([
    { $match: { customer: customerId, status: { $ne: 'cancelled' } } },
    { $group: { _id: null, billed: { $sum: '$grandTotal' }, paid: { $sum: '$amountPaid' } } },
  ]);

  await Customer.findByIdAndUpdate(customerId, {
    outstandingAmount: round2((summary?.billed || 0) - (summary?.paid || 0)),
  });
}

export const invoiceCrud = crudController(Invoice, {
  searchFields: ['number', 'notes'],
  populate: [
    { path: 'customer', select: 'code name gstin email phone paymentTermsDays' },
    { path: 'lines.product', select: 'sku name uom' },
    { path: 'salesOrder', select: 'number' },
  ],
  beforeCreate: async (body, req) => ({
    ...withTotals(body),
    number: body.number || (await nextNumber('INV')),
    createdBy: req.user._id,
  }),
  beforeUpdate: (body) => (body.lines ? withTotals(body) : body),
  afterWrite: (doc) => refreshOutstanding(doc.customer),
});

/** Raises an invoice for an existing sales order, defaulting to the full ordered quantity. */
export const createFromSalesOrder = asyncHandler(async (req, res) => {
  const order = await SalesOrder.findById(req.params.id).populate('customer', 'paymentTermsDays');
  if (!order) throw ApiError.notFound('Sales order not found');
  if (order.status === 'cancelled') throw ApiError.badRequest('This sales order is cancelled');

  const invoiceDate = req.body.invoiceDate ? new Date(req.body.invoiceDate) : new Date();
  const termsDays = order.customer?.paymentTermsDays ?? 30;
  const dueDate = req.body.dueDate
    ? new Date(req.body.dueDate)
    : new Date(invoiceDate.getTime() + termsDays * 24 * 60 * 60 * 1000);

  const invoice = await Invoice.create({
    number: await nextNumber('INV'),
    customer: order.customer._id || order.customer,
    salesOrder: order._id,
    invoiceDate,
    dueDate,
    lines: order.lines.map(({ quantityDispatched, ...line }) => line),
    subtotal: order.subtotal,
    discountTotal: order.discountTotal,
    taxTotal: order.taxTotal,
    grandTotal: order.grandTotal,
    placeOfSupply: req.body.placeOfSupply,
    createdBy: req.user._id,
  });

  await refreshOutstanding(invoice.customer);

  res.status(201).json({ success: true, data: invoice });
});

/** Records a receipt against an invoice and updates its payment status. */
export const recordPayment = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) throw ApiError.notFound('Invoice not found');
  if (invoice.status === 'cancelled') throw ApiError.badRequest('This invoice is cancelled');

  const amount = Number(req.body.amount);
  if (!amount || amount <= 0) throw ApiError.badRequest('Payment amount must be greater than zero');

  const due = round2(invoice.grandTotal - invoice.amountPaid);
  if (amount > due) throw ApiError.badRequest(`Payment exceeds the outstanding amount of ${due}`);

  const payment = await Payment.create({
    number: await nextNumber('PAY'),
    customer: invoice.customer,
    invoice: invoice._id,
    amount,
    paymentDate: req.body.paymentDate || new Date(),
    mode: req.body.mode || 'bank_transfer',
    referenceNumber: req.body.referenceNumber,
    notes: req.body.notes,
    createdBy: req.user._id,
  });

  invoice.amountPaid = round2(invoice.amountPaid + amount);
  invoice.status = invoice.amountPaid >= invoice.grandTotal ? 'paid' : 'partially_paid';
  await invoice.save();

  await refreshOutstanding(invoice.customer);

  res.status(201).json({ success: true, data: { invoice, payment } });
});

/** Open invoices bucketed by how long they are past due. */
export const ageing = asyncHandler(async (_req, res) => {
  const invoices = await Invoice.find({ status: { $in: ['unpaid', 'partially_paid'] } })
    .populate('customer', 'code name')
    .sort('dueDate');

  const now = Date.now();
  const buckets = { current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, days_90_plus: 0 };

  const rows = invoices.map((invoice) => {
    const due = round2(invoice.grandTotal - invoice.amountPaid);
    const daysOverdue = invoice.dueDate
      ? Math.floor((now - new Date(invoice.dueDate).getTime()) / (24 * 60 * 60 * 1000))
      : 0;

    if (daysOverdue <= 0) buckets.current += due;
    else if (daysOverdue <= 30) buckets.days_1_30 += due;
    else if (daysOverdue <= 60) buckets.days_31_60 += due;
    else if (daysOverdue <= 90) buckets.days_61_90 += due;
    else buckets.days_90_plus += due;

    return {
      id: invoice._id,
      number: invoice.number,
      customer: invoice.customer,
      dueDate: invoice.dueDate,
      grandTotal: invoice.grandTotal,
      amountDue: due,
      daysOverdue: Math.max(daysOverdue, 0),
    };
  });

  Object.keys(buckets).forEach((key) => {
    buckets[key] = round2(buckets[key]);
  });

  res.json({ success: true, data: { buckets, invoices: rows } });
});
