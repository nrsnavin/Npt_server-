import Todo from '../models/Todo.js';
import Receivable from '../models/Receivable.js';
import Customer, { CREDIT_STATUSES } from '../models/Customer.js';
import { MAYBE_OWING, applyPaymentPositions } from './paymentPosition.service.js';
import { raiseTask } from './task.service.js';
import { EVENTS, publish } from './events.service.js';

/**
 * The chase as a case: Payment Collection on the phone, the Payment Recovery Team in the field,
 * one receivable at a time [docs/PAYMENT-COLLECTION-WORKFLOW.md].
 *
 * The department task is where the collector works — its statuses are the workflow
 * [config/departmentTaskForms.js `paymentFollowUp`, `prt_recovery`] — and the receivable is
 * where the money is. This file keeps the two agreeing: a move on the task is a call on the
 * receivable's log, a promise on the task is the receivable's promise, and the sweep each
 * morning turns a promise nobody kept into a red card and says when a case should leave the
 * phone for the field. The rule suggests; the collector or Admin presses the button.
 */

/** The task kinds that are a collection case. */
export const COLLECTION_KINDS = ['team_payment_followup', 'my_payment_followup', 'prt_recovery'];

/** What moves a case from the phone to the field, unless somebody decides otherwise. */
export const PRT_RULE = { overdueDays: 30, brokenPromises: 2, unreachable: 3 };

/** What makes a buyer Watch or Hold, from the receivables alone. Admin's own word wins over these. */
export const CREDIT_RULE = { watchDays: 16, holdDays: 46, watchBroken: 1, holdBroken: 2 };

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 330 * 60 * 1000;
const idOf = (value) => String(value?._id || value || '');
const rupees = (value) => `₹${Math.round(value).toLocaleString('en-IN')}`;

/** The end of a calendar day in India (YYYY-MM-DD), as an instant. */
export function endOfIndiaDay(day) {
  const local = new Date(`${day}T00:00:00.000Z`);
  local.setUTCHours(23, 59, 59, 999);
  return new Date(local.getTime() - IST_OFFSET_MS);
}

/** Today in India, YYYY-MM-DD. */
export const indiaDay = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);

/**
 * The money a case is about: the open receivables of its order, or — a case raised on the buyer
 * with no order named — every open receivable of the customer. With their positions applied, so
 * `balance` nets the order's advances [paymentPosition.service].
 */
export async function receivablesOf(task) {
  const filter = task.order ? { order: idOf(task.order) } : task.customer ? { customer: idOf(task.customer) } : null;
  if (!filter) return [];
  const rows = await Receivable.find({ ...filter, ...MAYBE_OWING }).sort({ dueBy: 1 });
  await applyPaymentPositions(rows);
  return rows.filter((row) => row.balance > 0);
}

/**
 * A move on the task, logged as a call on the receivable [models/Receivable.js `followUps`] so
 * the chase screen reads what the collector did without a second entry. A promise sets the
 * receivable's promised and next follow-up dates, which is what the day screen is built on.
 */
export async function logCollectionCall(task, user, step, text, promisedDay) {
  const rows = await receivablesOf(task);
  if (!rows.length) return 0;
  const promisedDate = step.promise && promisedDay ? endOfIndiaDay(promisedDay) : undefined;
  const entry = {
    by: user._id, at: new Date(),
    note: text || step.label,
    status: step.followUp || undefined,
    mode: step.mode || undefined,
    spokeTo: task.brief?.contact || undefined,
    ...(promisedDate ? { promisedDate, nextFollowUpDate: promisedDate } : {}),
  };
  for (const row of rows) {
    /* Append-only bookkeeping: the receivable's version is left alone, as every log write is. */
    await Receivable.updateOne(
      { _id: row._id },
      { $push: { followUps: entry }, ...(promisedDate ? { $set: { nextFollowUpDate: promisedDate } } : {}) },
      { keepVersion: true }
    );
  }
  return rows.length;
}

/**
 * Money was taken — on the phone they said it went, or PRT took it at the desk — so whoever moved
 * the task is asked to record the receipt against the receivable, once per case and move. The
 * receipt is what stops the chase; Accounts' confirmation is what opens the payment gate.
 */
export async function askToRecordReceipt(task, user, step) {
  const [row] = await receivablesOf(task);
  if (!row) return null;
  const customer = task.customer?.name ? task.customer.name : (await Customer.findById(idOf(task.customer)).select('name').lean())?.name;
  return raiseTask({
    user: user._id,
    title: `Record the receipt — ${customer || 'the buyer'} · ${row.invoice?.number || row.number}`,
    notes: `${step.label} on the collection task. ${rupees(row.balance)} was still owed on ${row.invoice?.number || row.number}: record what came in, in Payments, so the chase stops and Accounts can confirm it.`,
    priority: 'high',
    dueDate: new Date(),
    link: `/payments/${row._id}`,
    originKey: `record-receipt:${task._id}:${step.key}`,
    customer: idOf(task.customer) || undefined,
    order: idOf(task.order) || undefined,
  }).catch(() => null);
}

/**
 * The money is in: every collection or PRT case on the order that has nothing left to chase is
 * finished, by the app, saying so — the receipt stops the chase, as the design says, without a
 * collector having to find the task and press Paid [docs/PAYMENT-COLLECTION-WORKFLOW.md §1].
 */
export async function settleCollectionTasks(orderId, { by } = {}) {
  if (!orderId) return [];
  const { completeHandoff } = await import('./handoff.service.js');
  const open = await Todo.find({ order: idOf(orderId), kind: { $in: COLLECTION_KINDS }, completed: false });
  if (!open.length) return [];
  /* Paid means confirmed: a receipt PRT wrote from the field is money Accounts has not seen yet,
     and the case — and the dispatch gate's own ask — stay open until it has. Every receivable on
     the order, not only the owing ones: a fully receipted, unconfirmed invoice is not owing by
     the ledger's filter, and it is exactly the one this must wait for. */
  const rows = await Receivable.find({ order: idOf(orderId) });
  await applyPaymentPositions(rows);
  if (rows.some((row) => row.balance > 0 || row.awaitingConfirmation > 0)) return [];
  const settled = [];
  for (const task of open) {
    settled.push(await completeHandoff(task, by || {}, { note: 'Paid in full — nothing left to chase', system: true, quiet: true }));
  }
  return settled;
}

/* ------------------------------ The sweep ------------------------------ */

/** The app, as the actor on a notice it writes itself. */
const THE_APP = { _id: null, name: 'The app' };

/** The latest entry of a status in the task's history. */
const lastOf = (task, status) => [...(task.statusHistory || [])].reverse().find((entry) => entry.status === status);
const countOf = (task, status) => (task.statusHistory || []).filter((entry) => entry.status === status).length;

/**
 * Promised, and the day has gone: the task turns Promise Broken by itself the morning after, with
 * priority high, unless money came in since the promise was made. A person may also set it.
 */
async function breakPromises(now) {
  const { noticeStatus, peopleOn } = await import('./handoff.service.js');
  const { findHandoff } = await import('../config/handoffs.js');
  const today = indiaDay(now);
  const promised = await Todo.find({ kind: { $in: COLLECTION_KINDS }, status: 'promised', completed: false }).limit(500);
  const broken = [];
  for (const task of promised) {
    const promise = lastOf(task, 'promised');
    if (!promise?.date || promise.date >= today) continue;
    const rows = await receivablesOf(task);
    const paidSince = rows.length === 0
      || rows.some((row) => (row.receipts || []).some((receipt) => new Date(receipt.receivedAt || receipt.createdAt) >= new Date(promise.at)));
    if (paidSince) continue;
    const step = (findHandoff(task.kind)?.form?.statuses || []).find((entry) => entry.key === 'promise_broken');
    if (!step) continue;
    const said = `Promised ${promise.date} and nothing came in`;
    task.status = step.key;
    task.priority = 'high';
    task.statusHistory = [...(task.statusHistory || []), { status: step.key, note: said, at: now }];
    task.updates = [...(task.updates || []), { kind: 'status', status: step.key, statusLabel: step.label, text: said, note: `${step.label}: ${said}`, at: now }];
    await task.save();
    /* Nobody made the move, so the collector holding it hears too — it is their card turning red. */
    await noticeStatus(task, THE_APP, { step, note: said, also: await peopleOn(task) });
    await publish(EVENTS.HANDOFF_UPDATED, { task, by: null });
    broken.push(task);
  }
  return broken;
}

/**
 * When the phone has stopped working — 30 days overdue, two promises broken, or not reachable
 * three times — the case should go to the field. The rule says so on the task, once, and tells
 * Admin and the marketing person; the collector or Admin presses Escalated to PRT.
 */
export function prtReason(task, rows, now = new Date()) {
  const broken = countOf(task, 'promise_broken');
  if (broken >= PRT_RULE.brokenPromises) return `${broken} promises broken`;
  const unreachable = countOf(task, 'not_reachable');
  if (unreachable >= PRT_RULE.unreachable) return `not reachable ${unreachable} times`;
  const oldest = rows.reduce((most, row) => Math.max(most, Math.floor((now - new Date(row.dueBy)) / DAY_MS)), 0);
  if (oldest >= PRT_RULE.overdueDays) return `${oldest} days overdue`;
  return null;
}

async function suggestEscalations(now) {
  const { noticeStatus, peopleOn } = await import('./handoff.service.js');
  const open = await Todo.find({
    kind: { $in: ['team_payment_followup', 'my_payment_followup'] }, completed: false,
    status: { $nin: ['disputed', 'escalate_prt', 'paid'] }, 'suggestion.kind': { $exists: false },
  }).limit(500);
  const suggested = [];
  for (const task of open) {
    const rows = await receivablesOf(task);
    if (!rows.length) continue;
    const reason = prtReason(task, rows, now);
    if (!reason) continue;
    const said = `Escalate to PRT? ${reason} — ${rupees(rows.reduce((sum, row) => sum + row.balance, 0))} still owed. Choose Escalated to PRT to send it to the field.`;
    task.suggestion = { kind: 'escalate_prt', reason, at: now };
    task.priority = 'high';
    task.updates = [...(task.updates || []), { kind: 'notice', statusLabel: 'Escalate to PRT?', text: said, note: said, at: now }];
    await task.save();
    await noticeStatus(task, THE_APP, { step: { key: task.status, label: 'Escalate to PRT?' }, note: said, also: await peopleOn(task) });
    suggested.push(task);
  }
  return suggested;
}

/**
 * The buyer's credit status from the receivables and the chase, for every buyer who owes
 * something — and back to Good for one who no longer does. Admin's override wins while it stands.
 */
export function deriveCredit({ oldestOverdueDays, brokenPromises, prtOpen }) {
  if (prtOpen) return { status: 'hold', reason: 'With the Payment Recovery Team' };
  if (brokenPromises >= CREDIT_RULE.holdBroken) return { status: 'hold', reason: `${brokenPromises} promises broken` };
  if (oldestOverdueDays >= CREDIT_RULE.holdDays) return { status: 'hold', reason: `${oldestOverdueDays} days overdue` };
  if (brokenPromises >= CREDIT_RULE.watchBroken) return { status: 'watch', reason: 'A promise broken' };
  if (oldestOverdueDays >= CREDIT_RULE.watchDays) return { status: 'watch', reason: `${oldestOverdueDays} days overdue` };
  return { status: 'good', reason: 'Nothing much overdue' };
}

/** The status the buyer shows: Admin's word, else the rule's, else Good. */
export const creditStatusOf = (credit) => credit?.override?.status || credit?.derived?.status || 'good';

async function deriveCreditStatuses(now) {
  const owing = await Receivable.find({ ...MAYBE_OWING, judgement: null }).select('customer dueBy receipts invoice order followUps').limit(5000);
  await applyPaymentPositions(owing);
  const byCustomer = new Map();
  for (const row of owing) {
    if (row.balance <= 0) continue;
    const key = idOf(row.customer);
    if (!byCustomer.has(key)) byCustomer.set(key, { oldestOverdueDays: 0, brokenPromises: 0, prtOpen: false });
    const facts = byCustomer.get(key);
    facts.oldestOverdueDays = Math.max(facts.oldestOverdueDays, Math.floor((now - new Date(row.dueBy)) / DAY_MS));
    if (row.promise?.broken) facts.brokenPromises += 1;
  }
  const customers = [...byCustomer.keys()];
  if (customers.length) {
    const cases = await Todo.find({ kind: { $in: COLLECTION_KINDS }, completed: false, customer: { $in: customers } }).select('kind customer statusHistory').lean();
    for (const task of cases) {
      const facts = byCustomer.get(idOf(task.customer));
      if (!facts) continue;
      if (task.kind === 'prt_recovery') facts.prtOpen = true;
      facts.brokenPromises = Math.max(facts.brokenPromises, countOf(task, 'promise_broken'));
    }
  }
  let changed = 0;
  const write = async (customer, derived) => {
    const status = creditStatusOf({ override: customer.credit?.override, derived });
    const before = customer.credit?.derived;
    if (before?.status === derived.status && before?.reason === derived.reason && customer.credit?.status === status) return;
    await Customer.updateOne({ _id: customer._id }, { $set: { 'credit.derived': { ...derived, at: now }, 'credit.status': status } }, { keepVersion: true });
    changed += 1;
  };
  const known = customers.length ? await Customer.find({ _id: { $in: customers } }).select('credit').lean() : [];
  for (const customer of known) await write(customer, deriveCredit(byCustomer.get(idOf(customer))));
  /* Buyers who no longer owe anything: back to Good, unless Admin says otherwise. */
  const settled = await Customer.find({ _id: { $nin: customers }, 'credit.derived.status': { $in: CREDIT_STATUSES.filter((status) => status !== 'good') } }).select('credit').lean();
  for (const customer of settled) await write(customer, { status: 'good', reason: 'Nothing owed' });
  return changed;
}

/**
 * The morning sweep on the chase [background.js]: promises that have gone unkept, cases that
 * should go to the field, and every buyer's credit status. Each is idempotent — a task is
 * broken once, suggested once, a status written only when it changes — so the sweep may run
 * as often as the timer likes.
 */
export async function runCollectionSweep({ now = new Date() } = {}) {
  const broken = await breakPromises(now);
  const suggested = await suggestEscalations(now);
  const credit = await deriveCreditStatuses(now);
  return { broken: broken.length, suggested: suggested.length, credit };
}
