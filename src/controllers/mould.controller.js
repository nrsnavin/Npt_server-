import Mould from '../models/Mould.js';
import Product from '../models/Product.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { listParams, paginated } from '../utils/query.js';
import { expectVersion, withoutVersion } from '../utils/concurrency.js';
import { recordChange, snapshot } from '../services/audit.service.js';
import { sendCsv } from '../utils/csv.js';
import { allMouldsVisibleTo, mouldVisibleTo, seesMachineRate } from '../services/pricingVisibility.js';

/** The same ceiling every other export uses — see pipeline.controller.js. */
const EXPORT_LIMIT = 5000;

/**
 * What the moulds list understands, in one function.
 *
 * Shared by the list and the export for the reason every other module shares it: the promise
 * of a download is that the file is what was on the screen, and two copies of a filter block
 * start agreeing and stop without anybody noticing.
 */
function mouldQuery(query) {
  const params = listParams(query, {
    searchFields: ['mouldCode', 'name', 'machine.code', 'location'],
    defaultSort: 'mouldCode',
  });

  if (query.status) params.filter.status = query.status;
  if (query.material) params.filter.material = query.material;
  if (query.ownedBy) params.filter.ownedBy = query.ownedBy;
  /* `product` singular in the query: a caller asks "what makes this model", and the answer
     is every tool whose list contains it. */
  if (query.product) params.filter.products = query.product;
  if (query.isActive !== undefined && query.isActive !== '') {
    params.filter.isActive = query.isActive === 'true';
  }

  return params;
}

/** The product fields a mould row needs. Named, so adding a field to the master cannot widen this. */
const PRODUCT_FIELDS = 'modelCode name category sizeMm material';

export const listMoulds = asyncHandler(async (req, res) => {
  const { page, limit, sort, filter } = mouldQuery(req.query);

  const [data, total] = await Promise.all([
    Mould.find(filter)
      .populate('products', PRODUCT_FIELDS)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit),
    Mould.countDocuments(filter),
  ]);

  paginated(res, allMouldsVisibleTo(data, req.user), { page, limit, total });
});

export const getMould = asyncHandler(async (req, res) => {
  const mould = await Mould.findById(req.params.id)
    .populate('products', PRODUCT_FIELDS)
    .populate('ownedByCustomer', 'name code');
  if (!mould) throw ApiError.notFound('Mould not found');
  res.json({ success: true, data: mouldVisibleTo(mould, req.user) });
});

/**
 * Whose mould it is has to be consistent with who is named on it.
 *
 * A company mould carrying a customer reference and a customer mould carrying none are both
 * records that read as one thing and hold another, and the whole point of recording ownership
 * is that somebody can rely on it before quoting a buyer-funded model to a competitor.
 */
function assertOwnership(mould) {
  if (mould.ownedBy === 'customer' && !mould.ownedByCustomer) {
    throw ApiError.badRequest('A customer-owned mould needs the customer who owns it');
  }
  if (mould.ownedBy !== 'customer' && mould.ownedByCustomer) {
    throw ApiError.badRequest('Only a customer-owned mould carries a customer');
  }
}

/**
 * Every model named on a tool has to be one the catalogue knows.
 *
 * Checked as a set rather than one at a time, so the refusal names all of them: telling
 * somebody about the first bad id in a list of five and making them resubmit to find the
 * second is how a bulk correction takes five round trips.
 */
async function assertProducts(ids) {
  if (!ids?.length) return;
  const found = await Product.find({ _id: { $in: ids } }).select('_id');
  if (found.length === ids.length) return;

  const known = new Set(found.map((product) => String(product._id)));
  const missing = ids.filter((id) => !known.has(String(id)));
  throw ApiError.badRequest(
    `Not in the product master: ${missing.join(', ')}`
  );
}

/** More cavities running than were ever cut means one of the two numbers is about another tool. */
function assertCavities(mould) {
  if (mould.activeCavities != null && mould.activeCavities > mould.cavities) {
    throw ApiError.badRequest(
      `This mould has ${mould.cavities} cavities, so ${mould.activeCavities} cannot be running`
    );
  }
}

export const createMould = asyncHandler(async (req, res) => {
  const mouldCode = req.body.mouldCode.toUpperCase();
  if (await Mould.findOne({ mouldCode })) {
    throw ApiError.conflict(`Mould ${mouldCode} is already on the register`);
  }

  await assertProducts(req.body.products);

  const mould = new Mould({ ...req.body, mouldCode });
  assertOwnership(mould);
  await mould.save();

  await mould.populate('products', PRODUCT_FIELDS);
  res.status(201).json({ success: true, data: mouldVisibleTo(mould, req.user) });
});

export const updateMould = asyncHandler(async (req, res) => {
  const mould = await Mould.findById(req.params.id);
  if (!mould) throw ApiError.notFound('Mould not found');

  expectVersion(mould, req.body);
  const before = snapshot(mould);

  const patch = withoutVersion(req.body);
  await assertProducts(patch.products);

  /*
   * Null clears; undefined leaves alone. A customer-owned tool bought out is an ordinary
   * correction, and without an explicit clear the only way to make one is through the database.
   */
  if (patch.ownedByCustomer === null) {
    mould.ownedByCustomer = undefined;
    delete patch.ownedByCustomer;
  }

  Object.assign(mould, patch);
  /*
   * Checked over the merged record rather than over the patch. Sending `activeCavities` on its
   * own has nothing to compare against, which is exactly the request that would otherwise slip
   * a blocked-cavity count past a cavity count it no longer fits.
   */
  assertCavities(mould);
  assertOwnership(mould);

  await mould.save();
  await recordChange({ model: 'Mould', doc: mould, before, by: req.user });

  await mould.populate('products', PRODUCT_FIELDS);
  res.json({ success: true, data: mouldVisibleTo(mould, req.user) });
});

export const exportMoulds = asyncHandler(async (req, res) => {
  const { sort, filter } = mouldQuery(req.query);

  const rows = await Mould.find(filter)
    .populate('products', PRODUCT_FIELDS)
    .sort(sort)
    .limit(EXPORT_LIMIT);

  /*
   * The derived figures go in the file. A tool-room spreadsheet that carries only the measured
   * inputs makes every reader redo the arithmetic, and half of them will do it on the part
   * weight and forget the runner — which is the mistake this register exists to stop.
   *
   * The two money columns come off for a reader who may not see costs, the same as they do on
   * the screen. A redaction the Export button walks around is not a redaction — it is a longer
   * route to the same figure, and the one somebody takes precisely because the screen refused.
   */
  const money = seesMachineRate(req.user);

  sendCsv(res, 'moulds', rows, [
    ['Mould', (row) => row.mouldCode],
    ['Name', (row) => row.name],
    ['Models', (row) => (row.products || []).map((product) => product.modelCode).join(' / ')],
    ['Material', (row) => row.material],
    ['Status', (row) => row.status],
    ['Cavities', (row) => row.cavities],
    ['Running', (row) => row.runningCavities],
    ['Part weight (g)', (row) => row.partWeightGrams],
    ['Runner weight (g)', (row) => row.runnerWeightGrams],
    ['Shot weight (g)', (row) => row.shotWeightGrams],
    ['Runner %', (row) => row.runnerPercent],
    ['Regrind recovery %', (row) => row.regrindRecoveryPercent],
    ['Consumption (g/pc)', (row) => row.consumptionPerPieceGrams],
    ['Cycle (s)', (row) => row.cycleTimeSeconds],
    ['Efficiency %', (row) => row.efficiencyPercent],
    ['Pieces/hour', (row) => row.piecesPerHour],
    ['Machine hours per 1000', (row) => row.machineHoursPer1000],
    ['Machine', (row) => row.machine?.code],
    ['Tonnage', (row) => row.machine?.tonnage],
    ...(money
      ? [
          ['Machine rate (/hr)', (row) => row.machine?.hourRate],
          ['Machine cost (/pc)', (row) => row.machineCostPerPiece],
        ]
      : []),
    ['Owned by', (row) => row.ownedBy],
    ['Location', (row) => row.location],
    ['Active', (row) => (row.isActive === false ? 'No' : 'Yes')],
  ]);
});
