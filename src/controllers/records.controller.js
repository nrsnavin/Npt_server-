import { DOWNTIME_REASONS, REJECT_REASONS } from '../config/productionReasons.js';
import mongoose from 'mongoose';
import QcRecord from '../models/QcRecord.js';
import SalesOrder from '../models/SalesOrder.js';
import { ownsCustomer, ownsRecord } from '../services/ownership.service.js';
import { isManagement } from '../utils/departments.js';
import Customer from '../models/Customer.js';
import { askForLocation } from '../services/customerLocation.service.js';
import { canRead } from '../services/access.service.js';
import { mayHandOff } from '../services/handoff.service.js';
import Enquiry from '../models/Enquiry.js';
import Todo from '../models/Todo.js';
import Machine from '../models/Machine.js';
import MouldRun from '../models/MouldRun.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { expectVersion, withoutVersion } from '../utils/concurrency.js';
import { transactional } from '../utils/transaction.js';
import { withOrderLock } from '../services/operationLock.service.js';
import { recordChange, snapshot } from '../services/audit.service.js';
import { sendCsv } from '../utils/csv.js';
import { accessLevel } from '../services/access.service.js';
import { levelSatisfies } from '../config/modules.js';
import {
  REGISTER_COLUMNS, qcReport, moveStock, setupChecklist, stockBook, approveQcRecord, createQcRecord, dispatchDetailsForOrder, dispatchRegister, enquiryRecords, finishRun, qcForOrder, qcPrefill, listQcRecords, listRuns, maintenanceHistory,
  mouldHistory, populateQc, populateRun, recordMaintenance, renderQcCertificate, startRun, logRun,
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
  const data = (await populateQc(QcRecord.findById(made._id))).toJSON();
  /* The sheet answers a Quality task: the screen offers to close that task now [taskClosable.service]. */
  if (made.task) {
    const { closableOf } = await import('../services/taskClosable.service.js');
    const task = await Todo.findById(made.task).select('kind status completed enquiry createdAt title department');
    const closable = task ? await closableOf(task) : null;
    if (closable) data.closeTask = { _id: task._id, title: task.title, department: task.department, why: closable.why };
  }
  res.status(201).json({ success: true, data });
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
  const machines = await Machine.find(filter).sort({ active: -1, code: 1 }).collation({ locale: 'en', numericOrdering: true });
  /* What each press is running now, and for which enquiry and buyer — the same run the enquiry and the production queue show. */
  const running = await MouldRun.find({ status: 'running', machine: { $in: machines.map((machine) => machine._id) } })
    .select('number machine mould modelNumber startedAt plannedQuantity enquiry customer')
    .populate([{ path: 'mould', select: 'mouldCode' }, { path: 'enquiry', select: 'number' }, { path: 'customer', select: 'name' }])
    .lean();
  res.json({
    success: true,
    data: machines.map((machine) => {
      const run = running.find((entry) => String(entry.machine) === String(machine._id));
      return {
        ...machine.toJSON(),
        running: run ? {
          _id: run._id, number: run.number, mould: run.mould?.mouldCode || run.modelNumber || null, startedAt: run.startedAt, plannedQuantity: run.plannedQuantity || null,
          enquiry: run.enquiry ? { _id: run.enquiry._id, number: run.enquiry.number } : null, customer: run.customer?.name || null,
        } : null,
      };
    }),
  });
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
/* Under the SO's lock when the run makes an SO line: its pieces join the line's count with nobody else writing it. */
const runOrder = async (req) => (mongoose.isValidObjectId(req.params.id) ? (await MouldRun.findById(req.params.id).select('order').lean())?.order : null) || `run:${req.params.id}`;
export const finishRunHandler = asyncHandler(withOrderLock(runOrder, transactional(async (req, res) => {
  const run = await finishRun(await byId(MouldRun, req.params.id, 'Run'), req.body, req.user);
  res.json({ success: true, data: await populateRun(MouldRun.findById(run._id)) });
})));
/** A line on a running job: counter read, a coded stop, or rejects by defect. */
export const logRunHandler = asyncHandler(transactional(async (req, res) => {
  const run = await logRun(await byId(MouldRun, req.params.id, 'Run'), req.body, req.user);
  res.json({ success: true, data: await populateRun(MouldRun.findById(run._id)) });
}));

/** The fixed lists a stop and a reject are coded from [config/productionReasons.js]. */
export const runReasonsHandler = (_req, res) => res.json({ success: true, data: { downtime: DOWNTIME_REASONS, rejects: REJECT_REASONS } });

export const mouldHistoryHandler = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Mould not found');
  const history = await mouldHistory(req.params.id);
  /* The tool room reads the register without the quality grant; the QC sheets stay Quality's. */
  if (!levelSatisfies(accessLevel(req.user, 'quality'), 'read')) history.qc = [];
  res.json({ success: true, data: history });
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

/** The SO, as its own screen would load it: someone else's order is not found, not forbidden. */
const visibleOrder = async (req) => {
  const order = mongoose.isValidObjectId(req.params.id) ? await SalesOrder.findById(req.params.id).select('number enquiry customer assignedTo lines._id lines.modelNumber lines.quantity') : null;
  if (!order || !ownsRecord(req.user, order)) throw ApiError.notFound('Order not found');
  return order;
};
export const orderQcHandler = asyncHandler(async (req, res) => {
  const { rows, lines } = await qcForOrder(await visibleOrder(req));
  res.json({ success: true, data: rows, lines });
});
export const orderDispatchHandler = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await dispatchDetailsForOrder(await visibleOrder(req)) });
});

/** What a new QC sheet starts with, from the task, enquiry, SO and line it is opened from. */
export const qcPrefillHandler = asyncHandler(async (req, res) => {
  const ids = Object.fromEntries(['task', 'enquiry', 'order', 'orderLine', 'item'].map((key) => [key, req.query[key]]).filter(([, value]) => value));
  if (Object.values(ids).some((value) => !mongoose.isValidObjectId(value))) throw ApiError.badRequest('Not a valid id');
  res.json({ success: true, data: await qcPrefill(ids) });
});

/**
 * What an enquiry led to — its SOs, QC sheets and dispatch — for whoever may open the enquiry: the
 * same rule as the enquiry's own page. The QC sheets only with the quality grant.
 */
export const enquiryRecordsHandler = asyncHandler(async (req, res) => {
  const enquiry = mongoose.isValidObjectId(req.params.id) ? await Enquiry.findById(req.params.id).select('number customer assignedTo') : null;
  if (!enquiry) throw ApiError.notFound('Enquiry not found');
  const mayRead = canRead(req.user, 'enquiries') ? ownsRecord(req.user, enquiry) : await mayHandOff(req.user, enquiry);
  if (!mayRead) throw ApiError.notFound('Enquiry not found');
  res.json({ success: true, data: await enquiryRecords(enquiry, { withQc: levelSatisfies(accessLevel(req.user, 'quality'), 'read') }) });
});

/** Where the rejects come from — the last 30 days unless a span is picked, at most a year. */
export const qcReportHandler = asyncHandler(async (req, res) => {
  const from = DAY.test(req.query.from || '') ? req.query.from : indiaToday(-29);
  const to = DAY.test(req.query.to || '') ? req.query.to : indiaToday();
  if ((new Date(to) - new Date(from)) / 86400000 > 366) throw ApiError.badRequest('Pick at most a year at a time');
  res.json({ success: true, data: await qcReport({ from, to }) });
});

export const stockBookHandler = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Material not found');
  res.json({ success: true, data: await stockBook(req.params.id, req.query) });
});
export const moveStockHandler = asyncHandler(transactional(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Material not found');
  const { material, movement } = await moveStock(req.params.id, req.body, req.user);
  res.status(201).json({ success: true, data: { material, movement } });
}));

/** Ask the buyer on WhatsApp for their delivery location — the next one they share is pinned. */
export const askLocationHandler = asyncHandler(async (req, res) => {
  const customer = mongoose.isValidObjectId(req.params.id) ? await Customer.findById(req.params.id).select('name mobile whatsapp notifications assignedTo sharedWith') : null;
  if (!customer || !ownsCustomer(req.user, customer)) throw ApiError.notFound('Customer not found');
  const message = await askForLocation(customer, req.user);
  res.status(201).json({ success: true, data: { message: message._id, recipient: message.recipient, at: message.createdAt } });
});

/** What the plant still has to fill in before the newer screens do anything — Admin's checklist. */
export const setupChecklistHandler = asyncHandler(async (req, res) => {
  if (!isManagement(req.user)) throw ApiError.forbidden('Only Admin sees the setup checklist');
  res.json({ success: true, data: await setupChecklist() });
});

/**
 * The models a run for this enquiry (and SO) may make, for the Start a run form's model list: the
 * mould of each, the pieces ordered and the most a run may plan [records.service `runModelsOf`].
 */
export const runModelsHandler = asyncHandler(async (req, res) => {
  const { runModelsOf, RUN_OVER_LIMIT } = await import('../services/records.service.js');
  const { default: SalesOrder } = await import('../models/SalesOrder.js');
  const { default: Mould } = await import('../models/Mould.js');
  const enquiry = mongoose.isValidObjectId(req.query.enquiry) ? req.query.enquiry : null;
  if (!enquiry) return res.json({ success: true, data: [] });
  const order = mongoose.isValidObjectId(req.query.order) ? await SalesOrder.findById(req.query.order).select('lines._id lines.mould lines.modelNumber lines.quantity').lean() : null;
  const models = await runModelsOf(enquiry, order);
  const moulds = await Mould.find({ _id: { $in: models.map((model) => model.mould).filter(Boolean) } }).select('mouldCode name').lean();
  const lines = order?.lines || [];
  res.json({
    success: true,
    data: models.map((model, at) => {
      const found = moulds.find((entry) => String(entry._id) === model.mould);
      return {
        mould: found ? { _id: found._id, mouldCode: found.mouldCode, name: found.name } : null,
        modelNumber: model.modelNumber, quantity: model.quantity,
        most: model.quantity ? Math.floor(model.quantity * (1 + RUN_OVER_LIMIT)) : null,
        orderLine: lines[at]?._id || null,
      };
    }),
  });
});
