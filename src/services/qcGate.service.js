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
 * Passed model by model: a Quality task passes the models on its rows (every model when it names
 * none), so an order going out each model as it is ready sends a model once Quality has passed
 * it, and not before. Passed means the Quality task finished on a pass since the Production
 * request was raised — QC Passed, Passed with Deviation — or a QC record on the enquiry read
 * Passed (with or without deviation) since then, which passes the whole order.
 */

export const QC_PASS_VERDICTS = ['passed', 'passed_with_deviation'];
const idOf = (value) => String(value?._id || value || '');
export const ticked = (value) => value === true || value === 'true' || value === 'Yes' || value === 'on' || value === 1;
const failedWords = /fail|reject|not ok|not passed/i;
const keyOf = (model) => String(model || '').trim().toLowerCase();

/** The models a Quality task is about: its rows, else the models named flat; empty means the whole order. */
export function qcModelsOf(task) {
  const rows = Array.isArray(task?.brief?.items) ? task.brief.items : [];
  const named = rows.length ? rows.map((row) => row?.model) : String(task?.brief?.models || '').split(',');
  return [...new Set(named.map((model) => String(model || '').trim()).filter(Boolean))];
}

/**
 * Whether a finished Quality task passed: the result its pass status recorded ("Passed", "Passed
 * with deviation") — a document's fields are a Map, a lean one's a plain object — else, for a task
 * closed before the check had pass statuses, the words it closed with.
 */
export function qcPassed(task) {
  if (!task?.completed) return false;
  const fields = task.outcome?.fields;
  const recorded = typeof fields?.get === 'function' ? fields.get('result') : fields?.result;
  if (recorded) return !failedWords.test(String(recorded));
  if (task.outcome?.result === 'closed_by_admin') return false;
  return !failedWords.test(String(task.outcome?.note || task.statusHistory?.at(-1)?.note || ''));
}

/** The job's models, as Production routed them or its request named them. */
function jobModels(production) {
  const routed = (production?.routing?.models || []).map((row) => row?.model).filter(Boolean);
  if (routed.length) return [...new Set(routed)];
  const named = String(production?.brief?.models || production?.brief?.model || '').split(',').map((model) => model.trim()).filter(Boolean);
  return [...new Set(named)];
}

/**
 * Whether QC is compulsory on the job this task is on, and how far Quality has passed it:
 * `checked` the models passed, `pending` those still to pass, `cleared` when none is left.
 * `task` is any task on the job — the Dispatch request, a finishing task — or `{ enquiry }`.
 */
export async function qcGateFor(task) {
  const enquiryId = idOf(task?.enquiry) || null;
  const filter = enquiryId ? { enquiry: enquiryId } : task?._id || task?.chain ? jobFilter(task) : null;
  if (!filter) return { required: false, cleared: true, why: null, checked: [], pending: [] };
  const [enquiry, production] = await Promise.all([
    enquiryId ? Enquiry.findById(enquiryId).select('qcRequired').lean() : null,
    /* The run's Production request — not Dispatch's "is it ready?" ask, which raises the same kind [askFromTask]. */
    Todo.findOne({ ...filter, kind: 'ask_edd', fromDepartment: { $ne: 'despatch' } }).sort({ createdAt: -1 }).select('brief routing createdAt').lean(),
  ]);
  const required = Boolean(enquiry?.qcRequired) || ticked(production?.brief?.qcRequired);
  if (!required) return { required: false, cleared: true, why: null, checked: [], pending: [] };
  const since = production?.createdAt ? { $gte: production.createdAt } : null;
  const checks = await Todo.find({ ...filter, kind: 'quality_check', ...(since ? { createdAt: since } : {}) })
    .sort({ createdAt: 1 }).select('brief completed outcome statusHistory status').lean();
  const passed = checks.filter(qcPassed);
  const record = enquiryId
    ? await QcRecord.exists({ enquiry: enquiryId, verdict: { $in: QC_PASS_VERDICTS }, ...(since ? { inspectedAt: since } : {}) })
    : null;
  const models = jobModels(production);
  /* A pass that names no model, or a QC record, passes the whole order. */
  const wholeOrder = Boolean(record) || passed.some((check) => !qcModelsOf(check).length);
  const passedKeys = new Set(passed.flatMap(qcModelsOf).map(keyOf));
  const checked = wholeOrder ? models : models.filter((model) => passedKeys.has(keyOf(model)));
  const pending = wholeOrder ? [] : models.filter((model) => !passedKeys.has(keyOf(model)));
  const cleared = wholeOrder || (models.length ? !pending.length : passed.length > 0);
  const failing = checks.some((check) => !check.completed && check.status === 'failed')
    || checks.some((check) => check.completed && !qcPassed(check));
  const why = cleared ? 'Quality passed it'
    : failing ? 'Quality failed it — the goods go back for rework and Quality checks them again'
      : checked.length ? `Quality has passed ${checked.join(', ')}; ${pending.join(', ')} still to pass`
        : 'Waiting for Quality’s pass';
  return { required: true, cleared, why, checked: wholeOrder ? ['all'] : checked, pending, wholeOrder };
}

/** Whether Quality has passed every one of `models` [qcGateFor]. */
export const qcPassedModels = (gate, models = []) => !gate.required || gate.cleared || gate.wholeOrder
  || models.every((model) => gate.checked.some((done) => keyOf(done) === keyOf(model)));

/**
 * Refuses a move that sends the goods out while QC is compulsory and not passed — for the models
 * named (a part load), or for the whole order.
 */
export async function assertQcCleared(task, what = 'send the goods out', { models } = {}) {
  const gate = await qcGateFor(task);
  if (!gate.required) return gate;
  const named = (models || []).map((model) => String(model || '').trim()).filter(Boolean);
  if (named.length) {
    const missing = named.filter((model) => !qcPassedModels(gate, [model]));
    if (missing.length) {
      throw ApiError.badRequest(`QC is compulsory on this order — Quality has not passed ${missing.join(', ')} yet. Quality records its pass, then Dispatch can ${what}.`);
    }
    return gate;
  }
  if (!gate.cleared) {
    throw ApiError.badRequest(`QC is compulsory on this order — ${gate.why}. Quality records its check, then Dispatch can ${what}.`);
  }
  return gate;
}
