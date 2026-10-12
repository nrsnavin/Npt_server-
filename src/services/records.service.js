import QcRecord from '../models/QcRecord.js';
import Machine from '../models/Machine.js';
import MaintenanceRecord from '../models/MaintenanceRecord.js';
import MouldRun from '../models/MouldRun.js';
import Mould from '../models/Mould.js';
import Enquiry from '../models/Enquiry.js';
import Todo from '../models/Todo.js';
import Trip from '../models/Trip.js';
import SalesOrder from '../models/SalesOrder.js';
import { findHandoff } from '../config/handoffs.js';
import ApiError from '../utils/ApiError.js';
import { nextNumber } from './numbering.service.js';
import { withCreateLocks } from './operationLock.service.js';
import { render, letterhead, facts, footer } from './recordPdf.js';
import { DEFECT_TYPES } from '../models/Inspection.js';
import { MOULDING_TYPES, PRINT_TYPES, QC_STAGES } from '../models/QcRecord.js';
import { MAINTENANCE_TYPES } from '../models/MaintenanceRecord.js';

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
  if (out.sampleSize != null && out.rejected != null && out.accepted == null) out.accepted = Math.max(0, out.sampleSize - out.rejected);
  return out;
}

const failedOf = (record) => new QcRecord(record).failedTests;

/** The SO an enquiry's work belongs to: its newest sales order, as the department forms read it. */
export const orderOnEnquiry = (enquiryId) => (enquiryId
  ? SalesOrder.findOne({ enquiry: enquiryId }).sort({ createdAt: -1 }).select('number enquiry customer lines._id lines.modelNumber lines.mould lines.colour').lean()
  : null);

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
  if (record.verdict === 'passed' && (failed.length || record.rejected > 0)) {
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
  if (made.task) {
    await Todo.updateOne(
      { _id: made.task },
      { $push: { updates: { note: `QC record ${made.number}: ${made.verdict.replace(/_/g, ' ')}${made.failedTests.length ? ` — failed ${made.failedTests.join(', ')}` : ''}`, by: user._id, at: new Date() } } },
      { keepVersion: true }
    );
  }
  return made;
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
  { path: 'order', select: 'number customerPo.number status' },
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

/**
 * A run started: one mould on one machine. One run at a time on a machine, and on a mould — the
 * second is refused with the run already going, under a lock so two people starting at once
 * cannot both succeed. The machine shows Running.
 */
export async function startRun(body, user) {
  return withCreateLocks([`run-machine:${body.machine || 'none'}`, `run-mould:${body.mould}`], async () => {
    const mould = await Mould.findById(body.mould);
    if (!mould) throw ApiError.badRequest('That mould is not on the register');
    const machine = body.machine ? await Machine.findById(body.machine) : null;
    if (body.machine && !machine) throw ApiError.badRequest('That machine is not on the list');
    const busy = await MouldRun.findOne({ status: 'running', $or: [{ mould: mould._id }, ...(machine ? [{ machine: machine._id }] : [])] }).select('number machine').lean();
    if (busy) throw ApiError.conflict(`${busy.number} is still running on this ${String(busy.machine) === String(machine?._id) ? 'machine' : 'mould'} — finish it first`);
    let customer;
    if (body.enquiry) customer = (await Enquiry.findById(body.enquiry).select('customer').lean())?.customer;
    const [run] = await MouldRun.create([{
      ...body,
      customer,
      number: await nextNumber('RUN'),
      status: 'running',
      startedAt: body.startedAt || new Date(),
      counterStart: body.counterStart ?? mould.totalShots ?? 0,
      cavitiesRunning: body.cavitiesRunning ?? mould.runningCavities,
      cycleTimeSeconds: body.cycleTimeSeconds ?? mould.cycleTimeSeconds,
      modelNumber: body.modelNumber || mould.mouldCode,
      startedBy: user._id,
    }]);
    if (machine) { machine.status = 'running'; await machine.save(); }
    return run;
  });
}

/** A run finished: its figures in, its shots added to the mould's life count once, the machine free. */
export async function finishRun(run, body, user) {
  if (run.status !== 'running') throw ApiError.conflict(`${run.number} is already ${run.status}`);
  const fields = ['counterEnd', 'goodPieces', 'rejectedPieces', 'regrindKg', 'downtimeMinutes', 'downtimeReason', 'issues', 'cycleTimeSeconds', 'cavitiesRunning', 'operator', 'shift'];
  for (const key of fields) if (body[key] !== undefined) run[key] = body[key];
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
  await run.save();
  if (run.machine) await Machine.updateOne({ _id: run.machine, status: 'running' }, { $set: { status: 'idle' } }, { keepVersion: true });
  return run;
}

const RUN_POPULATE = [
  { path: 'mould', select: 'mouldCode name totalShots maintenanceEveryShots lastMaintenanceShots' }, { path: 'machine', select: 'code name' },
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
  }).sort({ createdAt: 1 }).lean();
}

const statusLabel = (kind, key) => findHandoff(kind)?.form?.statuses?.find((entry) => entry.key === key)?.label || (key || '').replace(/_/g, ' ');

/**
 * Everything about how an SO's goods went, in one answer: each dispatch request with where it
 * stands, the trips it went on with the vehicle, driver and whether it was delivered, and the LR
 * details Reception keeps — invoice, LR number, transporter and the LR copy.
 */
export async function dispatchDetailsForOrder(order) {
  const requests = await requestsOfOrder(order);
  const ids = requests.map((task) => task._id);
  const [trips, lrTasks] = await Promise.all([
    ids.length
      ? Trip.find({ 'stops.task': { $in: ids } }).sort({ date: 1 }).populate([{ path: 'vehicle', select: 'number kind' }, { path: 'transporter', select: 'name phone' }]).lean()
      : [],
    Todo.find({
      kind: 'lr_copy',
      $or: [{ order: order._id }, ...(requests.some((task) => !task.order) ? [{ enquiry: order.enquiry, order: { $exists: false } }] : [])],
    }).sort({ createdAt: 1 }).select('status brief completed resultFile createdAt').lean(),
  ]);
  const MODE = { own_vehicle: 'Own vehicle', transport: 'Transport', party_collects: 'Party collected', courier: 'Courier' };
  return {
    order: { _id: order._id, number: order.number },
    requests: requests.map((task) => {
      const legs = trips.flatMap((trip) => trip.stops.filter((stop) => String(stop.task) === String(task._id)).map((stop) => ({
        trip: trip.number,
        tripId: trip._id,
        date: trip.date,
        status: trip.status,
        leftAt: trip.leftAt || null,
        mode: MODE[trip.mode] || trip.mode,
        goesBy: trip.mode === 'transport' ? trip.transporter?.name || '' : trip.vehicle?.number || '',
        driver: [trip.driverName, trip.driverPhone].filter(Boolean).join(' · '),
        quantity: stop.quantity ?? null,
        cartons: stop.cartons ?? null,
        delivery: stop.status,
        note: stop.note || '',
        at: stop.at || null,
      })));
      return {
        _id: task._id,
        status: task.status,
        statusLabel: statusLabel('invoice_dispatch', task.status),
        completed: Boolean(task.completed),
        raisedAt: task.createdAt,
        quantity: task.brief?.quantity || '',
        remark: (task.statusHistory || []).filter((entry) => entry.note).at(-1)?.note || task.notes || '',
        trips: legs,
      };
    }),
    lr: lrTasks.map((task) => ({
      _id: task._id,
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
