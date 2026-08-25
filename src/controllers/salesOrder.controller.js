import SalesOrder from '../models/SalesOrder.js';
import ProductionOrder from '../models/ProductionOrder.js';
import Bom from '../models/Bom.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import crudController from './crud.factory.js';
import { calculateTotals } from '../utils/money.js';
import { nextNumber } from '../services/numbering.service.js';
import { defaultWarehouse, postMovements, onHand } from '../services/inventory.service.js';

const withTotals = (body) => {
  const { lines, subtotal, discountTotal, taxTotal, grandTotal } = calculateTotals(body.lines || []);
  return { ...body, lines, subtotal, discountTotal, taxTotal, grandTotal };
};

export const salesOrderCrud = crudController(SalesOrder, {
  searchFields: ['number', 'customerPoNumber'],
  populate: [
    { path: 'customer', select: 'code name gstin email phone creditLimit' },
    { path: 'lines.product', select: 'sku name uom hangerType material color' },
    { path: 'owner', select: 'name email' },
  ],
  beforeCreate: async (body, req) => ({
    ...withTotals(body),
    number: body.number || (await nextNumber('SO')),
    owner: body.owner || req.user._id,
  }),
  beforeUpdate: (body) => (body.lines ? withTotals(body) : body),
});

/**
 * Raises one production order per order line, netting off finished goods already in stock.
 * Lines that are fully covered by stock are skipped.
 */
export const planProduction = asyncHandler(async (req, res) => {
  const order = await SalesOrder.findById(req.params.id).populate('lines.product', 'sku name');
  if (!order) throw ApiError.notFound('Sales order not found');
  if (['cancelled', 'closed'].includes(order.status)) {
    throw ApiError.badRequest(`Cannot plan production for a ${order.status} order`);
  }

  const created = [];
  const skipped = [];

  for (const line of order.lines) {
    const productId = line.product?._id || line.product;
    const available = await onHand('Product', productId);
    const shortfall = line.quantity - line.quantityDispatched - available;

    if (shortfall <= 0) {
      skipped.push({ product: productId, reason: 'covered by available stock' });
      continue;
    }

    const bom = await Bom.findOne({ product: productId, isActive: true }).sort('-version');
    const productionOrder = await ProductionOrder.create({
      number: await nextNumber('PRD'),
      product: productId,
      bom: bom?._id,
      salesOrder: order._id,
      quantityPlanned: Math.ceil(shortfall),
      plannedStart: req.body.plannedStart,
      plannedEnd: req.body.plannedEnd || order.deliveryDate,
      supervisor: req.body.supervisor,
      materials:
        bom?.components.map((component) => ({
          material: component.material,
          quantityRequired:
            component.quantityPerUnit * Math.ceil(shortfall) * (1 + component.scrapPercent / 100),
          uom: component.uom,
        })) || [],
    });

    created.push(productionOrder);
  }

  if (created.length) {
    order.status = 'in_production';
    await order.save();
  }

  res.status(201).json({ success: true, data: { productionOrders: created, skipped } });
});

/** Dispatches finished goods against the order, issuing stock and advancing the status. */
export const dispatch = asyncHandler(async (req, res) => {
  const order = await SalesOrder.findById(req.params.id);
  if (!order) throw ApiError.notFound('Sales order not found');
  if (['cancelled', 'closed'].includes(order.status)) {
    throw ApiError.badRequest(`Cannot dispatch a ${order.status} order`);
  }

  const warehouseId = req.body.warehouse || (await defaultWarehouse('finished_goods'))._id;
  const requested = req.body.lines?.length
    ? req.body.lines
    : order.lines.map((line) => ({
        product: String(line.product),
        quantity: line.quantity - line.quantityDispatched,
      }));

  const movements = [];
  for (const item of requested) {
    const line = order.lines.find((candidate) => String(candidate.product) === String(item.product));
    if (!line) throw ApiError.badRequest(`Product ${item.product} is not on this order`);

    const pending = line.quantity - line.quantityDispatched;
    if (item.quantity > pending) {
      throw ApiError.badRequest(`Dispatch quantity ${item.quantity} exceeds pending ${pending}`);
    }
    if (item.quantity <= 0) continue;

    movements.push({
      itemType: 'Product',
      item: line.product,
      warehouse: warehouseId,
      quantity: -item.quantity,
      type: 'sales_dispatch',
      reference: { docType: 'SalesOrder', docId: order._id, docNumber: order.number },
      createdBy: req.user._id,
    });
  }

  if (!movements.length) throw ApiError.badRequest('Nothing left to dispatch on this order');

  await postMovements(movements);

  for (const item of requested) {
    const line = order.lines.find((candidate) => String(candidate.product) === String(item.product));
    if (line && item.quantity > 0) line.quantityDispatched += item.quantity;
  }

  const fullyDispatched = order.lines.every((line) => line.quantityDispatched >= line.quantity);
  order.status = fullyDispatched ? 'dispatched' : 'partially_dispatched';
  await order.save();

  res.json({ success: true, data: order });
});
