import Todo from '../models/Todo.js';
import Enquiry from '../models/Enquiry.js';
import { findHandoff } from '../config/handoffs.js';

/**
 * The order's journey through the plant, as one chain of department tasks on the enquiry.
 *
 * Where the work starts says where it goes:
 *   Sample request, Create Quotation, Price Negotiation   end there — the work is the sample
 *                                                         or the quotation, and marketing has it back
 *   PO & SO        SO → Production → Printing / Assembly (as Production routes it) → QC → Dispatch → LR
 *   Ask EDD        Production → Printing / Assembly → QC → Dispatch → LR
 *
 * The SO prepared already raises Production [departmentTaskForms po_so `next`], Production's
 * routing raises Printing and Assembly [handoff.service `decideRouting`], and Dispatched raises the
 * LR copy. What was missing is the middle: once every finishing team — Production and whichever of
 * Printing and Assembly it asked — has the goods ready (Ready for Dispatch) or is done, Quality is
 * asked to check them; once Quality is done, Dispatch is asked to send them. Each is raised once
 * per run of the journey, and never in place of a task a person already raised. Quality never
 * holds Dispatch: a failed check is said on the Dispatch request, as everywhere else.
 *
 * A team task with no enquiry follows the same chain as team tasks for the same buyer, each
 * pointing back at the one it came from [Todo `previousTask`].
 *
 * And the floor's records say on the enquiry's tasks what they did: a mould run started on an
 * enquiry moves Production's task to Production Started, finished it says the pieces made, and
 * every line of the order made moves it to Production Completed — forward only, never over a
 * status somebody set further on.
 */

/** The teams that make and finish the goods; Quality waits for all of them. */
export const FINISHING_KINDS = ['ask_edd', 'ask_printing', 'ask_assembling_edd'];
/** The steps after the finishing teams, in order. */
const AFTER_FINISHING = ['quality_check', 'invoice_dispatch'];
/** Where a journey ends with the task itself. */
export const ENDS_AT_ITSELF = ['sample_request', 'sample_collect', 'create_quotation', 'price_negotiation'];

/*
 * Stages past Dispatch. Not Invoice & Dispatch itself: Production finishing moves the enquiry there
 * [handoffs ask_edd `whenDone`] a moment before Quality is asked, and Quality comes first.
 */
const PAST_QUALITY = ['lr_copy', 'closed', 'my_payment_followup'];

const idOf = (value) => String(value?._id || value || '');
/* A finishing team is through when it says Ready for Dispatch, has handed the goods on, or has finished. */
const isReady = (task) => {
  if (task.completed) return true;
  const step = (findHandoff(task.kind)?.form?.statuses || []).find((entry) => entry.key === task.status);
  return Boolean(step?.readyForDispatch || step?.handsTo);
};

/** The enquiry's dispatch plan [Enquiry `dispatchPlan`], and which models are ready. */
async function planOf(enquiryId) {
  const enquiry = await Enquiry.findById(enquiryId).select('dispatchPlan').lean();
  if (enquiry?.dispatchPlan?.mode !== 'by_model') return { byModel: false };
  const { modelReadiness } = await import('./handoff.service.js');
  return { byModel: true, ...(await modelReadiness(enquiryId)) };
}
const readyWords = ({ ready = [], waiting = [] }) => `Ready: ${ready.join(', ') || 'none'}${waiting.length ? ` · still to come: ${waiting.map((row) => row.model).join(', ')}` : ''}`;

/**
 * A finishing team said the goods are ready, or finished; or Quality finished. Raises what comes
 * next on the journey, if nothing still holds it. Never throws: the move that called it stands.
 */
export async function advanceJourney(task, user, why) {
  try {
    if (!FINISHING_KINDS.includes(task.kind) && task.kind !== 'quality_check') return null;
    return task.enquiry ? await advanceOnEnquiry(task, user, why) : await advanceTeamTask(task, user, why);
  } catch (error) {
    console.error(`[journey] next step after ${task.kind} not raised: ${error.message}`);
    return null;
  }
}

async function advanceOnEnquiry(task, user, why) {
  const enquiryId = idOf(task.enquiry);
  /* This run of the journey began with the newest Production request on the enquiry. */
  const start = await Todo.findOne({ enquiry: enquiryId, kind: 'ask_edd' }).sort({ createdAt: -1 }).select('createdAt').lean();
  if (!start) return null;
  const since = { enquiry: enquiryId, createdAt: { $gte: start.createdAt } };
  const raisedSince = async (kind) => Todo.exists({ ...since, kind });

  if (FINISHING_KINDS.includes(task.kind)) {
    /*
     * Already further on — Dispatch asked (by a person, or Dispatch asked Production itself) or the
     * LR in: a finishing team closing its task late does not send the order back through Quality.
     */
    const ahead = await Todo.exists({
      enquiry: enquiryId, kind: { $in: ['invoice_dispatch', 'lr_copy'] },
      $or: [{ completed: false }, { createdAt: { $gte: start.createdAt } }],
    });
    if (ahead) return null;
    /* Or the enquiry itself already reads Dispatch or later — moved there by hand or by a record. */
    const here = await Enquiry.findById(enquiryId).select('stage').lean();
    if (!here || PAST_QUALITY.includes(here.stage)) return null;
    const finishing = await Todo.find({ ...since, kind: { $in: FINISHING_KINDS } }).select('kind status completed').lean();
    /*
     * Printing or Assembly still making its share: Quality waits for the last of them — unless the
     * order goes out model by model, when a model ready is enough [Enquiry `dispatchPlan`].
     */
    const plan = await planOf(enquiryId);
    if (plan.byModel ? !plan.ready.length : finishing.some((entry) => !isReady(entry))) return null;
    if (!(await raisedSince('quality_check'))) {
      const said = plan.byModel ? `${readyWords(plan)} — dispatch plan: each model as it is ready` : why || 'Goods ready — check them before dispatch';
      return raiseOnEnquiry(enquiryId, 'quality_check', user, said);
    }
    return null;
  }
  /* Quality done on an order on its way: Dispatch has it next, unless already asked. */
  if (task.kind === 'quality_check' && task.completed && !(await raisedSince('invoice_dispatch'))) {
    /* An in-process check while the goods are still being made does not send them to Dispatch — model by model, one ready model is enough. */
    const finishing = await Todo.find({ ...since, kind: { $in: FINISHING_KINDS } }).select('kind status completed').lean();
    const plan = await planOf(enquiryId);
    if (plan.byModel ? !plan.ready.length : finishing.some((entry) => !isReady(entry))) return null;
    if (plan.byModel) return raiseOnEnquiry(enquiryId, 'invoice_dispatch', user, `Quality checked — ${readyWords(plan)}. Dispatch plan: each model as it is ready`);
    const result = task.outcome?.fields?.result || task.statusHistory?.at(-1)?.note || '';
    return raiseOnEnquiry(enquiryId, 'invoice_dispatch', user, `Quality ${/fail/i.test(result) ? 'reported a problem — see the QC task' : 'checked'}${why ? ` — ${why}` : ''}`);
  }
  return null;
}

async function raiseOnEnquiry(enquiryId, kind, user, note) {
  const { moveEnquiry } = await import('./handoff.service.js');
  const enquiry = await Enquiry.findById(enquiryId).populate('customer', 'code name');
  if (!enquiry || enquiry.stage === 'closed') return null;
  try {
    return await moveEnquiry({ enquiry, kind, note, user, system: true, openRecords: false });
  } catch (error) {
    /* Already open (somebody raised it), or a gate said no — the advance not in: Payment Collection is asked. */
    if ([400, 409].includes(error?.statusCode)) {
      console.warn(`[journey] ${enquiry.number}: ${findHandoff(kind)?.label || kind} not raised — ${error.message}`);
      return null;
    }
    throw error;
  }
}

/* ------------------------------ team tasks, with no enquiry ------------------------------ */

/** What follows a team task on the same buyer. */
const TEAM_NEXT = { po_so: 'ask_edd', ask_edd: 'quality_check', ask_printing: 'quality_check', ask_assembling_edd: 'quality_check', quality_check: 'invoice_dispatch' };

async function advanceTeamTask(task, user, why) {
  const kind = TEAM_NEXT[task.kind];
  if (!kind) return null;
  if (task.kind === 'quality_check' && !task.completed) return null;
  return raiseNextTeamTask(task, kind, user, why);
}

/**
 * The next team task in the chain, for the same buyer, carrying what the last one knew (model,
 * material, quantity). Once: a chain that already has it is left alone.
 */
export async function raiseNextTeamTask(task, kind, user, why) {
  if (await Todo.exists({ previousTask: task._id, kind })) return null;
  const handoff = findHandoff(kind);
  if (!handoff?.department) return null;
  const statuses = handoff.form?.statuses || [];
  const carried = {};
  for (const key of ['model', 'material', 'quantity', 'models']) if (task.brief?.[key]) carried[key] = task.brief[key];
  if (!carried.quantity && Array.isArray(task.brief?.items)) {
    const total = task.brief.items.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);
    if (total) carried.quantity = String(total);
    if (task.brief.items[0]?.model) carried.model = task.brief.items[0].model;
  }
  const buyer = task.customer?.name ? task.customer : null;
  const next = await Todo.create({
    customer: idOf(task.customer) || undefined,
    kind,
    department: handoff.department,
    fromDepartment: task.department,
    createdBy: task.createdBy || user?._id,
    previousTask: task._id,
    order: task.order || undefined,
    title: `${handoff.label} — ${buyer?.name || task.title.split(' — ').slice(1).join(' — ') || 'team task'}`,
    notes: `${findHandoff(task.kind)?.label || task.kind} → ${handoff.label}${why ? `: ${why}` : ''}${user?.name ? ` (${user.name})` : ''}`,
    ...(Object.keys(carried).length ? { brief: carried } : {}),
    ...(statuses.length ? { status: statuses[0].key, statusHistory: [{ status: statuses[0].key, by: user?._id, at: new Date() }] } : {}),
    dueDate: new Date(Date.now() + 86400000),
    priority: task.priority || 'normal',
    system: true,
    link: '/departments/mine',
  });
  return next;
}

/* ------------------------------ the floor, on the enquiry's tasks ------------------------------ */

/**
 * Production's open task on the enquiry hears what the floor did: the note always; the status
 * moved to `to` only when that is further along its workflow than where it is (never back, and
 * never over an issue somebody flagged). Its marketing person and Admin are told, as for any move.
 */
export async function tellProductionTask(enquiryId, { note, to, user }) {
  if (!enquiryId) return null;
  const task = await Todo.findOne({ enquiry: idOf(enquiryId), kind: 'ask_edd', completed: false }).sort({ createdAt: -1 });
  if (!task) return null;
  const statuses = findHandoff('ask_edd')?.form?.statuses || [];
  const at = (key) => statuses.findIndex((entry) => entry.key === key);
  const current = statuses.find((entry) => entry.key === task.status);
  const step = to && at(to) > at(task.status) && !current?.issue ? statuses[at(to)] : null;
  const now = new Date();
  if (step) {
    task.status = step.key;
    task.statusHistory = [...(task.statusHistory || []), { status: step.key, note, by: user?._id, at: now }];
  }
  task.updates = [...(task.updates || []), step
    ? { kind: 'status', status: step.key, statusLabel: step.label, text: note, note: `${step.label}: ${note}`, by: user?._id, at: now }
    : { kind: 'notice', statusLabel: 'From the floor', text: note, note, by: user?._id, at: now }];
  await task.save();
  if (step) {
    const { noticeStatus } = await import('./handoff.service.js');
    await noticeStatus(task, user, { step, note });
  }
  return task;
}

/* ------------------------------ what the enquiry screen shows ------------------------------ */

/**
 * The journey as steps for the enquiry screen: which chain it is on, each step done, in hand or
 * still to come, and what the floor is doing in Production right now.
 */
export function journeyOf(tasks = [], { running = [] } = {}) {
  const ofKind = (kinds) => tasks.filter((task) => kinds.includes(task.kind)).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const has = (kinds) => ofKind(kinds).length > 0;
  const step = (key, label, kinds, { optional = false } = {}) => {
    const [latest] = ofKind(kinds);
    if (!latest && optional) return null;
    const state = !latest ? 'todo' : latest.completed ? 'done' : 'open';
    return {
      key, label, state,
      status: latest && !latest.completed ? (findHandoff(latest.kind)?.form?.statuses || []).find((entry) => entry.key === latest.status)?.label || null : null,
      at: latest ? (latest.completedAt || latest.updatedAt || latest.createdAt) : null,
    };
  };
  const inOrder = has(['po_so', ...FINISHING_KINDS, ...AFTER_FINISHING, 'lr_copy']);
  if (!inOrder) {
    if (has(['create_quotation', 'price_negotiation'])) return { kind: 'quotation', steps: [step('quotation', 'Quotation', ['create_quotation', 'price_negotiation'])] };
    if (has(['sample_request', 'sample_collect'])) return { kind: 'sample', steps: [step('sample', 'Sample', ['sample_request', 'sample_collect'])] };
    return null;
  }
  const production = step('production', 'Production', ['ask_edd']);
  if (running.length) {
    production.state = production.state === 'done' ? 'done' : 'open';
    production.live = running.map((run) => `${run.machine?.code || 'Press'} · ${run.mould?.mouldCode || run.modelNumber || 'mould'} running`).join(', ');
  }
  const steps = [
    has(['po_so']) ? step('so', 'SO', ['po_so']) : null,
    production,
    step('printing', 'Printing', ['ask_printing'], { optional: true }),
    step('assembly', 'Assembly', ['ask_assembling_edd'], { optional: true }),
    step('quality', 'QC', ['quality_check']),
    step('dispatch', 'Dispatch', ['invoice_dispatch']),
    step('lr', 'LR', ['lr_copy']),
  ].filter(Boolean);
  return { kind: has(['po_so']) ? 'order' : 'production', steps };
}
