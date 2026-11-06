import Todo from '../models/Todo.js';
import Enquiry from '../models/Enquiry.js';
import ApiError from '../utils/ApiError.js';
import { EVENTS, publish } from './events.service.js';

/**
 * A small order [config/handoffs.js `small_order`]: a few pieces that may already be in the
 * godown. Dispatch checks the stock model by model and says how many are there:
 *
 *   all there      a Dispatch request for the lot — it goes out as any order does (loads, LR)
 *   some there     a Dispatch request for what is there, and Production asked for the rest
 *   none there     Production asked for the lot; the journey brings it to Dispatch when made
 *
 * No PO & SO step. The small order task closes with the check, saying what went where.
 */

const fail = (message) => { throw ApiError.badRequest(message); };
const idOf = (value) => String(value?._id ?? value ?? '');
const piecesOf = (value) => Math.max(0, Math.round(Number(String(value ?? '').replace(/,/g, '')) || 0));

/** The order's lines as asked, each with its quantity. */
export function smallOrderLines(task) {
  return (Array.isArray(task.brief?.items) ? task.brief.items : [])
    .filter((row) => row?.model)
    .map((row) => ({ ...row, quantity: piecesOf(row.quantity) }));
}

/** The lines as a brief for the next team: these items, the first model and the total for screens that read one. */
const briefFor = (lines, task) => {
  const items = lines.map((row) => Object.fromEntries(Object.entries({
    model: row.model, material: row.material, hook: row.hook, clip: row.clip, print: row.print, quantity: String(row.quantity),
  }).filter(([, value]) => value !== undefined && value !== '')));
  return {
    items,
    model: items.map((row) => row.model).join(', '),
    quantity: String(lines.reduce((sum, row) => sum + row.quantity, 0)),
    ...(task.brief?.deliveryNote ? { notes: task.brief.deliveryNote } : {}),
  };
};

/**
 * Dispatch's stock check: per model, the pieces in the godown. What is there goes to Dispatch,
 * what is short to Production; the task closes with the split said on it.
 */
export async function checkStock(task, user, { lines = [], note }) {
  const handoff = await import('./handoff.service.js');
  if (task.kind !== 'small_order') fail('The stock check is on a Small Order task');
  if (!handoff.mayWorkOnHandoff(user, task)) throw ApiError.forbidden('Dispatch checks the stock on its task');
  if (task.completed) fail('This small order is already checked');
  const asked = smallOrderLines(task);
  if (!asked.length) fail('This small order lists no models — add them to the task first');
  const said = new Map((Array.isArray(lines) ? lines : []).map((row) => [String(row.model || '').trim(), row]));
  const rows = asked.map((row) => {
    const entry = said.get(row.model);
    if (!entry || entry.available === undefined || entry.available === '') fail(`Say how many of ${row.model} are in stock — 0 if none`);
    const available = Math.min(row.quantity, piecesOf(entry.available));
    return { ...row, available, short: Math.max(0, row.quantity - available) };
  });
  const fromStock = rows.filter((row) => row.available > 0).map((row) => ({ ...row, quantity: row.available }));
  const toMake = rows.filter((row) => row.short > 0).map((row) => ({ ...row, quantity: row.short }));
  const text = String(note || '').trim();
  const split = rows.map((row) => `${row.model}: ${row.available} of ${row.quantity} in stock${row.short ? `, ${row.short} to make` : ''}`).join(' · ');
  const why = `Small order — stock checked by ${user.name}: ${split}${text ? ` — ${text}` : ''}`;

  let dispatch = null;
  let production = null;
  const enquiry = task.enquiry ? await Enquiry.findById(idOf(task.enquiry)) : null;
  const raise = async (kind, lot) => {
    const brief = briefFor(lot, task);
    let raised;
    if (enquiry) {
      const moved = await handoff.moveEnquiry({ enquiry, kind, note: why, user, system: true, brief, addToOpen: true, keepStage: kind === 'invoice_dispatch' && toMake.length > 0 });
      raised = moved?.task || moved;
    } else {
      const { raiseNextTeamTask } = await import('./journey.service.js');
      raised = await raiseNextTeamTask(task, kind, user, why, { brief });
    }
    /*
     * The lot's own lines on the task raised — the next team's form keeps one model and one
     * quantity, and a small order can be several models: what is to go (or to be made) is these.
     */
    if (raised?._id) {
      await Todo.updateOne({ _id: raised._id }, { $set: { 'brief.items': brief.items, 'brief.model': brief.model, 'brief.quantity': brief.quantity } }, { keepVersion: true });
      raised = await Todo.findById(raised._id);
    }
    return raised;
  };
  if (fromStock.length) dispatch = await raise('invoice_dispatch', fromStock);
  if (toMake.length) production = await raise('ask_edd', toMake);

  task.brief = { ...(task.brief || {}), stockCheck: rows.map(({ model, quantity, available, short }) => ({ model, quantity, available, short })) };
  task.markModified('brief');
  task.updates = [...(task.updates || []), { kind: 'note', statusLabel: 'Stock checked', text: split, note: why, by: user._id, at: new Date() }];
  task.status = 'checked';
  task.statusHistory = [...(task.statusHistory || []), { status: 'checked', note: split, by: user._id, at: new Date() }];
  await task.save();
  const done = await handoff.completeHandoff(task, user, {
    note: [fromStock.length && `${fromStock.reduce((sum, row) => sum + row.quantity, 0)} pcs from stock to Dispatch`, toMake.length && `${toMake.reduce((sum, row) => sum + row.quantity, 0)} pcs to Production`].filter(Boolean).join(' · '),
    system: true, quiet: true,
  });
  await publish(EVENTS.HANDOFF_UPDATED, { task: done, by: user });
  return { task: done, dispatch, production, rows };
}
