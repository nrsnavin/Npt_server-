import TradedItem, { modelKeyOf } from '../models/TradedItem.js';
import Quotation from '../models/Quotation.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { listParams, paginated } from '../utils/query.js';
import { expectVersion, withoutVersion } from '../utils/concurrency.js';
import { recordChange, snapshot } from '../services/audit.service.js';
import { ownershipFilter } from '../services/ownership.service.js';
import { collect, sendCsv } from '../utils/csv.js';
import {
  allTradedItemsVisibleTo, seesInwardPrice, tradedItemVisibleTo,
} from '../services/pricingVisibility.js';
import { sheetRows } from '../services/sheetRows.js';
import { TEMPLATE_HEADERS, applyImport, planImport } from '../services/tradedImport.service.js';

/**
 * The trading master [models/TradedItem.js]: bought-in items and their inward price.
 *
 * Anyone who quotes can list and pick from it; the price, and keeping the list, are the
 * Quotation department's and Admin's [services/pricingVisibility.js `seesInwardPrice`].
 */

const EXPORT_LIMIT = 5000;
const SORTABLE = ['modelNumber', 'code', 'supplier', 'inwardPrice', 'priceUpdatedAt', 'category', 'createdAt'];

function assertMayKeep(user) {
  if (!seesInwardPrice(user)) {
    throw ApiError.forbidden('The trading master is kept by the Quotation department and Admin');
  }
}

function tradedQuery(query, user) {
  const params = listParams(query, {
    searchFields: ['modelNumber', 'code', 'description', 'supplier', 'supplierItemCode'],
    defaultSort: 'modelNumber',
    sortable: SORTABLE.filter((field) => field !== 'inwardPrice' || seesInwardPrice(user)),
  });
  if (query.isActive !== undefined && query.isActive !== '') params.filter.isActive = query.isActive === 'true';
  if (query.supplier) params.filter.supplier = String(query.supplier);
  return params;
}

export const listTradedItems = asyncHandler(async (req, res) => {
  const { page, limit, sort, filter } = tradedQuery(req.query, req.user);
  const [rows, total] = await Promise.all([
    TradedItem.find(filter).select('-priceHistory').sort(sort).skip((page - 1) * limit).limit(limit),
    TradedItem.countDocuments(filter),
  ]);
  paginated(res, allTradedItemsVisibleTo(rows, req.user), { page, limit, total });
});

export const getTradedItem = asyncHandler(async (req, res) => {
  const item = await TradedItem.findById(req.params.id).populate('priceHistory.by', 'name');
  if (!item) throw ApiError.notFound('Item not found');
  res.json({ success: true, data: tradedItemVisibleTo(item, req.user) });
});

/** One model, one row: a second item under the same model name is refused by name. */
async function assertFree({ code, modelNumber }, except) {
  /* An edit that names neither has nothing to clash on — and an empty `$or` would match everything. */
  if (!code && !modelNumber) return;
  const clash = await TradedItem.findOne({
    _id: { $ne: except },
    $or: [
      ...(code ? [{ code: code.toUpperCase() }] : []),
      ...(modelNumber ? [{ modelKey: modelKeyOf(modelNumber) }] : []),
    ],
  });
  if (!clash) return;
  if (code && clash.code === code.toUpperCase()) throw ApiError.conflict(`Item code ${clash.code} is already ${clash.modelNumber}`);
  throw ApiError.conflict(`${clash.modelNumber} is already on the trading master`);
}

export const createTradedItem = asyncHandler(async (req, res) => {
  assertMayKeep(req.user);
  await assertFree(req.body);
  const now = new Date();
  const item = await TradedItem.create({
    ...req.body,
    priceUpdatedAt: now,
    priceHistory: [{ price: req.body.inwardPrice, at: now, by: req.user._id, source: 'manual' }],
  });
  res.status(201).json({ success: true, data: item });
});

export const updateTradedItem = asyncHandler(async (req, res) => {
  assertMayKeep(req.user);
  const item = await TradedItem.findById(req.params.id);
  if (!item) throw ApiError.notFound('Item not found');
  expectVersion(item, req.body);
  const before = snapshot(item);

  const { priceNote, ...patch } = withoutVersion(req.body);
  await assertFree({ code: patch.code, modelNumber: patch.modelNumber }, item._id);

  /* A price move is dated and kept; nothing else on the record is. */
  const priceMoved = patch.inwardPrice !== undefined && patch.inwardPrice !== item.inwardPrice;
  const was = item.inwardPrice;
  Object.assign(item, patch);
  if (priceMoved) {
    item.priceUpdatedAt = new Date();
    item.priceHistory.push({ price: item.inwardPrice, from: was, by: req.user._id, source: 'manual', note: priceNote });
  }
  await item.save();
  await recordChange({ model: 'TradedItem', doc: item, before, by: req.user });
  res.json({ success: true, data: item });
});

/**
 * An Excel or CSV upload. Without `commit` it answers what would happen and writes nothing; the
 * screen shows that, and the person sends the same file again with `commit=true`.
 */
export const importTradedItems = asyncHandler(async (req, res) => {
  assertMayKeep(req.user);
  if (!req.file) throw ApiError.badRequest('Attach the Excel or CSV file');
  const rows = sheetRows(req.file.buffer);
  if (!rows) throw ApiError.badRequest('That file could not be read as an Excel (.xlsx) or CSV sheet');

  const result = await planImport(rows);
  if (result.error) throw ApiError.badRequest(result.error);

  const commit = String(req.body.commit || req.query.commit) === 'true';
  if (!commit) return res.json({ success: true, data: { ...result, committed: false } });

  const written = await applyImport(result.plan, req.user);
  res.json({ success: true, data: { ...result, ...written, committed: true } });
});

/** The empty sheet, with the headings the upload reads. */
export const tradedTemplate = asyncHandler(async (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="trading-master-template.csv"');
  res.send(`﻿${TEMPLATE_HEADERS.join(',')}\r\nPH-17,TR-001,Plain hanger 17 inch,shirt,430,White,PP,Sri Balaji Plastics,SB-17,3.40,5000,500,39269099,18,\r\n`);
});

export const exportTradedItems = asyncHandler(async (req, res) => {
  const { sort, filter } = tradedQuery(req.query, req.user);
  const rows = await collect(TradedItem.find(filter).sort(sort).limit(EXPORT_LIMIT));
  const priced = seesInwardPrice(req.user);
  await sendCsv(res, 'trading-master', rows, [
    ['Model', (row) => row.modelNumber],
    ['Code', (row) => row.code],
    ['Description', (row) => row.description],
    ['Category', (row) => row.category],
    ['Size mm', (row) => row.sizeMm],
    ['Colour', (row) => row.colour],
    ['Material', (row) => row.material],
    ['Supplier', (row) => row.supplier],
    ['Supplier code', (row) => row.supplierItemCode],
    ...(priced ? [
      ['Inward price', (row) => row.inwardPrice],
      ['Price confirmed', (row) => (row.priceUpdatedAt ? row.priceUpdatedAt.toISOString().slice(0, 10) : '')],
    ] : []),
    ['MOQ', (row) => row.moq],
    ['Pcs per carton', (row) => row.piecesPerCarton],
    ['HSN', (row) => row.hsnCode],
    ['GST %', (row) => row.gstPercent],
    ['Active', (row) => (row.isActive === false ? 'No' : 'Yes')],
  ]);
});

/**
 * The quotations that price this item, and how many were costed on an inward price that has
 * since moved — the answer to "which quotes does this supplier's increase touch?"
 */
export const tradedItemQuotations = asyncHandler(async (req, res) => {
  assertMayKeep(req.user);
  const item = await TradedItem.findById(req.params.id);
  if (!item) throw ApiError.notFound('Item not found');
  const rows = await Quotation.find({ 'lines.tradedItem': item._id, ...ownershipFilter(req.user) })
    .select('number status lines.modelNumber lines.tradedItem lines.cost.inwardPrice lines.unitPrice createdAt customer')
    .populate('customer', 'name')
    .sort('-createdAt')
    .limit(50);
  const onItem = (row) => (row.lines || []).filter((line) => String(line.tradedItem) === String(item._id));
  res.json({
    success: true,
    data: rows,
    stale: rows.filter((row) => onItem(row).some((line) => line.cost?.inwardPrice !== item.inwardPrice)).length,
  });
});
