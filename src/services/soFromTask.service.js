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
 * An enquiry that already has an open order keeps it: a second (or third) SO request revises that
 * order from the latest request — its lines, terms and PO — rather than booking another
 * [reviseOrder]. A line kept keeps what the plant made and sent of it. An order already in
 * production was stopped when the request was sent [stopForRevision]; it goes back to the plant
 * as revised. A line without a model, pieces or a price cannot be an order line; nothing is booked
 * (or revised) then, and the task says what is missing.
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

  const open = await SalesOrder.findOne({ enquiry: enquiryId, status: { $nin: ['cancelled', 'closed'] } }).sort({ createdAt: -1 });
  /* Already booked by this request (an upload again): linked, with the PDF where it has none. */
  if (open && String(open.sourceTask || '') === String(task._id)) {
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
  if (problem) {
    /* An order already open stays as it was, linked; the request's gaps are said. */
    if (open) return { order: open, linked: true, problem: `not revised — ${problem}` };
    return { order: null, problem };
  }

  const presetNamed = (words) => PAYMENT_PRESETS.find((preset) => lower(preset.label) === lower(words));
  const terms = presetNamed(task.brief?.paymentTerms) || presetNamed(reading?.paymentTerms);
  const poNumber = String(task.brief?.poNumber || reading?.poNumber || '').trim();
  if (open) {
    const changes = await reviseOrder(open, user, { task, lines, terms, poNumber, reading, drafted });
    return { order: open, revised: true, changes, drafted };
  }
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
  /* Booked: Admin and the enquiry's marketing person hear it [orderNotices.service]. */
  const { noticeOrderBooked } = await import('./orderNotices.service.js');
  await noticeOrderBooked(order, { by: user });
  return { order, booked: true, drafted };
}

const modelKey = (line) => String(line.mould || line.modelNumber || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const pcs = (value) => `${Number(value || 0).toLocaleString('en-IN')} pcs`;
const LINE_TERMS = ['mould', 'modelNumber', 'category', 'material', 'materialRef', 'hookRef', 'clipRef', 'printRef', 'colour', 'printing', 'quantity', 'unitPrice', 'deliveryDate', 'remarks'];

/**
 * The open order revised from the latest SO request: each line matched to the order's line for the
 * same model keeps its id, what was made and sent of it, and takes the request's material, parts,
 * pieces, price and EDD; a model new on the request is added; a model no longer on it is taken
 * off — unless some of it has gone, when it stays at what has gone. The terms and PO follow the
 * request. Returns the changes in words. An order still in production is stopped first.
 */
export async function reviseOrder(order, user, { task, lines, terms, poNumber, reading = null, drafted = null }) {
  if (!PRE_RELEASE_STATUSES.includes(order.status)) await stopForRevision(order, user, { task, save: false });
  const changes = [];
  const old = [...order.lines];
  /* What is on a consignment already (sent or loading) — a line is never cut below it. */
  const { claimsFor } = await import('./dispatchStock.service.js');
  const claims = await claimsFor([order._id]);
  const claimedOf = (line) => { const claim = claims.get(String(line._id)); return claim ? claim.dispatched + claim.reserved : 0; };
  const kept = new Set();
  const next = [];
  for (const line of lines) {
    const match = old.find((entry) => !kept.has(String(entry._id)) && modelKey(entry) && modelKey(entry) === modelKey(line));
    if (match) {
      kept.add(String(match._id));
      const name = match.modelNumber || line.modelNumber || 'line';
      const claimed = claimedOf(match);
      if (line.quantity < claimed) {
        changes.push(`${name} kept at the ${pcs(claimed)} already on a consignment (the request said ${pcs(line.quantity)})`);
        line.quantity = claimed;
      }
      if (match.quantity !== line.quantity) changes.push(`${name} ${pcs(match.quantity)} → ${pcs(line.quantity)}`);
      if (match.unitPrice !== line.unitPrice) changes.push(`${name} ₹${match.unitPrice} → ₹${line.unitPrice}`);
      for (const field of LINE_TERMS) match.set(field, line[field]);
      next.push(match);
    } else {
      changes.push(`${line.modelNumber || 'a model'} added (${pcs(line.quantity)})`);
      next.push(line);
    }
  }
  for (const line of old.filter((entry) => !kept.has(String(entry._id)))) {
    const gone = claimedOf(line);
    if (gone > 0) {
      line.quantity = gone;
      next.push(line);
      changes.push(`${line.modelNumber || 'a model'} cut to the ${pcs(gone)} already on a consignment`);
    } else {
      changes.push(`${line.modelNumber || 'a model'} taken off`);
    }
  }
  order.lines = next;
  if (terms && order.paymentTerms !== terms.label) {
    changes.push(`terms ${order.paymentTerms || 'none'} → ${terms.label}`);
    order.paymentTerms = terms.label;
    order.paymentPlan = { advancePercent: terms.advancePercent, beforeDispatchPercent: terms.beforeDispatchPercent };
  }
  if (poNumber && order.customerPo?.number !== poNumber) {
    changes.push(`PO ${order.customerPo?.number || 'none'} → ${poNumber}`);
    order.customerPo = { number: poNumber, ...(reading?.poDate ? { date: new Date(reading.poDate) } : {}) };
  }
  if (task.resultFile) order.soDocument = task.resultFile;
  order.sourceTask = task._id;
  if (drafted) order.drafted = { ...drafted, at: new Date() };
  order.statusHistory.push({ from: order.status, to: order.status, by: user._id, note: `Revised from the SO request (${task.title})${changes.length ? `: ${changes.join('; ')}` : ' — nothing changed'}` });
  await order.save();
  const { ensureWorkOrders } = await import('./workOrder.service.js');
  await ensureWorkOrders({ orderIds: [order._id], user });
  await planCollection(order, { by: user });
  return changes;
}

/** The enquiry's open order already with the plant (released, not closed), if any. */
export async function orderInProductionFor(enquiryId) {
  if (!enquiryId) return null;
  const { CLOSED_ORDER_STATUSES } = await import('../models/SalesOrder.js');
  return SalesOrder.findOne({ enquiry: enquiryId, status: { $nin: [...PRE_RELEASE_STATUSES, ...CLOSED_ORDER_STATUSES] } }).sort({ createdAt: -1 });
}

/** In words, for the alert before a new SO request is sent and the notice after. */
export const inProductionWords = (order) => `${order.number} is already in production (${String(order.status).replace(/_/g, ' ')}). A new SO request stops that production — its work orders are cancelled — and the plant follows the revised SO once the SO team prepares it.`;

/**
 * An order taken back from the plant: it goes back to its checks, every line on hold, its open work
 * orders cancelled — marked to open again, with what they made, when it is released
 * [workOrder.service `ensureWorkOrders`]. `record` names the field that says why
 * (`revisionStop`, `paymentHold`); `save: false` leaves the save to the caller.
 */
export async function stopProduction(order, user, { why, record, extra = {}, save = true }) {
  if (PRE_RELEASE_STATUSES.includes(order.status)) return false;
  order[record] = { at: new Date(), by: user._id, fromStatus: order.status, ...extra };
  order.statusHistory.push({ from: order.status, to: 'order_verification', by: user._id, note: why });
  order.status = 'order_verification';
  order.releasedAt = undefined;
  order.releasedBy = undefined;
  for (const line of order.lines) {
    if (!line.production) line.production = {};
    line.production.status = 'production_hold';
  }
  const { default: WorkOrder, OPEN_WORK_ORDER_STATUSES } = await import('../models/WorkOrder.js');
  for (const wo of await WorkOrder.find({ order: order._id, status: { $in: OPEN_WORK_ORDER_STATUSES } })) {
    wo.status = 'cancelled';
    wo.reopenOnRelease = true;
    wo.history = [...(wo.history || []), { status: 'cancelled', note: `${order.number}: ${why}`, by: user._id, at: new Date() }];
    await wo.save();
  }
  if (save) await order.save();
  return true;
}

/** An order in production that a new SO request revises: the plant stops until the revised SO is released [stopProduction]. */
export async function stopForRevision(order, user, { task = null, save = true } = {}) {
  const why = `Production stopped — a new SO request${task?.title ? ` (${task.title})` : ''} revises this order${user?.name ? `, sent by ${user.name}` : ''}`;
  return stopProduction(order, user, { why, record: 'revisionStop', extra: { task: task?._id }, save });
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
  order.revisionStop = undefined;
  order.paymentHold = undefined;
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
