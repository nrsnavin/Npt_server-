import Todo from '../models/Todo.js';
import Enquiry from '../models/Enquiry.js';
import QcRecord from '../models/QcRecord.js';
import ApiError from '../utils/ApiError.js';
import { jobFilter } from './journey.service.js';

/**
 * QC compulsory before dispatch [config/departmentTaskForms.js ask_edd / po_so `qcRequired`;
 * Enquiry `qcRequired`]. Marketing or Admin tick it when the job goes to Production. Ticked, the
 * goods go from the finishing teams to Quality, and only Quality's pass lets them go to Dispatch
 * [journey.service; handoff.service `tellDispatchReady`, `setTaskStatus`; dispatch.controller
 * `createDispatch`]. Unticked, they go straight from the finishing teams to Dispatch.
 *
 * Cleared means Quality has passed this run of the job: its Quality task finished without a
 * failure since the Production request was raised, or a QC record on the enquiry read Passed
 * (with or without deviation) since then.
 */

export const QC_PASS_VERDICTS = ['passed', 'passed_with_deviation'];
const idOf = (value) => String(value?._id || value || '');
export const ticked = (value) => value === true || value === 'true' || value === 'Yes' || value === 'on' || value === 1;
const failedWords = /fail|reject|not ok|not passed/i;

/**
 * Whether QC is compulsory on the job this task is on, and whether Quality has passed it.
 * `task` is any task on the job — the Dispatch request, a finishing task — or `{ enquiry }`.
 */
export async function qcGateFor(task) {
  const enquiryId = idOf(task?.enquiry) || null;
  const filter = enquiryId ? { enquiry: enquiryId } : task?._id || task?.chain ? jobFilter(task) : null;
  if (!filter) return { required: false, cleared: true, why: null };
  const [enquiry, production] = await Promise.all([
    enquiryId ? Enquiry.findById(enquiryId).select('qcRequired').lean() : null,
    /* The run's Production request — not Dispatch's "is it ready?" ask, which raises the same kind [askFromTask]. */
    Todo.findOne({ ...filter, kind: 'ask_edd', fromDepartment: { $ne: 'despatch' } }).sort({ createdAt: -1 }).select('brief createdAt').lean(),
  ]);
  const required = Boolean(enquiry?.qcRequired) || ticked(production?.brief?.qcRequired);
  if (!required) return { required: false, cleared: true, why: null };
  const since = production?.createdAt ? { $gte: production.createdAt } : null;
  const quality = await Todo.findOne({ ...filter, kind: 'quality_check', completed: true, ...(since ? { createdAt: since } : {}) })
    .sort({ completedAt: -1 }).select('outcome statusHistory status').lean();
  const result = quality ? String(quality.outcome?.fields?.result || quality.outcome?.note || quality.statusHistory?.at(-1)?.note || '') : '';
  const passedTask = Boolean(quality) && !failedWords.test(result);
  const record = enquiryId
    ? await QcRecord.exists({ enquiry: enquiryId, verdict: { $in: QC_PASS_VERDICTS }, ...(since ? { inspectedAt: since } : {}) })
    : null;
  const cleared = passedTask || Boolean(record);
  return {
    required: true, cleared,
    why: cleared ? 'Quality passed it' : quality ? 'Quality reported a problem — it must pass before dispatch' : 'Waiting for Quality’s pass',
  };
}

/** Refuses a move that sends the goods out while QC is compulsory and not passed. */
export async function assertQcCleared(task, what = 'send the goods out') {
  const gate = await qcGateFor(task);
  if (gate.required && !gate.cleared) {
    throw ApiError.badRequest(`QC is compulsory on this order — ${gate.why}. Quality records its check, then Dispatch can ${what}.`);
  }
  return gate;
}
