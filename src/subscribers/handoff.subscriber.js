import User from '../models/User.js';
import Customer from '../models/Customer.js';
import Enquiry from '../models/Enquiry.js';
import { env } from '../config/env.js';
import { EVENTS, subscribe as busSubscribe, unsubscribe } from '../services/events.service.js';
import { describeHandoff, holderOf, moveEnquiry } from '../services/handoff.service.js';
import { sendPush } from '../services/push.service.js';
import { isWhatsAppConfigured, sendWhatsApp, whatsappTemplate } from '../providers/whatsapp.js';

/**
 * Telling people about department tasks: the department when one is sent, the sender when it
 * is done or sent back. In the installed app and on WhatsApp.
 *
 * WhatsApp to somebody who has not messaged the plant's number in 24 hours needs an approved
 * template — set WHATSAPP_TEMPLATE_TASK (variables 1 headline, 2 details, 3 link) and it is used;
 * without one the plain text is sent, which works inside that window and in the sandbox.
 * Best effort: the task on the queue is the record, these are how it reaches a phone.
 */

const safely = (name, handler) => {
  const listener = async (payload) => {
    try {
      await handler(payload);
    } catch (error) {
      console.error(`[handoff] ${name} failed:`, error);
      throw error;
    }
  };
  listener.handoverName = `handoff:${name}`;
  return listener;
};

async function tell(people, { headline, details, link }) {
  const url = `${env.appUrl}${link}`;
  await sendPush(people.map((person) => person._id), { title: headline, body: details, link })
    .catch((error) => console.error(`[handoff] push not sent: ${error.message}`));

  const template = whatsappTemplate('task');
  for (const person of people) {
    if (!person.phone) continue;
    const body = `${headline}\n${details}\n${url}`;
    if (!isWhatsAppConfigured()) {
      console.log(`\n[whatsapp] to ${person.phone}\n${body}\n`);
      continue;
    }
    await sendWhatsApp({
      to: person.phone,
      body,
      ...(template ? { template, variables: { 1: headline, 2: details, 3: url } } : {}),
    }).catch((error) => console.error(`[handoff] WhatsApp to ${person.phone} not sent: ${error.message}`));
  }
}

/** "ENQ-2026-0012 · SCM Garments" for a task, read fresh. */
async function aboutOf(task) {
  const [enquiry, customer] = await Promise.all([
    task.enquiry ? Enquiry.findById(task.enquiry).select('number') : null,
    task.customer ? Customer.findById(task.customer).select('name') : null,
  ]);
  return [enquiry?.number, customer?.name].filter(Boolean).join(' · ');
}

/** "Due today", or the day it is due — marketing's tasks are due on the follow-up date. */
function dueWords(due) {
  if (!due) return 'Due today';
  const day = (date) => new Date(date).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
  return day(due) === day(new Date()) ? 'Due today' : `Due ${day(due)}`;
}

/*
 * The status changes that hand the enquiry to another department, and the button they press
 * on marketing's behalf. Only while the enquiry is still in the first four stages — a late
 * "won" must not pull a job back out of production.
 */
const SALES_STAGES = ['enquiry', 'sample', 'pricing_quote', 'po_so'];

const STATUS_MOVES = {
  sample_required: 'sample_request',
  pricing_required: 'create_quotation',
  negotiation: 'price_negotiation',
  won: 'po_so',
};

/** Moves the enquiry on someone's behalf, unless the department it should go to has it already. */
async function moveOnBehalf(enquiryId, kind, { by, status } = {}) {
  const enquiry = await Enquiry.findById(enquiryId?._id || enquiryId).populate('customer', 'code name');
  if (!enquiry) return;
  /* Only from the first four stages: past PO & SO, departments move it themselves. */
  if (!SALES_STAGES.includes(enquiry.stage)) return;
  const holder = await holderOf(enquiry._id);
  if (holder?.kind === kind) return;
  const user = by?._id ? (by.name ? by : await User.findById(by._id).select('name department role')) : undefined;
  try {
    await moveEnquiry({ enquiry, kind, user: user || undefined, system: true, openRecords: false, note: status ? `Status: ${status.replace(/_/g, ' ')}` : undefined });
  } catch (error) {
    /* Two of these racing (the status and the sample it raised): the other one moved it. */
    if (error?.code === 11000 || error?.statusCode === 409) return;
    throw error;
  }
}

/**
 * Moves the enquiry on someone's behalf when a record says the work moved — but only from the
 * stage that work belongs to, so an enquiry somebody has already sent elsewhere is left alone.
 */
async function moveWhenAt(enquiryId, { at, kind, by, fields, note }) {
  const enquiry = await Enquiry.findById(enquiryId?._id || enquiryId).populate('customer', 'code name');
  if (!enquiry || !at.includes(enquiry.stage)) return;
  const holder = await holderOf(enquiry._id);
  if (holder?.kind === kind) return;
  const user = by?._id ? await User.findById(by._id).select('name department role') : undefined;
  try {
    await moveEnquiry({ enquiry, kind, fields, note, user: user || undefined, system: true, openRecords: false });
  } catch (error) {
    if (error?.code === 11000 || error?.statusCode === 409) return;
    /* A gate said no (Quality not passed, a balance left): the department moves it by hand. */
    if (error?.statusCode === 400) {
      console.warn(`[handoff] ${enquiry.number} not moved to ${kind}: ${error.message}`);
      return;
    }
    throw error;
  }
}

let registered = [];

export function registerHandoffSubscribers() {
  for (const [event, listener] of registered) unsubscribe(event, listener);
  registered = [];
  const subscribe = (event, listener) => {
    registered.push([event, listener]);
    return busSubscribe(event, listener);
  };

  subscribe(
    EVENTS.HANDOFF_SENT,
    safely('tell the department', async ({ task, by }) => {
      if (!task) return;
      /* The person it is for, or everybody in the department — anyone there may pick it up. */
      const people = task.user
        ? await User.find({ _id: task.user, isActive: { $ne: false } }).select('name phone')
        : await User.find({ department: task.department, isActive: { $ne: false } }).select('name phone');
      const recipients = people.filter((person) => String(person._id) !== String(by?._id));
      if (!recipients.length) return;

      const { label, department } = describeHandoff(task);
      await tell(recipients, {
        headline: `New task for ${task.user ? 'you' : department}: ${label}`,
        details: `${await aboutOf(task)}${by?.name ? ` — from ${by.name}` : ''}. ${dueWords(task.dueDate)}.${task.notes ? ` "${task.notes.slice(0, 200)}"` : ''}`,
        link: task.link || '/today',
      });
    })
  );

  const backToSender = (verb) => safely(`tell the sender (${verb})`, async ({ task, by }) => {
    if (!task?.createdBy || String(task.createdBy) === String(by?._id)) return;
    const sender = await User.findOne({ _id: task.createdBy, isActive: { $ne: false } }).select('name phone');
    if (!sender) return;
    const { label } = describeHandoff(task);
    await tell([sender], {
      headline: `${label} ${verb} by ${by?.name || 'the department'}`,
      details: `${await aboutOf(task)}${task.outcome?.note ? ` — "${task.outcome.note.slice(0, 200)}"` : ''}`,
      link: task.link || '/today',
    });
  });

  /*
   * Late: the department that holds it, whoever sent it, and Admin — once [runLateTaskSweep].
   * Admin because a late task is the delay the role requirements ask Admin to see.
   */
  subscribe(
    EVENTS.HANDOFF_LATE,
    safely('tell about a late task', async ({ task }) => {
      if (!task || task.completed) return;
      const active = { isActive: { $ne: false } };
      const [holders, sender, admins] = await Promise.all([
        task.user
          ? User.find({ _id: task.user, ...active }).select('name phone')
          : User.find({ department: task.department, ...active }).select('name phone'),
        task.createdBy ? User.find({ _id: task.createdBy, ...active }).select('name phone') : [],
        User.find({ $or: [{ role: 'admin' }, { department: 'management' }], ...active }).select('name phone'),
      ]);
      const people = [...new Map([...holders, ...sender, ...admins].map((person) => [String(person._id), person])).values()];
      if (!people.length) return;

      const { label, department } = describeHandoff(task);
      await tell(people, {
        headline: `Late: ${label} with ${department}`,
        details: `${await aboutOf(task)} — was due ${new Date(task.dueDate).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}.`,
        link: task.link || '/today',
      });
    })
  );

  subscribe(EVENTS.HANDOFF_DONE, backToSender('done'));
  subscribe(EVENTS.HANDOFF_RETURNED, backToSender('sent back'));

  /* An update from the department that has it: the marketing person who owns the buyer sees it. */
  subscribe(
    EVENTS.HANDOFF_UPDATED,
    safely('tell the owner about an update', async ({ task, by }) => {
      const enquiry = task?.enquiry ? await Enquiry.findById(task.enquiry).select('assignedTo') : null;
      if (!enquiry?.assignedTo || String(enquiry.assignedTo) === String(by?._id)) return;
      const update = task.updates?.at(-1);
      const { label, department } = describeHandoff(task);
      await sendPush([enquiry.assignedTo], {
        title: `${department}: ${label}`,
        body: `${await aboutOf(task)} — ${by?.name ? `${by.name}: ` : ''}${update?.note?.slice(0, 200) || 'updated'}`,
        link: task.link || '/today',
      }).catch((error) => console.error(`[handoff] push not sent: ${error.message}`));
    })
  );

  /* The status changes that hand work on move the enquiry through the same door as the buttons. */
  subscribe(
    EVENTS.ENQUIRY_STATUS_CHANGED,
    safely('move with the status', async ({ enquiry, to, by }) => {
      const kind = STATUS_MOVES[to];
      if (kind) await moveOnBehalf(enquiry, kind, { by, status: to });
    })
  );

  /* The sales order released to the plant: Sales / SO is done, Production has it. */
  subscribe(
    EVENTS.ORDER_RELEASED,
    safely('production has the enquiry', async ({ orderId, by }) => {
      const { default: SalesOrder } = await import('../models/SalesOrder.js');
      const order = await SalesOrder.findById(orderId).select('number enquiry customerPo');
      if (!order?.enquiry) return;
      await moveWhenAt(order.enquiry, {
        at: ['po_so'], kind: 'ask_edd', by,
        fields: { poNumber: order.customerPo?.number, soNumber: order.number },
        note: `${order.number} released to production`,
      });
    })
  );

  /* The goods have left the plant: Invoice & Dispatch is done, the LR copy is next. */
  subscribe(
    EVENTS.DISPATCH_LEFT,
    safely('dispatch moves to the LR copy', async ({ dispatchId, by }) => {
      const { default: Dispatch } = await import('../models/Dispatch.js');
      const { default: SalesOrder } = await import('../models/SalesOrder.js');
      const dispatch = await Dispatch.findById(dispatchId).select('number order invoice transporter lines');
      const order = dispatch && await SalesOrder.findById(dispatch.order).select('enquiry');
      if (!order?.enquiry) return;
      const sent = (dispatch.lines || []).reduce((sum, line) => sum + (line.quantity || 0), 0);
      await moveWhenAt(order.enquiry, {
        at: ['invoice_dispatch'], kind: 'lr_copy', by,
        fields: { invoiceNumber: dispatch.invoice?.number, quantitySent: sent ? String(sent) : undefined, transporter: dispatch.transporter },
        note: `${dispatch.number} has left the plant`,
      });
    })
  );

  /* The last money is in and nothing is left to send: the enquiry is finished. */
  subscribe(
    EVENTS.PAYMENT_SETTLED,
    safely('close a paid enquiry', async ({ receivableId }) => {
      const { default: Receivable } = await import('../models/Receivable.js');
      const { default: SalesOrder } = await import('../models/SalesOrder.js');
      const { dispatchBalance } = await import('../services/enquiryGates.service.js');
      const { closeEnquiryAutomatically } = await import('../services/handoff.service.js');
      const settled = await Receivable.findById(receivableId).select('order');
      const order = settled && await SalesOrder.findById(settled.order).select('enquiry');
      if (!order?.enquiry) return;
      const enquiry = await Enquiry.findById(order.enquiry).populate('customer', 'code name');
      if (!enquiry || enquiry.stage === 'closed') return;

      const orders = await SalesOrder.find({ enquiry: enquiry._id, status: { $ne: 'cancelled' } }).select('_id');
      const owed = await Receivable.find({ order: { $in: orders.map((row) => row._id) } });
      if (!owed.length || owed.some((row) => row.balance > 0)) return;
      if ((await dispatchBalance(enquiry._id)).length) return;

      const total = owed.reduce((sum, row) => sum + (row.invoice?.value || 0), 0);
      await closeEnquiryAutomatically({
        enquiry,
        note: `Paid in full — ₹${Math.round(total).toLocaleString('en-IN')} received, nothing left to send.`,
      });
    })
  );

  /* A sample or a costing raised on an enquiry is that department taking it over. */
  subscribe(
    EVENTS.SAMPLE_CREATED,
    safely('sampling has the enquiry', async ({ sample }) => {
      if (sample?.enquiry) await moveOnBehalf(sample.enquiry, 'sample_request', { by: sample.requestedBy ? { _id: sample.requestedBy } : undefined });
    })
  );
  subscribe(
    EVENTS.PRICING_REQUESTED,
    safely('quotation has the enquiry', async ({ pricing, by }) => {
      if (pricing?.enquiry) await moveOnBehalf(pricing.enquiry, 'create_quotation', { by });
    })
  );
}
