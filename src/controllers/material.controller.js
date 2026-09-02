import Material from '../models/Material.js';
import Pricing from '../models/Pricing.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { listParams, paginated } from '../utils/query.js';
import { expectVersion, withoutVersion } from '../utils/concurrency.js';
import { recordChange, snapshot } from '../services/audit.service.js';
import { sendCsv } from '../utils/csv.js';

/** The same ceiling every other export uses — see pipeline.controller.js. */
const EXPORT_LIMIT = 5000;

/** What the register's list understands, shared by the screen and its download. */
function materialQuery(query) {
  const params = listParams(query, {
    searchFields: ['name', 'code', 'colour', 'supplier'],
    defaultSort: 'name',
  });

  if (query.type) params.filter.type = query.type;
  if (query.isActive !== undefined && query.isActive !== '') {
    params.filter.isActive = query.isActive === 'true';
  }

  return params;
}

export const listMaterials = asyncHandler(async (req, res) => {
  const { page, limit, sort, filter } = materialQuery(req.query);

  const [data, total] = await Promise.all([
    Material.find(filter).sort(sort).skip((page - 1) * limit).limit(limit),
    Material.countDocuments(filter),
  ]);

  paginated(res, data, { page, limit, total });
});

export const getMaterial = asyncHandler(async (req, res) => {
  const material = await Material.findById(req.params.id);
  if (!material) throw ApiError.notFound('Material not found');
  res.json({ success: true, data: material });
});

export const createMaterial = asyncHandler(async (req, res) => {
  const code = req.body.code?.toUpperCase();
  if (code && (await Material.findOne({ code }))) {
    throw ApiError.conflict(`Material code ${code} is already in use`);
  }

  const material = await Material.create({
    ...req.body,
    ...(code ? { code } : {}),
    /* A rate arrives dated, so "when was this last true?" is answerable from the first day. */
    rateUpdatedAt: new Date(),
  });

  res.status(201).json({ success: true, data: material });
});

export const updateMaterial = asyncHandler(async (req, res) => {
  const material = await Material.findById(req.params.id);
  if (!material) throw ApiError.notFound('Material not found');

  expectVersion(material, req.body);
  const before = snapshot(material);

  const patch = withoutVersion(req.body);
  /*
   * A rate change is dated, and nothing else on the record is. Somebody looking at ₹160/kg six
   * months from now needs to know whether that is this week's number or last monsoon's, and a
   * generic `updatedAt` cannot tell them — it moves when the colour is corrected too.
   */
  if (patch.ratePerKg !== undefined && patch.ratePerKg !== material.ratePerKg) {
    patch.rateUpdatedAt = new Date();
  }

  Object.assign(material, patch);
  await material.save();
  await recordChange({ model: 'Material', doc: material, before, by: req.user });

  res.json({ success: true, data: material });
});

/**
 * What is priced against this material, so a rate change can be judged before it is made.
 *
 * A costing keeps the rate it was built on — that is deliberate, a quotation must not re-price
 * itself under the customer — which means changing a rate here silently leaves every existing
 * sheet on the old one. Showing what those sheets are is how somebody decides whether to
 * re-cost them.
 */
export const materialPricings = asyncHandler(async (req, res) => {
  const material = await Material.findById(req.params.id);
  if (!material) throw ApiError.notFound('Material not found');

  const rows = await Pricing.find({ materialRef: material._id })
    .select('number status modelNumber cost.rawMaterialRate approvedSellingPrice createdAt')
    .populate('customer', 'name')
    .sort('-createdAt')
    .limit(50);

  res.json({
    success: true,
    data: rows,
    /* The ones built on a rate that has since moved — the actual answer to "what is stale?" */
    stale: rows.filter((row) => row.cost?.rawMaterialRate !== material.ratePerKg).length,
  });
});

export const exportMaterials = asyncHandler(async (req, res) => {
  const { sort, filter } = materialQuery(req.query);
  const rows = await Material.find(filter).sort(sort).limit(EXPORT_LIMIT);

  sendCsv(res, 'materials', rows, [
    ['Name', (row) => row.name],
    ['Code', (row) => row.code],
    ['Type', (row) => row.type],
    ['Colour', (row) => row.colour],
    ['Rate per kg', (row) => row.ratePerKg],
    ['Grammage factor %', (row) => row.grammageFactorPercent],
    ['Supplier', (row) => row.supplier],
    ['Rate confirmed', (row) => (row.rateUpdatedAt ? row.rateUpdatedAt.toISOString().slice(0, 10) : '')],
    ['Active', (row) => (row.isActive === false ? 'No' : 'Yes')],
  ]);
});
