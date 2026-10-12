import TradedItem, { modelKeyOf } from '../models/TradedItem.js';
import { HANGER_CATEGORIES } from '../models/Mould.js';

/**
 * Reading the trading master from a spreadsheet [controllers/tradedItem.controller.js].
 *
 * The plant keeps this list in Excel, so the upload takes the sheet as it is: the header row is
 * found by its words, not its position, and each row lands on the item it names — by code when
 * it has one, by model otherwise. Nothing is written until the person has seen what would
 * change: the same call answers a preview first and writes only when asked to.
 */

/** Header words for each field. Compared lower-case with punctuation squeezed out. */
export const COLUMNS = {
  modelNumber: ['model', 'model no', 'model number', 'item', 'item name', 'product', 'name'],
  code: ['code', 'item code', 'our code', 'sku'],
  description: ['description', 'details', 'desc'],
  category: ['category', 'type'],
  sizeMm: ['size', 'size mm', 'size in mm', 'length'],
  colour: ['colour', 'color'],
  material: ['material'],
  supplier: ['supplier', 'vendor', 'supplier name', 'party'],
  supplierItemCode: ['supplier code', 'supplier item code', 'vendor code'],
  inwardPrice: ['inward price', 'inward rate', 'purchase price', 'purchase rate', 'price', 'rate', 'cost', 'landed cost', 'buy price'],
  moq: ['moq', 'minimum order', 'min order'],
  piecesPerCarton: ['pcs per carton', 'pieces per carton', 'carton qty', 'packing'],
  hsnCode: ['hsn', 'hsn code'],
  gstPercent: ['gst', 'gst %', 'gst percent', 'tax'],
  notes: ['notes', 'remarks'],
  /* The cost build-up [TradedItem `buildUp`], as the plant's price sheet heads it. */
  partWeightGrams: ['grammage as pp', 'grammage', 'grams', 'gram', 'weight'],
  runnerWeightGrams: ['runner grammage', 'runner'],
  jobWorkCost: ['job work cost', 'job work'],
  hookCost: ['hook', 'hook cost'],
  clipsCost: ['clips', 'clip', 'clips cost'],
  packingCost: ['packing cost'],
};

/** The columns that land on the item's build-up rather than on the item. */
export const BUILD_UP = ['partWeightGrams', 'runnerWeightGrams', 'jobWorkCost', 'hookCost', 'clipsCost', 'packingCost'];

/** The headings the template carries, in order. */
export const TEMPLATE_HEADERS = [
  'Model', 'Code', 'Description', 'Category', 'Size mm', 'Colour', 'Material', 'Supplier',
  'Supplier code', 'Inward price', 'MOQ', 'Pcs per carton', 'HSN', 'GST %', 'Notes',
  'Grammage as PP', 'Runner grammage', 'Job work cost', 'Hook', 'Clips', 'Packing cost',
];

const NUMERIC = ['sizeMm', 'inwardPrice', 'moq', 'piecesPerCarton', 'gstPercent', ...BUILD_UP];
/** The fields an upload may change on an existing item, and that are compared for "unchanged". */
const FIELDS = Object.keys(COLUMNS);

const squeeze = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();

/** Which field each column of the header row is, or null for a column nobody asked for. */
export function headerMap(header) {
  return header.map((cell) => {
    const word = squeeze(cell);
    if (!word) return null;
    return FIELDS.find((field) => COLUMNS[field].includes(word)) || null;
  });
}

/**
 * The header row: the first of the opening rows naming a model and a price — or a build-up
 * column, for a sheet that only updates those — so a title line or two above the table still reads.
 */
export function findHeader(rows) {
  for (let at = 0; at < Math.min(rows.length, 10); at += 1) {
    const map = headerMap(rows[at]);
    if (map.includes('modelNumber') && (map.includes('inwardPrice') || BUILD_UP.some((field) => map.includes(field)))) return { at, map };
  }
  return null;
}

/** "₹ 3.50", "3,500.00", "18%" → numbers; blank → undefined; anything else → NaN. */
const number = (text) => {
  const cleaned = String(text ?? '').replace(/[₹,%\s]|rs\.?/gi, '');
  if (!cleaned) return undefined;
  return Number(cleaned);
};

/** One spreadsheet row as an item's fields, with what is wrong with it. */
export function readRow(cells, map) {
  const fields = {};
  const problems = [];
  map.forEach((field, index) => {
    if (!field) return;
    const raw = String(cells[index] ?? '').trim();
    if (NUMERIC.includes(field)) {
      const value = number(raw);
      if (value === undefined) return;
      if (!Number.isFinite(value) || value < 0) problems.push(`${field === 'inwardPrice' ? 'Inward price' : field} "${raw}" is not a number`);
      else fields[field] = value;
    } else if (raw) {
      fields[field] = raw;
    }
  });

  if (fields.category) {
    const category = fields.category.toLowerCase().replace(/\s+/g, '_');
    if (HANGER_CATEGORIES.includes(category)) fields.category = category;
    else delete fields.category; /* A category the plant does not use is dropped, not refused. */
  }
  if (fields.code) fields.code = fields.code.toUpperCase();
  if (!fields.modelNumber) problems.push('No model');
  return { fields, problems };
}

const same = (a, b) => (a ?? '') === (b ?? '') || (typeof a === 'number' && Number(b) === a);

/**
 * What the upload would do, row by row: create, update (with the fields that move), leave
 * unchanged, or refuse with the reason. Rows naming the same item twice: the later one is
 * refused, so a sheet cannot quietly set two prices for one model.
 */
export async function planImport(rows) {
  const header = findHeader(rows);
  if (!header) {
    return { error: 'No header row with a Model column and an Inward price (or Price / Rate) column in the first ten rows.' };
  }

  const read = rows.slice(header.at + 1)
    .map((cells, offset) => ({ row: header.at + offset + 2, ...readRow(cells, header.map) }))
    .filter((entry) => Object.keys(entry.fields).length || entry.problems.some((problem) => problem !== 'No model'));

  const codes = read.map((entry) => entry.fields.code).filter(Boolean);
  const keys = read.map((entry) => modelKeyOf(entry.fields.modelNumber)).filter(Boolean);
  const existing = await TradedItem.find({ $or: [{ code: { $in: codes } }, { modelKey: { $in: keys } }] });
  const byCode = new Map(existing.filter((item) => item.code).map((item) => [item.code, item]));
  const byKey = new Map(existing.map((item) => [item.modelKey, item]));

  const seen = new Set();
  const plan = read.map(({ row, fields, problems }) => {
    if (problems.length) return { row, action: 'error', problems, fields };
    const key = modelKeyOf(fields.modelNumber);
    const item = (fields.code && byCode.get(fields.code)) || byKey.get(key);
    const identity = item ? String(item._id) : `new:${fields.code || key}`;
    if (seen.has(identity) || seen.has(`key:${key}`)) {
      return { row, action: 'error', problems: [`${fields.modelNumber} is on the sheet twice`], fields };
    }
    seen.add(identity);
    seen.add(`key:${key}`);

    /* A new item needs its price; a row updating one may carry only, say, its build-up. */
    if (!item) {
      return fields.inwardPrice === undefined
        ? { row, action: 'error', problems: ['No inward price'], fields }
        : { row, action: 'create', fields };
    }
    /* A model renamed onto another item's name would break the one-row-per-model rule. */
    const clash = byKey.get(key);
    if (clash && String(clash._id) !== String(item._id)) {
      return { row, action: 'error', problems: [`${fields.modelNumber} belongs to another item (${clash.code || clash.modelNumber})`], fields };
    }
    const current = (field) => (BUILD_UP.includes(field) ? item.buildUp?.[field] : item[field]);
    const changes = Object.fromEntries(
      Object.entries(fields)
        .filter(([field, value]) => !same(current(field), value))
        .map(([field, value]) => [field, { from: current(field) ?? null, to: value }])
    );
    return Object.keys(changes).length
      ? { row, action: 'update', id: item._id, modelNumber: item.modelNumber, changes, fields }
      : { row, action: 'unchanged', id: item._id, modelNumber: item.modelNumber, fields };
  });

  const count = (action) => plan.filter((entry) => entry.action === action).length;
  return {
    plan,
    summary: { create: count('create'), update: count('update'), unchanged: count('unchanged'), error: count('error') },
  };
}

/** Writes a plan: creates and updates, each price move dated in the item's history. */
/** A row's fields as the item stores them: the build-up columns under `buildUp`. */
function stored(fields, item) {
  const plain = Object.fromEntries(Object.entries(fields).filter(([field]) => !BUILD_UP.includes(field)));
  const buildUp = Object.fromEntries(Object.entries(fields).filter(([field]) => BUILD_UP.includes(field)));
  if (Object.keys(buildUp).length) plain.buildUp = { ...(item?.buildUp?.toObject?.() || item?.buildUp || {}), ...buildUp };
  return plain;
}

export async function applyImport(plan, user) {
  let created = 0;
  let updated = 0;
  const now = new Date();
  for (const entry of plan) {
    if (entry.action === 'create') {
      await TradedItem.create({
        ...stored(entry.fields),
        priceUpdatedAt: now,
        priceHistory: [{ price: entry.fields.inwardPrice, at: now, by: user?._id, source: 'upload' }],
      });
      created += 1;
    } else if (entry.action === 'update') {
      const item = await TradedItem.findById(entry.id);
      if (!item) continue;
      const before = item.inwardPrice;
      Object.assign(item, stored(entry.fields, item));
      if (entry.changes.inwardPrice) {
        item.priceUpdatedAt = now;
        item.priceHistory.push({ price: item.inwardPrice, from: before, at: now, by: user?._id, source: 'upload' });
      }
      await item.save();
      updated += 1;
    }
  }
  return { created, updated };
}
