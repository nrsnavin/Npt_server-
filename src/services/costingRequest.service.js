import Quotation, { CLOSED_QUOTATION_STATUSES, UNSENT_STATUSES } from '../models/Quotation.js';
import { resolveTasks } from './task.service.js';
import { EVENTS, publish } from './events.service.js';

/**
 * The quotation an enquiry is priced on — raised when the enquiry needs a price, by the
 * "Create Quotation" button or by its status reaching pricing required [subscribers/pricing].
 *
 * One open quotation per enquiry: an enquiry that goes back and forth through pricing must not
 * leave a drawer of half-built quotations behind it. It arrives with a line per model the
 * enquiry asks about and waits for the Quotation department to cost it.
 */
export async function ensureCostingFor(enquiry, { rows } = {}) {
  /*
   * Written before the look, so two requests in the same instant collide on the enquiry and the
   * second, retried, finds the first's quotation — rather than relying on the quote counter
   * happening to be written in the same transaction.
   */
  const { default: Enquiry } = await import('../models/Enquiry.js');
  await Enquiry.updateOne({ _id: enquiry._id }, { $set: { quotationAskedAt: new Date() } }, { timestamps: false });
  /* The models the task form named [departmentTaskForms create_quotation `items`] — filled from the enquiry, changed by whoever asked. */
  const lines = await quoteLinesFromRows(rows);
  const existing = await Quotation.findOne({ enquiry: enquiry._id, status: { $nin: CLOSED_QUOTATION_STATUSES } });
  if (existing) {
    const added = await addTaskModels(existing, lines);
    return { quotation: existing, created: false, added };
  }

  const { newQuotation } = await import('../controllers/quotation.controller.js');
  const quotation = await newQuotation({ enquiry: enquiry._id, ...(lines.length ? { lines } : {}), ...targetOf(lines) }, null, { system: true });
  return { quotation, created: true, added: lines.length };
}

/**
 * The quotation for a Create Quotation task raised from a customer with no enquiry [handoff.service
 * `raiseTeamTask`]: the buyer's, with the task's models as its lines. Nothing is made without a
 * customer or without a model — a quotation with neither has nothing to be about.
 */
export async function costingForCustomer(customerId, rows) {
  const lines = await quoteLinesFromRows(rows);
  if (!customerId || !lines.length) return null;
  const { newQuotation } = await import('../controllers/quotation.controller.js');
  return newQuotation({ customer: customerId, lines, ...targetOf(lines) }, null, { system: true });
}

const escape = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactly = (text) => new RegExp(`^${escape(String(text).trim())}$`, 'i');
const keyOf = (line) => String(line.mould || '') || String(line.modelNumber || '').trim().toLowerCase();

/**
 * The task form's model rows as quotation lines. Each row's answers are the registers' names, as
 * the form offers them ("M-101 · 380mm slim shirt hanger", "PP Black", the hook's name): resolved
 * to the mould, the material and the parts where they are on the registers, so the sheet is costed
 * from them; a model not on the register is quoted by its name. The material when it is not on
 * the register, and the target price, go on the line's remarks for the costing person.
 */
export async function quoteLinesFromRows(rows) {
  const asked = (Array.isArray(rows) ? rows : []).filter((row) => String(row?.model || '').trim());
  if (!asked.length) return [];
  const [{ default: Mould }, { default: Material }, { default: Component }] = await Promise.all([
    import('../models/Mould.js'), import('../models/Material.js'), import('../models/Component.js'),
  ]);
  const lines = [];
  for (const row of asked.slice(0, 20)) {
    const model = String(row.model).split(' · ')[0].trim();
    const mould = await Mould.findOne({ mouldCode: exactly(model) }).select('_id mouldCode').lean();
    const materialText = String(row.material || '').trim();
    const material = materialText ? await materialFor(Material, materialText) : null;
    const part = async (kind) => (String(row[kind] || '').trim()
      ? Component.findOne({ kind, name: exactly(row[kind]), isActive: { $ne: false } }).select('_id').lean()
      : null);
    const [hook, clip, print] = await Promise.all([part('hook'), part('clip'), part('print')]);
    const quantity = Number(String(row.quantity ?? '').replace(/,/g, ''));
    const target = Number(String(row.targetPrice ?? '').replace(/,/g, ''));
    const remarks = [
      materialText && !material && `Material & colour: ${materialText}`,
      String(row.hook || '').trim() && !hook && `Hook: ${row.hook}`,
      String(row.clip || '').trim() && !clip && `Clip: ${row.clip}`,
      String(row.print || '').trim() && !print && `Print: ${row.print}`,
      Number.isFinite(target) && target > 0 && `Target ₹${target} / pc`,
    ].filter(Boolean).join(' · ');
    lines.push({
      ...(mould ? { mould: mould._id } : { modelNumber: model }),
      ...(material ? { materialRef: material._id } : {}),
      ...(hook ? { hookRef: hook._id } : {}),
      ...(clip ? { clipRef: clip._id } : {}),
      ...(print ? { printRef: print._id } : {}),
      ...(String(row.packing || '').trim() ? { packing: String(row.packing).trim() } : {}),
      ...(Number.isFinite(quantity) && quantity > 0 ? { quantity } : {}),
      ...(remarks ? { remarks } : {}),
      ...(Number.isFinite(target) && target > 0 ? { targetPrice: target } : {}),
    });
  }
  return lines;
}

/** "PP Black" — the material by its name and colour as the form lists it, or by its name alone. */
async function materialFor(Material, text) {
  const active = { isActive: { $ne: false } };
  const named = await Material.findOne({ ...active, name: exactly(text) }).select('_id').lean();
  if (named) return named;
  const rows = await Material.find(active).select('_id name colour').lean();
  const wanted = text.toLowerCase().replace(/\s+/g, ' ');
  return rows.find((row) => `${row.name} ${row.colour || ''}`.toLowerCase().replace(/\s+/g, ' ').trim() === wanted) || null;
}

/** The quotation's target price from its rows, when the rows give one and agree. */
function targetOf(lines) {
  const targets = [...new Set(lines.map((line) => line.targetPrice).filter(Boolean))];
  return targets.length === 1 ? { targetPrice: targets[0] } : {};
}

/**
 * The task's models onto a quotation already open on the enquiry, while it is still being priced:
 * the models it does not carry yet are added, and a line that only stood for the enquiry ("As per
 * ENQ-…", nothing priced) gives way to the models named. One the buyer already holds is left as it
 * was — a revision is the Quotation team's to make.
 */
async function addTaskModels(quotation, lines) {
  if (!lines.length || !UNSENT_STATUSES.includes(quotation.status)) return 0;
  const { lineFrom } = await import('../controllers/quotation.controller.js');
  const have = new Set(quotation.lines.map((line) => keyOf({ mould: line.mould?._id || line.mould, modelNumber: line.modelNumber })));
  const missing = lines.filter((line) => !have.has(keyOf(line)));
  if (!missing.length) return 0;
  const standIn = (line) => !line.mould && !line.tradedItem && /^As per /i.test(line.modelNumber || '') && line.unitPrice == null;
  for (const line of [...quotation.lines]) if (standIn(line)) quotation.lines.pull(line._id);
  for (const row of missing) {
    const { targetPrice: _target, ...input } = row;
    quotation.lines.push(await lineFrom(input));
  }
  if (!quotation.targetPrice && targetOf(lines).targetPrice) quotation.targetPrice = targetOf(lines).targetPrice;
  quotation.statusHistory.push({ from: quotation.status, to: quotation.status, note: `Models added from the Create Quotation task: ${missing.map((line) => line.modelNumber || 'a model on the register').join(', ')}` });
  await quotation.save();
  return missing.length;
}

/** The newest answered or withdrawn quotation on the enquiry — what the next one is costed from. */
export async function lastClosedQuotationFor(enquiryId) {
  if (!enquiryId) return null;
  return Quotation.findOne({ enquiry: enquiryId, status: { $in: CLOSED_QUOTATION_STATUSES } }).sort({ createdAt: -1 });
}

/** Every handover a quotation can have queued [subscribers/pricing, subscribers/quotation]. */
const QUOTATION_TASK_KINDS = (quotation) => [
  `pricing:${quotation._id}:approval`,
  `pricing:${quotation._id}:cost`,
  `pricing:${quotation._id}:ready`,
  `quotation:${quotation._id}:follow-up`,
  `quotation:${quotation._id}:refused`,
  ...(quotation.lines || []).map((line) => `pricing:${quotation._id}:refused:${line._id}`),
];

/**
 * The enquiry is over — closed, or lost — and its quotation goes with it.
 *
 * One still being costed, waiting on Admin's signature or ready to send is **withdrawn**: the
 * plant pulled it, the buyer never answered, and the record says so rather than "rejected". Admin
 * is no longer asked to sign it, the Quotation department no longer sees it on the queue, and the
 * owner's "price ready" task is cleared. One the buyer already holds keeps its status — what was
 * offered is a fact — but nobody is asked to chase it any more.
 */
export async function withdrawQuotationsFor(enquiry, { note, by } = {}) {
  const open = await Quotation.find({ enquiry: enquiry._id, status: { $nin: CLOSED_QUOTATION_STATUSES } });
  const withdrawn = [];
  for (const quotation of open) {
    for (const key of QUOTATION_TASK_KINDS(quotation)) await resolveTasks(key);
    if (quotation.sentAt) continue;
    const from = quotation.status;
    quotation.status = 'withdrawn';
    quotation.statusHistory.push({ from, to: 'withdrawn', by: by?._id, note });
    quotation.respondedAt = new Date();
    await quotation.save();
    await publish(EVENTS.QUOTATION_WITHDRAWN, { quotation, by });
    withdrawn.push(quotation);
  }
  return withdrawn;
}
