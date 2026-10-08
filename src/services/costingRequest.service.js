import Pricing from '../models/Pricing.js';
import { hasRequirement } from '../models/requirement.schema.js';
import { EVENTS, publish } from './events.service.js';
import { nextNumber } from './numbering.service.js';

/**
 * The costing sheet an enquiry is priced on — raised when the enquiry needs a price, by the
 * "Create Quotation" button or by its status reaching pricing required [subscribers/pricing].
 *
 * One open costing per enquiry: an enquiry that goes back and forth through pricing must not
 * leave a drawer of half-built sheets behind it, and the second person to open one would not
 * know which was current.
 */

/**
 * The models the costing has to price, one line each [§7].
 *
 * An enquiry carries a list of items now, and a sheet carries a line per model, so the handover
 * is row for row: five models asked about become five lines with five floors, rather than one
 * line and four models somebody has to remember. The registers the buyer's requirement already
 * names come across with them, so the sheet is costed against the same resin and parts the
 * enquiry asked for [§28].
 *
 * Nothing here computes a cost. This raises the sheet; building it is `/cost`, and a line with
 * no cost on it is exactly what "somebody still has to price this" looks like.
 *
 * Each line takes its own model's tool. It used to take the enquiry's single mould on line one
 * and nothing on the rest, from when only the first model could name one; once every item
 * could, line two kept arriving blank — the costing had to start from nothing for a model whose
 * tool the enquiry already named. The enquiry's own mould is still line one's fallback, for a
 * record written before items carried a tool.
 */
function lineFor(item = {}, { mould } = {}) {
  return {
    mould,
    modelNumber: item.modelNumber,
    materialRef: item.materialRef,
    hookRef: item.hookRef,
    clipRef: item.clipRef,
    printRef: item.printRef,
    material: item.material,
    quantity: item.quantity,
    status: 'requested',
  };
}

/*
 * A model named only by its tool counts. "The 420, same as last time" has no text in it at all,
 * and filtering on the described fields alone dropped it from the sheet — the same mistake the
 * enquiry controller once made, and fixed, with `describesItem`.
 */
const describesItem = (row) => Boolean(row?.mould || hasRequirement(row));

function linesFor(enquiry) {
  const items = (enquiry.items || []).filter(describesItem);
  const rows = items.length ? items : [enquiry.requirement || {}];
  return rows.map((item, index) =>
    lineFor(item, { mould: item.mould || (index === 0 ? enquiry.mould : undefined) }));
}

/** The open costing for this enquiry, raising it if there is none. */
export async function ensureCostingFor(enquiry) {
  const existing = await Pricing.findOne({ enquiry: enquiry._id, status: { $nin: ['rejected'] } });
  if (existing) return { pricing: existing, created: false };

  const pricing = await Pricing.create({
    number: await nextNumber('PRC'),
    enquiry: enquiry._id,
    customer: enquiry.customer?._id || enquiry.customer,
    lines: linesFor(enquiry),
    targetPrice: enquiry.targetPrice,
    requestedBy: enquiry.assignedTo?._id || enquiry.assignedTo,
    statusHistory: [{ to: 'requested', by: enquiry.assignedTo?._id || enquiry.assignedTo }],
  });
  await publish(EVENTS.PRICING_REQUESTED, { pricing, enquiry });
  return { pricing, created: true };
}
