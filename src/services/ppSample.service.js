import PpSample, { PP_STATUS_WORDS } from '../models/PpSample.js';
import DeliveryChallan, { DC_MODES } from '../models/DeliveryChallan.js';
import Todo from '../models/Todo.js';
import Enquiry from '../models/Enquiry.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import { afterCommit } from '../utils/transaction.js';
import { inDepartment, isManagement } from '../utils/departments.js';
import { findHandoff } from '../config/handoffs.js';
import { EVENTS, publish } from './events.service.js';
import { nextNumber } from './numbering.service.js';

/**
 * The PP (pre-production) sample [models/PpSample.js, models/DeliveryChallan.js].
 *
 *   start     "PP sample required" ticked on the PO & SO request: the SO upload raises Production's
 *             PP Sample task (round 1) instead of bulk production [handoff.service `finishWithResult`]
 *   ready     Production marks PP Sample Ready: Dispatch gets Send PP Sample
 *   DC        Dispatch prepares the delivery challan on that task — DC-2026-0001, on the letterhead:
 *             model, mould, material, hook, clip, printing, pieces, how it travels
 *   sent      Dispatch marks PP Sample Sent (only once the DC is prepared): the enquiry's marketing
 *             person gets PP Sample Approval
 *   answer    Approved: bulk production goes on — the order is released and Production asked, the
 *             payment gate and the Production-confirmed hold still applying [handoff.service
 *             `continueAfterPp`]. Changes needed: another round, Production told what to change.
 *   gate      Until approved, the order is not released and Production is not asked, by any path
 *             [`ppPendingFor`, `assertPpCleared`].
 *   invoice   The DC stays "to be invoiced" and is listed on the order's Invoice & Dispatch task until
 *             somebody says which invoice took it.
 */

const fail = (message) => { throw ApiError.badRequest(message); };
const idOf = (value) => String(value?._id ?? value ?? '');
const OPEN = { status: { $nin: ['approved', 'cancelled'] } };

/* ------------------------------ The gate ------------------------------ */

/** A PP sample still to be approved for this enquiry, order or SO request — or null. */
export async function ppPendingFor({ enquiry = null, order = null, sourceTask = null } = {}) {
  const branches = [
    enquiry && { enquiry: idOf(enquiry) },
    order && { order: idOf(order) },
    sourceTask && { sourceTask: idOf(sourceTask) },
  ].filter(Boolean);
  if (!branches.length) return null;
  return PpSample.findOne({ ...OPEN, $or: branches }).sort({ createdAt: -1 });
}

export const ppWaitsWords = (pp) => `The PP sample is not approved yet — ${(PP_STATUS_WORDS[pp.status] || pp.status).toLowerCase()}${(pp.rounds || []).length > 1 ? ` (round ${pp.rounds.length})` : ''}. Bulk production starts once the buyer approves it.`;

/** Refused, with where the PP sample stands, while one is waiting. */
export async function assertPpCleared(where) {
  const pending = await ppPendingFor(where);
  if (pending) fail(ppWaitsWords(pending));
}

/* ------------------------------ Tasks ------------------------------ */

const linesOf = (pp, pieces) => (pp.lines || []).map((line) => ({
  model: line.model, material: line.material, hook: line.hook, clip: line.clip, print: line.print,
  pieces: String(pieces ?? line.pieces ?? ''),
})).map((row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined && value !== '')));

async function ownerOfPp(pp) {
  const person = pp.owner ? await User.findById(pp.owner).select('department').lean() : null;
  return { user: pp.owner || undefined, department: person?.department || 'marketing' };
}

/** One of the PP sample's tasks, on the enquiry (or the job) it belongs to. */
async function raisePpTask(pp, kind, user, { notes, items = null, priority = 'high' }) {
  const handoff = findHandoff(kind);
  const statuses = handoff?.form?.statuses || [];
  const source = pp.sourceTask ? await Todo.findById(pp.sourceTask).select('chain jobNumber customer enquiry order title').lean() : null;
  const enquiry = pp.enquiry ? await Enquiry.findById(pp.enquiry).select('number customer').populate('customer', 'name').lean() : null;
  const about = enquiry ? `${enquiry.number}${enquiry.customer?.name ? ` · ${enquiry.customer.name}` : ''}` : (source?.title?.split(' — ').slice(1).join(' — ') || 'team task');
  const round = (pp.rounds || []).length;
  const owner = handoff.department === 'owner' ? await ownerOfPp(pp) : null;
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return Todo.create({
    kind,
    title: `${handoff.label}${round > 1 ? ` (round ${round})` : ''} — ${about}`,
    notes,
    department: owner ? owner.department : handoff.department,
    ...(owner?.user ? { user: owner.user } : {}),
    fromDepartment: user?.department || undefined,
    createdBy: user?._id || pp.createdBy,
    enquiry: pp.enquiry || undefined,
    customer: pp.customer || undefined,
    order: pp.order || undefined,
    ...(source?.chain || (source && !pp.enquiry) ? { chain: source.chain || source._id } : {}),
    brief: { items: items || linesOf(pp) },
    ...(statuses.length ? { status: statuses[0].key, statusHistory: [{ status: statuses[0].key, by: user?._id, at: new Date() }] } : {}),
    dueDate: end,
    priority,
    link: '/departments/mine',
  });
}

/** Said on the PO & SO task, so the SO team and marketing read where the PP sample is. */
async function noteOnSource(pp, user, text) {
  if (!pp.sourceTask) return;
  await Todo.updateOne({ _id: pp.sourceTask }, {
    $push: { updates: { kind: 'note', statusLabel: 'PP sample', text, note: `PP sample: ${text}`, by: user?._id, at: new Date() } },
  }, { keepVersion: true });
}

/** A notice under "Needs your action", and a ring on the phone, for the people a move is for. */
async function tell(pp, recipients, user, { label, note, task }) {
  const ids = [...new Set(recipients.filter(Boolean).map(String))].filter((id) => id !== idOf(user?._id));
  if (!ids.length) return;
  const { default: TaskNotice } = await import('../models/TaskNotice.js');
  await TaskNotice.insertMany(ids.map((recipient) => ({
    recipient, task: task?._id, enquiry: pp.enquiry || undefined, customer: pp.customer || undefined, order: pp.order || undefined,
    department: task?.department, kind: task?.kind, status: 'pp_sample', statusLabel: label, note, by: user?._id, at: new Date(),
    ...(pp.enquiry ? {} : { link: '/departments/mine' }),
  })));
  const link = pp.enquiry ? `/enquiries/${idOf(pp.enquiry)}` : '/departments/mine';
  afterCommit(() => import('./push.service.js')
    .then(({ sendPush }) => sendPush(ids, { title: label, body: String(note || '').slice(0, 200), link, kind: 'pp-sample' }))
    .catch((error) => console.error(`[pp-sample] push not sent: ${error.message}`)));
}

/* ------------------------------ Start ------------------------------ */

/**
 * The SO uploaded on a request that ticked PP sample required: round 1 for Production, the
 * enquiry at PP Sample. Once per request — an upload again leaves the running PP sample alone.
 */
export async function startPpSample(task, user) {
  if (task.kind !== 'po_so' || task.brief?.ppSampleRequired !== 'Yes') return null;
  const already = await PpSample.findOne({ sourceTask: task._id });
  if (already) return already;
  const pieces = Number(task.brief?.ppPieces) || undefined;
  const lines = (Array.isArray(task.brief?.items) ? task.brief.items : []).filter((row) => row?.model).map((row) => ({
    model: row.model, material: row.material, hook: row.hook, clip: row.clip, print: row.print, pieces,
  }));
  if (!lines.length) fail('PP sample required, but the request lists no model — add the models to the request');
  const enquiry = task.enquiry ? await Enquiry.findById(idOf(task.enquiry)).select('assignedTo customer').lean() : null;
  const pp = await PpSample.create({
    enquiry: enquiry?._id, customer: task.customer?._id || task.customer || enquiry?.customer, sourceTask: task._id,
    owner: enquiry?.assignedTo || task.createdBy, lines, status: 'making', rounds: [{ number: 1 }], createdBy: user._id,
  });
  const make = await raisePpTask(pp, 'pp_sample', user, {
    notes: `PP sample for the order — make ${pieces ? `${pieces} pcs of each model` : 'the pieces marketing asked for'} with the order's own material, mould, hook, clip and printing. Bulk production waits for the buyer's approval.`,
  });
  pp.rounds[0].makeTask = make._id;
  await pp.save();
  if (enquiry) await Enquiry.updateOne({ _id: enquiry._id }, { $set: { stage: 'pp_sample' } }, { keepVersion: true });
  await noteOnSource(pp, user, 'required — Production makes it first; bulk production waits for the buyer’s approval');
  return pp;
}

/** The order the SO upload booked, on the PP sample it waits for. */
export async function linkPpOrder(pp, order) {
  if (!pp || !order?._id || idOf(pp.order) === idOf(order._id)) return;
  pp.order = order._id;
  await pp.save();
  await Todo.updateMany({ _id: { $in: pp.rounds.flatMap((round) => [round.makeTask, round.sendTask, round.approvalTask]).filter(Boolean) } }, { $set: { order: order._id } }, { keepVersion: true });
}

/* ------------------------------ The workflow's steps ------------------------------ */

/** The PP sample a task belongs to. */
export async function ppOfTask(task) {
  return PpSample.findOne({
    $or: [{ 'rounds.makeTask': task._id }, { 'rounds.sendTask': task._id }, { 'rounds.approvalTask': task._id }, { sourceTask: task._id }],
  }).sort({ createdAt: -1 });
}

/** Whoever answers for the buyer: the enquiry's marketing person (or whoever raised the request), or Admin. */
export const mayAnswerPp = (pp, user) => isManagement(user) || idOf(pp.owner) === idOf(user._id);

const cleanItems = (items) => (Array.isArray(items) ? items : []).filter((row) => row?.model).slice(0, 20);

/**
 * A status on one of the PP sample's tasks that moves it on [config/departmentTaskForms.js
 * `ppSample`], from handoff.service `setTaskStatus` — before the status moves, so a refusal
 * (Sent with no DC) leaves the task where it was.
 */
export async function onPpStep(task, user, step, text) {
  const pp = await ppOfTask(task);
  if (!pp) fail('This task’s PP sample was not found');
  const round = pp.rounds.at(-1);
  const now = new Date();
  if (step.ppSample === 'ready') {
    if (idOf(round.makeTask) !== idOf(task._id)) fail('This is an earlier round’s task — the PP sample has moved on');
    round.readyAt = now;
    pp.status = 'sending';
    const send = await raisePpTask(pp, 'pp_sample_send', user, {
      items: cleanItems(task.brief?.items) .length ? cleanItems(task.brief.items) : null,
      notes: `PP sample ready${text ? ` — ${user.name}: ${text}` : ''}. Prepare the DC (model, mould, material, hook, clip, printing, pieces) and send it to the buyer.`,
    });
    round.sendTask = send._id;
    await pp.save();
    await noteOnSource(pp, user, `ready (round ${round.number}) — Dispatch prepares the DC and sends it`);
    return pp;
  }
  if (step.ppSample === 'sent') {
    if (idOf(round.sendTask) !== idOf(task._id)) fail('This is an earlier round’s task — the PP sample has moved on');
    if (!round.challan) fail('Prepare the DC first — it goes with the PP sample, and is added to the invoice later');
    round.sentAt = now;
    pp.status = 'with_buyer';
    const challan = await DeliveryChallan.findById(round.challan).select('number lines transport').lean();
    const approval = await raisePpTask(pp, 'pp_sample_approval', user, {
      items: (challan?.lines || []).map((line) => ({ model: line.model, material: line.material, hook: line.hook, clip: line.clip, print: line.printing, pieces: String(line.pieces) })),
      notes: `PP sample sent with ${challan?.number || 'its DC'}${text ? ` — ${user.name}: ${text}` : ''}. Record the buyer’s answer: approved, or the changes they want.`,
    });
    round.approvalTask = approval._id;
    await pp.save();
    await tell(pp, [pp.owner], user, { label: 'PP sample sent — record the buyer’s answer', note: `${challan?.number || ''}${text ? ` · ${text}` : ''}`, task: approval });
    await noteOnSource(pp, user, `sent with ${challan?.number || 'its DC'} (round ${round.number}) — waiting for the buyer`);
    return pp;
  }
  if (step.ppSample === 'approved' || step.ppSample === 'changes') {
    if (idOf(round.approvalTask) !== idOf(task._id)) fail('This is an earlier round’s task — the PP sample has moved on');
    if (!mayAnswerPp(pp, user)) throw ApiError.forbidden('The enquiry’s marketing person or Admin records the buyer’s answer on the PP sample');
    return verdict(pp, user, step.ppSample, text);
  }
  return pp;
}

/** The buyer's answer on the round sent. */
async function verdict(pp, user, kind, text) {
  const round = pp.rounds.at(-1);
  const now = new Date();
  round.verdict = kind;
  round.verdictNote = text || undefined;
  round.verdictBy = user._id;
  round.verdictAt = now;
  if (kind === 'changes') {
    if (String(text || '').trim().length < 3) fail('Say what the buyer wants changed — Production makes the next round from it');
    pp.rounds.push({ number: round.number + 1, brief: text });
    pp.status = 'making';
    const make = await raisePpTask(pp, 'pp_sample', user, {
      notes: `PP sample round ${round.number + 1} — the buyer wants changes: ${text}`,
    });
    pp.rounds.at(-1).makeTask = make._id;
    await pp.save();
    await noteOnSource(pp, user, `changes needed (round ${round.number}): ${text} — Production makes round ${round.number + 1}`);
    return pp;
  }
  pp.status = 'approved';
  pp.approvedAt = now;
  pp.approvedBy = user._id;
  await pp.save();
  await noteOnSource(pp, user, `approved by the buyer (round ${round.number})${text ? ` — ${text}` : ''}`);
  /* Bulk production goes on, as the SO upload would have sent it [handoff.service `continueAfterPp`]. */
  const { continueAfterPp } = await import('./handoff.service.js');
  const outcome = await continueAfterPp(pp, user);
  if (outcome?.said) await noteOnSource(pp, user, outcome.said);
  return pp;
}

/**
 * The buyer's answer from the enquiry or the task panel's PP sample card: the same as the
 * approval task's own statuses — its task moves, and the PP sample with it.
 */
export async function answerPp(pp, user, { verdict: kind, note }) {
  if (!mayAnswerPp(pp, user)) throw ApiError.forbidden('The enquiry’s marketing person or Admin records the buyer’s answer on the PP sample');
  if (pp.status !== 'with_buyer') fail(pp.status === 'approved' ? 'The PP sample is already approved' : 'The PP sample has not been sent to the buyer yet');
  const task = await Todo.findById(pp.rounds.at(-1).approvalTask);
  if (!task || task.completed) fail('The approval task for this round is not open');
  const { setTaskStatus } = await import('./handoff.service.js');
  await setTaskStatus(task, user, { status: kind === 'approved' ? 'approved' : 'changes', note });
  return PpSample.findById(pp._id);
}

/* ------------------------------ The DC ------------------------------ */

const text = (value, max = 200) => String(value ?? '').trim().slice(0, max);

/** What the DC form opens with: the lines of the round, each model's mould by name. */
export async function challanPrefill(task) {
  const pp = await ppOfTask(task);
  if (!pp) fail('This task’s PP sample was not found');
  const round = pp.rounds.at(-1);
  const existing = round.challan ? await DeliveryChallan.findById(round.challan) : null;
  if (existing) return { pp, challan: existing, lines: existing.lines, transport: existing.transport || {}, remarks: existing.remarks || '' };
  const items = cleanItems(task.brief?.items).length ? cleanItems(task.brief.items) : linesOf(pp);
  const { default: Mould } = await import('../models/Mould.js');
  const moulds = await Mould.find({ mouldCode: { $in: items.map((row) => String(row.model || '').toUpperCase()) } }).select('mouldCode name').lean();
  const lines = items.map((row) => ({
    model: row.model,
    mould: moulds.find((mould) => mould.mouldCode === String(row.model || '').toUpperCase())?.name || '',
    material: row.material || '', hook: row.hook || '', clip: row.clip || '', printing: row.print || '',
    pieces: Number(row.pieces) || '',
  }));
  return { pp, challan: null, lines, transport: {}, remarks: '' };
}

/** Dispatch prepares (or corrects) the round's DC on Send PP Sample. One DC a round, numbered once. */
export async function prepareChallan(task, user, { lines = [], transport = {}, remarks = '' }) {
  const { mayWorkOnHandoff } = await import('./handoff.service.js');
  if (task.kind !== 'pp_sample_send') fail('A DC is prepared on the Send PP Sample task');
  if (!mayWorkOnHandoff(user, task)) throw ApiError.forbidden('Dispatch prepares the DC on its task');
  if (task.completed) fail('The PP sample has gone — this DC can no longer change');
  const pp = await ppOfTask(task);
  if (!pp) fail('This task’s PP sample was not found');
  const round = pp.rounds.at(-1);
  if (idOf(round.sendTask) !== idOf(task._id)) fail('This is an earlier round’s task — the PP sample has moved on');
  const rows = (Array.isArray(lines) ? lines : []).slice(0, 20).map((line) => ({
    model: text(line.model, 80), mould: text(line.mould, 120), material: text(line.material, 120), hook: text(line.hook, 120),
    clip: text(line.clip, 120), printing: text(line.printing, 200), pieces: Math.round(Number(line.pieces) || 0),
  })).filter((line) => line.model || line.pieces);
  if (!rows.length) fail('List what goes on the DC — at least one model with its pieces');
  const bad = rows.find((line) => !line.model || line.pieces < 1);
  if (bad) fail(`${bad.model || 'A line'}: give the model and the pieces (1 or more)`);
  const mode = transport?.mode ? text(transport.mode, 40) : undefined;
  if (mode && !DC_MODES.includes(mode)) fail('How it travels is one of: courier, transporter, own vehicle, hand delivery, party collects');
  const travel = { mode, courier: text(transport?.courier, 120) || undefined, reference: text(transport?.reference, 120) || undefined, vehicle: text(transport?.vehicle, 60) || undefined };
  let challan = round.challan ? await DeliveryChallan.findById(round.challan) : null;
  if (challan) {
    challan.lines = rows;
    challan.transport = travel;
    challan.remarks = text(remarks, 1000) || undefined;
    await challan.save();
  } else {
    challan = await DeliveryChallan.create({
      number: await nextNumber('DC'), kind: 'pp_sample', ppSample: pp._id, round: round.number,
      enquiry: pp.enquiry, order: pp.order, customer: pp.customer, task: task._id,
      lines: rows, transport: travel, remarks: text(remarks, 1000) || undefined, createdBy: user._id,
    });
    round.challan = challan._id;
    await pp.save();
  }
  const pieces = rows.reduce((sum, line) => sum + line.pieces, 0);
  await Todo.updateOne({ _id: task._id }, {
    $push: { updates: { kind: 'note', statusLabel: 'DC prepared', text: `${challan.number} — ${pieces} pcs`, note: `${challan.number} prepared — ${rows.map((line) => `${line.model} × ${line.pieces}`).join(', ')}`, by: user._id, at: new Date() } },
  }, { keepVersion: true });
  await publish(EVENTS.HANDOFF_UPDATED, { task, by: user });
  return challan;
}

/** Who may read the DCs on a piece of work: the teams that make, send and bill it, the marketing person, Admin. */
export function mayReadChallans(user, { owner = null } = {}) {
  if (isManagement(user)) return true;
  if (owner && idOf(owner) === idOf(user._id)) return true;
  /* Not marketing at large: a buyer is one marketing person's — theirs comes through `owner`. */
  return ['despatch', 'accounts', 'production', 'order_confirmation', 'audit'].some((key) => inDepartment(user, key));
}

/** Who says a DC went on an invoice: Dispatch, Accounts, Admin. */
export const mayInvoiceChallan = (user) => isManagement(user) || ['despatch', 'accounts'].some((key) => inDepartment(user, key));

/** The DC's pieces are on an invoice now — off the Invoice & Dispatch task's list. */
export async function markChallanInvoiced(challan, user, { number, date }) {
  if (!mayInvoiceChallan(user)) throw ApiError.forbidden('Dispatch, Accounts or Admin says which invoice took a DC');
  const invoice = text(number, 60);
  if (invoice.length < 2) fail('Give the invoice number the DC’s pieces were added to');
  challan.status = 'invoiced';
  challan.invoice = { number: invoice, date: text(date, 10) || undefined, by: user._id, at: new Date() };
  await challan.save();
  return challan;
}

export const CHALLAN_POPULATE = [
  { path: 'createdBy', select: 'name' },
  { path: 'invoice.by', select: 'name' },
  { path: 'enquiry', select: 'number' },
  { path: 'customer', select: 'code name' },
];

/** The DCs on a piece of work — its enquiry, its order, or (a job with no enquiry) the job's tasks. */
export async function challansOn({ enquiry = null, order = null, tasks = [], status = null }) {
  const branches = [enquiry && { enquiry: idOf(enquiry) }, order && { order: idOf(order) }, tasks.length && { task: { $in: tasks } }].filter(Boolean);
  if (!branches.length) return [];
  return DeliveryChallan.find({ $or: branches, ...(status ? { status } : {}) }).sort({ createdAt: -1 }).limit(50).populate(CHALLAN_POPULATE);
}

/* ------------------------------ The DC on paper ------------------------------ */

const MODE_WORDS = { courier: 'Courier', transporter: 'Transporter', own_vehicle: 'Own vehicle', hand_delivery: 'Hand delivery', party_collects: 'Party collects' };

/** The DC on the letterhead: what went, how many, how it travelled — no prices. */
export async function renderChallanPdf(challan) {
  const { render, letterhead, facts, footer } = await import('./recordPdf.js');
  const Customer = (await import('../models/Customer.js')).default;
  const buyer = challan.customer ? await Customer.findById(idOf(challan.customer)).select('name gstin billingAddress address city state').lean() : null;
  const enquiry = challan.enquiry ? await Enquiry.findById(idOf(challan.enquiry)).select('number').lean() : null;
  const day = (value) => new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  return render((doc) => {
    letterhead(doc, 'DELIVERY CHALLAN', challan.number);
    facts(doc, [
      ['Date', day(challan.createdAt)],
      ['To', buyer?.name],
      ['GSTIN', buyer?.gstin],
      ['Purpose', `Pre-production (PP) sample${challan.round > 1 ? ` — round ${challan.round}` : ''}. Not for sale; to be billed with the order's invoice.`],
      ['Enquiry', enquiry?.number],
      ['Sent by', challan.transport?.mode ? [MODE_WORDS[challan.transport.mode], challan.transport.courier, challan.transport.reference, challan.transport.vehicle].filter(Boolean).join(' · ') : null],
    ]);
    doc.moveDown(0.6);
    const left = doc.page.margins.left;
    const columns = [['#', 22], ['Model', 70], ['Mould', 85], ['Material', 85], ['Hook', 55], ['Clip', 55], ['Printing', 85], ['Pieces', 50]];
    let x = left;
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#111111');
    for (const [label, width] of columns) { doc.text(label, x, y, { width }); x += width; }
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(8.5);
    challan.lines.forEach((line, at) => {
      const rowY = doc.y;
      const cells = [String(at + 1), line.model, line.mould, line.material, line.hook, line.clip, line.printing, String(line.pieces)];
      let cx = left;
      let bottom = rowY;
      cells.forEach((cell, index) => {
        doc.text(cell || '—', cx, rowY, { width: columns[index][1] - 4 });
        bottom = Math.max(bottom, doc.y);
        cx += columns[index][1];
      });
      doc.y = bottom + 3;
    });
    const total = challan.lines.reduce((sum, line) => sum + (line.pieces || 0), 0);
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(9.5).text(`Total pieces: ${total}`, left);
    if (challan.remarks) {
      doc.moveDown(0.5);
      doc.font('Helvetica').fontSize(9).text(`Remarks: ${challan.remarks}`, left);
    }
    doc.moveDown(2.5);
    doc.font('Helvetica').fontSize(9).text('Received the above goods in good condition.', left);
    doc.moveDown(2);
    doc.text('Receiver’s signature', left, doc.y, { continued: true }).text('For the company — authorised signatory', { align: 'right' });
    footer(doc);
  });
}
