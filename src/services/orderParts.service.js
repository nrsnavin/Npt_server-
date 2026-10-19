import Component from '../models/Component.js';
import Mould from '../models/Mould.js';
import SalesOrder from '../models/SalesOrder.js';

/**
 * The hook, clip and print each order line carries, by name [web: OrderDetail "What was ordered",
 * ProductionWorkflow].
 *
 * A line's own pick on the register comes first. Where it has none, the mould says it: the mould
 * sheet gives each model its default part as a price — a hook at ₹0.70 is the 80MM MHOOK, the
 * only hook on the register at that price — so the part is the one the hook register prices the
 * same. Two parts at one price are both named ("80MM SPL.MHOOK or 80MM MHOOK BLACK"), for the
 * order team to pick on the line; none, and nothing is said. Names only — the rate stays off the
 * order screen.
 */

const COST_OF = { hook: 'hookCost', clip: 'clipsCost', print: 'printingCost' };
const paise = (value) => Math.round(Number(value || 0) * 100);
const idOf = (value) => String(value?._id || value || '');

/** For each mould, the parts its default costs name: `{ hook, clip, print }`, each `{ name, choices }` or null. */
export async function mouldDefaultParts(mouldIds = []) {
  const ids = [...new Set(mouldIds.map(idOf).filter((id) => /^[0-9a-f]{24}$/i.test(id)))];
  if (!ids.length) return new Map();
  const [moulds, parts] = await Promise.all([
    Mould.find({ _id: { $in: ids } }).select('hookCost clipsCost printingCost').lean(),
    Component.find({ kind: { $in: Object.keys(COST_OF) }, isActive: { $ne: false } }).select('kind name ratePerPiece').sort({ name: 1 }).lean(),
  ]);
  const priced = new Map();
  for (const part of parts) {
    const key = `${part.kind}:${paise(part.ratePerPiece)}`;
    priced.set(key, [...(priced.get(key) || []), part.name]);
  }
  return new Map(moulds.map((mould) => [String(mould._id), Object.fromEntries(Object.entries(COST_OF).map(([kind, field]) => {
    const names = paise(mould[field]) > 0 ? priced.get(`${kind}:${paise(mould[field])}`) || [] : [];
    return [kind, names.length ? { name: names.join(' or '), choices: names.length } : null];
  }))]));
}

/** One line's parts: `{ hook, clip, print }`, each `{ name, from: 'line' | 'mould', choices? }` or null. */
export function partsOfLine(line, defaults) {
  const fromMould = (kind) => {
    const found = defaults?.[kind];
    return found ? { name: found.name, from: 'mould', ...(found.choices > 1 ? { choices: found.choices } : {}) } : null;
  };
  const own = (name) => (name ? { name, from: 'line' } : null);
  return {
    hook: own(line.hookRef?.name) || fromMould('hook'),
    clip: own(line.clipRef?.name) || fromMould('clip'),
    print: own(line.printRef?.name || line.printing) || fromMould('print'),
  };
}

/** The order's lines (as sent) with `parts` on each. */
export async function withLineParts(plain) {
  const defaults = await mouldDefaultParts((plain.lines || []).map((line) => line.mould));
  return {
    ...plain,
    lines: (plain.lines || []).map((line) => ({ ...line, parts: partsOfLine(line, defaults.get(idOf(line.mould))) })),
  };
}

/** A line's print reference as the screens read it: the words, the file, who gave it and when. */
export const printReferenceOf = (line) => {
  const ref = line?.printReference;
  if (!ref?.text && !ref?.attachment) return null;
  const file = ref.attachment && typeof ref.attachment === 'object' && ref.attachment.key
    ? { key: ref.attachment.key, filename: ref.attachment.filename, mimeType: ref.attachment.mimeType }
    : null;
  return { text: ref.text || '', file, by: ref.by?.name || null, at: ref.at || null };
};

/**
 * What each model of an enquiry is to be made with, from its sales orders — the Production
 * workflow's spec per model [productionQueue.controller `productionWorkflow`]: hook, clip, print
 * and the print reference, the order's number beside them. The newest order's line wins a model
 * named on two.
 */
export async function orderSpecsForEnquiry(enquiryId) {
  const orders = await SalesOrder.find({ enquiry: enquiryId, status: { $ne: 'cancelled' } })
    .select('number lines.mould lines.modelNumber lines.hookRef lines.clipRef lines.printRef lines.printing lines.packing lines.colour lines.quantity lines.printReference')
    .populate([
      { path: 'lines.mould', select: 'mouldCode' },
      { path: 'lines.hookRef', select: 'name' },
      { path: 'lines.clipRef', select: 'name' },
      { path: 'lines.printRef', select: 'name' },
      { path: 'lines.printReference.attachment', select: 'key filename mimeType' },
      { path: 'lines.printReference.by', select: 'name' },
    ])
    .sort({ createdAt: -1 })
    .lean();
  const defaults = await mouldDefaultParts(orders.flatMap((order) => (order.lines || []).map((line) => line.mould)));
  const specs = [];
  const seen = new Set();
  for (const order of orders) {
    for (const line of order.lines || []) {
      const model = line.modelNumber || line.mould?.mouldCode || '';
      const key = model.toLowerCase().replace(/\s+/g, '');
      if (!model || seen.has(key)) continue;
      seen.add(key);
      specs.push({
        model,
        order: { _id: order._id, number: order.number },
        lineId: line._id,
        colour: line.colour || '',
        packing: line.packing || '',
        quantity: line.quantity || 0,
        parts: partsOfLine(line, defaults.get(idOf(line.mould))),
        printReference: printReferenceOf(line),
      });
    }
  }
  return specs;
}
