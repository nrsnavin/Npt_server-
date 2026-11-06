import Todo from '../models/Todo.js';
import Enquiry from '../models/Enquiry.js';
import PpSample from '../models/PpSample.js';
import DeliveryChallan from '../models/DeliveryChallan.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { transactional } from '../utils/transaction.js';
import { mayReadEnquiry, mayReadTaskQueries } from '../services/taskQuery.service.js';
import {
  CHALLAN_POPULATE, answerPp, challanPrefill, challansOn, markChallanInvoiced, mayAnswerPp, mayInvoiceChallan, mayReadChallans,
  ppOfTask, prepareChallan, renderChallanPdf,
} from '../services/ppSample.service.js';

/**
 * The PP sample and its delivery challans [services/ppSample.service.js]: the card on the enquiry
 * and on the task, the buyer's answer, the DC form on Send PP Sample, the DC on paper, and the DC
 * marked as added to an invoice.
 */

const PP_POPULATE = [
  { path: 'owner', select: 'name' },
  { path: 'approvedBy', select: 'name' },
  { path: 'rounds.verdictBy', select: 'name' },
  { path: 'rounds.challan', select: 'number status lines invoice createdAt' },
];

async function taskFor(req) {
  const task = await Todo.findById(req.params.id);
  if (!task) throw ApiError.notFound('Task not found');
  if (!(await mayReadTaskQueries(task, req.user))) throw ApiError.notFound('Task not found');
  return task;
}

const card = async (pp, user) => (pp ? {
  pp: await pp.populate(PP_POPULATE),
  challans: await DeliveryChallan.find({ ppSample: pp._id }).sort({ createdAt: -1 }).populate(CHALLAN_POPULATE),
  mayAnswer: pp.status === 'with_buyer' && mayAnswerPp(pp, user),
} : { pp: null, challans: [], mayAnswer: false });

/** The PP sample a task belongs to — the PO & SO request or one of the PP tasks. */
export const taskPpSample = asyncHandler(async (req, res) => {
  const task = await taskFor(req);
  res.json({ success: true, data: await card(await ppOfTask(task), req.user) });
});

export const enquiryPpSample = asyncHandler(async (req, res) => {
  const enquiry = await Enquiry.findById(req.params.id).select('number assignedTo customer createdBy');
  if (!enquiry || !(await mayReadEnquiry(enquiry, req.user))) throw ApiError.notFound('Enquiry not found');
  res.json({ success: true, data: await card(await PpSample.findOne({ enquiry: enquiry._id }).sort({ createdAt: -1 }), req.user) });
});

/** The buyer's answer: approved, or the changes they want (another round). */
export const answerPpSample = asyncHandler(transactional(async (req, res) => {
  const pp = await PpSample.findById(req.params.id);
  if (!pp) throw ApiError.notFound('PP sample not found');
  res.json({ success: true, data: await card(await answerPp(pp, req.user, req.body), req.user) });
}));

/** The DC form on Send PP Sample: the round's lines, or the DC already prepared. */
export const challanForm = asyncHandler(async (req, res) => {
  const task = await taskFor(req);
  const { challan, lines, transport, remarks } = await challanPrefill(task);
  res.json({ success: true, data: { challan, lines, transport, remarks } });
});

export const saveChallan = asyncHandler(transactional(async (req, res) => {
  const task = await Todo.findById(req.params.id);
  if (!task) throw ApiError.notFound('Task not found');
  const challan = await prepareChallan(task, req.user, req.body);
  res.status(201).json({ success: true, data: await challan.populate(CHALLAN_POPULATE) });
}));

/**
 * The DCs on a task's order — for Invoice & Dispatch, the ones still to be added to the invoice.
 * By the task's enquiry, its order, or (a job with no enquiry) the job's own tasks.
 */
export const taskChallans = asyncHandler(async (req, res) => {
  /* The teams that send and bill the goods read a job's DCs from any of its tasks, as does whoever may read the task. */
  const task = await Todo.findById(req.params.id);
  if (!task || !(mayReadChallans(req.user) || (await mayReadTaskQueries(task, req.user)))) throw ApiError.notFound('Task not found');
  const tasks = task.enquiry ? [] : (await Todo.find({ $or: [{ _id: task.chain || task._id }, { chain: task.chain || task._id }] }).select('_id').lean()).map((row) => row._id);
  const rows = await challansOn({ enquiry: task.enquiry, order: task.order, tasks, status: req.query.status === 'all' ? null : req.query.status || null });
  res.json({ success: true, data: rows, mayInvoice: mayInvoiceChallan(req.user) });
});

async function challanFor(req) {
  const challan = await DeliveryChallan.findById(req.params.id);
  if (!challan) throw ApiError.notFound('DC not found');
  const pp = challan.ppSample ? await PpSample.findById(challan.ppSample).select('owner').lean() : null;
  if (!mayReadChallans(req.user, { owner: pp?.owner })) throw ApiError.notFound('DC not found');
  return challan;
}

export const challanPdf = asyncHandler(async (req, res) => {
  const challan = await challanFor(req);
  const pdf = await renderChallanPdf(challan);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${challan.number}.pdf"`);
  res.send(pdf);
});

export const invoiceChallan = asyncHandler(async (req, res) => {
  const challan = await markChallanInvoiced(await challanFor(req), req.user, req.body);
  res.json({ success: true, data: await challan.populate(CHALLAN_POPULATE) });
});
