import Todo from '../models/Todo.js';
import Enquiry from '../models/Enquiry.js';
import Material from '../models/Material.js';
import Component from '../models/Component.js';
import { MATERIALS } from '../models/Mould.js';

/**
 * A model's details as the job last said them — material and colour, hook, clip, print and
 * packing — so a change made on any request (a different print on the quotation, another resin
 * for the sample) carries on to every request after it [handoff.service `taskPrefill`], and, when
 * the person asks, onto the enquiry itself [applyItemsToEnquiry].
 */

export const DETAIL_KEYS = ['material', 'colour', 'hook', 'clip', 'print', 'packing'];
const key = (model) => String(model || '').trim().toLowerCase();
const text = (value) => String(value ?? '').trim();

/**
 * Each model's details from the enquiry's requests, newest first: for every detail, the newest
 * request that gave it. `colourApart`: that request asked colour on its own (the sample's form);
 * otherwise its material line is "material & colour" together.
 */
export async function latestItemDetails(enquiryId) {
  const requests = await Todo.find({ enquiry: enquiryId, 'brief.items.0': { $exists: true } })
    .sort({ createdAt: -1 }).select('kind brief.items').limit(40).lean();
  const details = new Map();
  for (const request of requests) {
    for (const row of request.brief?.items || []) {
      const model = key(row?.model || row?.modelNumber);
      if (!model) continue;
      const said = details.get(model) || {};
      for (const name of DETAIL_KEYS) {
        if (said[name] !== undefined || !text(row[name])) continue;
        said[name] = text(row[name]);
        if (name === 'material') said.colourApart = Object.prototype.hasOwnProperty.call(row, 'colour');
      }
      details.set(model, said);
    }
  }
  return details;
}

/** "PP Black" — the material and colour as one line, unless the material already names the colour. */
export const materialAndColour = (material, colour) => (colour && !text(material).toLowerCase().includes(text(colour).toLowerCase())
  ? [material, colour].filter(Boolean).join(' ')
  : text(material) || text(colour));

/**
 * A row of the form brought up to what the job last said: the newest request's hook, clip, print
 * and packing; its material (and colour, where it asked them apart; else its "material & colour"
 * line, where it differs from the row's).
 */
export function withLatest(row, said) {
  if (!said) return row;
  const next = { ...row };
  for (const name of ['hook', 'clip', 'print', 'packing']) if (said[name]) next[name] = said[name];
  if (said.material) {
    if (said.colourApart) {
      next.material = said.material;
      if (said.colour !== undefined) next.colour = said.colour;
    } else if (said.material.toLowerCase() !== materialAndColour(next.material, next.colour).toLowerCase()) {
      next.material = said.material;
      next.colour = '';
    }
  } else if (said.colour) next.colour = said.colour;
  return next;
}

/** A register entry by its name, ignoring case. */
const byName = (Model, name, extra = {}) => (name ? Model.findOne({ ...extra, name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).select('name colour').lean() : null);

/**
 * "HIPS : NATURAL Black" read against the material register: the longest register name it starts
 * with, the rest its colour. A name the register does not know is matched to a resin family.
 */
async function readMaterial(line, colour) {
  const words = text(line);
  if (!words) return {};
  const exact = await byName(Material, words);
  if (exact) return { materialRef: exact._id, colour: colour ?? undefined };
  const all = await Material.find({}).select('name').lean();
  const lead = all.filter((entry) => words.toLowerCase().startsWith(entry.name.toLowerCase())).sort((a, b) => b.name.length - a.name.length)[0];
  /* What follows the name — "HIPS : NATURAL" — is the colour, without the separator. */
  const rest = (from) => text(words.slice(from)).replace(/^[:\-–,\s]+/, '') || undefined;
  if (lead) return { materialRef: lead._id, colour: colour ?? rest(lead.name.length) };
  const family = MATERIALS.find((entry) => words.toLowerCase().startsWith(entry.replace('_', ' ')));
  return family ? { material: family, colour: colour ?? rest(family.length) } : {};
}

/**
 * Writes a form's model rows onto the enquiry's items: each model matched by name, its material,
 * colour, hook, clip, print and packing set from the row — register entries by name, a print the
 * register does not know kept as the printing words. Returns what changed, model by model.
 */
export async function applyItemsToEnquiry(enquiryId, rows, user) {
  const enquiry = await Enquiry.findById(enquiryId)
    .populate([{ path: 'items.materialRef', select: 'name' }, { path: 'items.hookRef', select: 'name' }, { path: 'items.clipRef', select: 'name' }, { path: 'items.printRef', select: 'name' }]);
  if (!enquiry) return [];
  const changes = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const model = key(row?.model);
    if (!model) continue;
    const item = (enquiry.items || []).find((entry) => key(entry.modelNumber) === model);
    if (!item) continue;
    const said = (field, before, after) => { if (text(after) && text(after).toLowerCase() !== text(before).toLowerCase()) changes.push({ model: item.modelNumber, field, from: text(before), to: text(after) }); };
    const apart = Object.prototype.hasOwnProperty.call(row, 'colour');
    if (text(row.material)) {
      const before = materialAndColour(item.materialRef?.name || item.material, apart ? '' : item.colour);
      if (text(row.material).toLowerCase() !== before.toLowerCase()) {
        const read = await readMaterial(row.material, apart ? text(row.colour) || item.colour : undefined);
        if (read.materialRef || read.material) {
          said('material', before, row.material);
          item.materialRef = read.materialRef || undefined;
          if (read.material) item.material = read.material;
          if (read.colour !== undefined) item.colour = read.colour;
        }
      }
    }
    if (apart && text(row.colour) && text(row.colour).toLowerCase() !== text(item.colour).toLowerCase()) {
      said('colour', item.colour, row.colour);
      item.colour = text(row.colour);
    }
    for (const [field, kind, ref] of [['hook', 'hook', 'hookRef'], ['clip', 'clip', 'clipRef'], ['print', 'print', 'printRef']]) {
      const wanted = text(row[field]);
      const before = item[ref]?.name || (field === 'print' ? item.printing : '') || '';
      if (!wanted || wanted.toLowerCase() === text(before).toLowerCase()) continue;
      const found = await byName(Component, wanted, { kind });
      if (found) item[ref] = found._id;
      else if (field === 'print') { item.printRef = undefined; item.printing = wanted; } else continue;
      said(field, before, wanted);
    }
    if (text(row.packing) && text(row.packing) !== text(item.packing)) {
      said('packing', item.packing, row.packing);
      item.packing = text(row.packing);
    }
  }
  if (!changes.length) return [];
  enquiry.markModified('items');
  enquiry.$locals = { ...(enquiry.$locals || {}), by: user?._id };
  await enquiry.save();
  return changes;
}
