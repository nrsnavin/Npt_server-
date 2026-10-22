import Todo from '../models/Todo.js';
import QcRecord from '../models/QcRecord.js';
import { findHandoff } from '../config/handoffs.js';

/**
 * When a department's task has nothing left to do, the screen offers to close it — a dialog,
 * never a move made by itself [web: components/CloseTaskPrompt.jsx]. The rule is read here, per
 * kind of task, and travels on the task as `closable: { why, models }` (null while something is
 * still to do):
 *
 *   Production, Printing, Assembly   every model is through this team — handed to the team after
 *                                    it, Ready for Dispatch, or finished where nothing follows it
 *                                    (Production Completed on a model with no printing and no
 *                                    assembly; Full Quantity Ready on Printing where no assembly
 *                                    follows, or on Assembly)
 *   Quality                          a QC record has been entered on the task (or on its enquiry
 *                                    since the task was raised), or the task reads Resolved
 *   Dispatch                         marked Dispatched or Fully Dispatched — Reception has the LR
 *                                    copy task from that move
 *   Reception — LR copy              the LR copy went to the buyer (sent, in transit, delivered)
 *   Quotation                        the quote went to the buyer (Quote Sent)
 *
 * Closing is the task's own Task Closed status [handoff.service `setTaskStatus`]; the SO task
 * closes by its upload and is never offered here.
 */

const FINISHING_KINDS = ['ask_edd', 'ask_printing', 'ask_assembling_edd'];
const QUALITY_KINDS = ['quality_check', 'quality_issue'];
const PRICING_KINDS = ['create_quotation', 'price_negotiation'];
export const CLOSABLE_KINDS = [...FINISHING_KINDS, ...QUALITY_KINDS, ...PRICING_KINDS, 'invoice_dispatch', 'lr_copy'];

const DISPATCHED = ['dispatched', 'fully_dispatched'];
const LR_SENT = ['sent', 'in_transit', 'delivered'];
const TEAM_WORDS = { printing: 'Printing', assembling: 'Assembly' };
const VERDICT_WORDS = { passed: 'passed', passed_with_deviation: 'passed with deviation', rejected: 'rejected', on_hold: 'on hold' };

const idOf = (value) => String(value?._id || value || '');
const statusesOf = (kind) => findHandoff(kind)?.form?.statuses || [];
const stepOf = (kind, key) => statusesOf(kind).find((entry) => entry.key === key) || null;
/** The job a task belongs to: its enquiry, or the chain of team tasks it was raised on [journey.service `jobFilter`]. */
const jobKeyOf = (task) => (task.enquiry ? `e:${idOf(task.enquiry)}` : `c:${idOf(task.chain || task._id)}`);

/** The models a Production, Printing or Assembly task is for [handoff.service `modelsOfTask`]. */
function modelsOf(task) {
  const routed = (task.routing?.models || []).map((row) => (typeof row === 'string' ? row : row?.model)).filter(Boolean);
  if (routed.length) return [...new Set(routed.map((model) => String(model).trim()))];
  const listed = String(task.brief?.models || '').split(',').map((model) => model.trim()).filter(Boolean);
  if (listed.length) return [...new Set(listed)];
  return task.brief?.model ? [String(task.brief.model).trim()] : [];
}

/** Where each model stands: its own status once it moved on its own, else the task's [Todo `modelStatuses`]. */
function modelStatuses(task) {
  const models = modelsOf(task);
  const kept = new Map((task.modelStatuses || []).map((row) => [row.model, row.status]));
  if (!models.length) return [{ model: null, status: task.status }];
  return models.map((model) => ({ model, status: kept.get(model) || task.status }));
}

/**
 * Whether one model is through this team at a status, and how to say so. `route` is Production's
 * decision for the model — printing, assembly — or null when it was not routed.
 */
function throughAt(task, status, route, routed) {
  const step = stepOf(task.kind, status);
  if (!step) return null;
  if (step.done) return step.label;
  if (step.readyForDispatch) return step.label;
  if (step.handsTo) {
    /* Handed where the model goes; a model routed elsewhere is not through on that move. */
    const goes = !route ? true
      : step.handsTo === 'printing' ? task.kind === 'ask_edd' && Boolean(route.printing)
        : Boolean(route.assembly) && (task.kind === 'ask_printing' || !route.printing);
    return goes ? `handed to ${TEAM_WORDS[step.handsTo] || step.handsTo}` : null;
  }
  /* Finished here, and nothing follows this team for the model. */
  const nothingAfter = task.kind === 'ask_edd'
    ? (route ? !route.printing && !route.assembly : routed && !(task.routing?.handsTo || []).length)
    : task.kind === 'ask_printing' ? (route ? !route.assembly : routed)
      : true;
  if (task.kind === 'ask_edd' && status === 'completed' && nothingAfter) return 'Production Completed — nothing follows';
  if (task.kind !== 'ask_edd' && status === 'full_ready' && nothingAfter) return `Full Quantity Ready${task.kind === 'ask_printing' ? ' — no assembly after' : ''}`;
  return null;
}

function finishingClosable(task, context) {
  const rows = task.kind === 'ask_edd' ? task.routing?.models : context.routes.get(jobKeyOf(task));
  const routes = new Map((rows || []).filter((row) => row?.model).map((row) => [row.model, row]));
  /* Production's routing is known: for Production once decided; for the teams after it, once its task is found. */
  const routed = task.kind === 'ask_edd' ? Boolean(task.routing?.decidedAt) : context.routes.has(jobKeyOf(task));
  const said = modelStatuses(task).map((row) => ({ model: row.model, said: throughAt(task, row.status, routes.get(row.model) || null, routed) }));
  if (!said.length || said.some((row) => !row.said)) return null;
  const models = said.filter((row) => row.model);
  const why = models.length > 1
    ? `Every model is through: ${models.map((row) => `${row.model} ${row.said}`).join('; ')}`
    : `${models[0]?.model ? `${models[0].model}: ` : ''}${said[0].said}`;
  return { why, models };
}

function qualityClosable(task, context) {
  const mine = context.qc.filter((record) => (record.task ? idOf(record.task) === idOf(task._id)
    : task.enquiry && idOf(record.enquiry) === idOf(task.enquiry) && new Date(record.inspectedAt || record.createdAt) >= new Date(task.createdAt)));
  if (mine.length) {
    const latest = mine.sort((a, b) => new Date(b.inspectedAt || b.createdAt) - new Date(a.inspectedAt || a.createdAt))[0];
    return { why: `QC record ${latest.number} entered — ${VERDICT_WORDS[latest.verdict] || latest.verdict}`, models: [], record: { _id: latest._id, number: latest.number, verdict: latest.verdict } };
  }
  if (task.status === 'resolved') return { why: 'Resolved', models: [] };
  return null;
}

/** The rule for one task, with what it needs already fetched [`contextFor`]. */
function closableWith(task, context) {
  if (!task || task.completed || !task.kind) return null;
  if (FINISHING_KINDS.includes(task.kind)) return finishingClosable(task, context);
  if (QUALITY_KINDS.includes(task.kind)) return qualityClosable(task, context);
  if (task.kind === 'invoice_dispatch') {
    return DISPATCHED.includes(task.status) ? { why: `${stepOf(task.kind, task.status)?.label || 'Dispatched'} — Reception has the LR copy task`, models: [] } : null;
  }
  if (task.kind === 'lr_copy') {
    return LR_SENT.includes(task.status) ? { why: `${stepOf(task.kind, task.status)?.label || 'LR copy sent'}`, models: [] } : null;
  }
  if (PRICING_KINDS.includes(task.kind)) return task.status === 'sent' ? { why: 'Quote sent to the buyer', models: [] } : null;
  return null;
}

/** What the rules read, fetched once for a list: Production's routing per job, the QC records per Quality task. */
async function contextFor(tasks) {
  const open = tasks.filter((task) => task && !task.completed && CLOSABLE_KINDS.includes(task.kind));
  const after = open.filter((task) => ['ask_printing', 'ask_assembling_edd'].includes(task.kind));
  const enquiryIds = after.filter((task) => task.enquiry).map((task) => idOf(task.enquiry));
  const chainIds = after.filter((task) => !task.enquiry).map((task) => idOf(task.chain || task._id));
  const routes = new Map();
  if (enquiryIds.length || chainIds.length) {
    const rows = await Todo.find({
      kind: 'ask_edd',
      $or: [
        ...(enquiryIds.length ? [{ enquiry: { $in: enquiryIds } }] : []),
        ...(chainIds.length ? [{ chain: { $in: chainIds } }, { _id: { $in: chainIds } }] : []),
      ],
    }).select('enquiry chain routing createdAt').sort({ createdAt: -1 }).lean();
    /* The latest Production task per job. */
    for (const row of rows) {
      const key = jobKeyOf(row);
      if (!routes.has(key)) routes.set(key, row.routing?.models || []);
    }
  }
  const quality = open.filter((task) => QUALITY_KINDS.includes(task.kind));
  const qc = quality.length
    ? await QcRecord.find({
      $or: [
        { task: { $in: quality.map((task) => task._id) } },
        ...(quality.some((task) => task.enquiry) ? [{ enquiry: { $in: quality.filter((task) => task.enquiry).map((task) => idOf(task.enquiry)) } }] : []),
      ],
    }).select('task enquiry number verdict inspectedAt createdAt').lean()
    : [];
  return { routes, qc };
}

/** Whether this task may be offered for closing now, and why — null while something is still to do. */
export async function closableOf(task) {
  if (!task || task.completed || !CLOSABLE_KINDS.includes(task.kind)) return null;
  return closableWith(task, await contextFor([task]));
}

/**
 * The tasks as plain objects with `closable` on each — what a list sends the screen. Documents
 * are serialised as they would be anyway; plain rows are kept as they are.
 */
export async function withClosable(tasks) {
  const context = await contextFor(tasks);
  return tasks.map((task) => {
    const plain = task && typeof task.toJSON === 'function' ? task.toJSON() : task;
    if (plain) plain.closable = closableWith(task, context);
    return plain;
  });
}

/** One task, serialised with `closable` on it — what a move answers with. */
export async function taskWithClosable(task) {
  return (await withClosable([task]))[0];
}
