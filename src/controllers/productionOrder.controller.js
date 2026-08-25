import ProductionOrder from '../models/ProductionOrder.js';
import Bom from '../models/Bom.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import crudController from './crud.factory.js';
import { nextNumber } from '../services/numbering.service.js';
import { defaultWarehouse, postMovements } from '../services/inventory.service.js';

/** Explodes the active BOM into the material requirement list for a planned quantity. */
async function explodeBom(productId, quantity, bomId) {
  const bom = bomId
    ? await Bom.findById(bomId)
    : await Bom.findOne({ product: productId, isActive: true }).sort('-version');
  if (!bom) return { bom: null, materials: [] };

  return {
    bom,
    materials: bom.components.map((component) => ({
      material: component.material,
      quantityRequired: component.quantityPerUnit * quantity * (1 + component.scrapPercent / 100),
      uom: component.uom,
    })),
  };
}

export const productionOrderCrud = crudController(ProductionOrder, {
  searchFields: ['number', 'machine', 'notes'],
  populate: [
    { path: 'product', select: 'sku name hangerType material color sizeMm' },
    { path: 'materials.material', select: 'code name uom' },
    { path: 'salesOrder', select: 'number customer' },
    { path: 'supervisor', select: 'name email' },
  ],
  beforeCreate: async (body) => {
    const { bom, materials } = await explodeBom(body.product, body.quantityPlanned, body.bom);
    return {
      ...body,
      number: body.number || (await nextNumber('PRD')),
      bom: body.bom || bom?._id,
      materials: body.materials?.length ? body.materials : materials,
    };
  },
});

/** Issues BOM materials from the raw material store to the shop floor. */
export const issueMaterials = asyncHandler(async (req, res) => {
  const order = await ProductionOrder.findById(req.params.id);
  if (!order) throw ApiError.notFound('Production order not found');
  if (order.materialsIssued) throw ApiError.conflict('Materials have already been issued');
  if (order.status === 'cancelled') throw ApiError.badRequest('This order is cancelled');
  if (!order.materials.length) throw ApiError.badRequest('No BOM materials linked to this order');

  const warehouseId = req.body.warehouse || (await defaultWarehouse('raw_material'))._id;

  await postMovements(
    order.materials.map((material) => ({
      itemType: 'Material',
      item: material.material,
      warehouse: warehouseId,
      quantity: -material.quantityRequired,
      type: 'production_consume',
      reference: { docType: 'ProductionOrder', docId: order._id, docNumber: order.number },
      createdBy: req.user._id,
    }))
  );

  order.materials.forEach((material) => {
    material.quantityIssued = material.quantityRequired;
  });
  order.materialsIssued = true;
  order.status = order.status === 'planned' ? 'in_progress' : order.status;
  order.actualStart = order.actualStart || new Date();
  await order.save();

  res.json({ success: true, data: order });
});

/** Records good and scrapped output, moving finished hangers into the finished goods store. */
export const recordOutput = asyncHandler(async (req, res) => {
  const order = await ProductionOrder.findById(req.params.id);
  if (!order) throw ApiError.notFound('Production order not found');
  if (['completed', 'cancelled'].includes(order.status)) {
    throw ApiError.badRequest(`This order is already ${order.status}`);
  }

  const produced = Number(req.body.quantityProduced) || 0;
  const scrapped = Number(req.body.quantityScrapped) || 0;
  if (produced <= 0 && scrapped <= 0) {
    throw ApiError.badRequest('Provide a produced or scrapped quantity');
  }
  if (order.quantityProduced + produced > order.quantityPlanned) {
    throw ApiError.badRequest(
      `Output exceeds the planned quantity of ${order.quantityPlanned}`
    );
  }

  if (produced > 0) {
    const warehouseId = req.body.warehouse || (await defaultWarehouse('finished_goods'))._id;
    await postMovements([
      {
        itemType: 'Product',
        item: order.product,
        warehouse: warehouseId,
        quantity: produced,
        type: 'production_output',
        reference: { docType: 'ProductionOrder', docId: order._id, docNumber: order.number },
        createdBy: req.user._id,
      },
    ]);
  }

  order.quantityProduced += produced;
  order.quantityScrapped += scrapped;
  order.status = order.quantityProduced >= order.quantityPlanned ? 'completed' : 'in_progress';
  if (order.status === 'completed') order.actualEnd = new Date();
  await order.save();

  res.json({ success: true, data: order });
});

/** Open workload grouped by status, for the production board. */
export const workload = asyncHandler(async (_req, res) => {
  const data = await ProductionOrder.aggregate([
    {
      $group: {
        _id: '$status',
        orders: { $sum: 1 },
        plannedUnits: { $sum: '$quantityPlanned' },
        producedUnits: { $sum: '$quantityProduced' },
      },
    },
    { $project: { _id: 0, status: '$_id', orders: 1, plannedUnits: 1, producedUnits: 1 } },
  ]);

  res.json({ success: true, data });
});
