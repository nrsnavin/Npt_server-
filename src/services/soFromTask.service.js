import SalesOrder, { PRE_RELEASE_STATUSES } from '../models/SalesOrder.js';
import Enquiry from '../models/Enquiry.js';
import Mould from '../models/Mould.js';
import Material from '../models/Material.js';
import Component from '../models/Component.js';
import Todo from '../models/Todo.js';
import { nextNumber } from './numbering.service.js';
import { buildSpec } from './registers.service.js';
import { PAYMENT_PRESETS, assertPaidFor, planCollection } from './paymentGates.service.js';
import { EVENTS, publish } from './events.service.js';

/**
 * The SO team's task books the sales order itself [config/departmentTaskForms.js po_so].
 *
 * The request already says what the order is — each model with its material and colour, hook,
 * clip, print, pieces, price and EDD, the payment terms and the buyer's PO number. When the SO is
 * prepared (its PDF uploaded) those lines become the order on the Sales orders screen, matched to
 * the registers — the mould, the resin, the parts — so the plant plans what was asked, not a
 * retyped copy of it. The PDF stays on the task as the document sent to the buyer.
 *
 * Production confirmed on the request: the order is released to the plant there and then, and
 * its work orders are raised for the planning board. Not confirmed: it waits, unreleased, with the
 * enquiry under Production Holded Orders, and is released when Admin or its marketing person moves
 * it to Production [releaseHeldOrders]. The order's §13 checklist is not ticked on anybody's
 * behalf: the release says it came from the SO request, and who confirmed it.
 *
 * An enquiry that already has an open order (booked on the Sales orders screen) keeps it: the task
 * is linked to it rather than booking a second one. A line without a model, pieces or a price
 * cannot be an order line; nothing is booked then, and the task says what is missing.
 */

const lower = (text) => String(text || '').trim().toLowerCase();

/** "M-101 · 380mm slim shirt hanger" or "m-101" → the mould on the register, if there is one. */
async function mouldNamed(text) {
  const code = String(text || '').split(' · ')[0].trim().toUpperCase();
  if (!code) return null;
  return Mould.findOne({ mouldCode: code }).select('_id mouldCode').lean();
}

/** "PP Black" (the register's own words) → the material; else the words are the colour asked for. */
async function materialNamed(text, materials) {
  const said = lower(text);
  if (!said) return {};
  const label = (row) => lower(row.colour && !lower(row.name).includes(lower(row.colour)) ? `${row.name} ${row.colour}` : row.name);
  const match = materials.find((row) => label(row) === said);
  return match ? { materialRef: match._id, colour: match.colour || undefined } : { colour: String(text).trim() };
}

const partNamed = (text, kind, parts) => {
  const said = lower(text);
  return said ? parts.find((row) => row.kind === kind && lower(row.name) === said)?._id : undefined;
};

/** The request's lines as order lines, or why they cannot be. */
export async function orderLinesFromBrief(brief = {}) {
  const rows = Array.isArray(brief.items) ? brief.items : [];
  if (!rows.length) return { problem: 'the request has no order lines' };
  const missing = [];
  rows.forEach((row, at) => {
    const short = ['model', 'quantity', 'price'].filter((key) => !String(row[key] ?? '').trim() || (key === 'quantity' && !(Number(row.quantity) > 0)));
    if (short.length) missing.push(`line ${at + 1} (${row.model || 'no model'}) has no ${short.join(', ')}`);
  });
  if (missing.length) return { problem: missing.join('; ') };

  const [materials, parts] = await Promise.all([
    Material.find({ isActive: { $ne: false } }).select('name colour').lean(),
    Component.find({ isActive: { $ne: false }, kind: { $in: ['hook', 'clip', 'print'] } }).select('kind name').lean(),
  ]);
  const lines = [];
  for (const row of rows) {
    const mould = await mouldNamed(row.model);
    const material = await materialNamed(row.material, materials);
    const built = await buildSpec({
      mould: mould?._id,
      modelNumber: mould ? undefined : String(row.model).trim(),
      ...material,
      hookRef: partNamed(row.hook, 'hook', parts),
      clipRef: partNamed(row.clip, 'clip', parts),
      printRef: partNamed(row.print, 'print', parts),
      printing: row.print && !partNamed(row.print, 'print', parts) ? String(row.print).trim() : undefined,
    });
    lines.push({
      mould: built.mould || undefined,
      modelNumber: built.modelNumber,
      category: built.category,
      material: built.material,
      materialRef: built.materialRef || undefined,
      hookRef: built.hookRef || undefined,
      clipRef: built.clipRef || undefined,
      printRef: built.printRef || undefined,
      colour: built.colour,
      printing: built.printing,
      quantity: Number(row.quantity),
      unitPrice: Number(row.price),
      deliveryDate: row.edd ? new Date(row.edd) : undefined,
      /* What the request said that no register knows — kept on the line so nothing asked is lost. */
      remarks: [!mould && 'Model not on the mould register', row.hook && !built.hookRef && `Hook: ${row.hook}`, row.clip && !built.clipRef && `Clip: ${row.clip}`]
        .filter(Boolean).join(' · ') || undefined,
    });
  }
  return { lines };
}

const keyOf = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const money = (value) => `₹${Number(value)}`;

/**
 * The order's lines drafted from the SO PDF's reading [soRead.llm.js], with what the PDF leaves
 * blank filled from the request's line for the same model — and every difference between the two
 * said in words: a model on one and not the other, other pieces, another rate.
 */
export function draftFromReading(reading, requestRows = []) {
  const rows = [];
  const differences = [];
  const used = new Set();
  for (const read of reading?.lines || []) {
    const at = requestRows.findIndex((row, index) => !used.has(index) && keyOf(row.model).length && (keyOf(row.model) === keyOf(read.model) || keyOf(String(row.model).split(' · ')[0]) === keyOf(read.model)));
    const asked = at >= 0 ? requestRows[at] : null;
    if (at >= 0) used.add(at);
    else differences.push(`${read.model} is on the SO but not on the request`);
    if (asked) {
      if (read.quantity && Number(asked.quantity) && Number(asked.quantity) !== read.quantity) differences.push(`${read.model}: ${read.quantity.toLocaleString('en-IN')} pcs on the SO, ${Number(asked.quantity).toLocaleString('en-IN')} on the request`);
      if (read.price != null && asked.price !== undefined && asked.price !== '' && Number(asked.price) !== read.price) differences.push(`${read.model}: ${money(read.price)} on the SO, ${money(asked.price)} on the request`);
    }
    rows.push({
      model: read.model,
      material: read.material || asked?.material,
      hook: read.hook || asked?.hook,
      clip: read.clip || asked?.clip,
      print: read.print || asked?.print,
      quantity: read.quantity || asked?.quantity,
      price: read.price ?? asked?.price,
      edd: read.edd || asked?.edd,
    });
  }
  requestRows.forEach((row, index) => { if (!used.has(index) && row.model) differences.push(`${row.model} is on the request but not on the SO`); });
  return { rows, differences };
}

/**
 * Books (or finds) the enquiry's order for an SO task whose PDF was just uploaded. Returns the
 * order and what was said about it, or why none was booked. Never throws over the request's
 * contents: the SO is prepared either way.
 *
 * With a reading of the PDF [soRead.llm.js] the order is drafted from the SO itself — the document
 * sent to the buyer — and the request fills its gaps; without one (not set up, unreadable), from
 * the request. Either way it is a draft the SO team checks on the Sales orders screen.
 */
export async function bookOrderFromTask(task, user, { reading = null, readProblem = null } = {}) {
  const enquiryId = task.enquiry?._id || task.enquiry;
  if (!enquiryId) return { order: null };
  const enquiry = await Enquiry.findById(enquiryId).select('customer assignedTo number').lean();
  if (!enquiry?.customer) return { order: null, problem: 'the enquiry has no customer yet — convert the prospect first' };

  /* Already booked on the Sales orders screen (or by an earlier upload): the task is linked to it. */
  const open = await SalesOrder.findOne({ enquiry: enquiryId, status: { $nin: ['cancelled', 'closed'] } }).sort({ createdAt: -1 });
  if (open) {
    /* The SO PDF uploaded on the request is the order's too, where it has none yet. */
    if (task.resultFile && !open.soDocument) {
      open.soDocument = task.resultFile;
      await open.save();
    }
    return { order: open, linked: true };
  }

  const requestRows = Array.isArray(task.brief?.items) ? task.brief.items : [];
  let drafted = { from: 'request', readProblem: readProblem || undefined };
  let built = null;
  if (reading?.lines?.length) {
    const { rows, differences } = draftFromReading(reading, requestRows);
    const fromPdf = await orderLinesFromBrief({ items: rows });
    if (fromPdf.lines) {
      built = fromPdf;
      drafted = { from: 'so_pdf', soNumber: reading.soNumber, soDate: reading.soDate, differences };
    } else {
      /* The SO's own lines are short of a figure: the request's are used, and the SO team told why. */
      drafted = { from: 'request', readProblem: `the SO was read, but ${fromPdf.problem}` };
    }
  }
  const { lines, problem } = built || await orderLinesFromBrief(task.brief);
  if (problem) return { order: null, problem };

  const presetNamed = (words) => PAYMENT_PRESETS.find((preset) => lower(preset.label) === lower(words));
  const terms = presetNamed(task.brief?.paymentTerms) || presetNamed(reading?.paymentTerms);
  const poNumber = String(task.brief?.poNumber || reading?.poNumber || '').trim();
  const [order] = await SalesOrder.create([{
    number: await nextNumber('SO'),
    customer: enquiry.customer,
    enquiry: enquiryId,
    assignedTo: enquiry.assignedTo || user._id,
    sourceTask: task._id,
    ...(poNumber ? { customerPo: { number: poNumber, ...(reading?.poDate ? { date: new Date(reading.poDate) } : {}) } } : {}),
    drafted: { ...drafted, at: new Date() },
    ...(reading?.paymentTerms && !terms ? { remarks: `Payment terms on the SO: ${reading.paymentTerms}` } : {}),
    ...(terms ? { paymentTerms: terms.label, paymentPlan: { advancePercent: terms.advancePercent, beforeDispatchPercent: terms.beforeDispatchPercent } } : {}),
    soDocument: task.resultFile || undefined,
    lines,
    statusHistory: [{ to: 'po_received', by: user._id, note: `Booked from the SO request (${task.title})` }],
  }]);
  /* The terms say what is collected before production and dispatch: raise it and ask for it. */
  await planCollection(order, { by: user });
  return { order, booked: true, drafted };
}

/**
 * Released to the plant from the SO request (Production confirmed) or the enquiry's Move to
 * Production: the same release as the Sales orders screen's button, said as such. Refused by the
 * payment gate like any release — then it waits, and says why.
 */
export async function releaseFromTask(order, user, why) {
  if (!order || !PRE_RELEASE_STATUSES.includes(order.status)) return { released: false };
  try {
    await assertPaidFor(order, 'production', { by: user });
  } catch (error) {
    if (error?.statusCode === 400 || error?.statusCode === 409) return { released: false, problem: error.message };
    throw error;
  }
  order.statusHistory.push({ from: order.status, to: 'approved_for_production', by: user._id, note: why });
  order.status = 'approved_for_production';
  order.releasedBy = user._id;
  order.releasedAt = new Date();
  for (const line of order.lines) {
    if (!line.production) line.production = {};
    line.production.status = 'awaiting_planning';
  }
  await order.save();
  /* Work orders for the planning board, and the release said on the enquiry's tasks [handoff.subscriber]. */
  await publish(EVENTS.ORDER_RELEASED, { orderId: order._id, by: user });
  return { released: true };
}

/**
 * A Production Holded Order moved to Production: its order — booked from the SO request and
 * still waiting — is released with it.
 */
export async function releaseHeldOrders(enquiryId, user) {
  const waiting = await SalesOrder.find({ enquiry: enquiryId, sourceTask: { $exists: true }, status: { $in: PRE_RELEASE_STATUSES } });
  const results = [];
  for (const order of waiting) results.push({ order, ...(await releaseFromTask(order, user, 'Released with Move to Production')) });
  return results;
}

/** Says on the SO task what became of the order — booked, linked, released, or why not. */
export async function noteOrderOnTask(task, user, text) {
  await Todo.updateOne(
    { _id: task._id },
    { $push: { updates: { kind: 'notice', statusLabel: 'Sales order', text, note: `Sales order: ${text}`, by: user._id, at: new Date() } } },
    { keepVersion: true }
  );
}
