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

/**
 * The tasks of one job: an enquiry's, or — raised from the customer with no enquiry — one chain
 * of team tasks [Todo `chain`]: the first task and every task raised on from it.
 */
export function jobFilter(task) {
  if (task.enquiry) return { enquiry: idOf(task.enquiry) };
  const root = idOf(task.chain || task._id);
  return { $or: [{ chain: root }, { _id: root }] };
}
/** The chain a task raised on from this one belongs to. */
export const chainOf = (task) => (task.enquiry ? undefined : idOf(task.chain || task._id));
/* A finishing team is through when it says Ready for Dispatch, has handed the goods on, or has finished. */
const isReady = (task) => {
  if (task.completed) return true;
  const step = (findHandoff(task.kind)?.form?.statuses || []).find((entry) => entry.key === task.status);
  return Boolean(step?.readyForDispatch || step?.handsTo);
};

/** The enquiry's dispatch plan [Enquiry `dispatchPlan`], and which models are ready. */
async function planOf(enquiryId) {
  const enquiry = await Enquiry.findById(enquiryId).select('dispatchPlan qcRequired').lean();
  const qcRequired = Boolean(enquiry?.qcRequired);
  if (enquiry?.dispatchPlan?.mode !== 'by_model') return { byModel: false, qcRequired };
  const { modelReadiness } = await import('./handoff.service.js');
  return { byModel: true, qcRequired, ...(await modelReadiness(enquiryId)) };
}
const tickedQc = (value) => value === true || value === 'true' || value === 'Yes' || value === 'on';
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
     * QC compulsory [Enquiry `qcRequired`, or ticked on the Production request]: Quality is asked and
     * Dispatch waits for its pass. Otherwise the goods go straight to Dispatch [qcGate.service].
     */
    const plan = await planOf(enquiryId);
    const production = await Todo.findOne({ enquiry: enquiryId, kind: 'ask_edd' }).sort({ createdAt: -1 }).select('brief').lean();
    const qcRequired = plan.qcRequired || tickedQc(production?.brief?.qcRequired);
    /*
     * Already further on — Dispatch asked (by a person, or Dispatch asked Production itself) or the
     * LR in: a finishing team closing its task late does not send the order back through Quality.
     * With QC compulsory, Dispatch asked early is not further on: Quality is still owed its check.
     */
    const ahead = await Todo.exists({
      enquiry: enquiryId, kind: { $in: qcRequired ? ['lr_copy'] : ['invoice_dispatch', 'lr_copy'] },
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
    if (plan.byModel ? !plan.ready.length : finishing.some((entry) => !isReady(entry))) return null;
    if (!qcRequired) {
      if (await raisedSince('invoice_dispatch')) return null;
      const said = plan.byModel ? `${readyWords(plan)} — dispatch plan: each model as it is ready` : why || 'Goods ready';
      return raiseOnEnquiry(enquiryId, 'invoice_dispatch', user, said);
    }
    return askQuality(enquiryId, since, plan, user, why);
  }
  if (task.kind !== 'quality_check' || !task.completed) return null;
  /* Quality closed it without a pass (Admin closed a failed check): nothing goes to Dispatch on it. */
  const { qcPassed, qcModelsOf } = await import('./qcGate.service.js');
  if (!qcPassed(task)) return null;
  const passed = qcModelsOf(task);
  const passedWords = passed.length ? ` ${passed.join(', ')}` : '';
  /* Quality passed with the Dispatch request already open (QC compulsory): the request reads Goods Ready now. */
  if (await raisedSince('invoice_dispatch')) {
    const { tellDispatchReady } = await import('./handoff.service.js');
    /* Part of the order passed, more still to pass: the request moves on only when it goes out model by model. */
    const { qcGateFor } = await import('./qcGate.service.js');
    const gate = await qcGateFor({ enquiry: enquiryId });
    await tellDispatchReady(task, user, { key: 'quality_passed', label: `Quality passed${passedWords}` }, why || '', { partial: !gate.cleared });
    return null;
  }
  /* Quality done on an order on its way: Dispatch has it next. An in-process check while the goods are still being made does not send them — model by model, one ready model is enough. */
  const finishing = await Todo.find({ ...since, kind: { $in: FINISHING_KINDS } }).select('kind status completed').lean();
  const plan = await planOf(enquiryId);
  if (plan.byModel ? !plan.ready.length : finishing.some((entry) => !isReady(entry))) return null;
  if (plan.byModel) return raiseOnEnquiry(enquiryId, 'invoice_dispatch', user, `Quality passed${passedWords} — ${readyWords(plan)}. Dispatch plan: each model as it is ready`);
  return raiseOnEnquiry(enquiryId, 'invoice_dispatch', user, `Quality passed${passedWords}${why ? ` — ${why}` : ''}`);
}

/**
 * QC compulsory and goods ready: Quality is asked to check the models ready that it has not
 * passed and is not already checking — all of them together, or each as it is ready when the
 * order goes out model by model. A Quality task already open has them added to it; otherwise a
 * Quality task is raised with just those models, the order's pieces on each.
 */
async function askQuality(enquiryId, since, plan, user, why) {
  const { modelReadiness } = await import('./handoff.service.js');
  const readiness = plan.byModel ? plan : await modelReadiness(enquiryId);
  const ready = plan.byModel ? plan.ready : [...(readiness.ready || []), ...(readiness.waiting || []).map((row) => row.model)];
  const { qcPassed, qcModelsOf } = await import('./qcGate.service.js');
  const checks = await Todo.find({ ...since, kind: 'quality_check' }).sort({ createdAt: -1 });
  /* A check that names no model is the whole order's. */
  const covering = checks.filter((check) => !check.completed || qcPassed(check));
  if (covering.some((check) => !qcModelsOf(check).length)) return null;
  const covered = new Set(covering.flatMap(qcModelsOf).map((model) => model.toLowerCase()));
  const fresh = ready.filter((model) => !covered.has(String(model).toLowerCase()));
  /* No models known (an old Production request): one check for the order, once. */
  if (!ready.length) {
    if (checks.length) return null;
    return raiseOnEnquiry(enquiryId, 'quality_check', user, why || 'Goods ready — QC compulsory: check them before dispatch');
  }
  if (!fresh.length) return null;
  const { taskPrefill } = await import('./handoff.service.js');
  const prefill = await taskPrefill(enquiryId);
  const rowOf = (model) => {
    const row = (prefill.qualityItems || []).find((entry) => String(entry.model || '').toLowerCase() === String(model).toLowerCase());
    return Object.fromEntries(Object.entries({ model, material: row?.material, quantity: row?.quantity }).filter(([, value]) => value));
  };
  const said = plan.byModel
    ? `${readyWords(plan)} — dispatch plan: each model as it is ready. Check ${fresh.join(', ')} before dispatch`
    : why || `Goods ready — QC compulsory: check ${fresh.join(', ')} before dispatch`;
  const open = checks.find((check) => !check.completed);
  if (open) {
    const brief = open.brief?.toObject?.() ?? { ...(open.brief || {}) };
    open.brief = { ...brief, items: [...(Array.isArray(brief.items) ? brief.items : []), ...fresh.map(rowOf)] };
    open.markModified('brief');
    open.updates = [...(open.updates || []), { kind: 'note', text: `Also check ${fresh.join(', ')} — ready now`, note: `Added for QC: ${fresh.join(', ')}`, by: user?._id, at: new Date() }];
    await open.save();
    const { noticeStatus, peopleOn } = await import('./handoff.service.js');
    await noticeStatus(open, user, { step: { key: open.status || 'received', label: `More goods for QC: ${fresh.join(', ')}` }, note: said, also: await peopleOn(open), onlyAlso: true });
    return open;
  }
  return raiseOnEnquiry(enquiryId, 'quality_check', user, said, { items: fresh.map(rowOf) });
}

async function raiseOnEnquiry(enquiryId, kind, user, note, brief) {
  const { moveEnquiry } = await import('./handoff.service.js');
  const enquiry = await Enquiry.findById(enquiryId).populate('customer', 'code name');
  if (!enquiry || enquiry.stage === 'closed') return null;
  try {
    return await moveEnquiry({ enquiry, kind, note, user, system: true, openRecords: false, ...(brief ? { brief } : {}) });
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
const TEAM_NEXT = { po_so: 'ask_edd', quality_check: 'invoice_dispatch' };

/**
 * A job without an enquiry goes the way an enquiry's does: once every finishing team on it —
 * Production, and the Printing and Assembly it routed to, or the one team asked — is through,
 * Dispatch is asked, with Quality's check beside it (Quality never holds the goods back). Quality
 * finishing first asks Dispatch if nobody has.
 */
async function advanceTeamTask(task, user, why) {
  if (FINISHING_KINDS.includes(task.kind)) {
    const finishing = await Todo.find({ ...jobFilter(task), kind: { $in: FINISHING_KINDS } }).select('kind status completed brief').lean();
    if (finishing.some((entry) => !isReady(entry))) return null;
    /* QC compulsory, ticked on the Production task (or the one team asked): Quality first, Dispatch on its pass. */
    const production = finishing.find((entry) => entry.kind === 'ask_edd') || finishing[0];
    if (tickedQc(production?.brief?.qcRequired) || tickedQc(task.brief?.qcRequired)) {
      return raiseNextTeamTask(task, 'quality_check', user, why || 'Goods ready — QC compulsory: check them before dispatch');
    }
    return raiseNextTeamTask(task, 'invoice_dispatch', user, why || 'Goods ready');
  }
  const kind = TEAM_NEXT[task.kind];
  if (!kind) return null;
  if (task.kind === 'quality_check' && !task.completed) return null;
  /* Only Quality's pass sends the goods on; a failed check closed by Admin does not. */
  if (task.kind === 'quality_check' && !(await import('./qcGate.service.js')).qcPassed(task)) return null;
  return raiseNextTeamTask(task, kind, user, why);
}

/**
 * The next team task in the chain, for the same buyer, carrying what the last one knew (model,
 * material, quantity). Once: a chain that already has it is left alone.
 */
export async function raiseNextTeamTask(task, kind, user, why, { brief: given } = {}) {
  /* Once on the job: Dispatch asked by Assembly is not asked again by Printing. */
  if (await Todo.exists({ previousTask: task._id, kind })) return null;
  if (!task.enquiry && await Todo.exists({ ...jobFilter(task), kind, completed: false })) return null;
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
    chain: chainOf(task),
    order: task.order || undefined,
    title: `${handoff.label} — ${buyer?.name || task.title.split(' — ').slice(1).join(' — ') || 'team task'}`,
    notes: `${findHandoff(task.kind)?.label || task.kind} → ${handoff.label}${why ? `: ${why}` : ''}${user?.name ? ` (${user.name})` : ''}`,
    ...(Object.keys({ ...carried, ...given }).length ? { brief: { ...carried, ...given } } : {}),
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
export async function tellProductionTask(enquiryId, { note, to, user, model }) {
  if (!enquiryId) return null;
  const task = await Todo.findOne({ enquiry: idOf(enquiryId), kind: 'ask_edd', completed: false }).sort({ createdAt: -1 });
  if (!task) return null;
  const statuses = findHandoff('ask_edd')?.form?.statuses || [];
  const at = (key) => statuses.findIndex((entry) => entry.key === key);
  const behind = (key) => at(to) > at(key) && !statuses.find((entry) => entry.key === key)?.issue;
  const now = new Date();
  let step = null;
  if (to && task.modelStatuses?.length) {
    /* Models moving on their own [Todo `modelStatuses`]: the run's model moves (every model when it names none of them). */
    const { modelStatusesOf, slowestStatus } = await import('./handoff.service.js');
    const rows = modelStatusesOf(task);
    const mine = rows.some((row) => row.model === model) ? [model] : rows.map((row) => row.model);
    const moved = rows.filter((row) => mine.includes(row.model) && behind(row.status));
    if (moved.length) {
      step = statuses[at(to)];
      task.modelStatuses = rows.map((row) => (moved.includes(row) ? { model: row.model, status: to, note, by: user?._id, at: now } : row));
      task.status = slowestStatus(task, task.modelStatuses);
      task.statusHistory = [...(task.statusHistory || []), { status: step.key, note, ...(moved.length < rows.length ? { models: moved.map((row) => row.model) } : {}), by: user?._id, at: now }];
    }
  } else if (to && behind(task.status)) {
    step = statuses[at(to)];
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
export function journeyOf(tasks = [], { running = [], qcRequired = false } = {}) {
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
    /* QC only where it is compulsory, or Quality was asked anyway; otherwise the goods go straight to Dispatch. */
    step('quality', 'QC', ['quality_check'], { optional: !qcRequired }),
    step('dispatch', 'Dispatch', ['invoice_dispatch']),
    step('lr', 'LR', ['lr_copy']),
  ].filter(Boolean);
  return { kind: has(['po_so']) ? 'order' : 'production', steps };
}
