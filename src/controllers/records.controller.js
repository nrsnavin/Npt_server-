import mongoose from 'mongoose';
import QcRecord from '../models/QcRecord.js';
import Machine from '../models/Machine.js';
import MouldRun from '../models/MouldRun.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { expectVersion, withoutVersion } from '../utils/concurrency.js';
import { transactional } from '../utils/transaction.js';
import { recordChange, snapshot } from '../services/audit.service.js';
import { sendCsv } from '../utils/csv.js';
import {
  REGISTER_COLUMNS, approveQcRecord, createQcRecord, dispatchRegister, finishRun, listQcRecords, listRuns, maintenanceHistory,
  mouldHistory, populateQc, populateRun, recordMaintenance, renderQcCertificate, startRun,
} from '../services/records.service.js';

/** QC records, machines and their maintenance, mould runs, and the dispatch register [services/records.service.js]. */

const byId = async (Model, id, label) => {
  if (!mongoose.isValidObjectId(id)) throw ApiError.notFound(`${label} not found`);
  const doc = await Model.findById(id);
  if (!doc) throw ApiError.notFound(`${label} not found`);
  return doc;
};

export const listQc = asyncHandler(async (req, res) => {
  const { rows, pagination } = await listQcRecords(req.query);
  res.json({ success: true, data: rows, pagination });
});
export const getQc = asyncHandler(async (req, res) => {
  await byId(QcRecord, req.params.id, 'QC record');
  res.json({ success: true, data: await populateQc(QcRecord.findById(req.params.id)) });
});
export const createQc = asyncHandler(transactional(async (req, res) => {
  const made = await createQcRecord(req.body, req.user);
  res.status(201).json({ success: true, data: await populateQc(QcRecord.findById(made._id)) });
}));
export const approveQc = asyncHandler(transactional(async (req, res) => {
  const record = await approveQcRecord(await byId(QcRecord, req.params.id, 'QC record'), req.user);
  res.json({ success: true, data: await populateQc(QcRecord.findById(record._id)) });
}));
export const qcCertificate = asyncHandler(async (req, res) => {
  const record = await byId(QcRecord, req.params.id, 'QC record');
  const pdf = await renderQcCertificate(record);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${record.number}-qc-report.pdf"` });
  res.send(pdf);
});

export const listMachines = asyncHandler(async (req, res) => {
  const filter = req.query.active === 'true' ? { active: { $ne: false } } : {};
  res.json({ success: true, data: await Machine.find(filter).sort({ active: -1, code: 1 }).collation({ locale: 'en', numericOrdering: true }) });
});
export const createMachine = asyncHandler(transactional(async (req, res) => {
  const [made] = await Machine.create([withoutVersion(req.body)]);
  res.status(201).json({ success: true, data: made });
}));
export const updateMachine = asyncHandler(transactional(async (req, res) => {
  const machine = await byId(Machine, req.params.id, 'Machine');
  expectVersion(machine, req.body);
  const before = snapshot(machine);
  machine.set(withoutVersion(req.body));
  await machine.save();
  await recordChange({ model: 'Machine', doc: machine, before, by: req.user });
  res.json({ success: true, data: machine });
}));
export const machineDetail = asyncHandler(async (req, res) => {
  const machine = await byId(Machine, req.params.id, 'Machine');
  const [maintenance, runs] = await Promise.all([maintenanceHistory({ machine: machine._id, limit: 100 }), listRuns({ machine: machine._id, limit: 50 })]);
  res.json({ success: true, data: { machine, maintenance, runs } });
});

export const listMaintenance = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await maintenanceHistory(req.query) });
});
export const createMaintenance = asyncHandler(transactional(async (req, res) => {
  res.status(201).json({ success: true, data: await recordMaintenance(req.body, req.user) });
}));

export const listRunsHandler = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await listRuns(req.query) });
});
export const startRunHandler = asyncHandler(transactional(async (req, res) => {
  const run = await startRun(req.body, req.user);
  res.status(201).json({ success: true, data: await populateRun(MouldRun.findById(run._id)) });
}));
export const finishRunHandler = asyncHandler(transactional(async (req, res) => {
  const run = await finishRun(await byId(MouldRun, req.params.id, 'Run'), req.body, req.user);
  res.json({ success: true, data: await populateRun(MouldRun.findById(run._id)) });
}));
export const mouldHistoryHandler = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Mould not found');
  res.json({ success: true, data: await mouldHistory(req.params.id) });
});

const indiaToday = (offset = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + offset * 86400000));
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const dispatchRegisterHandler = asyncHandler(async (req, res) => {
  const from = DAY.test(req.query.from || '') ? req.query.from : indiaToday(-29);
  const to = DAY.test(req.query.to || '') ? req.query.to : indiaToday();
  if ((new Date(to) - new Date(from)) / 86400000 > 366) throw ApiError.badRequest('Pick at most a year at a time');
  const rows = await dispatchRegister({ from, to });
  if (req.query.format === 'csv') return sendCsv(res, 'dispatch-register', rows, REGISTER_COLUMNS.map(([key, label]) => [label, (row) => row[key]]));
  return res.json({ success: true, data: rows, meta: { from, to } });
});
