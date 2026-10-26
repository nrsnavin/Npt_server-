import Todo from '../models/Todo.js';
import Enquiry from '../models/Enquiry.js';
import ApiError from '../utils/ApiError.js';
import { findHandoff } from '../config/handoffs.js';

/**
 * A Production task Admin or marketing raised with no enquiry behind it — often only the buyer's
 * name, "what is the status?" The Production in charge reads the order and starts the task from
 * where the goods really are, model by model, rather than from the beginning:
 *
 *   link        the buyer has an open enquiry for it: the task joins that enquiry and follows its
 *               workflow (quantities, dispatch, payments) — or, when the enquiry already has a
 *               Production task, this one is closed onto it and the asker told
 *   details     the hanger details, filled on the task when they came without [handoff.service]
 *   start from  each model's place now —
 *                 not_started      he plans it (accept, plan, give the date), as any job
 *                 started          Production Started
 *                 handed_printing  with Printing since a date: Printing's task is raised from it
 *                 handed_assembly  with Assembly since a date (printing, if any, already done)
 *                 ready_dispatch   made and with Dispatch: the Dispatch request is raised
 *                 dispatched       already gone (date, pieces): recorded as a load, so nothing
 *                                  waits for it or sends it again
 *
 * The steps before a model's start point are taken as done: a model already with Assembly is not
 * routed through Printing again, a model ready for dispatch is not sent to either.
 */

export const START_POINTS = [
  { key: 'not_started', label: 'Not started yet' },
  { key: 'started', label: 'Production started' },
  { key: 'handed_printing', label: 'Already handed to Printing', dated: true },
  { key: 'handed_assembly', label: 'Already handed to Assembly', dated: true },
  { key: 'ready_dispatch', label: 'Ready — with Dispatch' },
  { key: 'dispatched', label: 'Already dispatched', dated: true, pieces: true },
];

const fail = (message) => { throw ApiError.badRequest(message); };
/* A Production task not yet under way: received, accepted, being planned. */
const BEFORE_START = ['received', 'accepted', 'planning'];
/* The teams after Production: a task of theirs on the job means the goods have moved on. */
const AFTER_PRODUCTION = ['ask_printing', 'ask_assembling_edd', 'invoice_dispatch', 'quality_check', 'lr_copy'];
const idOf = (value) => String(value?._id || value || '');
const indiaDay = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
const prettyDay = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/* A model's pieces on the task — its row's, else the task's one quantity when it has one model. 0 when unknown. */
function quantityOf(task, model) {
  const key = (value) => String(value || '').trim().toLowerCase();
  const row = (Array.isArray(task.brief?.items) ? task.brief.items : []).find((item) => key(item.model) === key(model));
  const count = (value) => Number(String(value ?? '').replace(/[^\d]/g, '')) || 0;
  if (row && count(row.quantity)) return count(row.quantity);
  /* One model on the task: the task's own pieces are its. */
  const items = Array.isArray(task.brief?.items) ? task.brief.items : [];
  return items.length <= 1 && handoffModels(task).length <= 1 ? count(task.brief?.quantity) : 0;
}

const handoffModels = (task) => [...new Set([task.brief?.model, ...String(task.brief?.models || '').split(',')].map((model) => String(model || '').trim()).filter(Boolean))];

function assertTeamProduction(task) {
  if (task.kind !== 'ask_edd') fail('Only a Production task starts from where the goods are');
  if (task.completed) throw ApiError.conflict('That task is already finished');
}

/** The buyer's open enquiries this task could join, each with its open SO and whether Production already has it. */
export async function linkOptions(task) {
  assertTeamProduction(task);
  if (task.enquiry) return { linked: true, enquiries: [] };
  const customer = idOf(task.customer);
  if (!customer) return { linked: false, enquiries: [] };
  const { default: SalesOrder } = await import('../models/SalesOrder.js');
  const rows = await Enquiry.find({ customer, status: { $ne: 'lost' }, stage: { $ne: 'closed' } })
    .select('number stage requirement.modelNumber items.modelNumber createdAt').sort({ createdAt: -1 }).limit(20).lean();
  const out = [];
  for (const row of rows) {
    const order = await SalesOrder.findOne({ enquiry: row._id, status: { $nin: ['cancelled', 'closed'] } }).sort({ createdAt: -1 }).select('number lines.modelNumber lines.quantity').lean();
    const production = await Todo.findOne({ enquiry: row._id, kind: 'ask_edd', completed: false }).select('title status').lean();
    out.push({
      _id: row._id, number: row.number, stage: row.stage, at: row.createdAt,
      models: [...new Set([...(row.items || []).map((item) => item.modelNumber), row.requirement?.modelNumber].filter(Boolean))],
      order: order ? { _id: order._id, number: order.number, lines: (order.lines || []).map((line) => ({ model: line.modelNumber, quantity: line.quantity })) } : null,
      inProduction: production ? { _id: production._id, title: production.title } : null,
    });
  }
  return { linked: false, enquiries: out };
}

/**
 * The task joins the buyer's enquiry: it follows that enquiry from now on — its order's lines are
 * its models and pieces. Only before it has started (nothing raised from it yet). An enquiry
 * already with Production: this request is the same order, so it is closed onto that task.
 */
export async function linkToEnquiry(task, user, enquiryId) {
  assertTeamProduction(task);
  if (task.enquiry) fail('This task is already on an enquiry');
  const enquiry = await Enquiry.findById(enquiryId);
  if (!enquiry) throw ApiError.notFound('Enquiry not found');
  if (idOf(enquiry.customer) !== idOf(task.customer)) fail(`${enquiry.number} is another buyer's — link the task to this buyer's enquiry`);
  if (await Todo.exists({ chain: task._id, kind: { $in: AFTER_PRODUCTION } })) fail('Link it before starting — Printing, Assembly or Dispatch already have tasks from this one');
  const handoff = await import('./handoff.service.js');
  const existing = await Todo.findOne({ enquiry: enquiry._id, kind: 'ask_edd', completed: false });
  if (existing) {
    const note = `Same order as ${enquiry.number} — Production follows it on ${existing.title}`;
    const done = await handoff.completeHandoff(task, user, { note, system: true });
    await Todo.updateOne({ _id: existing._id }, { $push: { updates: { kind: 'note', text: `${user.name} linked a status request for this buyer to this task`, note: `Linked: a status request (${task.title})`, by: user._id, at: new Date() } } }, { keepVersion: true });
    return { task: done, mergedInto: { _id: existing._id, title: existing.title }, enquiry: { _id: enquiry._id, number: enquiry.number } };
  }
  const { default: SalesOrder } = await import('../models/SalesOrder.js');
  const order = await SalesOrder.findOne({ enquiry: enquiry._id, status: { $nin: ['cancelled', 'closed'] } }).sort({ createdAt: -1 }).select('number lines.modelNumber lines.quantity').lean();
  /* The job stays on its asker's Team jobs, saying which enquiry it joined [teamJobs.service]. */
  if (idOf(task.chain) === idOf(task._id)) task.jobLinked = { enquiry: enquiry._id, number: enquiry.number, at: new Date(), by: user._id };
  task.enquiry = enquiry._id;
  task.chain = undefined;
  if (order) task.order = order._id;
  /* The order's lines are the models and pieces, where the request named none. */
  if (order?.lines?.length && !(task.brief?.items || []).length) {
    task.brief = { ...(task.brief?.toObject?.() ?? task.brief ?? {}), items: order.lines.map((line) => ({ model: line.modelNumber, quantity: String(line.quantity || '') })), model: order.lines[0].modelNumber };
    task.markModified('brief');
  }
  const said = `Linked to ${enquiry.number}${order ? ` (${order.number})` : ''} by ${user.name} — follows that enquiry's workflow from here`;
  task.updates = [...(task.updates || []), { kind: 'note', text: said, note: said, by: user._id, at: new Date() }];
  await task.save();
  /* The enquiry reads Production now, unless it is already further on. */
  const productionStage = findHandoff('ask_edd')?.stage;
  const EARLY = ['enquiry', 'sample', 'pricing_quote', 'po_so'];
  if (productionStage && (!enquiry.stage || EARLY.includes(enquiry.stage))) {
    enquiry.stage = productionStage;
    await enquiry.save().catch(() => null);
  }
  return { task, mergedInto: null, enquiry: { _id: enquiry._id, number: enquiry.number } };
}

/**
 * Starts the task from where each model is now [START_POINTS]. Routing is decided first — the
 * teams still ahead of each model — then each model moves to its place, in the order the goods
 * travel, so a model already dispatched is on record before any model reads ready.
 */
export async function startFrom(task, user, { models = [] } = {}) {
  assertTeamProduction(task);
  const handoff = await import('./handoff.service.js');
  handoff.assertPlansProduction(task, user, 'starts the task from where the goods are');
  /*
   * Once: started from where the goods are, or under way already — a model moved on, a team after
   * Production raised — each model moves on its own task from there. Starting again would route
   * it afresh and say on the job it had not started.
   */
  const moved = (status) => status && !BEFORE_START.includes(status);
  if (task.startedFromAt) throw ApiError.conflict('This task was already started from where the goods are — move each model on from its task');
  if (moved(task.status) || (task.modelStatuses || []).some((row) => moved(row.status))
    || await Todo.exists({ chain: task._id, kind: { $in: AFTER_PRODUCTION } })) {
    throw ApiError.conflict('This task is already under way — move each model on from its task');
  }
  const key = (model) => String(model || '').trim().toLowerCase();
  /*
   * A task with no enquiry: the in charge names the models as he reads the order — each with its
   * pieces — and they become the task's models, beside any already on it. On an enquiry the
   * models are the enquiry's.
   */
  if (!task.enquiry) {
    const named = [];
    for (const row of models) {
      const model = String(row?.model || '').trim().slice(0, 80);
      if (model && !named.some((entry) => key(entry.model) === key(model))) named.push({ model, quantity: String(row.quantity ?? '').replace(/[^\d]/g, '') });
    }
    const items = Array.isArray(task.brief?.items) ? task.brief.items.map((item) => ({ ...(item.toObject?.() ?? item) })) : [];
    for (const row of named) {
      const item = items.find((entry) => key(entry.model) === key(row.model));
      if (item) { if (row.quantity) item.quantity = row.quantity; } else items.push({ model: row.model, ...(row.quantity ? { quantity: row.quantity } : {}) });
    }
    const all = [...new Set([...handoff.modelsOfTask(task), ...items.map((item) => item.model)].filter(Boolean))];
    if (all.length) {
      task.brief = { ...(task.brief?.toObject?.() ?? task.brief ?? {}), model: task.brief?.model || all[0], models: all.join(', '), items: items.length ? items : undefined };
      task.markModified('brief');
      await task.save();
    }
  }
  const known = handoff.modelsOfTask(task);
  if (!known.length) fail('Name the models first — model, pieces, material, hook, clip, print — then say where each model is');
  const today = indiaDay(new Date());
  const rows = [];
  for (const model of known) {
    const given = models.find((row) => key(row?.model) === key(model)) || {};
    const at = given.at || 'not_started';
    const point = START_POINTS.find((entry) => entry.key === at);
    if (!point) fail(`Say where ${model} is: ${START_POINTS.map((entry) => entry.label).join(', ')}`);
    const printing = given.printing === true;
    const assembly = given.assembly === true;
    if (at === 'handed_printing' && !printing) fail(`${model} is with Printing — tick Printing for it`);
    if (at === 'handed_assembly' && !assembly) fail(`${model} is with Assembly — tick Assembly for it`);
    const date = String(given.date || '').trim();
    if (point.dated) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`Give the date ${model} was ${at === 'dispatched' ? 'dispatched' : 'handed over'}`);
      if (date > today) fail(`${model}: the date it was ${at === 'dispatched' ? 'dispatched' : 'handed over'} cannot be in the future`);
    }
    const pieces = Number(String(given.pieces ?? '').replace(/,/g, ''));
    if (point.pieces && !(pieces > 0)) fail(`Give the pieces of ${model} already dispatched`);
    /* Never more gone than the model's pieces, where the task knows them. */
    const ordered = quantityOf(task, model);
    if (point.pieces && ordered && pieces > ordered) {
      fail(`${model}: ${pieces.toLocaleString('en-IN')} pcs is more than its ${ordered.toLocaleString('en-IN')} pcs — give what was dispatched, or correct the model's pieces first`);
    }
    /* The teams still ahead of it: what it has passed through is done. */
    const route = at === 'ready_dispatch' || at === 'dispatched' ? { printing: false, assembly: false }
      : at === 'handed_assembly' ? { printing: false, assembly: true }
        : { printing, assembly };
    rows.push({ model, at, point, date, pieces, route, printing, assembly });
  }

  await handoff.decideRouting(task, user, { models: rows.map((row) => ({ model: row.model, ...row.route })) });
  const fresh = async () => Todo.findById(task._id);
  const several = known.length > 1;
  const move = async (status, group, note) => {
    if (!group.length) return;
    const current = await fresh();
    await handoff.setTaskStatus(current, user, { status, note, ...(several ? { models: group.map((row) => row.model) } : {}) });
  };
  const of = (at) => rows.filter((row) => row.at === at);
  const words = (row) => `${row.model}: ${row.point.label.toLowerCase()}${row.date ? ` on ${prettyDay(row.date)}` : ''}${row.pieces ? ` (${row.pieces.toLocaleString('en-IN')} pcs)` : ''}`;

  await move('started', of('started'), `Already in production — recorded by ${user.name}`);
  await move('handed_printing', of('handed_printing'), of('handed_printing').map((row) => `Already handed to Printing on ${prettyDay(row.date)} — recorded by ${user.name}`).join('; '));
  await move('handed_assembly', of('handed_assembly'), of('handed_assembly').map((row) => `Already handed to Assembly on ${prettyDay(row.date)}${row.printing ? ' (printing done)' : ''} — recorded by ${user.name}`).join('; '));
  if (of('dispatched').length) {
    await recordPastDispatch(await fresh(), user, of('dispatched'));
    await move('ready_dispatch', of('dispatched'), of('dispatched').map((row) => `Already dispatched on ${prettyDay(row.date)} (${row.pieces.toLocaleString('en-IN')} pcs) — recorded by ${user.name}`).join('; '));
  }
  await move('ready_dispatch', of('ready_dispatch'), `Made and with Dispatch — recorded by ${user.name}`);

  /* Floor planning: a model already past the presses is not left planned on one [floorPlanning.service]. */
  const past = rows.filter((row) => ['handed_printing', 'handed_assembly', 'ready_dispatch', 'dispatched'].includes(row.at));
  if (past.length) {
    const { default: WorkOrder } = await import('../models/WorkOrder.js');
    for (const row of past) {
      await WorkOrder.updateMany(
        { task: task._id, model: new RegExp(`^${row.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), status: { $in: ['planned', 'released', 'paused'] } },
        { $set: { status: 'completed' }, $push: { history: { status: 'completed', note: `Moulded before the app knew — ${words(row)}`, by: user._id, at: new Date() } } },
      );
    }
  }
  const done = await fresh();
  const said = `Started from where the goods are — ${rows.map(words).join(' · ')}`;
  done.updates = [...(done.updates || []), { kind: 'note', text: said, note: said, by: user._id, at: new Date() }];
  done.startedFromAt = new Date();
  await done.save();
  return done;
}

/**
 * Goods that left before the task: one Dispatch request, already finished, carrying a load of each
 * model and its pieces on the day it went — so the job's dispatch counts it, its shipments list
 * it, and no request is raised to send it again.
 */
async function recordPastDispatch(task, user, rows) {
  const { chainOf } = await import('./journey.service.js');
  const byDay = new Map();
  for (const row of rows) {
    if (!byDay.has(row.date)) byDay.set(row.date, []);
    byDay.get(row.date).push({ model: row.model, quantity: row.pieces });
  }
  const now = new Date();
  return Todo.create({
    kind: 'invoice_dispatch', department: 'despatch', fromDepartment: 'production',
    title: `Dispatched before — recorded by Production (${user.name})`,
    customer: task.customer || undefined, enquiry: task.enquiry || undefined, order: task.order || undefined,
    chain: chainOf(task), createdBy: user._id, user: user._id,
    status: 'dispatched', completed: true, completedAt: now, completedBy: user._id,
    loads: [...byDay].map(([day, lines]) => ({
      status: 'dispatched', lines, note: `Already dispatched on ${prettyDay(day)} — recorded by Production (${user.name})`, by: user._id, at: new Date(`${day}T12:00:00+05:30`),
    })),
    updates: [{ kind: 'note', note: `Recorded by Production: ${rows.map((row) => `${row.model} ${row.pieces.toLocaleString('en-IN')} pcs on ${prettyDay(row.date)}`).join(' · ')}`, by: user._id, at: now }],
    dueDate: now,
  });
}

