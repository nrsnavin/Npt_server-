import Quotation from '../models/Quotation.js';
import SalesOrder from '../models/SalesOrder.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import crudController from './crud.factory.js';
import { calculateTotals } from '../utils/money.js';
import { nextNumber } from '../services/numbering.service.js';

const withTotals = (body) => {
  const { lines, subtotal, discountTotal, taxTotal, grandTotal } = calculateTotals(body.lines || []);
  return { ...body, lines, subtotal, discountTotal, taxTotal, grandTotal };
};

export const quotationCrud = crudController(Quotation, {
  searchFields: ['number', 'notes'],
  populate: [
    { path: 'customer', select: 'code name gstin email phone' },
    { path: 'lines.product', select: 'sku name uom' },
    { path: 'owner', select: 'name email' },
  ],
  beforeCreate: async (body, req) => ({
    ...withTotals(body),
    number: body.number || (await nextNumber('QUO')),
    owner: body.owner || req.user._id,
  }),
  beforeUpdate: (body) => (body.lines ? withTotals(body) : body),
});

/** Creates a sales order from an accepted quotation, carrying prices across unchanged. */
export const convertToSalesOrder = asyncHandler(async (req, res) => {
  const quotation = await Quotation.findById(req.params.id);
  if (!quotation) throw ApiError.notFound('Quotation not found');
  if (quotation.salesOrder) throw ApiError.conflict('This quotation already has a sales order');
  if (quotation.status === 'rejected' || quotation.status === 'expired') {
    throw ApiError.badRequest(`A ${quotation.status} quotation cannot be converted`);
  }

  const salesOrder = await SalesOrder.create({
    number: await nextNumber('SO'),
    customer: quotation.customer,
    quotation: quotation._id,
    customerPoNumber: req.body.customerPoNumber,
    deliveryDate: req.body.deliveryDate,
    priority: req.body.priority || 'normal',
    shippingAddress: req.body.shippingAddress,
    lines: quotation.lines.map((line) => ({ ...line.toObject(), quantityDispatched: 0 })),
    subtotal: quotation.subtotal,
    discountTotal: quotation.discountTotal,
    taxTotal: quotation.taxTotal,
    grandTotal: quotation.grandTotal,
    owner: quotation.owner || req.user._id,
  });

  quotation.status = 'converted';
  quotation.salesOrder = salesOrder._id;
  await quotation.save();

  res.status(201).json({ success: true, data: salesOrder });
});
