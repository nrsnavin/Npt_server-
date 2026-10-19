import { findHandoff } from '../config/handoffs.js';
import { codeKey } from './modelCatalogue.service.js';

/**
 * The production queue's words [controllers/productionQueue.controller.js; web: pages/ProductionQueue.jsx]:
 * each enquiry's state said in at most thirty words — a problem first, then each model's status,
 * the press, the work orders and the teams after Production — and the model-by-model table the
 * Production workflow page is built on. Plain rules, no guessing: every word comes off a record.
 */

export const SUMMARY_WORDS = 30;

const statusesOf = (kind) => findHandoff(kind)?.form?.statuses || [];
const labelOf = (kind, key) => statusesOf(kind).find((entry) => entry.key === key)?.label || null;
const isIssue = (kind, key) => Boolean(statusesOf(kind).find((entry) => entry.key === key)?.issue);
const TEAM_WORDS = { printing: 'Printing', assembling: 'Assembly', quality: 'Quality', despatch: 'Dispatch' };
const pieces = (value) => Number(value || 0).toLocaleString('en-IN');

/** Text cut to `limit` words, with an ellipsis when cut. */
/*
 * Whether an enquiry has been taken for production, and what says so — the Production desk's
 * "In production" / "Not taken yet" filter [web: components/ProductionQueueList.jsx]: a work order
 * for its released lines, moulding on a press or pieces made, or Production's status at Production
 * Started or past it (on the task or on any of its models). Until then it is waiting to be taken.
 */
const startedKeys = (kind) => {
  const statuses = statusesOf(kind);
  const from = statuses.findIndex((entry) => entry.key === 'started');
  return new Set(from < 0 ? [] : statuses.slice(from).filter((entry) => !entry.issue && !entry.done).map((entry) => entry.key));
};
export function productionTaken({ task, workOrders = [], floor = {} }) {
  if (workOrders.length) return { taken: true, why: `Work order ${workOrders.map((wo) => wo.number).join(', ')}` };
  const running = floor.running || [];
  if (running.length) return { taken: true, why: `Moulding on ${running.map((run) => run.machine || 'a press').join(', ')}` };
  if (floor.made?.runs) return { taken: true, why: `${floor.made.runs} run${floor.made.runs === 1 ? '' : 's'} made ${pieces(floor.made.good)} pcs` };
  const started = startedKeys(task?.kind || 'ask_edd');
  const moved = [task?.status, ...(task?.modelStatuses || []).map((row) => row.status)].find((key) => started.has(key));
  if (moved) return { taken: true, why: labelOf(task?.kind || 'ask_edd', moved) };
  return { taken: false, why: null };
}

export function capWords(text, limit = SUMMARY_WORDS) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length <= limit) return words.join(' ');
  return `${words.slice(0, limit - 1).join(' ')} …`;
}

/** The models a Production task is for: its routing, its brief, else the enquiry's. */
export function modelsOf(task, enquiry = {}) {
  const routed = (task?.routing?.models || []).map((row) => (typeof row === 'string' ? row : row?.model)).filter(Boolean);
  if (routed.length) return [...new Set(routed)];
  const listed = String(task?.brief?.models || '').split(',').map((model) => model.trim()).filter(Boolean);
  if (listed.length) return [...new Set(listed)];
  const items = (enquiry.items || []).map((item) => item.modelNumber).filter(Boolean);
  if (items.length) return [...new Set(items)];
  const one = task?.brief?.model || enquiry.requirement?.modelNumber;
  return one ? [String(one).trim()] : [];
}

/** A team task's status for one model: its own, where models move apart, else the task's. */
function statusFor(task, model) {
  if (!task) return null;
  const own = (task.modelStatuses || []).find((row) => row.model === model)?.status;
  const key = own || task.status;
  return {
    key: key || null,
    label: task.completed ? 'Done' : labelOf(task.kind, key) || 'Asked',
    issue: !task.completed && isIssue(task.kind, key),
    done: Boolean(task.completed),
  };
}

/**
 * Each model's row on the workflow page: what follows moulding, Production's status, Printing's
 * and Assembly's (where it goes there) with the day the goods reached them, its EDD, and its
 * work orders.
 */
export function modelRows({ task, enquiry = {}, teams = {}, workOrders = [] }) {
  const routes = new Map((task?.routing?.models || []).filter((row) => row?.model).map((row) => [row.model, row]));
  const eddOf = new Map((enquiry.eddByModel || []).map((row) => [row.model, row]));
  return modelsOf(task, enquiry).map((model) => {
    const route = routes.get(model) || null;
    const edd = eddOf.get(model);
    return {
      model,
      decided: Boolean(route),
      printing: Boolean(route?.printing),
      assembly: Boolean(route?.assembly),
      production: statusFor(task, model),
      printingStatus: route?.printing ? statusFor(teams.printing, model) : null,
      printingReceived: route?.printing ? teams.printing?.routing?.receivedModels?.[model] || null : null,
      assemblyStatus: route?.assembly ? statusFor(teams.assembling, model) : null,
      assemblyReceived: route?.assembly ? teams.assembling?.routing?.receivedModels?.[model] || null : null,
      edd: edd ? edd.final?.date || edd.date || null : null,
      workOrders: workOrders.filter((wo) => codeKey(wo.modelNumber) === codeKey(model)).map((wo) => wo.number),
    };
  });
}

/**
 * The enquiry's state in at most thirty words, most urgent first: a problem; each model's
 * Production status (models at the same status said together); the press running and what is
 * made; the work orders; printing and assembly still to decide; the teams after Production; no EDD.
 */
export function summarise({ task, enquiry = {}, teams = {}, floor = {}, workOrders = [], edd = null }) {
  const parts = [];
  if (task?.status && isIssue(task.kind, task.status)) {
    const note = (task.updates || []).at(-1)?.text;
    parts.push(`Problem: ${labelOf(task.kind, task.status)}${note ? ` — ${note}` : ''}`);
  }
  const models = modelsOf(task, enquiry);
  if (task?.modelStatuses?.length && models.length > 1) {
    const groups = new Map();
    for (const model of models) {
      const label = statusFor(task, model).label;
      groups.set(label, [...(groups.get(label) || []), model]);
    }
    parts.push([...groups].map(([label, names]) => `${names.join(', ')} ${label}`).join('; '));
  } else if (!parts.length) {
    parts.push(`Production: ${labelOf(task?.kind, task?.status) || 'not started'}`);
  }
  const running = floor.running || [];
  if (running.length) {
    const run = running[0];
    parts.push(`Moulding on ${run.machine?.code || run.machine || 'a press'}${run.mould ? ` (${run.mould.mouldCode || run.mould})` : ''}`);
  }
  if (floor.made?.good) parts.push(`${pieces(floor.made.good)} made`);
  if (workOrders.length) {
    const done = workOrders.filter((wo) => wo.status === 'completed').length;
    const live = workOrders.filter((wo) => wo.status === 'running').length;
    parts.push(`Work orders ${done}/${workOrders.length} done${live ? `, ${live} running` : ''}`);
  }
  if (task?.kind === 'ask_edd' && task.enquiry && !task.routing?.decidedAt) parts.push('Printing/assembly not decided');
  for (const team of ['printing', 'assembling', 'quality', 'despatch']) {
    const other = teams[team];
    if (other) parts.push(`${TEAM_WORDS[team]} ${other.completed ? 'done' : labelOf(other.kind, other.status) || 'asked'}`);
  }
  if (!edd) parts.push('No EDD yet');
  return capWords(parts.join('. '));
}
