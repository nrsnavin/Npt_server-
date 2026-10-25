import Customer from '../models/Customer.js';
import Attachment from '../models/Attachment.js';
import { receivablesOf } from './collections.service.js';

/**
 * What the Reception, Payment Collection, Payment Recovery and Accounts desks read as tables
 * [web: components/DeskTables.jsx] — one line a task, every action on the line — beside what a
 * desk row already carries [handoff.service `enquiriesHeldBy`]:
 *
 *   buyer      the customer's phone and WhatsApp, the contact to ask for, the credit status and
 *              what they owe — every desk;
 *   sample     Reception's sample to hand over: its number and state, and who collected it, how
 *              many pieces, when, and the photo of the slip [Sample `collection`];
 *   documents  the papers kept on the task — the hand-over photo, the dispatch details;
 *   money      the chase: what is still due on the task's order (or customer), how many days the
 *              oldest is overdue, the promise and the next call on its log, what came in since
 *              the task was raised, the last payment logged (amount, mode, reference), and the
 *              order's value.
 */

const idOf = (value) => String(value?._id || value || '');
export const RECEPTION_KINDS = ['sample_collect', 'lr_copy'];
export const MONEY_KINDS = ['team_payment_followup', 'my_payment_followup', 'prt_recovery', 'request_prt_visit', 'ac_clarify'];
const DESK_KINDS = [...RECEPTION_KINDS, ...MONEY_KINDS];

const DAY_MS = 24 * 60 * 60 * 1000;
const round2 = (value) => Math.round(value * 100) / 100;

/** The latest of a set of dates, or null. */
const latest = (dates) => dates.filter(Boolean).map((date) => new Date(date)).sort((a, b) => b - a)[0] || null;
const earliest = (dates) => dates.filter(Boolean).map((date) => new Date(date)).sort((a, b) => a - b)[0] || null;

async function moneyOf(task) {
  const rows = await receivablesOf(task);
  const since = new Date(task.createdAt || 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const overdue = rows.map((row) => (row.dueBy ? Math.floor((today - new Date(row.dueBy).setHours(0, 0, 0, 0)) / DAY_MS) : 0));
  const calls = rows.flatMap((row) => row.followUps || []).sort((a, b) => new Date(b.at) - new Date(a.at));
  const promise = calls.find((call) => call.promisedDate);
  const receipts = rows.flatMap((row) => row.receipts || []);
  const last = receipts.slice().sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt))[0];
  return {
    due: round2(rows.reduce((sum, row) => sum + (row.balance || 0), 0)),
    invoices: rows.length,
    overdueDays: Math.max(0, ...overdue),
    promisedDate: promise?.promisedDate || null,
    promisedAmount: promise?.promisedAmount ?? null,
    nextCall: earliest(rows.map((row) => row.nextFollowUpDate)),
    collected: round2(receipts.filter((entry) => new Date(entry.receivedAt) >= since).reduce((sum, entry) => sum + (entry.amount || 0), 0)),
    lastPayment: last ? {
      amount: last.amount, mode: last.mode, reference: last.reference || null, receivedAt: last.receivedAt,
      confirmed: Boolean(last.confirmed?.at || last.confirmed === true),
    } : null,
    lastCallAt: latest(calls.map((call) => call.at)),
  };
}

export async function withDeskDetails(rows) {
  const desk = rows.filter((row) => DESK_KINDS.includes(row.task.kind));
  if (!desk.length) return rows;

  const customerIds = [...new Set(desk.map((row) => idOf(row.enquiry?.customer || row.task.customer)).filter(Boolean))];
  const customers = new Map((await Customer.find({ _id: { $in: customerIds } })
    .select('name mobile whatsapp contacts credit outstandingAmount creditTermsDays').lean())
    .map((row) => [String(row._id), row]));

  const sampleIds = desk.filter((row) => row.task.kind === 'sample_collect' && row.task.brief?.sample).map((row) => row.task.brief.sample);
  const { default: Sample } = await import('../models/Sample.js');
  const samples = new Map((sampleIds.length ? await Sample.find({ _id: { $in: sampleIds } })
    .select('number status quantity collection handover').populate('collection.photo', 'key filename mimeType').lean() : [])
    .map((row) => [String(row._id), row]));

  const receptionIds = desk.filter((row) => RECEPTION_KINDS.includes(row.task.kind)).map((row) => row.task._id);
  const papers = receptionIds.length
    ? await Attachment.find({ task: { $in: receptionIds }, docType: { $exists: true } }).select('key filename mimeType docType title task createdAt').sort({ createdAt: -1 }).lean()
    : [];

  const orderIds = [...new Set(desk.filter((row) => row.task.kind === 'ac_clarify').map((row) => idOf(row.task.order || row.records?.order)).filter(Boolean))];
  const { default: SalesOrder } = await import('../models/SalesOrder.js');
  const orders = new Map((orderIds.length ? await SalesOrder.find({ _id: { $in: orderIds } }) : [])
    .map((order) => [String(order._id), { _id: order._id, number: order.number, value: round2(order.totalValue || 0) }]));

  for (const row of desk) {
    const buyer = customers.get(idOf(row.enquiry?.customer || row.task.customer));
    if (buyer) {
      const primary = buyer.contacts?.find((contact) => contact.isPrimary) || buyer.contacts?.[0];
      row.buyer = {
        contact: primary?.name || null,
        phone: primary?.phone || buyer.mobile || buyer.whatsapp || null,
        whatsapp: buyer.whatsapp || primary?.phone || buyer.mobile || null,
        credit: { status: buyer.credit?.status || 'good', reason: buyer.credit?.override?.reason || buyer.credit?.derived?.reason || null },
        outstanding: buyer.outstandingAmount || 0,
        creditTermsDays: buyer.creditTermsDays || 0,
      };
    }
    if (row.task.kind === 'sample_collect') {
      const sample = samples.get(idOf(row.task.brief?.sample));
      if (sample) row.sample = { _id: sample._id, number: sample.number, status: sample.status, quantity: sample.quantity, collection: sample.collection || null };
    }
    /* Reception's LR Copy task: each shipment of the job and whether its LR is up and sent [handoff.service `shipmentsOf`]. */
    if (row.task.kind === 'lr_copy') {
      const { shipmentsOf } = await import('./handoff.service.js');
      row.shipments = (await shipmentsOf(row.task).catch(() => [])).filter((shipment) => shipment.needsLr)
        .map(({ _id, at, lines, pieces, paper, lrNumber, lrSentAt }) => ({ _id, at, lines, pieces, paper, lrNumber, lrSentAt }));
    }
    if (RECEPTION_KINDS.includes(row.task.kind)) {
      row.documents = papers.filter((paper) => String(paper.task) === String(row.task._id))
        .map(({ _id, key, filename, mimeType, docType, title, createdAt }) => ({ _id, key, filename, mimeType, docType, title, createdAt }));
    }
    if (MONEY_KINDS.includes(row.task.kind)) {
      row.money = await moneyOf(row.task);
      if (row.task.kind === 'ac_clarify') row.money.order = orders.get(idOf(row.task.order || row.records?.order)) || null;
    }
  }
  return rows;
}
