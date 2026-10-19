import Todo from '../models/Todo.js';
import { findHandoff } from '../config/handoffs.js';
import { capWords } from './productionSummary.service.js';
import { taskLines } from './taskSummary.llm.js';

/**
 * The Printing, Assembly and Quality desks, read at a glance [controllers/handoff.controller
 * `departmentDashboardFor`; web: components/FinishingDeskList.jsx]: each task with its enquiry,
 * buyer, EDD, its state in 20 to 30 words — written by the model from the task's records
 * [taskSummary.llm.js], by the rules until it has — and the enquiry's Production workflow page,
 * where every update on the order is given.
 */

export const FINISHING_DEPARTMENTS = ['quality', 'printing', 'assembling'];

const labelOf = (kind, key) => (findHandoff(kind)?.form?.statuses || []).find((entry) => entry.key === key)?.label || null;
const day = (value) => (value ? new Date(value).toISOString().slice(0, 10) : null);

/** A task's status, model by model where its models move apart. */
function statusWords(task) {
  if (task.modelStatuses?.length) {
    const groups = new Map();
    for (const row of task.modelStatuses) {
      const label = labelOf(task.kind, row.status) || row.status;
      groups.set(label, [...(groups.get(label) || []), row.model]);
    }
    return [...groups].map(([label, models]) => `${models.join(', ')} ${label}`).join('; ');
  }
  return labelOf(task.kind, task.status) || 'Asked';
}

/** What the task's own records say, as lines for the model to read. */
function factsOf(row, production) {
  const { task, enquiry } = row;
  const team = findHandoff(task.kind)?.label || task.kind;
  const models = String(task.brief?.models || task.brief?.model || '').trim();
  const received = Object.entries(task.routing?.receivedModels || {}).map(([model, date]) => `${model} on ${date}`).join(', ');
  const incoming = Object.entries(task.routing?.incoming || {}).map(([from, date]) => `${from} hands over ${date}`).join(', ');
  const updates = (task.updates || []).slice(-3).map((entry) => `- ${day(entry.at) || ''} ${entry.note || entry.text || entry.statusLabel || ''}`.trim());
  return [
    `Task: ${team} for ${enquiry?.number || 'a team task'}${enquiry?.customer?.name ? ` (${enquiry.customer.name})` : ''}`,
    models && `Models: ${models}`,
    `Status: ${statusWords(task)}`,
    received && `Goods received: ${received}`,
    incoming && `Expected: ${incoming}`,
    production && `Production: ${statusWords(production)}${production.completed ? ' (done)' : ''}`,
    `EDD: ${enquiry?.edd?.date || 'not given'}`,
    task.dueDate && `Task due: ${day(task.dueDate)}`,
    updates.length && `Latest updates:\n${updates.join('\n')}`,
  ].filter(Boolean).join('\n');
}

/** The rules' line: the status, the latest word on the task, Production's state, the EDD. */
function rulesOf(row, production) {
  const { task, enquiry } = row;
  const last = (task.updates || []).at(-1);
  const said = last?.text || (last?.note && !/^[A-Z][\w ]+:/.test(last.note) ? last.note : null);
  return capWords([
    statusWords(task),
    said,
    production && `Production: ${statusWords(production)}`,
    enquiry?.edd?.date ? null : 'No EDD yet',
  ].filter(Boolean).join('. '), 30);
}

/**
 * The desk's rows with `summary`, `summaryBy` (model or rules), `edd` and `workflow` — the
 * enquiry's Production workflow page, from its newest Production task.
 */
export async function withDeskSummaries(rows = []) {
  const ids = [...new Set(rows.filter((row) => row.enquiry?._id).map((row) => String(row.enquiry._id)))];
  const productions = ids.length
    ? await Todo.find({ enquiry: { $in: ids }, kind: 'ask_edd' })
      .select('enquiry kind status completed modelStatuses updatedAt createdAt').sort({ createdAt: -1 }).lean()
    : [];
  const productionOf = new Map();
  for (const task of productions) {
    const key = String(task.enquiry);
    const kept = productionOf.get(key);
    if (!kept || (kept.completed && !task.completed)) productionOf.set(key, task);
  }
  const items = rows.map((row) => {
    const production = row.enquiry?._id ? productionOf.get(String(row.enquiry._id)) : null;
    return {
      row,
      production,
      id: String(row.task._id),
      key: `${row.task._id}:${new Date(row.task.updatedAt || 0).getTime()}:${production?._id || ''}:${new Date(production?.updatedAt || 0).getTime()}`,
      facts: factsOf(row, production),
      rules: rulesOf(row, production),
    };
  });
  const lines = await taskLines(items);
  return items.map(({ row, production, id }) => ({
    ...row,
    summary: lines.get(id)?.summary || '',
    summaryBy: lines.get(id)?.writtenBy || 'rules',
    edd: row.enquiry?.edd?.date || null,
    workflow: production ? `/production/workflow/${production._id}` : null,
  }));
}
