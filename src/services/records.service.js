import QcRecord from '../models/QcRecord.js';
import Machine from '../models/Machine.js';
import MaintenanceRecord from '../models/MaintenanceRecord.js';
import MouldRun from '../models/MouldRun.js';
import Mould from '../models/Mould.js';
import Enquiry from '../models/Enquiry.js';
import Todo from '../models/Todo.js';
import { tellProductionTask } from './journey.service.js';
import Trip from '../models/Trip.js';
import SalesOrder, { OPEN_ORDER_STATUSES, PRE_RELEASE_STATUSES } from '../models/SalesOrder.js';
import Material from '../models/Material.js';
import StockMovement from '../models/StockMovement.js';
import { recordChange, snapshot } from './audit.service.js';
import { findHandoff } from '../config/handoffs.js';
import { modelJourneys, orderedModelsOf, warnDispatchOfQc } from './handoff.service.js';
import ApiError from '../utils/ApiError.js';
import { nextNumber } from './numbering.service.js';
import { finishedOn, startedOn, workOrderForRun } from './workOrder.service.js';
import { alertUnusual, mouldHistory as runHistoryOf, unusual, unusualSoFar } from './productionInsights.service.js';
import { withCreateLocks } from './operationLock.service.js';
import { render, letterhead, facts, footer } from './recordPdf.js';
import Inspection, { DEFECT_TYPES } from '../models/Inspection.js';
import Dispatch, { CLOSED_DISPATCH_STATUSES, GONE_DISPATCH_STATUSES } from '../models/Dispatch.js';
import { MOULDING_TYPES, PRINT_TYPES, QC_STAGES } from '../models/QcRecord.js';
import { MAINTENANCE_TYPES } from '../models/MaintenanceRecord.js';
import { aqlPlan } from '../utils/aql.js';
import { raiseDepartmentTask, resolveTasks } from './task.service.js';

/**
 * The plant's records beyond the workflow: QC test sheets, machines and their maintenance, mould
 * runs, and the register of what left the plant.
 */

const round1 = (value) => Math.round(value * 10) / 10;
const within = (actual, target, tolerance) => Math.abs(actual - target) <= (tolerance || 0);

/* ------------------------------------------------------------- QC records --- */

/**
 * Works out what can be worked out from the figures, so a result is never typed against its own
 * numbers: breaking strength's min/avg/max and pass, hook pull and clip grip against what is
 * required, weight and each measurement against target ± tolerance, the hang test against the
 * deflection allowed. A result the inspector set by hand where there are no figures is kept.
 */
export function workOut(record) {
  const out = structuredClone(record);
  const breaking = out.breaking || {};
  const samples = (breaking.samplesKg || []).filter((value) => Number.isFinite(value));
  if (samples.length) {
    breaking.minKg = Math.min(...samples);
    breaking.maxKg = Math.max(...samples);
    breaking.avgKg = round1(samples.reduce((sum, value) => sum + value, 0) / samples.length);
    if (breaking.requiredKg != null) breaking.result = breaking.minKg >= breaking.requiredKg ? 'pass' : 'fail';
  }
  out.breaking = breaking;
  if (out.hook?.pullRequiredKg != null && out.hook?.pullActualKg != null) out.hook.result = out.hook.pullActualKg >= out.hook.pullRequiredKg ? 'pass' : 'fail';
  if (out.clip?.gripRequiredKg != null && out.clip?.gripActualKg != null) out.clip.result = out.clip.gripActualKg >= out.clip.gripRequiredKg ? 'pass' : 'fail';
  if (out.weight?.target != null && out.weight?.actual != null) out.weight.result = within(out.weight.actual, out.weight.target, out.weight.tolerance) ? 'pass' : 'fail';
  for (const row of out.measurements || []) {
    if (row.target != null && row.actual != null) row.result = within(row.actual, row.target, row.tolerance) ? 'pass' : 'fail';
  }
  if (out.hangLoad?.deflectionMm != null && out.hangLoad?.allowedDeflectionMm != null) {
    out.hangLoad.result = out.hangLoad.deflectionMm <= out.hangLoad.allowedDeflectionMm ? 'pass' : 'fail';
  }
  const pass = (ok) => (ok ? 'pass' : 'fail');
  if (out.hookTurns?.required != null && out.hookTurns?.achieved != null) out.hookTurns.result = pass(out.hookTurns.achieved >= out.hookTurns.required);
  if (out.shrinkage?.mouldMm && out.shrinkage?.partMm != null) {
    out.shrinkage.percent = Math.round(((out.shrinkage.mouldMm - out.shrinkage.partMm) / out.shrinkage.mouldMm) * 10000) / 100;
    if (out.shrinkage.maxPercent != null) out.shrinkage.result = pass(Math.abs(out.shrinkage.percent) <= out.shrinkage.maxPercent);
  }
  const resin = out.resinChecks;
  if (resin?.moisturePercent != null && resin?.moistureMaxPercent != null) resin.moistureResult = pass(resin.moisturePercent <= resin.moistureMaxPercent);
  if (resin?.mfi != null && (resin.mfiMin != null || resin.mfiMax != null)) resin.mfiResult = pass((resin.mfiMin == null || resin.mfi >= resin.mfiMin) && (resin.mfiMax == null || resin.mfi <= resin.mfiMax));
  if (out.packing && (out.packing.piecesPerCarton != null || out.packing.labels)) {
    const counted = out.packing.piecesPerCarton == null || out.packing.piecesFound == null || out.packing.piecesFound === out.packing.piecesPerCarton;
    if (out.packing.piecesFound != null || out.packing.labels) out.packing.result = pass(counted && out.packing.labels !== 'fail');
  }
  /* AQL: the plan for the lot, its sample size where none was given, and the rejects against it. */
  const plan = out.aql ? aqlPlan(out.lotSize, out.aql) : null;
  if (plan) {
    out.aqlPlan = { letter: plan.letter, sampleSize: plan.sampleSize, accept: plan.accept, reject: plan.reject };
    if (out.sampleSize == null) out.sampleSize = plan.sampleSize;
    if (out.rejected != null) out.aqlResult = pass(out.rejected <= plan.accept);
  }
  if (out.sampleSize != null && out.rejected != null && out.accepted == null) out.accepted = Math.max(0, out.sampleSize - out.rejected);
  return out;
}

const failedOf = (record) => new QcRecord(record).failedTests;

/** The QC verdicts Dispatch is told about: a lot that failed, or is held, at the press or later. */
export const QC_WARNING_VERDICTS = ['rejected', 'on_hold'];
const LOT_STAGES = ['first_off', 'in_process', 'final', 'pre_dispatch'];

/**
 * The latest QC verdict on each enquiry's goods (the press, final and before-dispatch checks — not
 * incoming material), for the dispatch screens to show beside each request. Shown, never a lock:
 * the plant decides whether goods go.
 */
export async function latestQcByEnquiry(enquiryIds) {
  const ids = [...new Set((enquiryIds || []).filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const rows = await QcRecord.find({ enquiry: { $in: ids }, stage: { $in: LOT_STAGES } })
    .sort({ inspectedAt: -1 }).select('number enquiry order verdict stage inspectedAt breaking hook clip print weight measurements hangLoad drop colourMatch hookTurns uv shrinkage resinChecks packing cartonDrop aqlResult').lean();
  const latest = new Map();
  for (const row of rows) {
    if (latest.has(String(row.enquiry))) continue;
    latest.set(String(row.enquiry), { _id: row._id, number: row.number, verdict: row.verdict, stage: row.stage, at: row.inspectedAt, failed: new QcRecord(row).failedTests });
  }
  return latest;
}

/** The SO an enquiry's work belongs to: its newest sales order, as the department forms read it. */
export const orderOnEnquiry = (enquiryId) => (enquiryId
  ? SalesOrder.findOne({ enquiry: enquiryId }).sort({ createdAt: -1 }).select('number enquiry customer lines._id lines.modelNumber lines.mould lines.colour').lean()
  : null);

/** The enquiry's open SOs, newest first — more than one, and work that belongs to one SO must say which. */
export const openOrdersOn = (enquiryId) => (enquiryId
  ? SalesOrder.find({ enquiry: enquiryId, status: { $in: OPEN_ORDER_STATUSES } }).sort({ createdAt: -1 }).select('number customerPo.number').lean()
  : []);
const askWhichOrder = (open) => ApiError.badRequest(`This enquiry has ${open.length} open sales orders (${open.map((row) => row.number).join(', ')}) — pick which one this is for`);

/**
 * Ties a QC record to its sales order. Picked: it must exist and be on the same enquiry, and the
 * line must be one of its lines — the model and mould come off the line when the sheet left them
 * empty. Not picked: the enquiry's SO, so a sheet filled from an enquiry still lands on the order.
 */
async function linkOrder(record) {
  let order;
  if (record.order) {
    order = await SalesOrder.findById(record.order).select('number enquiry customer lines._id lines.modelNumber lines.mould lines.colour').lean();
    if (!order) throw ApiError.badRequest('That sales order was not found');
    if (record.enquiry && order.enquiry && String(order.enquiry) !== String(record.enquiry)) {
      throw ApiError.badRequest(`${order.number} is on another enquiry — pick the SO of this enquiry`);
    }
  } else {
    const open = await openOrdersOn(record.enquiry);
    if (open.length > 1) throw askWhichOrder(open);
    order = await orderOnEnquiry(record.enquiry);
  }
  if (!order) {
    if (record.orderLine) throw ApiError.badRequest('Pick the sales order the line is on');
    return;
  }
  record.order = order._id;
  record.enquiry = record.enquiry || order.enquiry;
  record.customer = record.customer || order.customer;
  if (record.orderLine) {
    const line = (order.lines || []).find((row) => String(row._id) === String(record.orderLine));
    if (!line) throw ApiError.badRequest(`That line is not on ${order.number}`);
    record.modelNumber = record.modelNumber || line.modelNumber;
    record.mould = record.mould || line.mould;
  } else if (order.lines?.length === 1) {
    record.orderLine = order.lines[0]._id;
  }
}

export async function createQcRecord(body, user) {
  const record = workOut(body);
  if (record.rejected > (record.sampleSize ?? Infinity)) throw ApiError.badRequest('More rejected than were sampled — check the figures');
  if (record.rejected > 0 && !record.defects?.length) throw ApiError.badRequest('Say what was wrong with the rejected pieces');
  const failed = failedOf(record);
  /* Rejects within the AQL plan still pass the lot; without a plan, any reject is a deviation. */
  const rejectsAllowed = record.aqlPlan ? record.aqlPlan.accept : 0;
  if (record.verdict === 'passed' && (failed.length || record.rejected > rejectsAllowed)) {
    throw ApiError.badRequest(`${failed.length ? `${failed.join(', ')} failed` : 'Pieces were rejected'} — mark it Passed with deviation (say why in the remarks) or Rejected`);
  }
  if (record.verdict === 'passed_with_deviation' && String(record.remarks || '').trim().length < 5) {
    throw ApiError.badRequest('Say why it passes with a deviation');
  }
  /* The task first: the enquiry (and its SO) come off it, and the buyer off the enquiry. */
  if (record.task) {
    const task = await Todo.findById(record.task).select('kind enquiry order').lean();
    if (!task || !['quality_check', 'quality_issue'].includes(task.kind)) throw ApiError.badRequest('A QC record answers a Quality task');
    record.enquiry = record.enquiry || task.enquiry;
    record.order = record.order || task.order;
  }
  await linkOrder(record);
  if (record.enquiry) {
    const enquiry = await Enquiry.findById(record.enquiry).select('customer').lean();
    if (!enquiry) throw ApiError.badRequest('That enquiry was not found');
    record.customer = record.customer || enquiry.customer;
  }
  const [made] = await QcRecord.create([{ ...record, number: await nextNumber('QCR'), inspectedBy: user._id, inspectedAt: record.inspectedAt || new Date() }]);
  await syncInspection(made, user);
  if (QC_WARNING_VERDICTS.includes(made.verdict) && LOT_STAGES.includes(made.stage) && made.enquiry) {
    await warnDispatchOfQc(made, user);
  }
  if (made.task) {
    await Todo.updateOne(
      { _id: made.task },
      { $push: { updates: { kind: 'notice', statusLabel: `QC record ${made.number}`, text: `${made.verdict.replace(/_/g, ' ')}${made.failedTests.length ? ` — failed ${made.failedTests.join(', ')}` : ''}`, note: `QC record ${made.number}: ${made.verdict.replace(/_/g, ' ')}${made.failedTests.length ? ` — failed ${made.failedTests.join(', ')}` : ''}`, by: user._id, at: new Date() } } },
      { keepVersion: true }
    );
  }
  return made;
}

/**
 * One form for Quality: a QC sheet on an SO line also writes that line's inspection — the record
 * the SO's quality panel, the line's hold and the consignment's pre-dispatch check read. The press
 * and final checks always; a before-dispatch check when exactly one consignment still to go carries
 * the line (an inspection before dispatch is about one lorry). Otherwise the sheet says why not.
 */
async function syncInspection(record, user) {
  const note = (text) => QcRecord.updateOne({ _id: record._id }, { $set: { inspectionNote: text } }, { keepVersion: true });
  if (!record.order || !record.orderLine) return null;
  if (!['in_process', 'final', 'pre_dispatch'].includes(record.stage)) return null;
  if (!['passed', 'passed_with_deviation', 'rejected'].includes(record.verdict)) return note('On hold — no inspection written until it has a verdict');
  if (!(record.sampleSize > 0)) return note('No pieces counted, so no inspection was written on the SO');
  const order = await SalesOrder.findById(record.order).select('status lines');
  const line = order?.lines.id(record.orderLine);
  if (!order || !line) return null;
  if (PRE_RELEASE_STATUSES.includes(order.status) || order.status === 'cancelled') return note(`${order.status === 'cancelled' ? 'The SO was cancelled' : 'The SO is not released yet'} — no inspection written on it`);
  let consignment = null;
  if (record.stage === 'pre_dispatch') {
    const open = await Dispatch.find({ order: order._id, 'lines.orderLine': line._id, status: { $nin: [...GONE_DISPATCH_STATUSES, ...CLOSED_DISPATCH_STATUSES] } }).select('_id number').lean();
    if (open.length !== 1) return note(open.length ? 'More than one consignment carries this line — record the before-dispatch check on the consignment' : 'No consignment raised yet — the check is kept here and on the dispatch request');
    [consignment] = open;
  }
  const [inspection] = await Inspection.create([{
    number: await nextNumber('QC'),
    order: order._id,
    line: line._id,
    dispatch: consignment?._id,
    mould: record.mould || line.mould,
    materialRef: line.materialRef,
    modelNumber: record.modelNumber || line.modelNumber,
    colour: record.resin?.colour || line.colour,
    stage: record.stage,
    inspectedBy: user._id,
    inspectedAt: record.inspectedAt || new Date(),
    quantityInspected: record.sampleSize,
    quantityRejected: record.rejected || 0,
    defects: record.defects || [],
    verdict: record.verdict,
    remarks: [`From QC record ${record.number}`, record.remarks].filter(Boolean).join(' — '),
  }]);
  await QcRecord.updateOne({ _id: record._id }, { $set: { inspection: inspection._id }, $unset: { inspectionNote: 1 } }, { keepVersion: true });
  return inspection;
}

/** The QC head's sign-off — never the inspector's own. */
export async function approveQcRecord(record, user) {
  if (record.approvedAt) throw ApiError.conflict(`${record.number} was already approved`);
  if (String(record.inspectedBy) === String(user._id)) throw ApiError.forbidden('The record is approved by someone other than the person who checked it');
  record.approvedBy = user._id;
  record.approvedAt = new Date();
  await record.save();
  return record;
}

const QC_POPULATE = [
  { path: 'enquiry', select: 'number' }, { path: 'customer', select: 'name code' }, { path: 'mould', select: 'mouldCode name' },
  { path: 'order', select: 'number customerPo.number status' }, { path: 'inspection', select: 'number verdict' },
  { path: 'machine', select: 'code name' }, { path: 'resin.material', select: 'name grade' }, { path: 'inspectedBy', select: 'name' },
  { path: 'approvedBy', select: 'name' }, { path: 'run', select: 'number' }, { path: 'task', select: 'kind title' },
];
export const populateQc = (query) => query.populate(QC_POPULATE);

export async function listQcRecords({ stage, verdict, mould, enquiry, order, from, to, page = 1, limit = 25 }) {
  const filter = {};
  if (order) filter.order = order;
  if (stage) filter.stage = stage;
  if (verdict) filter.verdict = verdict;
  if (mould) filter.mould = mould;
  if (enquiry) filter.enquiry = enquiry;
  if (from || to) filter.inspectedAt = { ...(from ? { $gte: new Date(`${from}T00:00:00+05:30`) } : {}), ...(to ? { $lte: new Date(`${to}T23:59:59+05:30`) } : {}) };
  const size = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * size;
  const [rows, total] = await Promise.all([
    populateQc(QcRecord.find(filter).sort({ inspectedAt: -1 }).skip(skip).limit(size)),
    QcRecord.countDocuments(filter),
  ]);
  return { rows, pagination: { page: Math.max(Number(page) || 1, 1), limit: size, total, pages: Math.ceil(total / size) } };
}

const label = (list, key) => list.find((entry) => entry.key === key)?.label || key;
const result = (value) => ({ pass: 'Pass', fail: 'FAIL', not_tested: '—' }[value] || '—');

/** The QC certificate: what was made, what it was made of, how it tested, and who signed it. */
export async function renderQcCertificate(record) {
  await record.populate(QC_POPULATE);
  return render((doc) => {
    letterhead(doc, 'Quality test report', record.number);
    facts(doc, [
      ['Stage', label(QC_STAGES, record.stage)],
      ['Buyer', record.customer?.name],
      ['Enquiry', record.enquiry?.number],
      ['Sales order', record.order?.number],
      ['Buyer PO', record.order?.customerPo?.number],
      ['Model / size', [record.modelNumber || record.mould?.mouldCode, record.size].filter(Boolean).join(' · ')],
      ['Moulding', record.mouldingType && label(MOULDING_TYPES, record.mouldingType)],
      ['Resin', [record.resin?.name || record.resin?.material?.name, record.resin?.grade, record.resin?.colour, record.resin?.batch && `batch ${record.resin.batch}`].filter(Boolean).join(' · ')],
      ['Masterbatch', record.resin?.masterbatch && `${record.resin.masterbatch}${record.resin.masterbatchPercent != null ? ` · ${record.resin.masterbatchPercent}%` : ''}`],
      ['Hook', [record.hook?.type, record.hook?.finish].filter(Boolean).join(' · ')],
      ['Clips', record.clip?.type],
      ['Print', record.print?.type && [label(PRINT_TYPES, record.print.type), record.print.colour, record.print.artwork].filter(Boolean).join(' · ')],
      ['Produced on', record.producedOn && new Date(record.producedOn).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })],
    ]);
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#111111').text('Tests', 42, doc.y);
    doc.moveDown(0.3);
    const rows = [
      ['Breaking strength', record.breaking?.samplesKg?.length ? `min ${record.breaking.minKg} / avg ${record.breaking.avgKg} / max ${record.breaking.maxKg} kgf (${record.breaking.samplesKg.length} samples)` : '', record.breaking?.requiredKg != null ? `≥ ${record.breaking.requiredKg} kgf` : '', record.breaking?.result],
      ['Hang load', record.hangLoad?.loadKg != null ? `${record.hangLoad.loadKg} kg for ${record.hangLoad.hours ?? '—'} h, ${record.hangLoad.deflectionMm ?? '—'} mm` : '', record.hangLoad?.allowedDeflectionMm != null ? `≤ ${record.hangLoad.allowedDeflectionMm} mm` : '', record.hangLoad?.result],
      ['Drop', record.drop?.heightCm != null ? `${record.drop.heightCm} cm × ${record.drop.drops ?? 1}` : '', '', record.drop?.result],
      ['Hook pull', record.hook?.pullActualKg != null ? `${record.hook.pullActualKg} kgf` : '', record.hook?.pullRequiredKg != null ? `≥ ${record.hook.pullRequiredKg} kgf` : '', record.hook?.result],
      ['Clip grip', record.clip?.gripActualKg != null ? `${record.clip.gripActualKg} kgf` : '', record.clip?.gripRequiredKg != null ? `≥ ${record.clip.gripRequiredKg} kgf` : '', record.clip?.result],
      ['Print adhesion', '', 'tape test', record.print?.adhesion],
      ['Weight', record.weight?.actual != null ? `${record.weight.actual} g` : '', record.weight?.target != null ? `${record.weight.target} ± ${record.weight.tolerance ?? 0} g` : '', record.weight?.result],
      ...(record.measurements || []).map((row) => [row.name, row.actual != null ? `${row.actual} ${row.unit || ''}` : '', row.target != null ? `${row.target} ± ${row.tolerance ?? 0} ${row.unit || ''}` : '', row.result]),
      ['Colour', '', record.colourMatch?.against ? `against ${record.colourMatch.against}` : '', record.colourMatch?.result],
      ['Hook turns', record.hookTurns?.achieved != null ? `${record.hookTurns.achieved} turns` : '', record.hookTurns?.required != null ? `≥ ${record.hookTurns.required}` : '', record.hookTurns?.result],
      ['UV / colour-fastness', record.uv?.hours != null ? `${record.uv.hours} h` : '', '', record.uv?.result],
      ['Shrinkage', record.shrinkage?.percent != null ? `${record.shrinkage.percent}%` : '', record.shrinkage?.maxPercent != null ? `≤ ${record.shrinkage.maxPercent}%` : '', record.shrinkage?.result],
      ['Resin moisture', record.resinChecks?.moisturePercent != null ? `${record.resinChecks.moisturePercent}%` : '', record.resinChecks?.moistureMaxPercent != null ? `≤ ${record.resinChecks.moistureMaxPercent}%` : '', record.resinChecks?.moistureResult],
      ['Melt-flow (MFI)', record.resinChecks?.mfi != null ? `${record.resinChecks.mfi} g/10 min` : '', [record.resinChecks?.mfiMin, record.resinChecks?.mfiMax].some((value) => value != null) ? `${record.resinChecks.mfiMin ?? '—'}–${record.resinChecks.mfiMax ?? '—'}` : '', record.resinChecks?.mfiResult],
      ['Packing', record.packing?.piecesFound != null ? `${record.packing.piecesFound} pcs/carton` : '', record.packing?.piecesPerCarton != null ? `${record.packing.piecesPerCarton} pcs/carton` : '', record.packing?.result],
      ['Carton drop', record.cartonDrop?.heightCm != null ? `${record.cartonDrop.heightCm} cm × ${record.cartonDrop.drops ?? 1}` : '', '', record.cartonDrop?.result],
    ].filter(([, found, wanted, outcome]) => found || wanted || (outcome && outcome !== 'not_tested'));
    const widths = [120, 210, 110, 70];
    for (const row of rows) {
      const y = doc.y;
      let x = 42;
      row.forEach((cell, index) => {
        doc.font(index === 3 && cell === 'fail' ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('#111111')
          .text(index === 3 ? result(cell) : String(cell || ''), x, y, { width: widths[index] - 6 });
        x += widths[index];
      });
      doc.moveDown(0.35);
    }
    doc.moveDown(0.4);
    facts(doc, [
      ['AQL', record.aqlPlan?.sampleSize ? `${record.aql} · code ${record.aqlPlan.letter} · sample ${record.aqlPlan.sampleSize} · accept ≤ ${record.aqlPlan.accept}, reject ≥ ${record.aqlPlan.reject} · ${record.aqlResult === 'fail' ? 'LOT REJECTED' : 'lot accepted'}` : null],
      ['Standards', record.standardsFrom],
      ['Sample', record.sampleSize != null ? `${record.sampleSize} of a lot of ${record.lotSize ?? '—'} · ${record.accepted ?? '—'} accepted · ${record.rejected || 0} rejected` : null],
      ['Defects', (record.defects || []).map((row) => `${DEFECT_TYPES.find((entry) => entry.key === row.type)?.label || row.type} × ${row.count}`).join(', ')],
      ['Verdict', record.verdict.replace(/_/g, ' ').toUpperCase()],
      ['Remarks', record.remarks],
      ['Checked by', `${record.inspectedBy?.name || ''} · ${new Date(record.inspectedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`],
      ['Approved by', record.approvedBy ? `${record.approvedBy.name} · ${new Date(record.approvedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` : 'Not yet approved'],
    ]);
    footer(doc);
  });
}

/* ----------------------------------------------------- machines, maintenance --- */

const addDays = (date, days) => new Date(new Date(date).getTime() + days * 86400000);

/**
 * A piece of maintenance recorded — and the machine or mould it was on brought up to date: when
 * it was last serviced and when (or at what shot count) it is next due, and its status back to
 * working when it was down for this.
 */
export async function recordMaintenance(body, user) {
  if (body.asset === 'machine' && !body.machine) throw ApiError.badRequest('Pick the machine');
  if (body.asset === 'mould' && !body.mould) throw ApiError.badRequest('Pick the mould');
  const doneOn = new Date(body.doneOn || Date.now());
  if (doneOn > addDays(new Date(), 1)) throw ApiError.badRequest('Maintenance cannot be recorded for a day still to come');
  let record;
  if (body.asset === 'machine') {
    const machine = await Machine.findById(body.machine);
    if (!machine) throw ApiError.badRequest('That machine is not on the list');
    const nextDueOn = body.nextDueOn ? new Date(body.nextDueOn) : machine.serviceEveryDays ? addDays(doneOn, machine.serviceEveryDays) : undefined;
    [record] = await MaintenanceRecord.create([{ ...body, mould: undefined, doneOn, nextDueOn, number: await nextNumber('MNT'), recordedBy: user._id }]);
    if (!machine.lastServiceAt || doneOn >= machine.lastServiceAt) {
      machine.lastServiceAt = doneOn;
      if (nextDueOn) machine.nextServiceDue = nextDueOn;
    }
    if (['breakdown', 'maintenance'].includes(machine.status) && body.backInService !== false) machine.status = 'idle';
    await machine.save();
    await resolveTasks(machineReminderKey(machine._id));
  } else {
    const mould = await Mould.findById(body.mould);
    if (!mould) throw ApiError.badRequest('That mould is not on the register');
    const shotCount = body.shotCount ?? mould.totalShots ?? 0;
    const nextDueShots = body.nextDueShots ?? (mould.maintenanceEveryShots ? shotCount + mould.maintenanceEveryShots : undefined);
    [record] = await MaintenanceRecord.create([{ ...body, machine: undefined, doneOn, shotCount, nextDueShots, number: await nextNumber('MNT'), recordedBy: user._id }]);
    if (!mould.lastMaintenanceAt || doneOn >= mould.lastMaintenanceAt) {
      mould.lastMaintenanceAt = doneOn;
      mould.lastMaintenanceShots = shotCount;
    }
    if (mould.status === 'maintenance' && body.backInService !== false) mould.status = 'active';
    await mould.save();
    await resolveTasks(mouldReminderKey(mould._id));
  }
  return record;
}

export async function maintenanceHistory({ asset, machine, mould, type, from, to, limit = 100 }) {
  const filter = {};
  if (asset) filter.asset = asset;
  if (machine) filter.$or = [{ machine }, { onMachine: machine }];
  if (mould) filter.mould = mould;
  if (type) filter.type = type;
  if (from || to) filter.doneOn = { ...(from ? { $gte: new Date(`${from}T00:00:00+05:30`) } : {}), ...(to ? { $lte: new Date(`${to}T23:59:59+05:30`) } : {}) };
  return MaintenanceRecord.find(filter).sort({ doneOn: -1 }).limit(Math.min(Number(limit) || 100, 500))
    .populate([{ path: 'machine', select: 'code name' }, { path: 'mould', select: 'mouldCode name' }, { path: 'onMachine', select: 'code' }, { path: 'recordedBy', select: 'name' }]);
}

export const MAINTENANCE_LABELS = Object.fromEntries(MAINTENANCE_TYPES.map((type) => [type.key, type.label]));

/* ------------------------------------------------------------- mould runs --- */

const sameCode = (a, b) => String(a || '').replace(/[^a-z0-9]/gi, '').toLowerCase() === String(b || '').replace(/[^a-z0-9]/gi, '').toLowerCase();

/** How far over the pieces ordered a run may plan: 10%. */
export const RUN_OVER_LIMIT = 0.1;

/**
 * The models a run for this enquiry may make, with the pieces ordered of each: the SO's lines when
 * it has one, else the enquiry's items. `[{ mould, modelNumber, quantity }]`.
 */
export async function runModelsOf(enquiryId, order = null) {
  if (order?.lines?.length) return order.lines.map((line) => ({ mould: line.mould ? String(line.mould) : null, modelNumber: line.modelNumber || '', quantity: line.quantity || 0 }));
  const enquiry = await Enquiry.findById(enquiryId).select('items.mould items.modelNumber mould requirement.modelNumber').lean();
  if (!enquiry) return [];
  /* No SO yet: the pieces the job's requests give each model [handoff.service `orderedModelsOf`]. */
  const { orderedModelsOf } = await import('./handoff.service.js');
  const { ordered } = await orderedModelsOf({ enquiryId });
  const piecesOf = (model) => [...ordered].find(([name]) => sameCode(name, model))?.[1] || 0;
  const rows = enquiry.items?.length
    ? enquiry.items.map((item) => ({ mould: item.mould ? String(item.mould) : null, modelNumber: item.modelNumber || '' }))
    : enquiry.mould ? [{ mould: String(enquiry.mould), modelNumber: enquiry.requirement?.modelNumber || '' }] : [];
  return rows.map((row) => ({ ...row, quantity: piecesOf(row.modelNumber) }));
}

/**
 * A run's mould must be one of the enquiry's models (where they name their moulds); its pieces
 * planned at most 10% over what was ordered of it.
 */
function assertRunFits(models, { mould, line, planned, fromWorkOrder }) {
  if (!models.length) return;
  const model = line
    ? { quantity: line.quantity || 0, modelNumber: line.modelNumber || mould.mouldCode }
    : models.find((entry) => (entry.mould && entry.mould === String(mould._id)) || sameCode(entry.modelNumber, mould.mouldCode));
  /* Only where the enquiry names its moulds: a model typed as text alone cannot be checked against one. */
  if (!model && !fromWorkOrder && models.some((entry) => entry.mould)) {
    const names = [...new Set(models.map((entry) => entry.modelNumber).filter(Boolean))].join(', ');
    throw ApiError.badRequest(`${mould.mouldCode} is not one of this enquiry’s models${names ? ` — pick ${names}` : ''}`);
  }
  if (!model?.quantity || planned == null || planned === '') return;
  const most = Math.floor(model.quantity * (1 + RUN_OVER_LIMIT));
  if (Number(planned) > most) {
    throw ApiError.badRequest(`${Number(planned).toLocaleString('en-IN')} pcs is more than 10% over the ${model.quantity.toLocaleString('en-IN')} ordered of ${model.modelNumber || mould.mouldCode} — plan ${most.toLocaleString('en-IN')} at most`);
  }
}

/**
 * A run started: one mould on one machine. One run at a time on a machine, and on a mould — the
 * second is refused with the run already going, under a lock so two people starting at once
 * cannot both succeed. The machine shows Running.
 */
export async function startRun(input, user) {
  /* Started from a work order: the mould, the order and the line come from it [workOrder.service]. */
  const named = input.workOrder ? await workOrderForRun({ workOrder: input.workOrder }) : null;
  const { setupSkipReason: _skip, ...given } = input;
  const body = {
    ...given,
    mould: input.mould || named?.mould,
    order: input.order || named?.order,
    /* A work order made for a Production task before its SO has a line key of its own, not an SO line [floorPlanning.service]. */
    orderLine: input.orderLine || (named?.order ? named.orderLine : undefined),
    plannedQuantity: input.plannedQuantity ?? (named ? named.toMakeQty : undefined),
  };
  if (!body.mould) throw ApiError.badRequest('Pick the mould');
  /* Floor planning: a task's work order starts once its first piece is approved, or with a reason [floorPlanning.service]. */
  if (named?.task) await (await import('./floorPlanning.service.js')).assertSetupDone(named, user, { skipReason: input.setupSkipReason });
  return withCreateLocks([`run-machine:${body.machine || 'none'}`, `run-mould:${body.mould}`], async () => {
    const mould = await Mould.findById(body.mould);
    if (!mould) throw ApiError.badRequest('That mould is not on the register');
    const machine = body.machine ? await Machine.findById(body.machine) : null;
    if (body.machine && !machine) throw ApiError.badRequest('That machine is not on the list');
    const busy = await MouldRun.findOne({ status: 'running', $or: [{ mould: mould._id }, ...(machine ? [{ machine: machine._id }] : [])] }).select('number machine').lean();
    if (busy) throw ApiError.conflict(`${busy.number} is still running on this ${String(busy.machine) === String(machine?._id) ? 'machine' : 'mould'} — finish it first`);
    /* The SO line it makes: picked, or the enquiry's SO line on this mould (or its only line). */
    let order = null;
    let orderLine = body.orderLine;
    const ORDER_SELECT = 'number enquiry customer status lines._id lines.mould lines.modelNumber lines.quantity';
    if (body.order) {
      order = await SalesOrder.findById(body.order).select(ORDER_SELECT).lean();
      if (!order) throw ApiError.badRequest('That sales order was not found');
      if (body.enquiry && order.enquiry && String(order.enquiry) !== String(body.enquiry)) throw ApiError.badRequest(`${order.number} is on another enquiry`);
    } else if (body.enquiry) {
      const open = await openOrdersOn(body.enquiry);
      if (open.length > 1) throw askWhichOrder(open);
      const newest = await orderOnEnquiry(body.enquiry);
      order = newest ? await SalesOrder.findById(newest._id).select(ORDER_SELECT).lean() : null;
    }
    let line = null;
    if (order) {
      if (orderLine) {
        line = order.lines.find((entry) => String(entry._id) === String(orderLine));
        if (!line) throw ApiError.badRequest(`That line is not on ${order.number}`);
      } else {
        const onMould = order.lines.filter((entry) => String(entry.mould) === String(mould._id));
        line = onMould.length === 1 ? onMould[0] : order.lines.length === 1 ? order.lines[0] : null;
      }
    } else if (orderLine) throw ApiError.badRequest('Pick the sales order the line is on');
    const enquiryId = body.enquiry || order?.enquiry;
    /* For an enquiry: one of its models, and not more than 10% over the pieces ordered of it [runModelsOf]. */
    if (enquiryId) assertRunFits(await runModelsOf(enquiryId, order), { mould, line, planned: body.plannedQuantity, fromWorkOrder: Boolean(named) });
    const customer = enquiryId ? (await Enquiry.findById(enquiryId).select('customer').lean())?.customer || order?.customer : order?.customer;
    const [run] = await MouldRun.create([{
      ...body,
      enquiry: enquiryId,
      order: order?._id,
      orderLine: line?._id,
      customer,
      number: await nextNumber('RUN'),
      status: 'running',
      startedAt: body.startedAt || new Date(),
      counterStart: body.counterStart ?? mould.totalShots ?? 0,
      cavitiesRunning: body.cavitiesRunning ?? mould.runningCavities,
      cycleTimeSeconds: body.cycleTimeSeconds ?? mould.cycleTimeSeconds,
      modelNumber: body.modelNumber || line?.modelNumber || mould.mouldCode,
      startedBy: user._id,
    }]);
    if (machine) { machine.status = 'running'; await machine.save(); }
    /* The work order it is made against — named, or the one for its order line. */
    const wo = named || (order && line ? await workOrderForRun({ order: order._id, orderLine: line._id }) : null);
    if (wo) {
      run.workOrder = wo._id;
      await run.save();
      await startedOn(wo, run, user);
    }
    /* The enquiry's Production task hears it: Production Started, with the press and the mould [journey.service]. */
    if (enquiryId) {
      const planned = run.plannedQuantity ? ` · ${Number(run.plannedQuantity).toLocaleString('en-IN')} pcs to make` : '';
      await tellProductionTask(enquiryId, {
        note: `${run.number} moulding on ${machine?.code || 'a press'} — mould ${mould.mouldCode}${run.colour ? `, ${run.colour}` : ''}${planned}`,
        to: 'started', user, model: run.modelNumber,
      });
    }
    return run;
  });
}

/** A run finished: its figures in, its shots added to the mould's life count once, the machine free. */
export async function finishRun(run, body, user) {
  if (run.status !== 'running') throw ApiError.conflict(`${run.number} is already ${run.status}`);
  const fields = ['counterEnd', 'goodPieces', 'rejectedPieces', 'regrindKg', 'downtimeMinutes', 'downtimeReason', 'issues', 'cycleTimeSeconds', 'cavitiesRunning', 'operator', 'shift'];
  for (const key of fields) if (body[key] !== undefined) run[key] = body[key];
  /* Coded stops and rejects from the finish form join any logged during the run [logRun]. */
  const now = new Date();
  if (body.downtime?.length) run.downtime = [...(run.downtime || []), ...body.downtime.map((entry) => ({ ...entry, at: now, by: user._id }))];
  if (body.rejects?.length) run.rejects = [...(run.rejects || []), ...body.rejects.map((entry) => ({ ...entry, at: now, by: user._id }))];
  settleCodedTotals(run);
  if (body.resin) run.resin = { ...(run.resin?.toObject?.() || run.resin || {}), ...body.resin };
  if (run.counterEnd != null && run.counterStart != null && run.counterEnd < run.counterStart) {
    throw ApiError.badRequest(`The counter cannot end (${run.counterEnd}) below where it started (${run.counterStart})`);
  }
  run.status = body.aborted ? 'aborted' : 'completed';
  run.endedAt = body.endedAt ? new Date(body.endedAt) : new Date();
  if (run.endedAt < run.startedAt) throw ApiError.badRequest('A run cannot end before it started');
  run.endedBy = user._id;
  const shots = run.shots ?? 0;
  if (shots && run.shotsCounted == null) {
    run.shotsCounted = shots;
    await Mould.updateOne({ _id: run.mould }, { $inc: { totalShots: shots } }, { keepVersion: true });
  }
  if (run.order && run.orderLine && run.goodPieces > 0 && run.producedAdded == null) await addToProduction(run, user);
  if (run.resin?.material && run.resin?.usedKg > 0 && run.resinIssued == null) await issueResin(run, user);
  await finishedOn(run, user);
  /* Far outside what this mould usually does: flagged on the run, and Production told [productionInsights]. */
  const unusualNow = run.status === 'completed' ? unusual(run, await runHistoryOf(run.mould, { exclude: run._id })) : [];
  if (unusualNow.length) run.anomalies = [...(run.anomalies || []), ...unusualNow.map((entry) => ({ ...entry, at: new Date() }))];
  await run.save();
  if (unusualNow.length) await alertUnusual(run, unusualNow, user);
  if (shots) {
    const mould = await Mould.findById(run.mould).select('mouldCode totalShots maintenanceEveryShots lastMaintenanceShots').lean();
    if (mould) await remindMould(mould);
  }
  if (run.machine) await Machine.updateOne({ _id: run.machine, status: 'running' }, { $set: { status: 'idle' } }, { keepVersion: true });
  /*
   * The enquiry's Production task hears what the run made; once every line of its order is made,
   * it reads Production Completed [journey.service].
   */
  if (run.enquiry) {
    const order = run.order ? await SalesOrder.findById(run.order).select('number lines.quantity lines.production.producedQty').lean() : null;
    const made = order?.lines?.length && order.lines.every((line) => (line.production?.producedQty || 0) >= (line.quantity || 0));
    const pieces = `${Number(run.goodPieces || 0).toLocaleString('en-IN')} good, ${Number(run.rejectedPieces || 0).toLocaleString('en-IN')} rejected`;
    await tellProductionTask(run.enquiry, {
      note: `${run.number} ${run.status === 'aborted' ? 'stopped' : 'finished'} — ${pieces}${made ? ` · every line of ${order.number} made` : ''}`,
      to: made ? 'completed' : null, user,
    });
  }
  return run;
}

/**
 * The run's totals from its coded entries: minutes stopped is the sum of the stops; rejected
 * pieces is the figure typed, or the coded sum when none was — and coded rejects cannot exceed
 * the total, because then the total is wrong.
 */
function settleCodedTotals(run) {
  const stops = run.downtime || [];
  if (stops.length) run.downtimeMinutes = stops.reduce((sum, entry) => sum + (entry.minutes || 0), 0);
  const coded = (run.rejects || []).reduce((sum, entry) => sum + (entry.pieces || 0), 0);
  if (!(run.rejects || []).length) return;
  if (run.rejectedPieces == null) run.rejectedPieces = coded;
  else if (coded > run.rejectedPieces) {
    throw ApiError.badRequest(`The rejects by defect add up to ${coded.toLocaleString('en-IN')}, more than the ${run.rejectedPieces.toLocaleString('en-IN')} rejected`);
  }
}

/**
 * A line on a running job, from the floor: the shot counter read, a stop with its reason and
 * minutes, or rejects by defect. Kept on the run; the totals follow [settleCodedTotals].
 */
export async function logRun(run, body, user) {
  if (run.status !== 'running') throw ApiError.conflict(`${run.number} is ${run.status} — only a running job takes a log`);
  const at = new Date();
  if (body.counter != null) {
    const last = (run.counterLog || []).at(-1)?.counter ?? run.counterStart ?? 0;
    if (body.counter < last) throw ApiError.badRequest(`The counter cannot go back — last read ${last.toLocaleString('en-IN')}`);
    run.counterLog = [...(run.counterLog || []), { counter: body.counter, at, by: user._id }];
  }
  if (body.downtime) run.downtime = [...(run.downtime || []), { ...body.downtime, at, by: user._id }];
  if (body.rejects) run.rejects = [...(run.rejects || []), { ...body.rejects, at, by: user._id }];
  /* While running, the rejected total is simply what has been coded so far. */
  if ((run.rejects || []).length) run.rejectedPieces = run.rejects.reduce((sum, entry) => sum + (entry.pieces || 0), 0);
  if ((run.downtime || []).length) run.downtimeMinutes = run.downtime.reduce((sum, entry) => sum + (entry.minutes || 0), 0);
  /* Rejects running far above this mould's usual, once enough pieces are counted to judge. */
  const soFar = body.counter != null || body.rejects ? unusualSoFar(run, await runHistoryOf(run.mould, { exclude: run._id })) : [];
  if (soFar.length) run.anomalies = [...(run.anomalies || []), ...soFar.map((entry) => ({ ...entry, at: new Date() }))];
  await run.save();
  if (soFar.length) await alertUnusual(run, soFar, user);
  return run;
}

/**
 * A finished run's good pieces, added to its SO line's produced count — once, and only on an order
 * in production. Otherwise the run says why, and the plant adds them on the SO by hand.
 */
async function addToProduction(run, user) {
  const order = await SalesOrder.findById(run.order);
  const line = order?.lines.id(run.orderLine);
  if (!order || !line) { run.productionNote = 'The SO line was not found — add the pieces on the SO'; return; }
  if (PRE_RELEASE_STATUSES.includes(order.status) || ['cancelled', 'closed'].includes(order.status)) {
    run.productionNote = `${order.number} is not in production — the pieces were not added to it`;
    return;
  }
  const before = snapshot(order);
  if (!line.production) line.production = {};
  line.production.producedQty = (line.production.producedQty || 0) + run.goodPieces;
  if (!line.production.actualStart) line.production.actualStart = run.startedAt;
  await order.save();
  await recordChange({ model: 'SalesOrder', doc: order, before, by: user });
  run.producedAdded = run.goodPieces;
  run.productionNote = `${run.goodPieces.toLocaleString('en-IN')} added to ${order.number} · ${line.modelNumber || 'line'}`;
}

/** The resin a run used, taken out of the store — once — with the book entry behind it. */
async function issueResin(run, user) {
  const kg = run.resin.usedKg;
  const material = await Material.findOneAndUpdate({ _id: run.resin.material }, { $inc: { stockKg: -kg } }, { new: true, keepVersion: true });
  if (!material) return;
  await StockMovement.create([{ material: material._id, kind: 'issue', kg: -kg, balanceAfter: material.stockKg, run: run._id, reference: run.number, by: user._id }]);
  run.resinIssued = kg;
}

/* ------------------------------------------------------------------ stock --- */

export const lowStockKey = (materialId) => `low-stock:${materialId}`;

/** A receipt from the supplier, or a count corrected — the balance moved and the book entry kept. */
export async function moveStock(materialId, { kind, kg, reference, note }, user) {
  /* One atomic step on the balance, and the entry written in the same transaction. A correction
     downwards is refused by the same step when the store does not hold that much — checked and
     taken together, so two corrections at once cannot both pass a check neither of them saw. */
  const enough = kind === 'adjust' && kg < 0 ? { stockKg: { $gte: -kg } } : {};
  const material = await Material.findOneAndUpdate({ _id: materialId, ...enough }, { $inc: { stockKg: kg } }, { new: true, keepVersion: true });
  if (!material) {
    const held = await Material.findById(materialId).select('stockKg').lean();
    if (!held) throw ApiError.notFound('Material not found');
    throw ApiError.badRequest(`The store holds ${Number(held.stockKg || 0).toLocaleString('en-IN')} kg — a correction cannot take it below zero`);
  }
  const [movement] = await StockMovement.create([{ material: material._id, kind, kg, balanceAfter: material.stockKg, reference, note, by: user._id }]);
  if (material.reorderKg == null || material.stockKg > material.reorderKg) await resolveTasks(lowStockKey(material._id));
  return { material, movement };
}

export async function stockBook(materialId, { limit = 100 } = {}) {
  const material = await Material.findById(materialId).select('name code colour stockKg reorderKg');
  if (!material) throw ApiError.notFound('Material not found');
  const movements = await StockMovement.find({ material: materialId }).sort({ at: -1 }).limit(Math.min(Number(limit) || 100, 500))
    .populate([{ path: 'by', select: 'name' }, { path: 'run', select: 'number' }]).lean();
  return { material, movements };
}

const RUN_POPULATE = [
  { path: 'mould', select: 'mouldCode name totalShots maintenanceEveryShots lastMaintenanceShots' }, { path: 'machine', select: 'code name' },
  { path: 'order', select: 'number lines._id lines.modelNumber' },
  { path: 'enquiry', select: 'number' }, { path: 'customer', select: 'name' }, { path: 'resin.material', select: 'name grade' },
  { path: 'startedBy', select: 'name' }, { path: 'endedBy', select: 'name' },
];
export const populateRun = (query) => query.populate(RUN_POPULATE);

export async function listRuns({ status, mould, machine, enquiry, limit = 100 }) {
  const filter = {};
  if (status) filter.status = status;
  if (mould) filter.mould = mould;
  if (machine) filter.machine = machine;
  if (enquiry) filter.enquiry = enquiry;
  return populateRun(MouldRun.find(filter).sort({ startedAt: -1 }).limit(Math.min(Number(limit) || 100, 500)));
}

/** A mould's history in one answer: its runs, its maintenance, its QC records, and where it stands. */
export async function mouldHistory(mouldId) {
  const mould = await Mould.findById(mouldId).select('mouldCode name totalShots maintenanceEveryShots lastMaintenanceShots lastMaintenanceAt status cavities activeCavities');
  if (!mould) throw ApiError.notFound('Mould not found');
  const [runs, maintenance, qc] = await Promise.all([
    listRuns({ mould: mouldId, limit: 50 }),
    maintenanceHistory({ mould: mouldId, limit: 50 }),
    populateQc(QcRecord.find({ mould: mouldId }).sort({ inspectedAt: -1 }).limit(20)),
  ]);
  return { mould, runs, maintenance, qc };
}

/* ------------------------------------------------------ dispatch register --- */

const indiaDay = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);

/**
 * The dispatch register: every stop on every trip that left, in a span of days — date, trip,
 * buyer, enquiry, goods, cartons, how it went, driver — with the LR number, transporter and invoice
 * Reception keeps on the LR copy task, and whether it was delivered.
 */
export async function dispatchRegister({ from, to }) {
  const trips = await Trip.find({ leftAt: { $gte: new Date(`${from}T00:00:00+05:30`), $lte: new Date(`${to}T23:59:59+05:30`) }, status: { $in: ['left', 'completed'] } })
    .sort({ leftAt: 1 })
    .populate([{ path: 'vehicle', select: 'number' }, { path: 'transporter', select: 'name' }, { path: 'stops.customer', select: 'name city' }, { path: 'stops.enquiry', select: 'number' }])
    .lean();
  const enquiryIds = trips.flatMap((trip) => trip.stops.map((stop) => stop.enquiry?._id)).filter(Boolean);
  const stopTasks = trips.flatMap((trip) => trip.stops.map((stop) => stop.task)).filter(Boolean);
  const [lrTasks, requests] = await Promise.all([
    Todo.find({ enquiry: { $in: enquiryIds }, kind: 'lr_copy' }).sort({ createdAt: -1 }).select('enquiry brief status').lean(),
    Todo.find({ _id: { $in: stopTasks } }).select('order').populate('order', 'number customerPo.number').lean(),
  ]);
  const lrByEnquiry = new Map();
  for (const task of lrTasks) if (!lrByEnquiry.has(String(task.enquiry))) lrByEnquiry.set(String(task.enquiry), task);
  /* The SO on the dispatch request; a request raised before tasks carried one, the enquiry's SO. */
  const orderByTask = new Map(requests.filter((task) => task.order).map((task) => [String(task._id), task.order]));
  const missing = [...new Set(trips.flatMap((trip) => trip.stops.filter((stop) => !orderByTask.has(String(stop.task)) && stop.enquiry).map((stop) => String(stop.enquiry._id))))];
  const fallback = new Map();
  if (missing.length) {
    const orders = await SalesOrder.find({ enquiry: { $in: missing } }).sort({ createdAt: -1 }).select('number enquiry customerPo.number').lean();
    for (const row of orders) if (!fallback.has(String(row.enquiry))) fallback.set(String(row.enquiry), row);
  }
  const MODE = { own_vehicle: 'Own vehicle', transport: 'Transport', party_collects: 'Party collected', courier: 'Courier' };
  return trips.flatMap((trip) => trip.stops.map((stop) => {
    const lr = stop.enquiry ? lrByEnquiry.get(String(stop.enquiry._id)) : null;
    const so = orderByTask.get(String(stop.task)) || (stop.enquiry ? fallback.get(String(stop.enquiry._id)) : null);
    return {
      date: indiaDay(new Date(trip.leftAt)),
      trip: trip.number,
      tripId: trip._id,
      order: so?.number || '',
      orderId: so?._id || null,
      buyerPo: so?.customerPo?.number || '',
      customer: stop.customer?.name || '',
      city: stop.customer?.city || '',
      enquiry: stop.enquiry?.number || '',
      enquiryId: stop.enquiry?._id || null,
      model: stop.model || '',
      quantity: stop.quantity || null,
      cartons: stop.cartons || null,
      mode: MODE[trip.mode] || trip.mode,
      goesBy: trip.mode === 'transport' ? trip.transporter?.name || '' : trip.vehicle?.number || '',
      driver: trip.driverName || '',
      lrNumber: lr?.brief?.lrNumber || '',
      transporter: lr?.brief?.transporter || '',
      invoiceNumber: lr?.brief?.invoiceNumber || '',
      delivery: stop.status === 'delivered' ? 'Delivered' : stop.status === 'not_delivered' ? `Not delivered${stop.note ? ` — ${stop.note}` : ''}` : 'On the way',
    };
  }));
}

export const REGISTER_COLUMNS = [
  ['date', 'Date'], ['trip', 'Trip'], ['customer', 'Buyer'], ['city', 'City'], ['order', 'Sales order'], ['buyerPo', 'Buyer PO'], ['enquiry', 'Enquiry'], ['model', 'Model'],
  ['quantity', 'Quantity'], ['cartons', 'Cartons'], ['mode', 'Went by'], ['goesBy', 'Vehicle / transporter'], ['driver', 'Driver'],
  ['invoiceNumber', 'Invoice'], ['lrNumber', 'LR / docket'], ['transporter', 'Transporter (LR)'], ['delivery', 'Delivery'],
];

/* ------------------------------------------------------ what an SO links to --- */

/**
 * The dispatch requests an SO went out on: the ones that carry it, and — for requests raised before
 * tasks carried their SO — the enquiry's requests with none, when this is the enquiry's SO.
 */
async function requestsOfOrder(order) {
  const newest = order.enquiry ? await orderOnEnquiry(order.enquiry) : null;
  const sameEnquiry = newest && String(newest._id) === String(order._id);
  return Todo.find({
    kind: 'invoice_dispatch',
    $or: [{ order: order._id }, ...(sameEnquiry ? [{ enquiry: order.enquiry, order: { $exists: false } }] : [])],
  }).sort({ createdAt: 1 }).populate(REQUEST_POPULATE).lean();
}

/* A Dispatch request with its SO, and each load's proof and who sent it. */
const REQUEST_POPULATE = [{ path: 'order', select: 'number' }, { path: 'loads.attachment', select: 'key filename mimeType' }, { path: 'loads.by', select: 'name' }];
const LOAD_MODES_SAID = { transporter: 'Transporter', own_vehicle: 'Own vehicle', party_collects: 'Party collects' };

/**
 * The models ordered and how much of each has gone, across every load on the requests [handoff.service
 * `recordDispatchLoad`] — what the enquiry and SO pages chart. `ordered` is the SO's lines (else the enquiry's items).
 */
function modelsSent(requests, ordered) {
  const rows = new Map([...ordered].map(([model, quantity]) => [model.toLowerCase(), { model, ordered: quantity, sent: 0, loads: [] }]));
  for (const request of requests) {
    for (const load of request.loads || []) {
      for (const line of load.lines || []) {
        const key = String(line.model || '').toLowerCase();
        if (!rows.has(key)) rows.set(key, { model: line.model, ordered: 0, sent: 0, loads: [] });
        const row = rows.get(key);
        row.sent += line.quantity || 0;
        row.loads.push({ at: load.at, quantity: line.quantity || 0 });
      }
    }
  }
  return [...rows.values()].map((row) => ({ ...row, left: Math.max(0, (row.ordered || 0) - row.sent) }));
}

const statusLabel = (kind, key) => findHandoff(kind)?.form?.statuses?.find((entry) => entry.key === key)?.label || (key || '').replace(/_/g, ' ');

const TRIP_MODES_SAID = { own_vehicle: 'Own vehicle', transport: 'Transport', party_collects: 'Party collected', courier: 'Courier' };

/** Dispatch requests and LR tasks, with the trips each request went on, in the words a screen shows. */
async function describeDispatch(requests, lrTasks, { ordered = null } = {}) {
  const ids = requests.map((task) => task._id);
  const qc = await latestQcByEnquiry(requests.map((task) => task.enquiry?._id || task.enquiry));
  const trips = ids.length
    ? await Trip.find({ 'stops.task': { $in: ids } }).sort({ date: 1 }).populate([{ path: 'vehicle', select: 'number kind' }, { path: 'transporter', select: 'name phone' }]).lean()
    : [];
  return {
    ...(ordered ? { models: modelsSent(requests, ordered) } : {}),
    requests: requests.map((task) => ({
      _id: task._id,
      order: task.order?.number ? { _id: task.order._id, number: task.order.number } : null,
      status: task.status,
      statusLabel: statusLabel('invoice_dispatch', task.status),
      completed: Boolean(task.completed),
      raisedAt: task.createdAt,
      quantity: task.brief?.quantity || '',
      qc: qc.get(String(task.enquiry?._id || task.enquiry)) || null,
      remark: (task.statusHistory || []).filter((entry) => entry.note).at(-1)?.note || task.notes || '',
      /* Each load sent from the dispatch form: when, the models and pieces, how, the proof, who. */
      loads: (task.loads || []).map((load) => ({
        _id: load._id,
        at: load.at,
        status: load.status,
        statusLabel: statusLabel('invoice_dispatch', load.status),
        lines: (load.lines || []).map((line) => ({ model: line.model, quantity: line.quantity || 0 })),
        mode: LOAD_MODES_SAID[load.mode] || load.mode || '',
        modeKey: load.mode || null,
        proof: load.attachment?.key ? load.attachment : null,
        /* What Dispatch said of how it went; the paper may follow the goods [handoff.service `addLoadProof`]. */
        lrNumber: load.lrNumber || '', transporter: load.transporter || '', vehicleNumber: load.vehicleNumber || '',
        proofPending: !load.attachment,
        /* A transporter's shipment has an LR to send; Reception marks it sent from its LR Copy task [handoff.service `markShipmentSent`]. */
        needsLr: load.mode === 'transporter',
        lrSentAt: load.lrSent?.at || null,
        by: load.by?.name || '',
        note: load.note || '',
      })),
      trips: trips.flatMap((trip) => trip.stops.filter((stop) => String(stop.task) === String(task._id)).map((stop) => ({
        trip: trip.number,
        tripId: trip._id,
        date: trip.date,
        status: trip.status,
        leftAt: trip.leftAt || null,
        mode: TRIP_MODES_SAID[trip.mode] || trip.mode,
        goesBy: trip.mode === 'transport' ? trip.transporter?.name || '' : trip.vehicle?.number || '',
        driver: [trip.driverName, trip.driverPhone].filter(Boolean).join(' · '),
        quantity: stop.quantity ?? null,
        cartons: stop.cartons ?? null,
        delivery: stop.status,
        note: stop.note || '',
        at: stop.at || null,
      }))),
    })),
    lr: lrTasks.map((task) => ({
      _id: task._id,
      order: task.order?.number ? { _id: task.order._id, number: task.order.number } : null,
      status: task.status,
      statusLabel: statusLabel('lr_copy', task.status),
      completed: Boolean(task.completed),
      invoiceNumber: task.brief?.invoiceNumber || '',
      lrNumber: task.brief?.lrNumber || '',
      transporter: task.brief?.transporter || '',
      lrCopy: task.resultFile || null,
    })),
  };
}

const LR_SELECT = 'status brief completed resultFile createdAt order';

/**
 * Everything about how an SO's goods went, in one answer: each dispatch request with where it
 * stands, the trips it went on with the vehicle, driver and whether it was delivered, and the LR
 * details Reception keeps — invoice, LR number, transporter and the LR copy.
 */
export async function dispatchDetailsForOrder(order) {
  const requests = await requestsOfOrder(order);
  const lrTasks = await Todo.find({
    kind: 'lr_copy',
    $or: [{ order: order._id }, ...(requests.some((task) => !task.order) ? [{ enquiry: order.enquiry, order: { $exists: false } }] : [])],
  }).sort({ createdAt: 1 }).select(LR_SELECT).populate('resultFile', 'key filename').lean();
  const ordered = new Map();
  for (const line of order.lines || []) if (line.modelNumber) ordered.set(line.modelNumber, (ordered.get(line.modelNumber) || 0) + (line.quantity || 0));
  return { order: { _id: order._id, number: order.number }, ...(await describeDispatch(requests, lrTasks, { ordered })) };
}

/**
 * What an enquiry led to, on its own page: its sales orders, its QC records (for those with the
 * quality grant) and how its goods went — every dispatch request, trip and LR, each with its SO.
 */
export async function enquiryRecords(enquiry, { withQc }) {
  const [orders, requests, lrTasks, qc] = await Promise.all([
    SalesOrder.find({ enquiry: enquiry._id }).sort({ createdAt: -1 }).select('number status customerPo.number paymentTerms lines.modelNumber lines.quantity createdAt').lean(),
    Todo.find({ enquiry: enquiry._id, kind: 'invoice_dispatch' }).sort({ createdAt: 1 }).populate(REQUEST_POPULATE).lean(),
    Todo.find({ enquiry: enquiry._id, kind: 'lr_copy' }).sort({ createdAt: 1 }).select(LR_SELECT).populate([{ path: 'resultFile', select: 'key filename' }, { path: 'order', select: 'number' }]).lean(),
    withQc ? populateQc(QcRecord.find({ enquiry: enquiry._id }).sort({ inspectedAt: -1 }).limit(100)) : null,
  ]);
  return {
    orders: orders.map((row) => ({
      _id: row._id, number: row.number, status: row.status, buyerPo: row.customerPo?.number || '', paymentTerms: row.paymentTerms || '',
      models: (row.lines || []).map((line) => line.modelNumber).filter(Boolean).join(', '),
      quantity: (row.lines || []).reduce((sum, line) => sum + (line.quantity || 0), 0),
    })),
    qc,
    dispatch: await describeDispatch(requests, lrTasks, { ordered: (await orderedModelsOf({ enquiryId: enquiry._id })).ordered }),
    /*
     * Where each model is, once Production has the job: each team on its route with its status
     * (Goods Received, In Work Queue, Ready for Dispatch…), Quality where compulsory, and the
     * pieces dispatched [handoff.service `modelJourneys`] — the enquiry's one-glance view.
     */
    journeys: await modelJourneys(enquiry._id),
  };
}

/** An SO's QC records, newest first, with the latest verdict per line of the order. */
export async function qcForOrder(order) {
  const rows = await populateQc(QcRecord.find({ order: order._id }).sort({ inspectedAt: -1 }).limit(100));
  const latest = new Map();
  for (const row of rows) if (row.orderLine && !latest.has(String(row.orderLine))) latest.set(String(row.orderLine), row);
  return {
    rows,
    lines: (order.lines || []).map((line) => {
      const last = latest.get(String(line._id));
      return { line: line._id, modelNumber: line.modelNumber, verdict: last?.verdict || null, record: last ? { _id: last._id, number: last.number } : null };
    }),
  };
}

/* ------------------------------------------------------- QC sheet prefill --- */

const MATERIAL_WORDS = { pp: 'PP', hips: 'HIPS', abs: 'ABS', pc: 'Polycarbonate', ps: 'PS', k_resin: 'K-resin' };
const printTypeOf = (text) => {
  const said = String(text || '').toLowerCase();
  if (!said) return undefined;
  if (/pad/.test(said)) return 'pad';
  if (/screen/.test(said)) return 'screen';
  if (/foil|stamp/.test(said)) return 'hot_stamp';
  if (/size/.test(said)) return 'size_marker';
  if (/^(no|none|nil|-)$/.test(said)) return 'none';
  return undefined;
};

/**
 * What a QC sheet can start with, from where it is opened: the task gives the enquiry, the enquiry
 * gives its SO, the SO's line (or the enquiry's item, before there is an SO) gives the model, size,
 * mould, resin and colour, hook, clips and print, the mould gives the cavities and the part weight,
 * and the line's quantity the lot. Only what is known is sent; the form fills its empty boxes with it.
 *
 * A line is used when it is picked, or when the SO (or the enquiry) has only one — with several and
 * none picked, the choices come back and the per-model figures wait for the pick.
 */
export async function qcPrefill({ task: taskId, enquiry: enquiryId, order: orderId, orderLine, item: itemId }) {
  let enquiryRef = enquiryId;
  let orderRef = orderId;
  if (taskId) {
    const task = await Todo.findById(taskId).select('enquiry order').lean();
    if (!task) throw ApiError.notFound('Task not found');
    enquiryRef = enquiryRef || task.enquiry;
    orderRef = orderRef || task.order;
  }
  const parts = (prefix) => [
    { path: `${prefix}.mould`, select: 'mouldCode name sizeMm hookType cavities activeCavities partWeightGrams material packingQty qcStandards' },
    { path: `${prefix}.materialRef`, select: 'name colour supplier type' },
    { path: `${prefix}.hookRef`, select: 'name colour' },
    { path: `${prefix}.clipRef`, select: 'name colour' },
    { path: `${prefix}.printRef`, select: 'name colour' },
  ];
  let order = orderRef ? await SalesOrder.findById(orderRef).populate(parts('lines')).populate('customer', 'name qcStandards').lean() : null;
  if (orderRef && !order) throw ApiError.notFound('Order not found');
  enquiryRef = enquiryRef || order?.enquiry;
  const enquiry = enquiryRef ? await Enquiry.findById(enquiryRef).select('number customer items mould').populate(parts('items')).populate('customer', 'name qcStandards').lean() : null;
  if (enquiryRef && !enquiry) throw ApiError.notFound('Enquiry not found');
  /* With several open SOs and none picked, the form is asked to pick — nothing is assumed. */
  const openOrders = enquiry ? await openOrdersOn(enquiry._id) : [];
  if (!order && enquiry && openOrders.length <= 1) {
    const newest = await orderOnEnquiry(enquiry._id);
    order = newest ? await SalesOrder.findById(newest._id).populate(parts('lines')).populate('customer', 'name qcStandards').lean() : null;
  }

  const rows = order ? order.lines || [] : enquiry?.items || [];
  const lineKind = order ? 'order' : 'enquiry';
  const wanted = order ? orderLine : itemId;
  const row = wanted ? rows.find((entry) => String(entry._id) === String(wanted)) : rows.length === 1 ? rows[0] : null;
  if (wanted && !row) throw ApiError.badRequest(order ? `That line is not on ${order.number}` : 'That item is not on the enquiry');

  const fields = {};
  if (row) {
    const mould = row.mould?.mouldCode ? row.mould : null;
    const hasHook = Boolean(row.hookRef) || ['swivel', 'metal_swivel'].includes(mould?.hookType);
    const hasClips = Boolean(row.clipRef) || mould?.hookType === 'clip';
    const sizeMm = row.sizeMm || mould?.sizeMm;
    const cavities = mould ? (mould.activeCavities ?? mould.cavities) : null;
    Object.assign(fields, {
      modelNumber: row.modelNumber || mould?.mouldCode,
      size: sizeMm ? `${sizeMm} mm` : undefined,
      mould: mould?._id,
      mouldingType: mould ? (hasHook || hasClips ? 'injection_assembly' : 'injection') : undefined,
      cavities: cavities ? (mould.cavities && cavities < mould.cavities ? `${cavities} of ${mould.cavities}` : `All ${cavities}`) : undefined,
      resin: {
        material: row.materialRef?._id,
        name: row.materialRef?.name || MATERIAL_WORDS[row.material || mould?.material],
        colour: row.colour || row.materialRef?.colour,
        supplier: row.materialRef?.supplier,
      },
      hook: { type: row.hookRef?.name || (mould?.hookType ? mould.hookType.replace(/_/g, ' ') : undefined), finish: row.hookRef?.colour },
      clip: { type: row.clipRef?.name },
      print: { type: printTypeOf(row.printRef?.name || row.printing), colour: row.printRef?.colour, artwork: row.printRef?.name || row.printing },
      weight: mould?.partWeightGrams ? { target: mould.partWeightGrams } : undefined,
      measurements: sizeMm ? [{ name: 'Width', unit: 'mm', target: sizeMm }] : undefined,
      lotSize: row.quantity || undefined,
    });
  }
  /* The minimums: the model's standards, with the buyer's own laid over them. */
  const buyer = order?.customer || enquiry?.customer;
  const mouldOfRow = row?.mould?.mouldCode ? row.mould : null;
  const defined = (object) => Object.fromEntries(Object.entries(object || {}).filter(([, value]) => value != null && value !== ''));
  const standard = { ...defined(mouldOfRow?.qcStandards), ...defined(buyer?.qcStandards) };
  if (standard.piecesPerCarton == null && mouldOfRow?.packingQty) standard.piecesPerCarton = mouldOfRow.packingQty;
  const sources = [Object.keys(defined(mouldOfRow?.qcStandards)).length && `model ${mouldOfRow.mouldCode}`, Object.keys(defined(buyer?.qcStandards)).length && `buyer ${buyer.name}`].filter(Boolean);
  if (Object.keys(standard).length) {
    const merge = (key, value) => { fields[key] = { ...(fields[key] || {}), ...JSON.parse(JSON.stringify(value)) }; };
    merge('breaking', { requiredKg: standard.breakingMinKg });
    merge('hook', { pullRequiredKg: standard.hookPullMinKg });
    merge('clip', { gripRequiredKg: standard.clipGripMinKg });
    merge('hangLoad', { loadKg: standard.hangLoadKg, hours: standard.hangHours, allowedDeflectionMm: standard.allowedDeflectionMm });
    if (fields.weight || standard.weightToleranceG != null) merge('weight', { tolerance: standard.weightToleranceG });
    merge('drop', { heightCm: standard.dropHeightCm, drops: standard.drops });
    merge('resinChecks', { moistureMaxPercent: standard.moistureMaxPercent, mfiMin: standard.mfiMin, mfiMax: standard.mfiMax });
    merge('shrinkage', { maxPercent: standard.shrinkageMaxPercent });
    merge('hookTurns', { required: standard.hookTurns });
    merge('uv', { hours: standard.uvHours });
    merge('cartonDrop', { heightCm: standard.cartonDropCm });
    merge('packing', { piecesPerCarton: standard.piecesPerCarton });
    if (fields.measurements && standard.widthToleranceMm != null) fields.measurements = fields.measurements.map((entry) => (entry.name === 'Width' ? { ...entry, tolerance: standard.widthToleranceMm } : entry));
    if (standard.aql != null) fields.aql = standard.aql;
    if (sources.length) fields.standardsFrom = `Standards: ${sources.join(' · ')}`;
  }
  const label = (entry) => [entry.modelNumber || entry.mould?.mouldCode, entry.colour, entry.quantity && `${entry.quantity} pcs`].filter(Boolean).join(' · ') || 'Item';
  return {
    enquiry: enquiry ? { _id: enquiry._id, number: enquiry.number } : null,
    customer: order?.customer?.name || enquiry?.customer?.name || null,
    order: order ? { _id: order._id, number: order.number, buyerPo: order.customerPo?.number || '' } : null,
    /* Several open SOs and none picked: the ones to choose from. */
    orderChoices: !order && openOrders.length > 1 ? openOrders.map((row) => ({ _id: row._id, number: row.number, buyerPo: row.customerPo?.number || '' })) : [],
    lineKind,
    line: row ? row._id : null,
    lines: rows.map((entry) => ({ _id: entry._id, label: label(entry) })),
    fields: Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(fields))).filter(([, value]) => !(value && typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length))),
  };
}

/* ------------------------------------------------------------ reject report --- */

const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);

/**
 * Where the rejects come from, over a span of days: the QC sheets (verdicts, failed tests, defects,
 * pieces rejected out of those sampled, by mould) and the runs (pieces rejected at the press out of
 * those made, and the minutes stopped, by machine and by mould). Highest reject rate first.
 */
export async function qcReport({ from, to }) {
  const span = { $gte: new Date(`${from}T00:00:00+05:30`), $lte: new Date(`${to}T23:59:59+05:30`) };
  const [records, runs] = await Promise.all([
    QcRecord.find({ inspectedAt: span }).populate({ path: 'mould', select: 'mouldCode name' }).lean(),
    MouldRun.find({ endedAt: span, status: { $in: ['completed', 'aborted'] } })
      .populate([{ path: 'mould', select: 'mouldCode name' }, { path: 'machine', select: 'code name' }]).lean(),
  ]);

  const verdicts = Object.fromEntries(['passed', 'passed_with_deviation', 'rejected', 'on_hold'].map((key) => [key, 0]));
  const failedTests = new Map();
  const defects = new Map();
  const mouldRows = new Map();
  const machineRows = new Map();
  const mouldRow = (mould) => {
    const key = String(mould?._id || 'none');
    if (!mouldRows.has(key)) mouldRows.set(key, { mould: mould ? { _id: mould._id, code: mould.mouldCode, name: mould.name } : null, sheets: 0, failedSheets: 0, sampled: 0, rejectedSampled: 0, made: 0, rejectedMade: 0 });
    return mouldRows.get(key);
  };

  for (const record of records) {
    verdicts[record.verdict] = (verdicts[record.verdict] || 0) + 1;
    const failed = new QcRecord(record).failedTests;
    for (const name of failed) failedTests.set(name, (failedTests.get(name) || 0) + 1);
    for (const row of record.defects || []) defects.set(row.type, (defects.get(row.type) || 0) + row.count);
    if (!record.mould) continue;
    const row = mouldRow(record.mould);
    row.sheets += 1;
    if (record.verdict === 'rejected' || failed.length) row.failedSheets += 1;
    row.sampled += record.sampleSize || 0;
    row.rejectedSampled += record.rejected || 0;
  }
  for (const run of runs) {
    const good = run.goodPieces || 0;
    const bad = run.rejectedPieces || 0;
    const row = mouldRow(run.mould);
    row.made += good + bad;
    row.rejectedMade += bad;
    if (!run.machine) continue;
    const key = String(run.machine._id);
    if (!machineRows.has(key)) machineRows.set(key, { machine: { _id: run.machine._id, code: run.machine.code, name: run.machine.name }, runs: 0, made: 0, rejected: 0, downtimeMinutes: 0 });
    const machine = machineRows.get(key);
    machine.runs += 1;
    machine.made += good + bad;
    machine.rejected += bad;
    machine.downtimeMinutes += run.downtimeMinutes || 0;
  }

  const byRate = (a, b) => (b.rejectPercent ?? -1) - (a.rejectPercent ?? -1);
  return {
    from, to,
    sheets: records.length,
    verdicts,
    failedTests: [...failedTests].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    defects: [...defects].map(([type, count]) => ({ type, label: DEFECT_TYPES.find((entry) => entry.key === type)?.label || type, count })).sort((a, b) => b.count - a.count),
    moulds: [...mouldRows.values()].filter((row) => row.mould).map((row) => ({
      ...row, sampleRejectPercent: pct(row.rejectedSampled, row.sampled), rejectPercent: pct(row.rejectedMade, row.made),
    })).sort(byRate),
    machines: [...machineRows.values()].map((row) => ({ ...row, rejectPercent: pct(row.rejected, row.made) })).sort(byRate),
    pressRejects: { made: runs.reduce((sum, run) => sum + (run.goodPieces || 0) + (run.rejectedPieces || 0), 0), rejected: runs.reduce((sum, run) => sum + (run.rejectedPieces || 0), 0) },
  };
}

/* ------------------------------------------------------------ reminders --- */

export const machineReminderKey = (machineId) => `machine-service:${machineId}`;
export const mouldReminderKey = (mouldId) => `mould-maintenance:${mouldId}`;

/** A mould past its shot count since the last maintenance: one task on the tool room's queue. */
export async function remindMould(mould) {
  const every = mould.maintenanceEveryShots;
  const since = Math.max(0, (mould.totalShots || 0) - (mould.lastMaintenanceShots || 0));
  if (!every || since < every) return null;
  return raiseDepartmentTask({
    department: 'mould',
    title: `Maintenance due — mould ${mould.mouldCode}`,
    notes: `${since.toLocaleString('en-IN')} shots since the last maintenance, against every ${every.toLocaleString('en-IN')}. Record it on the mould when done.`,
    link: `/moulds/${mould._id}`,
    originKey: mouldReminderKey(mould._id),
  });
}

/**
 * Machines whose service falls due within two days, and moulds past their shot count: each gets one
 * task on its department's queue (production for machines, the tool room for moulds), raised once
 * and closed when the maintenance is recorded.
 */
export async function runMaintenanceReminders({ now = new Date() } = {}) {
  const soon = new Date(new Date(now).getTime() + 2 * 86400000);
  const raised = [];
  const machines = await Machine.find({ active: { $ne: false }, status: { $ne: 'retired' }, nextServiceDue: { $lte: soon } }).lean();
  for (const machine of machines) {
    const overdue = new Date(machine.nextServiceDue) < new Date(now);
    const task = await raiseDepartmentTask({
      department: 'production',
      title: `Service ${overdue ? 'overdue' : 'due'} — machine ${machine.code}`,
      notes: `Preventive maintenance was due on ${new Date(machine.nextServiceDue).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}. Record it on the machine when done.`,
      link: `/machines/${machine._id}`,
      dueDate: machine.nextServiceDue,
      originKey: machineReminderKey(machine._id),
    });
    if (task) raised.push(`machine ${machine.code}`);
  }
  const moulds = await Mould.find({ maintenanceEveryShots: { $gt: 0 }, isActive: { $ne: false } }).select('mouldCode totalShots maintenanceEveryShots lastMaintenanceShots').lean();
  for (const mould of moulds) if (await remindMould(mould)) raised.push(`mould ${mould.mouldCode}`);
  /* And the resin running short: production is asked to reorder, once, until a receipt lifts it. */
  const short = await Material.find({ isActive: { $ne: false }, reorderKg: { $gt: 0 }, $expr: { $lte: ['$stockKg', '$reorderKg'] } }).select('name stockKg reorderKg').lean();
  for (const material of short) {
    const task = await raiseDepartmentTask({
      department: 'production',
      title: `Reorder ${material.name}`,
      notes: `${Math.round(material.stockKg)} kg in the store, against a reorder level of ${material.reorderKg} kg.`,
      link: '/materials',
      originKey: lowStockKey(material._id),
    });
    if (task) raised.push(`stock ${material.name}`);
  }
  return raised;
}

/* ---------------------------------------------------------- setup checklist --- */

/**
 * What the plant still has to fill in before the newer screens do anything: machines on the list,
 * moulds with a maintenance interval and test standards, resin with stock and a reorder level,
 * buyers with delivery details and a location pin, the dispatch lists, and WhatsApp's templates.
 * Each a count against the whole, so Admin sees how far along it is and where to go.
 */
export async function setupChecklist() {
  const [{ default: Customer }, { default: Vehicle }, { default: Transporter }, whatsapp] = await Promise.all([
    import('../models/Customer.js'), import('../models/Vehicle.js'), import('../models/Transporter.js'), import('../providers/whatsapp.js'),
  ]);
  const active = { isActive: { $ne: false } };
  const [machines, moulds, mouldsTimed, mouldsTested, materials, materialsStocked, materialsReorder, customers, customersDelivery, customersPinned, vehicles, transporters] = await Promise.all([
    Machine.countDocuments({ active: { $ne: false } }),
    Mould.countDocuments(active),
    Mould.countDocuments({ ...active, maintenanceEveryShots: { $gt: 0 } }),
    Mould.countDocuments({ ...active, qcStandards: { $exists: true, $ne: null } }),
    Material.countDocuments(active),
    Material.countDocuments({ ...active, stockKg: { $gt: 0 } }),
    Material.countDocuments({ ...active, reorderKg: { $gt: 0 } }),
    Customer.countDocuments({ status: { $ne: 'inactive' } }),
    Customer.countDocuments({ status: { $ne: 'inactive' }, $or: [{ deliveryMode: { $exists: true, $ne: null } }, { deliveryRoute: { $exists: true, $ne: null } }, { usualTransporter: { $exists: true, $ne: null } }] }),
    Customer.countDocuments({ status: { $ne: 'inactive' }, 'site.lat': { $exists: true } }),
    Vehicle.countDocuments({ active: { $ne: false } }),
    Transporter.countDocuments({ active: { $ne: false } }),
  ]);
  const templates = ['trip', 'lr_copy', 'location', 'task'].filter((key) => !whatsapp.whatsappTemplate(key));
  const share = (have, of) => ({ have, of, done: of === 0 ? true : have >= of });
  return [
    { key: 'machines', label: 'Moulding machines on the list', ...{ have: machines, of: null, done: machines > 0 }, link: '/machines', hint: 'Add each press once — runs and maintenance are kept against it' },
    { key: 'mould_interval', label: 'Moulds with a maintenance interval (shots)', ...share(mouldsTimed, moulds), link: '/moulds', hint: 'Edit the mould → Maintenance every (shots)' },
    { key: 'mould_standards', label: 'Moulds with test standards', ...share(mouldsTested, moulds), link: '/moulds', hint: 'Edit the mould → Test standards — the QC sheet fills its minimums from them' },
    { key: 'resin_stock', label: 'Materials with stock in the store', ...share(materialsStocked, materials), link: '/materials', hint: 'Material register → In store → Received' },
    { key: 'resin_reorder', label: 'Materials with a reorder level', ...share(materialsReorder, materials), link: '/materials', hint: 'Edit the material → Reorder at (kg)' },
    { key: 'delivery', label: 'Buyers with delivery details', ...share(customersDelivery, customers), link: '/customers', hint: 'How the goods go, the route or the usual transporter — the planner groups by these' },
    { key: 'pins', label: 'Buyers with a location pin', ...share(customersPinned, customers), link: '/dispatch/plan', hint: 'Ask them on WhatsApp from Plan trips — the planner groups pinned buyers by real distance' },
    { key: 'dispatch_lists', label: 'Vehicles and transporters', have: vehicles + transporters, of: null, done: vehicles > 0 && transporters > 0, link: '/dispatch/lists', hint: `${vehicles} vehicles · ${transporters} transporters` },
    { key: 'whatsapp', label: 'WhatsApp connected', have: whatsapp.isWhatsAppConfigured() ? 1 : 0, of: null, done: whatsapp.isWhatsAppConfigured(), link: '/integrations', hint: 'Messages to buyers go out from the company number' },
    { key: 'templates', label: 'WhatsApp templates approved', have: 4 - templates.length, of: 4, done: !templates.length, link: '/integrations', hint: templates.length ? `Missing: ${templates.map((key) => `WHATSAPP_TEMPLATE_${key.toUpperCase()}`).join(', ')} — without them, messages only reach buyers who wrote in the last 24 hours` : 'All set' },
  ];
}
