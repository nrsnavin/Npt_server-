import Component from '../models/Component.js';
import { parseSheet } from './mouldSheet.service.js';

/**
 * The plant's aux price lists — hooks, clips and print, one rate a piece — onto the hook, clip
 * and print registers [scripts/import-aux.js]. A name with "hook" in it is a hook; a print by
 * its colours ("1 COLOUR") is print; everything else (clips, and the pads that go with them) is a
 * clip. "NONE" is the list saying no part, and is not a part.
 */

export const kindOf = (name) => {
  if (/hook/i.test(name)) return 'hook';
  if (/\bcolou?rs?\b/i.test(name)) return 'print';
  return 'clip';
};

/** The shade a name carries, for the register's colour column. */
export function colourOf(name) {
  if (/\bblack\b/i.test(name)) return 'Black';
  if (/\bwhite\b/i.test(name)) return 'White';
  if (/\bm\.?\s?grey\b/i.test(name)) return 'M.Grey';
  return undefined;
}

export const nameKey = (name) => String(name || '').replace(/\s+/g, ' ').trim().toUpperCase();

/** The list's rows as `{ line, name, kind, colour, rate, warnings }`; "NONE" and blanks left out. */
export function readAux(text) {
  const rows = parseSheet(text);
  const headerAt = rows.findIndex((cells) => cells.some((cell) => /price|rate/i.test(cell)));
  const entries = [];
  rows.slice(headerAt + 1).forEach((cells, offset) => {
    const name = String(cells[0] ?? '').replace(/\s+/g, ' ').trim();
    if (!name || /^none$/i.test(name)) return;
    const raw = String(cells[1] ?? '').trim();
    const warnings = [];
    let rate = raw ? Number(raw.replace(/[₹,\s]|rs\.?/gi, '')) : undefined;
    if (raw && (!Number.isFinite(rate) || rate < 0)) {
      warnings.push(`price "${raw}" is not a number`);
      rate = undefined;
    }
    if (rate === undefined) warnings.push('No price — added at ₹0, to fill in');
    entries.push({ line: headerAt + offset + 2, name, kind: kindOf(name), colour: colourOf(name), rate, warnings });
  });
  return entries;
}

/** Each row: create, update (a price that moved), or unchanged — matched on kind and name. */
export async function planAux(entries) {
  const existing = await Component.find({ kind: { $in: ['hook', 'clip', 'print'] } }).select('kind name ratePerPiece');
  const byKey = new Map(existing.map((part) => [`${part.kind}:${nameKey(part.name)}`, part]));
  const seen = new Map();
  return entries.map((entry) => {
    const key = `${entry.kind}:${nameKey(entry.name)}`;
    if (seen.has(key)) return { ...entry, action: 'skip', reason: `already on line ${seen.get(key)}` };
    seen.set(key, entry.line);
    const part = byKey.get(key);
    if (!part) return { ...entry, action: 'create' };
    const moved = entry.rate !== undefined && part.ratePerPiece !== entry.rate;
    return { ...entry, id: part._id, action: moved ? 'update' : 'unchanged', from: part.ratePerPiece };
  });
}

/** Writes a plan; a price that moves is dated. */
export async function applyAux(plan) {
  const now = new Date();
  let created = 0;
  let updated = 0;
  for (const entry of plan) {
    if (entry.action === 'create') {
      await Component.create({
        kind: entry.kind,
        name: entry.name,
        colour: entry.colour,
        ratePerPiece: entry.rate ?? 0,
        rateUpdatedAt: entry.rate !== undefined ? now : undefined,
        notes: entry.rate === undefined ? 'No price on the aux list — fill it in.' : undefined,
      });
      created += 1;
    } else if (entry.action === 'update') {
      await Component.updateOne({ _id: entry.id }, { $set: { ratePerPiece: entry.rate, rateUpdatedAt: now } });
      updated += 1;
    }
  }
  return { created, updated };
}
