import PurchaseOrder from '../models/PurchaseOrder.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import crudController from './crud.factory.js';
import { calculateTotals } from '../utils/money.js';
import { nextNumber } from '../services/numbering.service.js';
import { defaultWarehouse, postMovements } from '../services/inventory.service.js';

const withTotals = (body) => {
  const { lines, subtotal, discountTotal, taxTotal, grandTotal } = calculateTotals(body.lines || []);
  return { ...body, lines, subtotal, discountTotal, taxTotal, grandTotal };
};

export const purchaseOrderCrud = crudController(PurchaseOrder, {
  searchFields: ['number', 'notes'],
  populate: [
    { path: 'supplier', select: 'code name email phone leadTimeDays' },
    { path: 'lines.material', select: 'code name uom' },
    { path: 'warehouse', select: 'code name' },
  ],
  beforeCreate: async (body, req) => ({
    ...withTotals(body),
    number: body.number || (await nextNumber('PO')),
    createdBy: req.user._id,
  }),
  beforeUpdate: (body) => (body.lines ? withTotals(body) : body),
});

/** Receives material against a purchase order and books it into the raw material store. */
export const receive = asyncHandler(async (req, res) => {
  const order = await PurchaseOrder.findById(req.params.id);
  if (!order) throw ApiError.notFound('Purchase order not found');
  if (order.status === 'cancelled') throw ApiError.badRequest('This purchase order is cancelled');
  if (order.status === 'received') throw ApiError.badRequest('This purchase order is fully received');

  const warehouseId =
    req.body.warehouse || order.warehouse || (await defaultWarehouse('raw_material'))._id;

  const requested = req.body.lines?.length
    ? req.body.lines
    : order.lines.map((line) => ({
        material: String(line.material),
        quantity: line.quantity - line.quantityReceived,
      }));

  const movements = [];
  for (const item of requested) {
    const line = order.lines.find((candidate) => String(candidate.material) === String(item.material));
    if (!line) throw ApiError.badRequest(`Material ${item.material} is not on this purchase order`);

    const pending = line.quantity - line.quantityReceived;
    if (item.quantity > pending) {
      throw ApiError.badRequest(`Receipt quantity ${item.quantity} exceeds pending ${pending}`);
    }
    if (item.quantity <= 0) continue;

    movements.push({
      itemType: 'Material',
      item: line.material,
      warehouse: warehouseId,
      quantity: item.quantity,
      type: 'purchase_receipt',
      unitCost: line.unitPrice,
      reference: { docType: 'PurchaseOrder', docId: order._id, docNumber: order.number },
      createdBy: req.user._id,
    });
  }

  if (!movements.length) throw ApiError.badRequest('Nothing left to receive on this purchase order');

  await postMovements(movements);

  for (const item of requested) {
    const line = order.lines.find((candidate) => String(candidate.material) === String(item.material));
    if (line && item.quantity > 0) line.quantityReceived += item.quantity;
  }

  const fullyReceived = order.lines.every((line) => line.quantityReceived >= line.quantity);
  order.status = fullyReceived ? 'received' : 'partially_received';
  order.warehouse = warehouseId;
  await order.save();

  res.json({ success: true, data: order });
});
