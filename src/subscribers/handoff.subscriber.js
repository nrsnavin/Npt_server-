import User from '../models/User.js';
import Customer from '../models/Customer.js';
import Enquiry from '../models/Enquiry.js';
import { env } from '../config/env.js';
import { EVENTS, subscribe as busSubscribe, unsubscribe } from '../services/events.service.js';
import { describeHandoff } from '../services/handoff.service.js';
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
        details: `${await aboutOf(task)}${by?.name ? ` — from ${by.name}` : ''}. Due today.${task.notes ? ` "${task.notes.slice(0, 200)}"` : ''}`,
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

  subscribe(EVENTS.HANDOFF_DONE, backToSender('done'));
  subscribe(EVENTS.HANDOFF_RETURNED, backToSender('sent back'));
}
