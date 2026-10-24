import Todo from '../models/Todo.js';
import Enquiry from '../models/Enquiry.js';
import { findHandoff } from '../config/handoffs.js';

/**
 * Will the order make its EDD? A reading for every open enquiry and its tasks, against
 * marketing's EDD [Enquiry `edd`], from what is still to do and how long the plant takes to do it.
 *
 * What is still to do, model by model: each team on the model's route (Production, then Printing
 * and/or Assembly, as Production routed it) that is not through with it yet, a team part-way
 * through counted for what it has left [statusProgress]; then Quality where QC is compulsory, and
 * Dispatch.
 *
 * How long a team takes — the model [stageModel]: days = base + perModel × (models − 1), learned
 * from the plant's own finished tasks of the last year (a least-squares line through how many days
 * each took against how many models it had), the defaults below until there are enough of them.
 * An order of several models therefore needs more days at every team, and is flagged earlier.
 * The stages are added end to end, the conservative reading: a warning that comes a little early
 * costs a phone call; one that comes late costs the buyer.
 *
 * The readings, worst first:
 *   late       red     the EDD has passed and the goods have not gone
 *   will_miss  red     a team's own date — a completion date, or a hand-over date — is after the EDD
 *   at_risk    orange  the days still needed run past the EDD
 *   watch      yellow  inside the warning window: the days needed plus a margin that grows with
 *                      them (half as much again, two days at least) reach the EDD — several models
 *                      enter it well before one model would
 *   on_track   green   the rest
 *   none               no EDD to read against, or everything has gone
 *
 * `assess` is pure — the figures in, the reading out — so it is tested without a database.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const DELIVERY_LEVELS = ['late', 'will_miss', 'at_risk', 'watch', 'on_track'];

/** The teams in the order the goods pass them. */
export const STAGES = ['production', 'printing', 'assembling', 'quality', 'despatch'];
const STAGE_WORDS = { production: 'Production', printing: 'Printing', assembling: 'Assembly', quality: 'Quality', despatch: 'Dispatch' };
/** Working days to calendar days: one weekly off in seven. */
const CALENDAR = 7 / 6;

/**
 * Until the plant's own history says otherwise: working days for one model at each team, and the
 * days each further model adds. Moulding is the long pole; finishing, checking and loading less.
 */
export const DEFAULT_STAGE_DAYS = Object.freeze({
  production: { base: 4, perModel: 1.5 },
  printing: { base: 2, perModel: 1 },
  assembling: { base: 2, perModel: 1 },
  quality: { base: 1, perModel: 0.5 },
  despatch: { base: 1, perModel: 0.25 },
});
const KIND_OF_STAGE = { production: 'ask_edd', printing: 'ask_printing', assembling: 'ask_assembling_edd', quality: 'quality_check', despatch: 'invoice_dispatch' };
const STAGE_OF_KIND = Object.fromEntries(Object.entries(KIND_OF_STAGE).map(([stage, kind]) => [kind, stage]));
/** Fewer finished tasks than this and the defaults stand. */
const MIN_SAMPLES = 8;

const indiaDay = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
const daysBetween = (fromDay, toDay) => Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS);
const addDays = (day, n) => indiaDay(new Date(Date.parse(`${day}T12:00:00+05:30`) + n * DAY_MS));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const prettyDay = (day) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' }).format(new Date(`${day}T00:00:00.000+05:30`));
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** Working days a team needs for `n` models, by the stage model. */
export function stageDays(stage, n, model = DEFAULT_STAGE_DAYS) {
  if (n <= 0) return 0;
  const { base, perModel } = model[stage] || DEFAULT_STAGE_DAYS[stage] || { base: 1, perModel: 0.5 };
  return base + perModel * (n - 1);
}

/**
 * A least-squares line through finished tasks — days taken against models on the task — for
 * one team: `{ base, perModel, samples }`. Too few tasks, or all of one size, and the slope is
 * the default's, the base what the tasks say once that is taken off.
 */
export function fitStage(samples, fallback) {
  const rows = samples.filter((row) => Number.isFinite(row.days) && row.days >= 0 && row.models >= 1);
  if (rows.length < MIN_SAMPLES) return { ...fallback, samples: rows.length, learned: false };
  const xs = rows.map((row) => row.models - 1);
  const ys = rows.map((row) => row.days);
  const mean = (list) => list.reduce((sum, value) => sum + value, 0) / list.length;
  const mx = mean(xs);
  const my = mean(ys);
  const sxx = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  const slope = sxx > 0 ? xs.reduce((sum, x, at) => sum + (x - mx) * (ys[at] - my), 0) / sxx : fallback.perModel;
  const perModel = clamp(Number.isFinite(slope) ? slope : fallback.perModel, 0, 5);
  const base = clamp(my - perModel * mx, 0.5, 20);
  return { base: Math.round(base * 10) / 10, perModel: Math.round(perModel * 10) / 10, samples: rows.length, learned: true };
}

let cached = null;
/**
 * The stage model, learned from the plant's finished tasks of the last year [fitStage], kept for
 * six hours. `refresh` reads it again.
 */
export async function stageModel({ now = new Date(), refresh = false } = {}) {
  if (!refresh && cached && now - cached.at < 6 * 60 * 60 * 1000) return cached.model;
  const since = new Date(now.getTime() - 365 * DAY_MS);
  const done = await Todo.find({ kind: { $in: Object.values(KIND_OF_STAGE) }, completed: true, completedAt: { $gte: since }, 'outcome.result': 'done' })
    .select('kind createdAt completedAt brief routing.models').limit(5000).lean();
  const byStage = Object.fromEntries(STAGES.map((stage) => [stage, []]));
  for (const task of done) {
    const stage = STAGE_OF_KIND[task.kind];
    if (!stage || !task.completedAt || !task.createdAt) continue;
    byStage[stage].push({ days: (task.completedAt - task.createdAt) / DAY_MS / CALENDAR, models: Math.max(1, modelsOf(task).length) });
  }
  const model = Object.fromEntries(STAGES.map((stage) => [stage, fitStage(byStage[stage], DEFAULT_STAGE_DAYS[stage])]));
  cached = { at: now, model };
  return model;
}
/** For tests: forget what was learned. */
export const forgetStageModel = () => { cached = null; };

/** The models a task is for: routed, else the brief's list, else its one model. */
function modelsOf(task) {
  const routed = (task?.routing?.models || []).map((row) => (typeof row === 'string' ? row : row?.model)).filter(Boolean);
  if (routed.length) return [...new Set(routed.map((model) => String(model).trim()))];
  const items = (task?.brief?.items || []).map((row) => row?.model).filter(Boolean);
  if (items.length) return [...new Set(items.map((model) => String(model).trim()))];
  const listed = String(task?.brief?.models || '').split(',').map((model) => model.trim()).filter(Boolean);
  if (listed.length) return [...new Set(listed)];
  return task?.brief?.model ? [String(task.brief.model).trim()] : [];
}

/**
 * How far one model has got at one team, 0 to 1: through (handed on, ready for dispatch, done) is
 * 1; otherwise its status's place on the team's ladder up to the step that ends it, at most 0.8 —
 * part-made is never as good as made. Issues count as no progress.
 */
export function statusProgress(kind, status) {
  const statuses = (findHandoff(kind)?.form?.statuses || []).filter((step) => !step.issue);
  const at = statuses.findIndex((step) => step.key === status);
  if (at < 0) return 0;
  const step = statuses[at];
  if (step.done || step.handsTo || step.readyForDispatch) return 1;
  const end = statuses.findIndex((entry) => entry.handsTo || entry.readyForDispatch || entry.done);
  return clamp(at / Math.max(1, end < 0 ? statuses.length : end), 0, 0.8);
}

/**
 * The reading for one order.
 *
 * @param edd     marketing's EDD, YYYY-MM-DD, or null
 * @param models  `[{ model, stages: [{ stage, progress }], dates: [{ department, date, kind }] }]`:
 *                the stages still before each model (progress 0–1 for one under way) and the
 *                dates the teams gave for it
 * @param model   the stage model [stageModel]
 * @param gone    everything has gone (or is no longer this plant's to make)
 */
export function assess({ edd, models = [], model = DEFAULT_STAGE_DAYS, now = new Date(), gone = false }) {
  const today = indiaDay(now);
  const total = models.length;
  const open = models.filter((row) => row.stages.some((stage) => stage.progress < 1));
  const base = { models: total, modelsLeft: open.length };
  if (!edd || gone || !open.length) return { ...base, level: 'none', why: !edd ? null : 'Nothing left to make or send', daysLeft: null, daysNeeded: 0, stages: [] };
  const daysLeft = daysBetween(today, edd);
  /* Each stage: how many models still need it, and how much of that work is left. */
  const stages = STAGES.map((stage) => {
    const rows = open.map((row) => row.stages.find((entry) => entry.stage === stage)).filter((entry) => entry && entry.progress < 1);
    if (!rows.length) return null;
    const left = rows.reduce((sum, entry) => sum + (1 - entry.progress), 0) / rows.length;
    const days = stageDays(stage, rows.length, model) * left * CALENDAR;
    return { stage, label: STAGE_WORDS[stage], models: rows.length, days: Math.round(days * 10) / 10 };
  }).filter(Boolean);
  const daysNeeded = Math.ceil(stages.reduce((sum, stage) => sum + stage.days, 0));
  const finish = addDays(today, daysNeeded);
  /* The warning window grows with the work: several models enter it well before one would. */
  const margin = Math.max(2, Math.ceil(daysNeeded * 0.5));
  const watchFrom = addDays(edd, -(daysNeeded + margin));
  /* The teams' own dates past the EDD: they have said it already. */
  const past = open.flatMap((row) => (row.dates || []).filter((entry) => entry.date && entry.date > edd).map((entry) => ({ ...entry, model: row.model })));
  const reasons = [
    `${plural(open.length, 'model')} of ${total} still to finish`,
    ...stages.map((stage) => `${stage.label}: about ${plural(Math.ceil(stage.days), 'day')} for ${plural(stage.models, 'model')}`),
    ...past.map((entry) => `${STAGE_WORDS[entry.department] || entry.department} ${entry.kind === 'handover' ? 'hands over' : 'completes'} ${entry.model} on ${prettyDay(entry.date)} — after the EDD`),
  ];
  const reading = { ...base, daysLeft, daysNeeded, finish, watchFrom, margin, stages, reasons, edd };
  if (daysLeft < 0) return { ...reading, level: 'late', score: 100, why: `Past the EDD by ${plural(-daysLeft, 'day')} — ${plural(open.length, 'model')} not finished` };
  if (past.length) {
    const worst = past.reduce((best, entry) => (entry.date > best.date ? entry : best), past[0]);
    return { ...reading, level: 'will_miss', score: 90, why: `Will miss the EDD — ${STAGE_WORDS[worst.department] || worst.department} gave ${prettyDay(worst.date)} for ${worst.model}` };
  }
  if (daysNeeded > daysLeft) {
    return { ...reading, level: 'at_risk', score: clamp(Math.round(70 + (daysNeeded - daysLeft) * 3), 70, 89), why: `May miss the EDD — about ${plural(daysNeeded, 'day')} of work for ${plural(open.length, 'model')}, ${plural(daysLeft, 'day')} left` };
  }
  if (daysNeeded + margin >= daysLeft) {
    return { ...reading, level: 'watch', score: clamp(Math.round(40 + ((daysNeeded + margin - daysLeft) / Math.max(1, margin)) * 29), 40, 69), why: `Watch — ${plural(open.length, 'model')} need about ${plural(daysNeeded, 'day')}, ${plural(daysLeft, 'day')} left` };
  }
  return { ...reading, level: 'on_track', score: clamp(Math.round((daysNeeded / Math.max(1, daysLeft)) * 39), 0, 39), why: `On track — about ${plural(daysNeeded, 'day')} of work, ${plural(daysLeft, 'day')} left; watched from ${prettyDay(watchFrom)}` };
}

const idOf = (value) => String(value?._id || value || '');

/**
 * The figures for each enquiry, read from its tasks: for this run of the journey (since its newest
 * Production request), each model's stages still to come and the teams' dates for it. Enquiries
 * with no Production task yet (the order still at the SO) have every model's moulding before them.
 */
async function figuresFor(enquiries) {
  const ids = enquiries.map((row) => row._id);
  const kinds = Object.values(KIND_OF_STAGE);
  const tasks = await Todo.find({ enquiry: { $in: ids }, kind: { $in: kinds } })
    .select('enquiry kind status completed createdAt modelStatuses routing brief outcome.fields updates.kind updates.status updates.fields')
    .sort({ createdAt: -1 }).lean();
  const byEnquiry = new Map();
  for (const task of tasks) {
    const key = idOf(task.enquiry);
    if (!byEnquiry.has(key)) byEnquiry.set(key, []);
    byEnquiry.get(key).push(task);
  }
  return enquiries.map((enquiry) => {
    const all = byEnquiry.get(idOf(enquiry._id)) || [];
    const start = all.find((task) => task.kind === 'ask_edd') || null;
    const mine = start ? all.filter((task) => task.createdAt >= start.createdAt) : [];
    const latest = (kind) => mine.find((task) => task.kind === kind) || null;
    const items = (enquiry.items || []).map((row) => row.modelNumber).filter(Boolean);
    const routes = new Map((start?.routing?.models || []).filter((row) => row?.model).map((row) => [row.model, row]));
    const names = routes.size ? [...routes.keys()] : start ? (modelsOf(start).length ? modelsOf(start) : items) : items.length ? items : [enquiry.requirement?.modelNumber || 'Order'];
    const qcRequired = Boolean(enquiry.qcRequired);
    const dispatch = latest('invoice_dispatch');
    const sentAll = Boolean(dispatch && (dispatch.completed || (dispatch.updates || []).some((line) => line.kind === 'status' && ['dispatched', 'fully_dispatched'].includes(line.status))));
    const sentModels = new Set((dispatch?.updates || []).filter((line) => line.kind === 'status' && line.status === 'part_dispatched')
      .flatMap((line) => String(line.fields?.modelsSent || '').split(',').map((model) => model.trim().toLowerCase()).filter(Boolean)));
    const dates = new Map((enquiry.eddByModel || []).map((row) => [row.model, row.teams || []]));
    const qc = latest('quality_check');
    const models = names.map((model) => {
      const route = routes.get(model);
      const teams = ['production', ...(route?.printing ? ['printing'] : []), ...(route?.assembly ? ['assembling'] : [])];
      const stages = teams.map((stage) => {
        const task = latest(KIND_OF_STAGE[stage]);
        if (!task) return { stage, progress: 0 };
        if (task.completed) return { stage, progress: 1 };
        const status = (task.modelStatuses || []).find((row) => row.model === model)?.status || task.status;
        return { stage, progress: statusProgress(task.kind, status) };
      });
      if (qcRequired) stages.push({ stage: 'quality', progress: qc?.completed ? 1 : 0 });
      const sent = sentAll || sentModels.has(model.toLowerCase());
      stages.push({ stage: 'despatch', progress: sent ? 1 : 0 });
      return { model, stages, dates: (dates.get(model) || []).map((entry) => ({ department: entry.department, date: entry.date, kind: entry.kind })) };
    });
    return { enquiry, models, gone: sentAll };
  });
}

/**
 * The reading for each enquiry, by id: `{ level, score, why, reasons, daysLeft, daysNeeded,
 * finish, watchFrom, models, modelsLeft, stages }`. Closed and lost enquiries read none.
 */
export async function deliveryRiskFor(enquiryIds, { now = new Date() } = {}) {
  const ids = [...new Set(enquiryIds.filter(Boolean).map(idOf))];
  const out = new Map();
  if (!ids.length) return out;
  const enquiries = await Enquiry.find({ _id: { $in: ids } })
    .select('number stage edd eddByModel qcRequired items.modelNumber requirement.modelNumber').lean();
  const model = await stageModel({ now });
  for (const { enquiry, models, gone } of await figuresFor(enquiries)) {
    const closed = enquiry.stage === 'closed';
    out.set(idOf(enquiry._id), assess({ edd: enquiry.edd?.date || null, models, model, now, gone: gone || closed }));
  }
  return out;
}

/**
 * Every open order in danger, worst first — late, will miss, at risk, then those in the warning
 * window — for the at-risk list [web: components/DeliveryRiskPanel.jsx]. `scope` narrows the
 * enquiries (a marketing person's own).
 */
export async function ordersAtRisk({ now = new Date(), scope = {}, levels = ['late', 'will_miss', 'at_risk', 'watch'], limit = 100 } = {}) {
  const enquiries = await Enquiry.find({ ...scope, stage: { $ne: 'closed' }, 'edd.date': { $ne: null } })
    .select('number customer assignedTo edd stage').populate('customer', 'name').populate('assignedTo', 'name').limit(1000).lean();
  const risks = await deliveryRiskFor(enquiries.map((row) => row._id), { now });
  return enquiries
    .map((enquiry) => ({
      enquiry: { _id: enquiry._id, number: enquiry.number, stage: enquiry.stage, customer: enquiry.customer?.name || null, owner: enquiry.assignedTo?.name || null },
      edd: enquiry.edd.date,
      risk: risks.get(idOf(enquiry._id)),
    }))
    .filter((row) => row.risk && levels.includes(row.risk.level))
    .sort((a, b) => (b.risk.score - a.risk.score) || String(a.edd).localeCompare(String(b.edd)))
    .slice(0, limit);
}
