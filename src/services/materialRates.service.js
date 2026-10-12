import Material from '../models/Material.js';
import { parseSheet } from './mouldSheet.service.js';

/**
 * The plant's resin rate list onto the material register [scripts/import-materials.js]: one
 * row per material — resin, colour, the name the store uses ("PP : NATURAL") and the rate per kg.
 *
 * Grammage: a mould's weight is recorded on a PP basis, and HIPS throws 18.8% heavier from the
 * same cavity — so every HIPS row carries +18.8%, and every other resin the PP weight as it is.
 */

export const HIPS_GRAMMAGE_PERCENT = 18.8;

/** The resin as the list writes it → the register's type. GP-PS is GPPS written another way. */
const TYPES = {
  PP: 'pp', HIPS: 'hips', GPPS: 'gpps', 'GP-PS': 'gpps', LD: 'ld', HD: 'hd', ABS: 'abs',
  EVA: 'eva', KRESIN: 'kresin', PS: 'ps',
};

export const grammageFor = (type) => (type === 'hips' ? HIPS_GRAMMAGE_PERCENT : 0);

const squeeze = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export const nameKey = (name) => String(name || '').replace(/\s+/g, ' ').trim().toUpperCase();

/** The list's rows as `{ line, type, resin, colour, name, rate, warnings }`. */
export function readRates(text) {
  const rows = parseSheet(text);
  const headerAt = rows.findIndex((cells) => cells.some((cell) => /rate/i.test(cell)) && cells.some((cell) => /name/i.test(cell)));
  const header = headerAt >= 0 ? rows[headerAt].map(squeeze) : ['material', 'colour', 'name', 'rate per kg'];
  const at = (words) => header.findIndex((cell) => words.includes(cell));
  const columns = {
    resin: at(['material', 'resin', 'type']),
    colour: at(['colour', 'color']),
    name: at(['name']),
    rate: at(['rate per kg', 'rate', 'rate kg', 'price']),
  };
  const entries = [];
  rows.slice(headerAt >= 0 ? headerAt + 1 : 0).forEach((cells, offset) => {
    const line = (headerAt >= 0 ? headerAt : -1) + offset + 2;
    const resin = String(cells[columns.resin] ?? '').trim().toUpperCase();
    const colour = String(cells[columns.colour] ?? '').trim();
    if (!resin && !colour) return;
    const name = String(cells[columns.name] ?? '').trim() || `${resin} : ${colour}`;
    const warnings = [];
    const type = TYPES[resin] || 'other';
    if (!TYPES[resin]) warnings.push(`"${resin}" is not a resin the register knows — taken as Other`);
    const raw = String(cells[columns.rate] ?? '').trim();
    let rate = raw ? Number(raw.replace(/[₹,\s]|rs\.?/gi, '')) : undefined;
    if (raw && (!Number.isFinite(rate) || rate < 0)) {
      warnings.push(`rate "${raw}" is not a number`);
      rate = undefined;
    }
    if (rate === undefined) warnings.push('No rate — added at ₹0/kg, to fill in');
    entries.push({ line, resin, type, colour, name, rate, warnings });
  });
  return entries;
}

/** Each row: create, update (with what moves), or unchanged — matched on the name, any spacing or case. */
export async function planRates(entries) {
  const existing = await Material.find({}).select('name type colour ratePerKg grammageFactorPercent');
  const byName = new Map(existing.map((material) => [nameKey(material.name), material]));
  const seen = new Map();
  return entries.map((entry) => {
    const key = nameKey(entry.name);
    if (seen.has(key)) return { ...entry, action: 'skip', reason: `already on line ${seen.get(key)}` };
    seen.set(key, entry.line);
    const grammage = grammageFor(entry.type);
    const material = byName.get(key);
    if (!material) return { ...entry, grammage, action: 'create' };
    const changes = {};
    if (entry.rate !== undefined && material.ratePerKg !== entry.rate) changes.ratePerKg = { from: material.ratePerKg, to: entry.rate };
    if ((material.grammageFactorPercent || 0) !== grammage) changes.grammageFactorPercent = { from: material.grammageFactorPercent || 0, to: grammage };
    if (material.type !== entry.type) changes.type = { from: material.type, to: entry.type };
    return { ...entry, grammage, id: material._id, action: Object.keys(changes).length ? 'update' : 'unchanged', changes };
  });
}

/** Writes a plan; a rate that moves is dated. */
export async function applyRates(plan) {
  const now = new Date();
  let created = 0;
  let updated = 0;
  for (const entry of plan) {
    if (entry.action === 'create') {
      await Material.create({
        name: entry.name,
        type: entry.type,
        colour: entry.colour || undefined,
        ratePerKg: entry.rate ?? 0,
        rateUpdatedAt: entry.rate !== undefined ? now : undefined,
        grammageFactorPercent: entry.grammage,
        notes: entry.rate === undefined ? 'No rate on the rate list — fill it in.' : undefined,
      });
      created += 1;
    } else if (entry.action === 'update') {
      const material = await Material.findById(entry.id);
      if (!material) continue;
      if (entry.changes.ratePerKg) {
        material.ratePerKg = entry.rate;
        material.rateUpdatedAt = now;
      }
      material.grammageFactorPercent = entry.grammage;
      material.type = entry.type;
      if (entry.colour && !material.colour) material.colour = entry.colour;
      await material.save();
      updated += 1;
    }
  }
  return { created, updated };
}
