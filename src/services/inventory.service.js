import ApiError from '../utils/ApiError.js';
import Stock from '../models/Stock.js';
import StockMovement from '../models/StockMovement.js';
import Warehouse from '../models/Warehouse.js';

/**
 * Applies a single stock change: updates the on-hand balance and appends a ledger entry.
 * `quantity` is signed — positive receives stock, negative issues it.
 */
export async function postMovement({
  itemType,
  item,
  warehouse,
  quantity,
  type,
  unitCost = 0,
  reference,
  remarks,
  createdBy,
  allowNegative = false,
}) {
  if (!quantity) throw ApiError.badRequest('Stock movement quantity cannot be zero');

  const stock =
    (await Stock.findOne({ itemType, item, warehouse })) ||
    new Stock({ itemType, item, warehouse, quantity: 0, averageCost: unitCost });

  const newQuantity = stock.quantity + quantity;
  if (newQuantity < 0 && !allowNegative) {
    throw ApiError.badRequest(
      `Insufficient stock: on hand ${stock.quantity}, requested ${Math.abs(quantity)}`
    );
  }

  // Weighted average costing, recalculated only on receipts.
  if (quantity > 0 && unitCost > 0) {
    const currentValue = stock.quantity * stock.averageCost;
    const incomingValue = quantity * unitCost;
    stock.averageCost = newQuantity > 0 ? (currentValue + incomingValue) / newQuantity : unitCost;
  }

  stock.quantity = newQuantity;
  await stock.save();

  const movement = await StockMovement.create({
    itemType,
    item,
    warehouse,
    quantity,
    type,
    unitCost: unitCost || stock.averageCost,
    balanceAfter: newQuantity,
    reference,
    remarks,
    createdBy,
  });

  return { stock, movement };
}

/** Applies several movements in sequence, rolling each one back if a later one fails. */
export async function postMovements(movements) {
  const applied = [];
  try {
    for (const movement of movements) {
      applied.push(await postMovement(movement));
    }
    return applied;
  } catch (error) {
    for (const { movement } of applied.reverse()) {
      await postMovement({
        itemType: movement.itemType,
        item: movement.item,
        warehouse: movement.warehouse,
        quantity: -movement.quantity,
        type: 'adjustment',
        remarks: `Rollback of ${movement._id}`,
        allowNegative: true,
      });
      await StockMovement.deleteOne({ _id: movement._id });
    }
    throw error;
  }
}

/** Resolves the default warehouse of a given type, used when a caller does not pass one. */
export async function defaultWarehouse(type) {
  const warehouse = await Warehouse.findOne({ type, isActive: true });
  if (!warehouse) {
    throw ApiError.badRequest(`No active ${type} warehouse configured`);
  }
  return warehouse;
}

export async function onHand(itemType, item, warehouse) {
  const filter = { itemType, item };
  if (warehouse) filter.warehouse = warehouse;
  const rows = await Stock.find(filter);
  return rows.reduce((sum, row) => sum + row.quantity, 0);
}
