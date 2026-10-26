import Todo from '../models/Todo.js';
import Customer from '../models/Customer.js';
import ApiError from '../utils/ApiError.js';
import { HANDOFFS, findHandoff } from '../config/handoffs.js';
import { HANGER_DETAILS } from '../config/departmentTaskForms.js';
import { findDepartment } from '../config/modules.js';
import { isManagement } from '../utils/departments.js';

/**
 * Team jobs [web: pages/TeamJobs.jsx, TeamJobDetail.jsx] — a task Admin or marketing gave a team
 * with no enquiry behind it, read the way an enquiry is: what was asked, where it is now, the
 * steps each team took, and what each did. A job is its first task (`chain` is its own id,
 * numbered `JOB-…`) and every task raised from it on the same chain — Production → Printing →
 * Dispatch → LR, Payment Collection → PRT, A/C Clarify.
 *
 * Who reads which: Admin every job; anyone else the jobs they gave, and a marketing person the
 * jobs for buyers assigned to them too.
 */

const idOf = (value) => String(value?._id || value || '');
const ROOT = { enquiry: null, $expr: { $eq: ['$chain', '$_id'] } };
/* A personal reminder (My Payment Follow-up) is its raiser's own, not a job given to a team. */
const PERSONAL_KINDS = HANDOFFS.filter((handoff) => handoff.department === 'owner').map((handoff) => handoff.key);
/*
 * A job: a team task's first task — numbered on raising [numberOldJobs numbers any from before],
 * and still one when it has since joined the buyer's enquiry [`jobLinked`]. Read by its number,
 * which is indexed: the shape of a first task (`chain` is its own id) cannot be, and asking for it
 * read every task in the book.
 */
const JOBS = { jobNumber: { $exists: true, $nin: [null, ''] }, kind: { $exists: true, $nin: PERSONAL_KINDS } };

const stepLabel = (task) => (findHandoff(task.kind)?.form?.statuses || []).find((entry) => entry.key === task.status)?.label || (task.status ? String(task.status).replace(/_/g, ' ') : 'Received');
const taskLabel = (task) => findHandoff(task.kind)?.label || task.title || 'Task';
const teamOf = (task) => findDepartment(task.department)?.label || String(task.department || 'Team').replace(/_/g, ' ');

/** Jobs raised before they were numbered get their number the first time they are read. */
async function numberOldJobs() {
  /* Through the chain index: only tasks on a chain are looked at, never the whole book. */
  const old = await Todo.find({ chain: { $exists: true }, jobNumber: null, ...ROOT, kind: { $exists: true, $nin: PERSONAL_KINDS } }).select('_id createdAt').sort({ createdAt: 1 }).limit(200).lean();
  if (!old.length) return;
  const { nextNumber } = await import('./numbering.service.js');
  for (const row of old) await Todo.updateOne({ _id: row._id, jobNumber: null }, { $set: { jobNumber: await nextNumber('JOB', row.createdAt) } }, { keepVersion: true });
}

/** Which jobs this person reads [see the head of this file]. */
async function scopeFor(user) {
  if (isManagement(user)) return {};
  const mine = await Customer.find({ assignedTo: user._id }).distinct('_id');
  return { $or: [{ createdBy: user._id }, ...(mine.length ? [{ customer: { $in: mine } }] : [])] };
}

/* The goods follow this order, team to team; a later team's task is further along. */
const PIPELINE = ['ask_edd', 'ask_printing', 'ask_assembling_edd', 'quality_check', 'invoice_dispatch', 'lr_copy'];
const firstStatusOf = (task) => findHandoff(task.kind)?.form?.statuses?.[0]?.key;
/* A team has taken it up: its task has moved on from the status it was raised at. */
const movedOn = (task) => Boolean(task.status && task.status !== firstStatusOf(task))
  || (task.modelStatuses || []).some((row) => row.status && row.status !== firstStatusOf(task));
const LR_SENT = ['sent', 'in_transit', 'delivered'];

/**
 * Reception's LR task done for the job, though left open to track the lorry: every shipment's LR
 * is with the buyer and nothing is left for Dispatch to send.
 */
function lrSettled(task, tasks) {
  if (task.kind !== 'lr_copy' || task.completed || !LR_SENT.includes(task.status)) return false;
  const dispatch = tasks.filter((entry) => entry.kind === 'invoice_dispatch');
  if (!dispatch.length || dispatch.some((entry) => !entry.completed)) return false;
  return dispatch.flatMap((entry) => entry.loads || []).filter((load) => load.mode === 'transporter').every((load) => load.lrSent?.at);
}

/**
 * Who has the goods: the furthest team along that has taken them up — Printing at work while
 * Assembly, raised beside it, waits for them. Nobody has yet: the first team in line. Work that
 * is not goods (Payment Collection → PRT) reads the newest task.
 */
function holderOf(open) {
  const rank = (task) => PIPELINE.indexOf(task.kind);
  const newest = (a, b) => new Date(b.createdAt) - new Date(a.createdAt);
  const moved = open.filter(movedOn);
  if (moved.length) return [...moved].sort((a, b) => rank(b) - rank(a) || newest(a, b))[0];
  const goods = open.filter((task) => rank(task) >= 0);
  if (goods.length) return [...goods].sort((a, b) => rank(a) - rank(b) || newest(b, a))[0];
  return [...open].sort(newest)[0];
}

/** Where a job is now, in one line: the team holding it and its status — or done, with how it ended. */
function nowOf(tasks, root = null) {
  if (root?.jobLinked?.enquiry) {
    const linked = { _id: root.jobLinked.enquiry, number: root.jobLinked.number };
    return root.completed
      ? { done: true, words: `Done — on ${linked.number || 'the enquiry'}: ${stepLabel(root)}`, team: root.department, linked }
      : { done: false, words: `Joined ${linked.number || 'the enquiry'} — ${teamOf(root)}: ${stepLabel(root)}`, team: root.department, linked };
  }
  /* The goods are ready, and Dispatch waits to be told whom they are for — Production's task done or not. */
  if (root && !root.customer && root.buyerWantedAt) {
    return { done: false, words: 'Goods ready — name the buyer so Dispatch can send them', team: 'despatch', needsBuyer: true };
  }
  const open = tasks.filter((task) => !task.completed && !lrSettled(task, tasks));
  if (!open.length) {
    const settled = tasks.find((task) => lrSettled(task, tasks));
    const last = settled || [...tasks].sort((a, b) => new Date(b.completedAt || b.updatedAt) - new Date(a.completedAt || a.updatedAt))[0];
    return { done: true, words: `Done — ${teamOf(last)}: ${stepLabel(last)}`, team: last?.department || null };
  }
  const holder = holderOf(open);
  const others = open.length > 1 ? ` · ${open.length} teams working` : '';
  return { done: false, words: `${teamOf(holder)}: ${stepLabel(holder)}${others}`, team: holder.department };
}

const modelsOf = (task) => {
  const items = Array.isArray(task.brief?.items) ? task.brief.items.map((item) => item.model) : [];
  return [...new Set([...String(task.brief?.models || task.brief?.model || '').split(','), ...items].map((model) => String(model || '').trim()).filter(Boolean))];
};

/**
 * The hanger's details on the job — model, material & colour, hook, clip, print, quantity — read
 * from what was asked and, where the asker left one out, from the task that filled it later (the
 * Production team, say, on its own task [handoff.service `editTaskBrief`]), with who filled it.
 */
const detailsOf = (root, tasks) => {
  /* The asking first — as read with its updates' names — then the rest in order. */
  const ordered = [tasks.find((task) => idOf(task._id) === idOf(root._id)) || root, ...tasks.filter((task) => idOf(task._id) !== idOf(root._id))];
  return HANGER_DETAILS.map((field) => {
    const task = ordered.find((entry) => String(entry.brief?.[field.key] ?? '').trim());
    if (!task) return null;
    /* Filled after the asking: the latest "Details filled" / "Corrected" line naming it says who. */
    const line = [...(task.updates || [])].reverse().find((entry) => entry.kind === 'corrected' && String(entry.text || '').split(', ').includes(field.label));
    const value = String(task.brief[field.key]).trim();
    return {
      key: field.key, label: field.label,
      value: field.type === 'number' && Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-IN') : value,
      ...(line ? { filledBy: { team: teamOf(task), name: line.by?.name || null, at: line.at } } : {}),
    };
  }).filter(Boolean);
};

/** The jobs this person gave or follows, newest move first: open ones by default, or done. */
export async function listTeamJobs(user, { state = 'open', search = '', limit = 200, page = 1 } = {}) {
  await numberOldJobs();
  const scope = await scopeFor(user);
  /*
   * Open jobs are found from their open tasks — through the chain index — and done ones are read a
   * page at a time, newest first [web: Team jobs "Load more"]: a year of finished jobs is never
   * loaded to show the handful still open, nor all at once to show the done list.
   */
  const needle = String(search || '').trim().toLowerCase();
  /* A job whose only open task is an LR already with the buyer may read done [lrSettled]: it is looked at for both lists, and where it is now decides. */
  const [openChains, workingChains] = await Promise.all([
    Todo.distinct('chain', { chain: { $exists: true }, completed: false }),
    Todo.distinct('chain', { chain: { $exists: true }, completed: false, $nor: [{ kind: 'lr_copy', status: { $in: LR_SENT } }] }),
  ]);
  const elsewhere = [{ 'jobLinked.enquiry': { $exists: true }, completed: false }, { buyerWantedAt: { $exists: true }, customer: null }];
  const which = state === 'open' ? [{ $or: [{ _id: { $in: openChains } }, ...elsewhere] }]
    : state === 'done' ? [{ $nor: [{ _id: { $in: workingChains } }, ...elsewhere] }] : [];
  const size = needle ? 500 : state === 'done' ? Math.min(limit, 50) : 500;
  const skip = !needle && state === 'done' ? (Math.max(1, Number(page) || 1) - 1) * size : 0;
  const roots = await Todo.find({ $and: [JOBS, scope, ...which] })
    .select('jobNumber jobLinked buyerWantedAt kind department title notes brief customer createdBy createdAt updatedAt jobEdd completed status')
    .populate([{ path: 'customer', select: 'name' }, { path: 'createdBy', select: 'name' }])
    .sort(state === 'done' ? { updatedAt: -1 } : { createdAt: -1 }).skip(skip).limit(size).lean();
  if (!roots.length) return [];
  const all = await Todo.find({ chain: { $in: roots.map((root) => root._id) } })
    .select('chain kind department status modelStatuses.status completed completedAt createdAt updatedAt loads.mode loads.lrSent').lean();
  const byJob = new Map();
  for (const task of all) {
    const key = idOf(task.chain);
    if (!byJob.has(key)) byJob.set(key, []);
    byJob.get(key).push(task);
  }
  const rows = roots.map((root) => {
    /* A job that joined an enquiry has no chain any more: its own task is the whole of it here. */
    const tasks = root.jobLinked?.enquiry ? [root] : byJob.get(idOf(root._id)) || [root];
    const now = nowOf(tasks, root);
    return {
      _id: root._id,
      number: root.jobNumber || null,
      customer: root.customer ? { _id: root.customer._id, name: root.customer.name } : null,
      asked: { team: teamOf(root), what: taskLabel(root), note: String(root.notes || '').split('\n')[0].slice(0, 160), models: modelsOf(root) },
      raisedBy: root.createdBy?.name || null,
      raisedAt: root.createdAt,
      edd: root.jobEdd?.date || null,
      now,
      teams: [...new Set(tasks.map(teamOf))],
      openTasks: tasks.filter((task) => !task.completed).length,
      lastMoveAt: tasks.reduce((latest, task) => (new Date(task.updatedAt || task.createdAt) > latest ? new Date(task.updatedAt || task.createdAt) : latest), new Date(root.createdAt)),
    };
  });
  return rows
    /* Open/done by where each job is now — a job whose last open task is an LR already with the buyer reads done. */
    .filter((row) => (state === 'done' ? row.now.done : state === 'all' ? true : !row.now.done))
    .filter((row) => !needle || [row.number, row.customer?.name, row.asked.what, row.asked.note, row.asked.models.join(' '), row.raisedBy].some((value) => String(value || '').toLowerCase().includes(needle)))
    .sort((a, b) => b.lastMoveAt - a.lastMoveAt)
    .slice(0, limit);
}

/**
 * One job, read whole: what was asked; where it is now; each team's task with its status, who
 * has it and when it moved; every move and update in plain words, newest first; and — where the
 * job has them — each model's journey, the payments logged and what Accounts said, the shipments
 * with their LR, and the files on any of its tasks.
 */
export async function teamJob(user, id) {
  await numberOldJobs();
  if (!/^[0-9a-f]{24}$/i.test(String(id))) throw ApiError.notFound('Job not found');
  const root = await Todo.findOne({ $and: [{ _id: id }, JOBS, await scopeFor(user)] })
    .populate([{ path: 'customer', select: 'name mobile' }, { path: 'createdBy', select: 'name' }]);
  if (!root) throw ApiError.notFound('Job not found');
  const POPULATE = [{ path: 'user', select: 'name' }, { path: 'updates.by', select: 'name' }, { path: 'createdBy', select: 'name' }];
  /* Joined an enquiry: its own task, read here; the rest of its workflow is the enquiry's. */
  const tasks = root.jobLinked?.enquiry
    ? [await root.populate(POPULATE)]
    : await Todo.find({ chain: root._id }).sort({ createdAt: 1 }).populate(POPULATE);
  const steps = tasks.map((task) => ({
    _id: task._id, kind: task.kind, team: teamOf(task), department: task.department, what: taskLabel(task),
    status: task.status || null, statusLabel: stepLabel(task), completed: Boolean(task.completed), completedAt: task.completedAt || null,
    with: task.user?.name || null, raisedAt: task.createdAt, lastMoveAt: task.updatedAt,
    modelStatuses: (task.modelStatuses || []).map((row) => ({ model: row.model, status: row.status, label: (findHandoff(task.kind)?.form?.statuses || []).find((entry) => entry.key === row.status)?.label || row.status })),
  }));
  /* Every move and update, the asking itself first in time — newest shown first. */
  const timeline = [];
  for (const task of tasks) {
    timeline.push({ at: task.createdAt, team: teamOf(task), what: `${taskLabel(task)} asked`, text: task._id.equals(root._id) ? String(task.notes || '') : String(task.notes || '').slice(0, 400), by: task.createdBy?.name || null, kind: 'asked' });
    for (const line of task.updates || []) {
      timeline.push({ at: line.at, team: teamOf(task), what: line.statusLabel || (line.kind === 'status' ? stepLabel({ ...task.toObject(), status: line.status }) : 'Update'), text: line.text || line.note || '', by: line.by?.name || null, kind: line.kind || 'note' });
    }
    if (task.completed) timeline.push({ at: task.completedAt || task.updatedAt, team: teamOf(task), what: `${taskLabel(task)} closed`, text: [task.outcome?.result, task.outcome?.note].filter((part) => typeof part === 'string' && part).join(' — '), by: null, kind: 'closed' });
  }
  timeline.sort((a, b) => new Date(b.at) - new Date(a.at));

  const handoff = await import('./handoff.service.js');
  const production = tasks.find((task) => task.kind === 'ask_edd');
  const journeys = production ? await handoff.modelJourneys(null, { task: production }).catch(() => []) : [];
  const shipments = tasks.some((task) => ['invoice_dispatch', 'lr_copy'].includes(task.kind)) ? await handoff.shipmentsOf(root).catch(() => []) : [];
  /* Money taken on any of its Payment Collection or PRT tasks, and what Accounts said of it. */
  const { receiptsOfTask } = await import('./paymentGates.service.js');
  const payments = [];
  for (const task of tasks.filter((entry) => ['team_payment_followup', 'prt_recovery', 'ac_clarify'].includes(entry.kind))) {
    for (const row of await receiptsOfTask(task).catch(() => [])) if (!payments.some((seen) => idOf(seen._id) === idOf(row._id))) payments.push({ ...row, team: teamOf(task) });
  }
  const { default: Attachment } = await import('../models/Attachment.js');
  const files = await Attachment.find({ task: { $in: tasks.map((task) => task._id) } }).select('key filename mimeType title docType task createdAt').sort({ createdAt: -1 }).lean();
  const documents = files.map((file) => {
    const task = tasks.find((entry) => idOf(entry._id) === idOf(file.task));
    return { _id: file._id, key: file.key, filename: file.filename, mimeType: file.mimeType, title: file.title || file.filename, at: file.createdAt, team: task ? teamOf(task) : null };
  });
  return {
    _id: root._id,
    number: root.jobNumber || null,
    customer: root.customer ? { _id: root.customer._id, name: root.customer.name, mobile: root.customer.mobile || null } : null,
    /* A model the asker left out and a team filled later is the job's model too. */
    asked: { team: teamOf(root), what: taskLabel(root), note: root.notes || '', models: [...new Set([...modelsOf(root), ...tasks.flatMap((task) => modelsOf(task))])], brief: root.brief || {} },
    hanger: detailsOf(root, tasks),
    raisedBy: root.createdBy?.name || null,
    raisedAt: root.createdAt,
    edd: root.jobEdd?.date || null,
    now: nowOf(tasks, root),
    linked: root.jobLinked?.enquiry ? { _id: root.jobLinked.enquiry, number: root.jobLinked.number || null } : null,
    /* No buyer named: whoever may name one sees the picker [nameJobBuyer]. */
    mayNameBuyer: !root.customer && !root.jobLinked?.enquiry && mayNameBuyer(user, root),
    steps, timeline, journeys, shipments, payments, documents,
  };
}

const mayNameBuyer = (user, root) => isManagement(user) || idOf(root.createdBy) === idOf(user._id);

/**
 * The buyer named on a job that had none [web: TeamJobDetail "Name the buyer"] — by its asker or
 * Admin; a marketing person names one of their own buyers. Every task of the job takes it, and a
 * job whose goods were ready and waiting for it goes on to Dispatch now [journey.service].
 */
export async function nameJobBuyer(user, id, customerId, { noBuyer = false } = {}) {
  if (!/^[0-9a-f]{24}$/i.test(String(id))) throw ApiError.notFound('Job not found');
  const root = await Todo.findOne({ $and: [{ _id: id }, JOBS, await scopeFor(user)] });
  if (!root) throw ApiError.notFound('Job not found');
  if (!mayNameBuyer(user, root)) throw ApiError.forbidden('Whoever gave the job, or Admin, names its buyer');
  if (root.customer) throw ApiError.conflict('This job already has its buyer');
  /* The buyer's register: a marketing person names their own, Admin any. */
  if (root.jobLinked?.enquiry) throw ApiError.conflict('This job follows its enquiry now — its buyer is the enquiry’s');
  const waiting = Boolean(root.buyerWantedAt);
  if (noBuyer === true) {
    /* No buyer — stock, a fair: said on the job, and the goods go on to Dispatch as they are. */
    if (!waiting) throw ApiError.badRequest('Nothing waits for a buyer on this job');
    const said = `No buyer — sent as it is, said by ${user.name}`;
    root.buyerWantedAt = undefined;
    root.buyerWaivedAt = new Date();
    root.updates = [...(root.updates || []), { kind: 'note', text: said, note: said, by: user._id, at: new Date() }];
    await root.save();
    const { resolveTasks } = await import('./task.service.js');
    await resolveTasks(`job-buyer:${root._id}`);
    await advanceHeld(root, user, said);
    return teamJob(user, id);
  }
  const buyer = /^[0-9a-f]{24}$/i.test(String(customerId || '')) ? await Customer.findById(customerId).select('name assignedTo') : null;
  const { isOwnershipScoped, ownsRecord } = await import('./ownership.service.js');
  if (!buyer || (isOwnershipScoped(user) && !ownsRecord(user, buyer))) throw ApiError.badRequest('Pick a buyer from the register');
  const said = `Buyer named: ${buyer.name} — by ${user.name}`;
  const tasks = await Todo.find({ $or: [{ chain: root._id }, { _id: root._id }] });
  for (const task of tasks) {
    if (task.customer) continue;
    task.customer = buyer._id;
    task.title = String(task.title || '').replace(/ — team task$/, ` — ${buyer.name}`);
    if (String(task._id) === String(root._id)) task.buyerWantedAt = undefined;
    if (!task.completed) task.updates = [...(task.updates || []), { kind: 'note', text: said, note: said, by: user._id, at: new Date() }];
    await task.save();
  }
  const { resolveTasks } = await import('./task.service.js');
  await resolveTasks(`job-buyer:${root._id}`);
  if (waiting) await advanceHeld(root, user, `Goods ready — buyer named: ${buyer.name}`);
  return teamJob(user, id);
}

/* The goods were ready and held for the buyer: Dispatch (or Quality first) is asked now. */
async function advanceHeld(root, user, why) {
  const { advanceJourney, FINISHING_KINDS } = await import('./journey.service.js');
  const finishing = await Todo.find({ $or: [{ chain: root._id }, { _id: root._id }], kind: { $in: FINISHING_KINDS } }).sort({ updatedAt: -1 });
  const from = finishing.find((task) => !task.completed) || finishing[0];
  if (from) await advanceJourney(from, user, why);
}

/**
 * Admin closes a team job where it stands [web: TeamJobDetail "Close job"]: every open task on it
 * closed with the reason, each team told, and the reminders about the job ended. Its record stays.
 */
export async function closeTeamJob(user, id, reason) {
  if (!isManagement(user)) throw ApiError.forbidden('Only Admin closes a team job outright');
  const why = String(reason || '').trim();
  if (why.length < 5) throw ApiError.badRequest('Say why the job is being closed');
  if (!/^[0-9a-f]{24}$/i.test(String(id))) throw ApiError.notFound('Job not found');
  const root = await Todo.findOne({ $and: [{ _id: id }, JOBS] });
  if (!root) throw ApiError.notFound('Job not found');
  const open = root.jobLinked?.enquiry
    ? (root.completed ? [] : [root])
    : await Todo.find({ $or: [{ chain: root._id }, { _id: root._id }], completed: false });
  if (!open.length) throw ApiError.conflict('Nothing is open on this job');
  const { closeByAdmin } = await import('./handoff.service.js');
  for (const task of open) await closeByAdmin(task, user, { reason: why });
  const { resolveTasks } = await import('./task.service.js');
  const { askKeyFor } = await import('./eddAsk.service.js');
  await resolveTasks(`job-buyer:${root._id}`);
  await resolveTasks(askKeyFor({ chain: root._id }));
  return teamJob(user, id);
}
