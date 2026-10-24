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
  /* PP Natural when the register has it — the list carries a dozen PP grades, from ₹55 to ₹160. */
  const pp = await Material.findOne({ type: 'pp', colour: /^natural$/i, ratePerKg: { $gt: 0 } }).sort({ updatedAt: -1 }).select('name ratePerKg')
    || await Material.findOne({ type: 'pp', ratePerKg: { $gt: 0 } }).sort({ updatedAt: -1 }).select('name ratePerKg');
  return pp ? { rate: pp.ratePerKg, from: pp.name } : { rate: 0, from: null };
}

/**
 * A code with case, spaces and punctuation gone, so "CRF-25", "crf 25" and "CRF25 " are one model
 * and the sheet's own spellings never make a second record. A code of nothing but punctuation
 * keeps itself.
 */
export const codeKey = (code) => {
  const text = String(code || '').toUpperCase().replace(/\s+/g, ' ').trim();
  return text.replace(/[^A-Z0-9]+/g, '') || text;
};

/**
 * "TP-224 (2)": the copy an earlier import made of a code repeated on the sheet — a small number,
 * so "PCB-807 (9508)" is a model of its own; and only where the code it copies is there too.
 */
const COPY = /^(.*\S)\s+\(([2-9]|\d{2})\)$/;
const copyOf = (value, present) => {
  const base = String(value || '').match(COPY)?.[1];
  return base && present.has(codeKey(base)) ? base : null;
};

const REGISTER_NAME = { mould: 'the mould register', traded: 'the trading master' };
const SUPPLY_REGISTER = { trade: 'traded', manufacture: 'mould' };

/**
 * Each row's register. A blank Trade / Manufacture follows the same code's other rows when they
 * agree on one, and is Manufacture otherwise — said in the warnings either way.
 */
function placeRows(entries) {
  const supplies = new Map();
  for (const entry of entries) {
    if (!entry.supply) continue;
    const key = codeKey(entry.code);
    supplies.set(key, new Set([...(supplies.get(key) || []), entry.supply]));
  }
  return entries.map((entry) => {
    const warnings = [...entry.warnings];
    const known = [...(supplies.get(codeKey(entry.code)) || [])];
    let supply = entry.supply;
    if (!supply && known.length === 1) {
      supply = known[0];
      warnings.push(`Trade / Manufacture is blank — taken as ${supply === 'trade' ? 'Trade' : 'Manufacture'}, as on its other row`);
    } else if (!supply) {
      const hasData = Object.keys(entry.numbers).length || entry.photoUrl;
      warnings.push(hasData ? 'Trade / Manufacture is blank — taken as Manufacture' : 'Nothing but the name on the sheet — added with prefilled values, to fill in');
    }
    if (known.length > 1) warnings.push(`${entry.code} is on the sheet as both Trade and Manufacture — on both registers`);
    return { ...entry, warnings, register: SUPPLY_REGISTER[supply] || 'mould', lines: [entry.line] };
  });
}

/**
 * Rows of one code on one register made one record: the first row's figures and photo stand, a
 * later row fills only what the first left blank, and a figure the rows disagree on is noted on
 * the record and in the warnings — for the person to settle, rather than a second record.
 */
function mergeRows(placed) {
  const merged = new Map();
  for (const entry of placed) {
    const key = `${entry.register}:${codeKey(entry.code)}`;
    const first = merged.get(key);
    if (!first) {
      merged.set(key, { ...entry, numbers: { ...entry.numbers }, notes: [...entry.notes] });
      continue;
    }
    const differences = [];
    for (const [field, value] of Object.entries(entry.numbers)) {
      if (first.numbers[field] === undefined) first.numbers[field] = value;
      else if (first.numbers[field] !== value) differences.push(`${LABELS[field]} ${value} (kept ${first.numbers[field]})`);
    }
    if (entry.photoUrl && !first.photoUrl) first.photoUrl = entry.photoUrl;
    else if (entry.photoUrl && entry.photoUrl !== first.photoUrl) differences.push('another photo');
    for (const note of entry.notes) if (!first.notes.includes(note)) first.notes.push(note);
    for (const warning of entry.warnings) if (!first.warnings.includes(warning)) first.warnings.push(warning);
    first.lines.push(entry.line);
    const said = entry.code === first.code ? '' : ` as "${entry.code}"`;
    first.warnings.push(differences.length
      ? `Line ${entry.line}${said} merged in — it differs: ${differences.join(', ')}`
      : `Line ${entry.line}${said} merged in`);
    if (differences.length) first.notes.push(`Sheet line ${entry.line} also gives ${differences.join(', ')} — check which is right`);
  }
  return [...merged.values()];
}

/** A register's records by `codeKey`, the "(2)" copies left out — they are reported, not matched. */
function byKey(records, keysOf) {
  const present = new Set(records.flatMap(keysOf).filter(Boolean).map(codeKey));
  const map = new Map();
  for (const record of records) {
    for (const value of keysOf(record)) {
      if (!value || copyOf(value, present)) continue;
      const key = codeKey(value);
      const list = map.get(key) || [];
      if (!list.includes(record)) map.set(key, [...list, record]);
    }
  }
  return map;
}

/**
 * Each entry's action: create or update on the mould register or the trading master. Nothing is
 * dropped and nothing is doubled: the rows of one code are one record [mergeRows], a code already
 * on the register — however it is spelt there — is updated, and a row with nothing but its name
 * goes in with prefilled values to fill in [applySheet]. Each of these is named in the warnings.
 */
export async function planSheet(entries) {
  const plan = mergeRows(placeRows(entries));
  const [moulds, items] = await Promise.all([
    Mould.find().select('mouldCode name'),
    TradedItem.find().select('code modelKey modelNumber'),
  ]);
  const register = {
    mould: { byKey: byKey(moulds, (mould) => [mould.mouldCode]), byName: byKey(moulds, (mould) => [mould.name]), codeOf: (mould) => mould.mouldCode },
    traded: { byKey: byKey(items, (item) => [item.code, item.modelNumber]), byName: new Map(), codeOf: (item) => item.code || item.modelNumber },
  };

  return plan.map((entry) => {
    const key = codeKey(entry.code);
    const here = register[entry.register];
    const matches = here.byKey.get(key) || here.byName.get(key) || [];
    const upper = entry.code.toUpperCase();
    const existing = matches.find((record) => here.codeOf(record).toUpperCase() === upper) || matches[0];
    if (existing && here.codeOf(existing).toUpperCase() !== upper) entry.warnings.push(`On ${REGISTER_NAME[entry.register]} as ${here.codeOf(existing)} — updated that one`);
    if (matches.length > 1) entry.warnings.push(`${REGISTER_NAME[entry.register]} already has ${matches.map(here.codeOf).join(' and ')} — one model? Merge them by hand`);
    const other = entry.register === 'mould' ? 'traded' : 'mould';
    const elsewhere = (register[other].byKey.get(key) || [])[0];
    if (elsewhere && !plan.some((row) => row.register === other && codeKey(row.code) === key)) {
      entry.warnings.push(`Also on ${REGISTER_NAME[other]} as ${register[other].codeOf(elsewhere)} — the sheet says ${entry.register === 'mould' ? 'Manufacture' : 'Trade'}`);
    }
    if (!existing && entry.numbers.partWeightGrams === undefined) {
      entry.warnings.push(entry.register === 'mould' ? 'No grammage — weight 0 until measured' : 'No grammage — the estimate has no resin');
    }
    return { ...entry, sheetCode: entry.code, action: existing ? 'update' : 'create', id: existing?._id };
  });
}

/**
 * The "CODE (2)" records an earlier import made for a code repeated on the sheet, on either
 * register — listed for the person to merge or delete; this never removes anything itself.
 */
export async function earlierCopies() {
  const [moulds, items] = await Promise.all([
    Mould.find().select('mouldCode'),
    TradedItem.find().select('modelNumber'),
  ]);
  const found = (register, records, codeOf) => {
    const present = new Set(records.map((record) => codeKey(codeOf(record))));
    return records
      .map((record) => ({ register, code: codeOf(record), of: copyOf(codeOf(record), present), id: record._id }))
      .filter((copy) => copy.of);
  };
  return [...found('mould', moulds, (mould) => mould.mouldCode), ...found('traded', items, (item) => item.modelNumber)];
}

const noteText = (entry) => entry.notes.join(' · ');

/** What a new record was given because the sheet did not say, for the person to replace. */
function prefilledNote(entry) {
  const missing = ['partWeightGrams', 'runnerWeightGrams', 'jobWorkCost', 'packingCost']
    .filter((field) => entry.numbers[field] === undefined)
    .map((field) => LABELS[field].toLowerCase());
  if (entry.register === 'mould') {
    const weight = entry.numbers.partWeightGrams === undefined ? 'weight 0 g, ' : '';
    return `Prefilled: ${weight}1 cavity, ${DEFAULT_CYCLE_SECONDS} s cycle, PP — fill in ${[...missing, 'cavities', 'cycle time'].join(', ')}.`;
  }
  return missing.length ? `Not on the sheet: ${missing.join(', ')} — fill in.` : '';
}
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
          notes: withNote(withNote(`From ${sheetName}.`, prefilledNote(entry)), noteText(entry)),
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
          notes: withNote(withNote(`${how}. Replace with the supplier's price.`, prefilledNote(entry)), noteText(entry)),
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
    const got = await fetchPhoto(entry.photoUrl, entry.sheetCode || entry.code);
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
