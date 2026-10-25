import Todo from '../models/Todo.js';
import { capWords, modelsOf } from '../services/productionSummary.service.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { findHandoff } from '../config/handoffs.js';
import { canRead } from '../services/access.service.js';
import { ownsRecord } from '../services/ownership.service.js';
import { bandOf, readsWholeQueue } from './productionQueue.controller.js';
import { deliveryRiskFor } from '../services/deliveryRisk.service.js';
import { RISK_LEVELS, riskOfFinishing } from '../services/eddRisk.service.js';
import { ticked as qcTicked } from '../services/qcGate.service.js';
import { dispatchPlanOf } from '../utils/dispatchPlan.js';

/**
 * Printing's and Assembly's queues, in the order the goods are due [web: components/
 * FinishingQueueList.jsx] — the production queue's next legs. One row per open Printing or
 * Assembly task, banded by the date the team works to: its own EDD or hand-over date where it
 * has given one, the enquiry's EDD until then, the undated last.
 *
 * Beside each row, the goods: which team they come from (Production, or Printing before
 * Assembly), the day that team said it hands over [Todo `routing.incoming`], and the day each
 * model actually came [`routing.receivedModels`, written by handoff.service `handOn`]. So the
 * desk opens on what is in hand to work and what is still on the press — and a model not yet
 * come is never mistaken for one waiting on this team.
 *
 * Each model's goods stand at one of three: still to come, received (Goods Received — the team
 * puts them in its work queue from here [handoff.service `addToWorkQueue`]), or in the work queue.
 * The row's `goods.stage` is the earliest of its models that has come: received while any model
 * waits to be taken on.
 *
 * Read by whoever reads the production queue; nothing is changed here. The row opens the task
 * (statuses, the date) or the enquiry's Production workflow page.
 */

const TEAMS = {
  printing: { kind: 'ask_printing', label: 'Printing', word: 'print' },
  assembling: { kind: 'ask_assembling_edd', label: 'Assembly', word: 'assemble' },
};
const READERS = ['production', 'dispatch', 'quality', 'orders', 'enquiries'];
const FROM_LABEL = { production: 'Production', printing: 'Printing' };
const BAND_RANK = { late: 0, today: 1, week: 2, later: 3, none: 4 };

const indiaDay = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
const person = (user) => (user && typeof user === 'object' ? { _id: user._id, name: user.name } : null);
const statusesOf = (kind) => findHandoff(kind)?.form?.statuses || [];
const stepOf = (kind, key) => statusesOf(kind).find((entry) => entry.key === key) || null;
const rankOf = (kind, key) => statusesOf(kind).findIndex((entry) => entry.key === key);
const latestOf = (task) => {
  const last = (task.updates || []).at(-1);
  return last ? { note: last.note || last.text || null, at: last.at, by: person(last.by) } : null;
};
const prettyDay = (day) => {
  const date = new Date(`${day}T00:00:00Z`);
  return `${date.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getUTCMonth()]}`;
};

/** A team's status for one model — its own where models move apart, else the task's. */
function statusFor(task, model) {
  if (!task) return null;
  const key = (task.modelStatuses || []).find((row) => row.model === model)?.status || task.status || null;
  const step = stepOf(task.kind, key);
  return {
    key, label: task.completed ? (step && !step.done ? step.label : 'Done') : step?.label || 'Asked',
    issue: !task.completed && Boolean(step?.issue), done: Boolean(task.completed),
    handed: Boolean(step?.handsTo), ready: Boolean(step?.readyForDispatch || step?.done),
  };
}

/** The date this team gave for one model [Todo `modelDates`] — its own, or the one for all. */
const givenFor = (task, model) => {
  const rows = task.modelDates || [];
  return (rows.find((row) => row.model === model) || rows.find((row) => row.model === 'All models'))?.date || null;
};

/**
 * The row's models, each with where the goods are and where this team has got to. Which team a
 * model comes from is Production's routing: printed first, it reaches Assembly from Printing.
 */
function modelRowsFor(team, task, production, printing, enquiry) {
  const routes = new Map((production?.routing?.models || []).filter((row) => row?.model).map((row) => [row.model, row]));
  const eddOf = new Map((enquiry?.eddByModel || []).map((row) => [row.model, row]));
  const incoming = task.routing?.incoming || {};
  const received = task.routing?.receivedModels || {};
  return modelsOf(task, enquiry || {}).map((model) => {
    const route = routes.get(model) || null;
    const from = team === 'assembling' && route?.printing ? 'printing' : 'production';
    const before = from === 'printing' ? statusFor(printing, model) : statusFor(production, model);
    const next = team === 'printing' && route?.assembly ? 'assembling' : null;
    const own = statusFor(task, model);
    const came = received[model] || null;
    /* In the work queue: taken on by this team [handoff.service `addToWorkQueue`], or already further on. */
    const queuedOn = task.routing?.queuedModels?.[model] || null;
    const queued = Boolean(queuedOn) || rankOf(task.kind, own?.key) >= rankOf(task.kind, 'in_queue');
    return {
      model,
      from, fromLabel: FROM_LABEL[from], before,
      expected: incoming[from] || null, received: came,
      /* Where the goods stand here: still to come, received (to put in the work queue), in the work queue. */
      queued: Boolean(came) && queued, queuedOn,
      goods: !came ? 'to_come' : queued ? 'in_queue' : 'received',
      status: own,
      /* The date this team gave: its hand-over day where the model goes on, its completion date where it is last. */
      given: givenFor(task, model), givenLabel: next ? 'Hand-over' : 'Completion', next,
      handed: Boolean(next) && Boolean(own?.handed),
      /* Marketing's EDD for the model: set for it, else the enquiry's. */
      edd: eddOf.get(model)?.final?.date || enquiry?.edd?.date || null,
    };
  });
}

/** The row in at most thirty words: the goods first, then each model's state, then what follows. */
function summariseRow(team, row) {
  const parts = [];
  const waiting = row.models.filter((entry) => !entry.received);
  const inHand = row.models.filter((entry) => entry.received);
  if (row.task.issue) parts.push(`${row.task.statusLabel}`);
  if (waiting.length) {
    const byFrom = new Map();
    for (const entry of waiting) byFrom.set(entry.from, [...(byFrom.get(entry.from) || []), entry]);
    for (const [from, entries] of byFrom) {
      const soonest = entries.map((entry) => entry.expected).filter(Boolean).sort()[0];
      parts.push(`${entries.map((entry) => entry.model).join(', ')} still with ${FROM_LABEL[from]}${soonest ? `, due ${prettyDay(soonest)}` : ''}${entries[0].before?.label ? ` (${entries[0].before.label})` : ''}`);
    }
  }
  if (inHand.length) {
    const byStatus = new Map();
    for (const entry of inHand) byStatus.set(entry.status?.label || 'In hand', [...(byStatus.get(entry.status?.label || 'In hand') || []), entry.model]);
    parts.push([...byStatus].map(([label, models]) => `${models.join(', ')}: ${label}`).join(' · '));
  }
  const onward = row.models.filter((entry) => entry.next && !entry.handed);
  if (onward.length) parts.push(`${onward.map((entry) => entry.model).join(', ')} go${onward.length > 1 ? '' : 'es'} on to Assembly`);
  if (!row.edd?.own) parts.push(team === 'printing' && onward.length ? 'No hand-over date yet' : 'No completion date yet');
  return capWords(parts.filter(Boolean).join('. '), 30);
}

export const listFinishingQueue = asyncHandler(async (req, res) => {
  const team = TEAMS[req.params.team];
  if (!team) throw ApiError.badRequest('The queue is Printing’s or Assembly’s');
  if (!READERS.some((moduleKey) => canRead(req.user, moduleKey))) {
    throw ApiError.forbidden('The queue is read by the plant’s departments and marketing');
  }
  const now = new Date();
  const tasks = await Todo.find({ kind: team.kind, completed: false })
    .populate([
      {
        path: 'enquiry',
        select: 'number stage status customer assignedTo edd eddByModel qcRequired dispatchPlan requirement.modelNumber requirement.colour requirement.quantity items.modelNumber items.mould',
        populate: [{ path: 'customer', select: 'code name assignedTo' }, { path: 'assignedTo', select: 'name' }],
      },
      { path: 'user', select: 'name' },
      { path: 'createdBy', select: 'name department' },
      { path: 'customer', select: 'code name assignedTo' },
      { path: 'order', select: 'number status' },
      { path: 'updates.by', select: 'name' },
    ])
    .lean();

  /* Marketing reads its own buyers' rows; whoever works to the queue reads the whole of it. */
  const mayRead = (task) => readsWholeQueue(req.user)
    || (task.enquiry ? ownsRecord(req.user, task.enquiry)
      : String(task.createdBy?._id || task.createdBy) === String(req.user._id) || (task.customer && ownsRecord(req.user, task.customer)));
  const mine = tasks.filter(mayRead);

  /* The job's other teams: Production (the routing, where the goods are) and Printing before Assembly. */
  const enquiryIds = mine.filter((task) => task.enquiry).map((task) => task.enquiry._id);
  const chainIds = mine.filter((task) => !task.enquiry).map((task) => task.chain || task._id);
  const kinds = ['ask_edd', 'quality_check', ...(req.params.team === 'assembling' ? ['ask_printing'] : [])];
  const others = (enquiryIds.length || chainIds.length)
    ? await Todo.find({
      kind: { $in: kinds },
      $or: [
        ...(enquiryIds.length ? [{ enquiry: { $in: enquiryIds } }] : []),
        ...(chainIds.length ? [{ chain: { $in: chainIds } }, { _id: { $in: chainIds } }] : []),
      ],
    }).select('enquiry chain kind status completed completedAt modelStatuses routing brief updatedAt createdAt').sort({ createdAt: -1 }).lean()
    : [];
  const jobKeyOf = (task) => (task.enquiry ? `e:${String(task.enquiry._id || task.enquiry)}` : `c:${String(task.chain || task._id)}`);
  const siblings = new Map();
  for (const other of others) {
    const key = other.enquiry ? `e:${String(other.enquiry)}` : `c:${String(other.chain || other._id)}`;
    const slot = siblings.get(key) || {};
    const held = slot[other.kind];
    /* The open task, else the newest. */
    if (!held || (held.completed && !other.completed)) slot[other.kind] = other;
    siblings.set(key, slot);
  }

  const rows = mine.map((task) => {
    const enquiry = task.enquiry || null;
    const slot = siblings.get(jobKeyOf(task)) || {};
    const production = slot.ask_edd || null;
    const models = modelRowsFor(req.params.team, task, production, slot.ask_printing || null, enquiry);
    const own = (task.modelDates || []).map((entry) => entry.date).filter(Boolean).sort().at(-1) || null;
    /* Marketing's EDD: the enquiry's, or on a job raised from the customer, the job's [eddAsk.service]. */
    const enquiryEdd = enquiry?.edd?.date || task.jobEdd?.date || null;
    const handsOn = models.some((entry) => entry.next);
    /* The queue runs by marketing's EDD, as Production's does; a team task with none goes by the team's own date. */
    const date = enquiryEdd || own;
    const expected = models.filter((entry) => !entry.received).map((entry) => entry.expected).filter(Boolean).sort()[0] || null;
    const received = models.filter((entry) => entry.received).length;
    const toQueue = models.filter((entry) => entry.goods === 'received').map((entry) => entry.model);
    const inQueue = models.filter((entry) => entry.goods === 'in_queue').length;
    const step = stepOf(task.kind, task.status);
    const row = {
      link: production ? `/production/workflow/${production._id}` : null,
      task: {
        _id: task._id, kind: task.kind, department: task.department, status: task.status || null, statusLabel: step?.label || 'Asked', issue: Boolean(step?.issue),
        ready: Boolean(step?.readyForDispatch || step?.done), user: person(task.user), with: person(task.user),
        dueDate: task.dueDate || null, late: Boolean(task.dueDate && task.dueDate < now), priority: task.priority || 'normal',
        brief: task.brief || {}, createdAt: task.createdAt, updatedAt: task.updatedAt, raisedBy: person(task.createdBy), latest: latestOf(task),
        modelStatuses: task.modelStatuses || [], modelDates: task.modelDates || [], routing: task.routing || null, customer: task.customer || null,
        attention: task.attention ? { kind: task.attention.kind, note: task.attention.note, at: task.attention.at } : null,
        /*
         * What the task panel opened from the row shows [web: components/TaskPanel.jsx]: the enquiry
         * it is for, who asked, what was asked and everything said on it since — without them the
         * panel read a task on an enquiry as a team task with no history.
         */
        title: task.title, notes: task.notes || null, fromDepartment: task.fromDepartment || null, completed: Boolean(task.completed),
        /* Marketing's EDD and each model's dates travel with it, so the task panel reads them [web: components/TaskEdd.jsx]. */
        enquiry: enquiry ? { _id: enquiry._id, number: enquiry.number, dispatchPlan: dispatchPlanOf(enquiry), edd: enquiry.edd || null, eddByModel: enquiry.eddByModel || [] } : null,
        createdBy: person(task.createdBy), order: task.order ? { _id: task.order._id, number: task.order.number } : null,
        updates: task.updates || [], statusHistory: task.statusHistory || [],
      },
      enquiry: enquiry ? {
        _id: enquiry._id, number: enquiry.number, stage: enquiry.stage, team: false,
        model: enquiry.requirement?.modelNumber || (enquiry.items || []).find((item) => item.modelNumber)?.modelNumber || task.brief?.model || null,
        colour: enquiry.requirement?.colour || task.brief?.material || null,
        quantity: task.brief?.quantity || enquiry.requirement?.quantity || null,
        customer: enquiry.customer ? { _id: enquiry.customer._id, name: enquiry.customer.name, code: enquiry.customer.code } : null,
        owner: person(enquiry.assignedTo),
        edd: enquiry.edd?.date ? { date: enquiry.edd.date, department: enquiry.edd.department || null } : null,
      } : {
        _id: null, number: null, stage: null, team: true, model: task.brief?.model || null, colour: task.brief?.material || null, quantity: task.brief?.quantity || null,
        customer: task.customer && typeof task.customer === 'object' ? { _id: task.customer._id, name: task.customer.name, code: task.customer.code } : null,
        owner: person(task.createdBy), edd: null,
      },
      order: task.order ? { _id: task.order._id, number: task.order.number, status: task.order.status } : null,
      models,
      /* The date the row is queued by, and where it came from. */
      /* `own`: the team's own date — its hand-over day where models go on, else its completion date — shown beside the EDD. */
      edd: date ? {
        date, source: enquiryEdd ? 'enquiry' : 'team', label: enquiryEdd ? 'EDD' : handsOn ? 'Hand-over' : 'Completion',
        own, ownLabel: own ? (handsOn ? 'Hand-over' : 'Completion') : null, enquiry: enquiryEdd,
      } : null,
      band: bandOf(date, now),
      /* Red, orange, yellow, green against the date the team works to [eddRisk.service `riskOfFinishing`]. */
      risk: riskOfFinishing({ edd: date, waiting: models.length - received, expected, ready: Boolean(step?.readyForDispatch || step?.done || step?.handsTo), now }),
      /* QC compulsory before dispatch, and whether Quality has passed it [qcGate.service]. */
      qc: { required: Boolean(enquiry?.qcRequired) || qcTicked(production?.brief?.qcRequired), cleared: Boolean(slot.quality_check?.completed && !stepOf('quality_check', slot.quality_check.status)?.issue) },
      /* The goods: from whom, when they are due, how many models have come. */
      goods: {
        from: [...new Set(models.map((entry) => entry.from))], expected, received, total: models.length,
        inHand: received > 0, all: models.length > 0 && received === models.length,
        /* Came and not yet taken on — the desk's "Goods received", with Add to work queue — and taken on. */
        toQueue, queued: inQueue,
        stage: toQueue.length ? 'received' : inQueue ? 'in_queue' : received ? 'in_queue' : 'to_come',
      },
      handsOn, next: handsOn ? 'assembling' : null,
      production: production ? { _id: production._id, status: production.status || null, statusLabel: stepOf('ask_edd', production.status)?.label || null, completed: Boolean(production.completed) } : null,
    };
    row.summary = summariseRow(req.params.team, row);
    return row;
  });
  /* Each model's own journey — Production, Printing / Assembly as routed, Quality, Dispatch [handoff.service `modelJourneys`]. */
  const { modelJourneys } = await import('../services/handoff.service.js');
  await Promise.all(rows.map(async (row, at) => {
    const own = mine[at];
    const enquiryId = row.enquiry?.team ? null : row.enquiry?._id || null;
    row.journeys = await modelJourneys(enquiryId, { task: { _id: own._id, chain: own.chain } }).catch(() => []);
  }));
  /* Will each order make marketing's EDD, all its models and teams counted [deliveryRisk.service]. */
  const deliveries = await deliveryRiskFor(rows.map((row) => row.enquiry?._id));
  for (const row of rows) row.delivery = (row.enquiry?._id && deliveries.get(String(row.enquiry._id))) || null;
  rows.sort((a, b) => (BAND_RANK[a.band] - BAND_RANK[b.band])
    || String(a.edd?.date || '').localeCompare(String(b.edd?.date || ''))
    || (new Date(a.task.dueDate || 0) - new Date(b.task.dueDate || 0)));

  const count = (test) => rows.filter(test).length;
  res.json({
    success: true,
    data: rows,
    meta: {
      team: req.params.team, label: team.label, asOf: now, day: indiaDay(now),
      bands: Object.fromEntries(Object.keys(BAND_RANK).map((band) => [band, count((row) => row.band === band)])),
      risk: Object.fromEntries(RISK_LEVELS.map((level) => [level, count((row) => row.risk?.level === level)])),
      goods: {
        waiting: count((row) => !row.goods.inHand),
        inHand: count((row) => row.goods.inHand),
        received: count((row) => row.goods.stage === 'received'),
        inQueue: count((row) => row.goods.stage === 'in_queue'),
        toCome: count((row) => row.goods.stage === 'to_come'),
        dueToday: count((row) => !row.goods.all && row.goods.expected === indiaDay(now)),
        overdue: count((row) => !row.goods.all && row.goods.expected && row.goods.expected < indiaDay(now)),
      },
      issues: count((row) => row.task.issue),
      noDate: count((row) => !row.edd?.own),
      handsOn: count((row) => row.handsOn),
      ready: count((row) => row.task.ready),
    },
  });
});
