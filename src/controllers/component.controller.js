import Component, { COMPONENT_KINDS, COMPONENT_LABELS } from '../models/Component.js';
import Pricing from '../models/Pricing.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { listParams, paginated } from '../utils/query.js';
import { expectVersion, withoutVersion } from '../utils/concurrency.js';
import { recordChange, snapshot } from '../services/audit.service.js';
import { sendCsv } from '../utils/csv.js';

/** The same ceiling every other export uses — see pipeline.controller.js. */
const EXPORT_LIMIT = 5000;

/**
 * Which register is being asked for.
 *
 * Refused rather than defaulted when it is missing or unknown: these are three registers that
 * happen to share a table, and a list that silently returned all three would show a costing
 * clerk hooks in the clip picker. The message names what is valid, because a caller that got
 * this wrong cannot see the enum from where they are standing.
 */
function kindOf(value) {
  if (!COMPONENT_KINDS.includes(value)) {
    throw ApiError.badRequest(`Say which register: ${COMPONENT_KINDS.join(', ')}`);
  }
  return value;
}

/** What a register's list understands, shared by the screen and its download. */
function componentQuery(query) {
  const params = listParams(query, {
    searchFields: ['name', 'code', 'colour', 'supplier'],
    defaultSort: 'name',
  });

  params.filter.kind = kindOf(query.kind);
  if (query.isActive !== undefined && query.isActive !== '') {
    params.filter.isActive = query.isActive === 'true';
  }

  return params;
}

export const listComponents = asyncHandler(async (req, res) => {
  const { page, limit, sort, filter } = componentQuery(req.query);

  const [data, total] = await Promise.all([
    Component.find(filter).sort(sort).skip((page - 1) * limit).limit(limit),
    Component.countDocuments(filter),
  ]);

  paginated(res, data, { page, limit, total });
});

export const getComponent = asyncHandler(async (req, res) => {
  const component = await Component.findById(req.params.id);
  if (!component) throw ApiError.notFound('Not on the register');
  res.json({ success: true, data: component });
});

export const createComponent = asyncHandler(async (req, res) => {
  const kind = kindOf(req.body.kind);
  const code = req.body.code?.toUpperCase();

  /* Unique within a kind: a hook and a clip may both be `STD-01` in their own stores. */
  if (code && (await Component.findOne({ kind, code }))) {
    throw ApiError.conflict(`${code} is already on the ${COMPONENT_LABELS[kind].toLowerCase()}`);
  }

  const component = await Component.create({
    ...req.body,
    kind,
    ...(code ? { code } : {}),
    /* A rate arrives dated, so "when was this last true?" is answerable from the first day. */
    rateUpdatedAt: new Date(),
  });

  res.status(201).json({ success: true, data: component });
});

export const updateComponent = asyncHandler(async (req, res) => {
  const component = await Component.findById(req.params.id);
  if (!component) throw ApiError.notFound('Not on the register');

  expectVersion(component, req.body);
  const before = snapshot(component);

  const patch = withoutVersion(req.body);
  /*
   * A rate change is dated and nothing else is. Somebody reading ₹0.70 six months from now
   * needs to know whether that is this week's number, and a generic `updatedAt` cannot say —
   * it moves when the supplier is corrected too.
   */
  if (patch.ratePerPiece !== undefined && patch.ratePerPiece !== component.ratePerPiece) {
    patch.rateUpdatedAt = new Date();
  }

  Object.assign(component, patch);
  await component.save();
  await recordChange({ model: 'Component', doc: component, before, by: req.user });

  res.json({ success: true, data: component });
});

/**
 * What is priced against this part, so a rate change can be judged before it is made.
 *
 * The same reasoning as the material register's: a costing keeps the rate it was built on, so
 * changing one here leaves every existing sheet on the old figure. Showing which sheets those
 * are is how somebody decides what to re-cost.
 */
export const componentPricings = asyncHandler(async (req, res) => {
  const component = await Component.findById(req.params.id);
  if (!component) throw ApiError.notFound('Not on the register');

  const field = { hook: 'hookRef', clip: 'clipRef', print: 'printRef' }[component.kind];
  const line = { hook: 'cost.hookCost', clip: 'cost.metalClipsCost', print: 'cost.printingCost' }[
    component.kind
  ];

  const rows = await Pricing.find({ [field]: component._id })
    .select(`number status modelNumber ${line} approvedSellingPrice createdAt`)
    .populate('customer', 'name')
    .sort('-createdAt')
    .limit(50);

  const on = (row) => line.split('.').reduce((value, key) => value?.[key], row);

  res.json({
    success: true,
    data: rows,
    stale: rows.filter((row) => on(row) !== component.ratePerPiece).length,
  });
});

export const exportComponents = asyncHandler(async (req, res) => {
  const { sort, filter } = componentQuery(req.query);
  const rows = await Component.find(filter).sort(sort).limit(EXPORT_LIMIT);

  sendCsv(res, `${filter.kind}s`, rows, [
    ['Name', (row) => row.name],
    ['Code', (row) => row.code],
    ['Colour', (row) => row.colour],
    ['Rate per piece', (row) => row.ratePerPiece],
    ['Supplier', (row) => row.supplier],
    ['Rate confirmed', (row) => (row.rateUpdatedAt ? row.rateUpdatedAt.toISOString().slice(0, 10) : '')],
    ['Active', (row) => (row.isActive === false ? 'No' : 'Yes')],
  ]);
});
