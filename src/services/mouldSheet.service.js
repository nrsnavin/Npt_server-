import Mould from '../models/Mould.js';
import TradedItem, { modelKeyOf } from '../models/TradedItem.js';
import Material from '../models/Material.js';
import { attachPhoto } from './recordPhoto.service.js';

/**
 * The plant's price sheet — one row per model with its photo link, whether it is made here or
 * bought in, and the cost build-up — read onto the registers [scripts/import-mould-sheet.js]:
 * a Manufacture row onto the mould register, a Trade row onto the trading master.
 *
 * The sheet has no cycle time; a new mould starts at 30 s, for the tool room to measure. It has
 * no purchase price either; a new bought-in item's inward price is estimated from its build-up
 * (grams at the PP rate, plus job work, hook, clips and packing) and says so, until the
 * supplier's price replaces it.
 */

export const DEFAULT_CYCLE_SECONDS = 30;

/** Header words → field. Compared lower-case with punctuation squeezed out. */
const COLUMNS = {
  code: ['code', 'model', 'model no', 'mould code'],
  photoUrl: ['photo link', 'image link', 'photo url', 'link'],
  supply: ['trade manufacture', 'trade or manufacture', 'manufacture trade', 'type', 'trade'],
  partWeightGrams: ['grammage as pp', 'grammage', 'gram', 'grams', 'weight', 'part weight'],
  runnerWeightGrams: ['runner grammage', 'runner', 'runner weight'],
  jobWorkCost: ['job work cost', 'job work', 'jobwork'],
  packingCost: ['packing cost'],
  hookCost: ['hook', 'hook cost'],
  clipsCost: ['clips', 'clip', 'clips cost'],
  category: ['category'],
};
const NUMERIC = ['partWeightGrams', 'runnerWeightGrams', 'jobWorkCost', 'packingCost', 'hookCost', 'clipsCost'];
const squeeze = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Tab- or comma-separated text into rows, quotes and line breaks inside quotes understood. */
export function parseSheet(text) {
  const source = String(text).replace(/^﻿/, '');
  const firstLine = source.split('\n', 1)[0];
  const separator = firstLine.includes('\t') ? '\t' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let at = 0; at < source.length; at += 1) {
    const char = source[at];
    if (quoted) {
      if (char === '"' && source[at + 1] === '"') { cell += '"'; at += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === separator) { row.push(cell); cell = ''; }
    else if (char === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** "0.70" → 0.7; "..2" → 0.2, said as a warning; blank → undefined; anything else → NaN. */
function readNumber(raw, warnings, label) {
  const text = String(raw ?? '').trim();
  if (!text) return undefined;
  let cleaned = text.replace(/[₹,\s]|rs\.?/gi, '');
  if (/^\.{2,}\d/.test(cleaned)) {
    cleaned = cleaned.replace(/^\.+/, '.');
    warnings.push(`${label} "${text}" read as ${Number(cleaned)}`);
  }
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) {
    warnings.push(`${label} "${text}" is not a number — left out`);
    return undefined;
  }
  return value;
}

const LABELS = {
  partWeightGrams: 'Grammage', runnerWeightGrams: 'Runner grammage', jobWorkCost: 'Job work cost',
  packingCost: 'Packing cost', hookCost: 'Hook', clipsCost: 'Clips',
};

/**
 * The sheet's rows as entries: `{ line, code, supply, photoUrl, numbers, notes, warnings }`.
 * Columns nobody maps (the dated "IP-14/2/26", an unnamed scratch column) become notes, labelled
 * with their heading — kept rather than dropped, because somebody wrote them for a reason.
 */
export function readSheet(rows) {
  const headerAt = rows.findIndex((cells) => cells.some((cell) => squeeze(cell) === 'code'));
  if (headerAt < 0) return { error: 'No header row with a CODE column' };
  const header = rows[headerAt];
  const map = header.map((cell) => Object.keys(COLUMNS).find((field) => COLUMNS[field].includes(squeeze(cell))) || null);
  const entries = [];
  rows.slice(headerAt + 1).forEach((cells, offset) => {
    const line = headerAt + offset + 2;
    const code = String(cells[map.indexOf('code')] ?? '').replace(/\s+/g, ' ').trim();
    if (!code) return;
    const warnings = [];
    const numbers = {};
    const notes = [];
    let supply = null;
    let photoUrl = null;
    map.forEach((field, index) => {
      const raw = String(cells[index] ?? '').trim();
      if (!raw) return;
      if (field === 'code' || field === 'category') return;
      if (field === 'photoUrl') photoUrl = /^https?:\/\//i.test(raw) ? raw : null;
      else if (field === 'supply') supply = /trade/i.test(raw) ? 'trade' : /manuf/i.test(raw) ? 'manufacture' : null;
      else if (NUMERIC.includes(field)) {
        const value = readNumber(raw, warnings, LABELS[field]);
        if (value !== undefined) numbers[field] = value;
      } else if (!field) {
        const heading = String(header[index] ?? '').trim();
        notes.push(heading ? `${heading}: ${raw}` : `Sheet note: ${raw}`);
      }
    });
    entries.push({ line, code, supply, photoUrl, numbers, notes, warnings });
  });
  return { entries };
}

const round2 = (value) => Math.round(value * 100) / 100;

/**
 * What a bought-in piece costs by the sheet's build-up: grams (part and runner, PP basis) at the
 * PP rate, plus job work, hook, clips and packing. The resin is left out when no rate is known.
 */
export function estimateInward(numbers, ppRate) {
  const grams = (numbers.partWeightGrams || 0) + (numbers.runnerWeightGrams || 0);
  const resin = ppRate ? (grams / 1000) * ppRate : 0;
  return round2(resin + (numbers.jobWorkCost || 0) + (numbers.hookCost || 0) + (numbers.clipsCost || 0) + (numbers.packingCost || 0));
}

/** The PP rate the estimate uses: the one given, else the newest PP on the material register. */
export async function ppRateFor(given) {
  if (given) return { rate: given, from: 'given' };
  const pp = await Material.findOne({ type: 'pp', ratePerKg: { $gt: 0 } }).sort({ updatedAt: -1 }).select('name ratePerKg');
  return pp ? { rate: pp.ratePerKg, from: pp.name } : { rate: 0, from: null };
}

/**
 * Each entry's action: create or update on the mould register or the trading master, or skip
 * with the reason. The first row of a code wins within a register; a later one is skipped and
 * named, because two rows for one model is a question for the person, not for the import.
 */
export async function planSheet(entries) {
  const codes = entries.map((entry) => entry.code.toUpperCase());
  const [moulds, items] = await Promise.all([
    Mould.find({ mouldCode: { $in: codes } }).select('mouldCode'),
    TradedItem.find({ $or: [{ code: { $in: codes } }, { modelKey: { $in: entries.map((entry) => modelKeyOf(entry.code)) } }] }).select('code modelKey modelNumber'),
  ]);
  const mouldByCode = new Map(moulds.map((mould) => [mould.mouldCode, mould]));
  const itemByKey = new Map(items.map((item) => [item.modelKey, item]));
  const itemByCode = new Map(items.filter((item) => item.code).map((item) => [item.code, item]));

  const seen = { mould: new Map(), traded: new Map() };
  const supplies = new Map();
  for (const entry of entries) {
    const key = entry.code.toUpperCase();
    if (entry.supply) supplies.set(key, new Set([...(supplies.get(key) || []), entry.supply]));
  }

  return entries.map((entry) => {
    const warnings = [...entry.warnings];
    const hasData = Object.keys(entry.numbers).length || entry.photoUrl;
    if (!entry.supply && !hasData) return { ...entry, action: 'skip', reason: 'nothing but the code on this row' };
    let register = entry.supply === 'trade' ? 'traded' : 'mould';
    if (!entry.supply) warnings.push('Trade / Manufacture is blank — taken as Manufacture');
    const key = entry.code.toUpperCase();
    if (seen[register].has(key)) {
      return { ...entry, register, action: 'skip', reason: `${entry.code} is already on line ${seen[register].get(key)} of the sheet` };
    }
    seen[register].set(key, entry.line);
    if (supplies.get(key)?.size > 1) warnings.push(`${entry.code} is on the sheet as both Trade and Manufacture — on both registers`);

    if (register === 'mould') {
      if (entry.numbers.partWeightGrams === undefined) warnings.push('No grammage — weight 0 until measured');
      const existing = mouldByCode.get(key);
      return { ...entry, warnings, register, action: existing ? 'update' : 'create', id: existing?._id };
    }
    const existing = itemByCode.get(key) || itemByKey.get(modelKeyOf(entry.code));
    if (!existing && entry.numbers.partWeightGrams === undefined) warnings.push('No grammage — the estimate has no resin');
    register = 'traded';
    return { ...entry, warnings, register, action: existing ? 'update' : 'create', id: existing?._id };
  });
}

const noteText = (entry) => entry.notes.join(' · ');
const withNote = (current, add) => {
  if (!add) return current;
  return current && current.includes(add) ? current : [current, add].filter(Boolean).join('\n');
};

/**
 * Writes a plan. A new mould gets the sheet's figures, one cavity, PP, and a 30 s cycle; an
 * existing one has only the figures the sheet gives replaced — its cycle, cavities and name are
 * the tool room's. A new bought-in item gets the build-up and an estimated inward price; an
 * existing one keeps its price, which may already be the supplier's.
 */
export async function applySheet(plan, { by, ppRate = 0, sheetName = 'the price sheet', fetchPhoto, photos = true, log = () => {} }) {
  const result = { moulds: { created: 0, updated: 0 }, traded: { created: 0, updated: 0 }, photos: { added: 0, kept: 0, failed: [] } };
  for (const entry of plan) {
    if (entry.action === 'skip') continue;
    let record;
    if (entry.register === 'mould') {
      if (entry.action === 'create') {
        record = await Mould.create({
          mouldCode: entry.code,
          name: entry.code,
          material: 'pp',
          cavities: 1,
          partWeightGrams: entry.numbers.partWeightGrams ?? 0,
          cycleTimeSeconds: DEFAULT_CYCLE_SECONDS,
          ...entry.numbers,
          notes: withNote(`From ${sheetName}.`, noteText(entry)),
        });
        result.moulds.created += 1;
      } else {
        record = await Mould.findById(entry.id);
        Object.assign(record, entry.numbers);
        record.notes = withNote(record.notes, noteText(entry));
        await record.save();
        result.moulds.updated += 1;
      }
    } else {
      const buildUp = { ...entry.numbers };
      if (entry.action === 'create') {
        const price = estimateInward(entry.numbers, ppRate);
        const how = ppRate
          ? `Estimated from ${sheetName} build-up at ₹${ppRate}/kg PP (grams + runner, job work, hook, clips, packing)`
          : `Estimated from ${sheetName} build-up without resin (no PP rate) — job work, hook, clips, packing`;
        const now = new Date();
        record = await TradedItem.create({
          modelNumber: entry.code,
          code: entry.code.length <= 24 ? entry.code.toUpperCase() : undefined,
          material: 'PP',
          buildUp,
          inwardPrice: price,
          priceUpdatedAt: now,
          priceHistory: [{ price, at: now, by: by?._id, source: 'upload', note: how }],
          notes: withNote(`${how}. Replace with the supplier's price.`, noteText(entry)),
        });
        result.traded.created += 1;
      } else {
        record = await TradedItem.findById(entry.id);
        record.buildUp = { ...(record.buildUp?.toObject?.() || record.buildUp || {}), ...buildUp };
        record.notes = withNote(record.notes, noteText(entry));
        await record.save();
        result.traded.updated += 1;
      }
    }

    if (!photos || !entry.photoUrl) continue;
    if (record.photo && record.photoSourceUrl === entry.photoUrl) {
      result.photos.kept += 1;
      continue;
    }
    const got = await fetchPhoto(entry.photoUrl, entry.code);
    if (got.error) {
      result.photos.failed.push({ code: entry.code, line: entry.line, reason: got.error });
      log(`  photo for ${entry.code}: ${got.error}`);
      continue;
    }
    await attachPhoto(record, {
      link: entry.register === 'mould' ? 'mould' : 'tradedItem',
      buffer: got.buffer,
      mimeType: got.mimeType,
      filename: got.filename,
      by: by._id,
      title: `${entry.code} — part photo`,
      sourceUrl: entry.photoUrl,
    });
    result.photos.added += 1;
    log(`  photo for ${entry.code}: ${got.filename}`);
  }
  return result;
}
