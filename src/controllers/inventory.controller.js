import Stock from '../models/Stock.js';
import StockMovement from '../models/StockMovement.js';
import Material from '../models/Material.js';
import Product from '../models/Product.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { postMovement } from '../services/inventory.service.js';
import { round2 } from '../utils/money.js';

/** Current balances, optionally filtered by item type or warehouse. */
export const stockLevels = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.itemType) filter.itemType = req.query.itemType;
  if (req.query.warehouse) filter.warehouse = req.query.warehouse;

  const rows = await Stock.find(filter)
    .populate('warehouse', 'code name type')
    .populate('item')
    .sort('itemType');

  const data = rows
    .filter((row) => row.item)
    .map((row) => ({
      id: row._id,
      itemType: row.itemType,
      itemId: row.item._id,
      code: row.item.sku || row.item.code,
      name: row.item.name,
      uom: row.item.uom || 'pcs',
      warehouse: row.warehouse,
      quantity: round2(row.quantity),
      averageCost: round2(row.averageCost),
      stockValue: round2(row.quantity * row.averageCost),
      reorderLevel: row.item.reorderLevel ?? 0,
      belowReorder: row.quantity < (row.item.reorderLevel ?? 0),
    }));

  res.json({ success: true, data });
});

export const movements = asyncHandler(async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

  const filter = {};
  if (req.query.itemType) filter.itemType = req.query.itemType;
  if (req.query.item) filter.item = req.query.item;
  if (req.query.type) filter.type = req.query.type;
  if (req.query.warehouse) filter.warehouse = req.query.warehouse;

  const [data, total] = await Promise.all([
    StockMovement.find(filter)
      .populate('warehouse', 'code name')
      .populate('item')
      .populate('createdBy', 'name')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(limit),
    StockMovement.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  });
});

/** Manual correction of an on-hand balance, e.g. after a physical count. */
export const adjust = asyncHandler(async (req, res) => {
  const { itemType, item, warehouse, quantity, remarks } = req.body;
  if (!['Material', 'Product'].includes(itemType)) {
    throw ApiError.badRequest('itemType must be Material or Product');
  }

  const { stock, movement } = await postMovement({
    itemType,
    item,
    warehouse,
    quantity: Number(quantity),
    type: Number(quantity) < 0 ? 'scrap' : 'adjustment',
    remarks: remarks || 'Manual stock adjustment',
    createdBy: req.user._id,
  });

  res.status(201).json({ success: true, data: { stock, movement } });
});

/** Items at or below their reorder level, for the purchasing to-do list. */
export const reorderReport = asyncHandler(async (_req, res) => {
  const [materials, products] = await Promise.all([
    Material.find({ isActive: true, reorderLevel: { $gt: 0 } }).populate('preferredSupplier', 'code name'),
    Product.find({ isActive: true, reorderLevel: { $gt: 0 } }),
  ]);

  const balances = await Stock.aggregate([
    { $group: { _id: { itemType: '$itemType', item: '$item' }, quantity: { $sum: '$quantity' } } },
  ]);

  const balanceOf = new Map(
    balances.map((row) => [`${row._id.itemType}:${row._id.item}`, row.quantity])
  );

  const build = (itemType) => (item) => {
    const quantity = balanceOf.get(`${itemType}:${item._id}`) || 0;
    return {
      itemType,
      id: item._id,
      code: item.sku || item.code,
      name: item.name,
      uom: item.uom || 'pcs',
      quantity: round2(quantity),
      reorderLevel: item.reorderLevel,
      shortfall: round2(Math.max(item.reorderLevel - quantity, 0)),
      preferredSupplier: item.preferredSupplier,
    };
  };

  const data = [...materials.map(build('Material')), ...products.map(build('Product'))].filter(
    (row) => row.quantity < row.reorderLevel
  );

  res.json({ success: true, data });
});
