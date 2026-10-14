import CustomerMessage from '../models/CustomerMessage.js';
import Customer from '../models/Customer.js';
import Enquiry from '../models/Enquiry.js';
import { company } from '../config/company.js';
import { isProduction } from '../config/env.js';
import { findHandoff } from '../config/handoffs.js';
import { sendEmail } from './notification.service.js';
import { bufferOf } from './storage.service.js';
import { recipientOf } from './quotationMessage.js';
import { isWhatsAppConfigured, sendWhatsApp, whatsappTemplate } from '../providers/whatsapp.js';
import { normalisePhone } from '../utils/phone.js';
import { signedPath } from '../utils/signedLink.js';
import { customerEmail } from './emailSignature.js';

/**
 * The work a department uploaded, sent to the buyer — Dispatch's LR copy, by email (attached)
 * and WhatsApp (as a document fetched from a signed link) [config/departmentTaskForms.js
 * `sendResult`]. Every channel is logged as a customer message, sent, skipped or failed, so
 * "you never sent the LR" is answerable from the record.
 *
 * Never throws: the upload already happened, and a provider being down must not undo it. The
 * results say what went and what did not.
 */


/** The public link WhatsApp fetches the file from. */
export const publicFileUrl = (baseUrl, attachment) =>
  `${baseUrl}/public/files${signedPath('task-file', attachment._id, attachment.filename || 'document')}`;

export function draftFor({ title, enquiry, customer, task }) {
  const name = recipientOf(customer).name || customer?.name || 'Sir / Madam';
  const invoice = task.brief?.invoiceNumber ? ` (invoice ${task.brief.invoiceNumber})` : '';
  const about = `${enquiry?.number || 'your order'}${invoice}`;
  return {
    subject: `${title} — ${about} — ${company.name}`,
    body: `Dear ${name},\n\nYour goods for ${about} have been dispatched. Please find the ${title} attached.\n\nThank you,\n${company.name}\n${company.phone}`,
    name,
    about,
  };
}

export async function sendResultToCustomer({ task, attachment, user, baseUrl }) {
  const form = findHandoff(task.kind)?.form || {};
  const title = form.resultTitle || 'document';
  const enquiry = await Enquiry.findById(task.enquiry?._id || task.enquiry).select('number customer').lean();
  const customer = await Customer.findById(enquiry?.customer || task.customer);
  if (!customer) return [];
  const recipient = recipientOf(customer);
  const draft = draftFor({ title, enquiry, customer, task });
  const base = { customer: customer._id, enquiry: enquiry?._id, task: task._id, event: `${task.kind}_sent`, sentBy: user?._id, subject: draft.subject, body: draft.body };
  const results = [];

  /* Email, with the file attached. */
  const email = String(recipient.email || '').trim().toLowerCase();
  if (customer.notifications?.email === false) {
    results.push(await CustomerMessage.create({ ...base, channel: 'email', status: 'skipped', skipReason: 'opted_out' }));
  } else if (!email) {
    results.push(await CustomerMessage.create({ ...base, channel: 'email', status: 'skipped', skipReason: 'no_address' }));
  } else {
    try {
      const content = await bufferOf(attachment.key);
      const sent = await sendEmail({
        to: email,
        subject: draft.subject,
        /* Signed with the plant's footer [services/emailSignature.js]. */
        ...customerEmail(draft.body),
        attachments: content ? [{ filename: attachment.filename, content, contentType: attachment.mimeType }] : [],
      });
      results.push(await CustomerMessage.create({
        ...base, channel: 'email', recipient: email, status: 'sent', providerId: sent.messageId, providerStatus: sent.delivered ? 'sent' : 'logged',
      }));
    } catch (error) {
      results.push(await CustomerMessage.create({ ...base, channel: 'email', recipient: email, status: 'failed', error: error.message }));
    }
  }

  /* WhatsApp, with the file as a document from a signed link. */
  const phone = recipient.whatsapp ? normalisePhone(recipient.whatsapp) : '';
  const link = publicFileUrl(baseUrl, attachment);
  if (customer.notifications?.whatsapp === false) {
    results.push(await CustomerMessage.create({ ...base, channel: 'whatsapp', status: 'skipped', skipReason: 'opted_out' }));
  } else if (!phone) {
    results.push(await CustomerMessage.create({ ...base, channel: 'whatsapp', status: 'skipped', skipReason: 'no_address' }));
  } else if (!isWhatsAppConfigured()) {
    if (isProduction) {
      results.push(await CustomerMessage.create({ ...base, channel: 'whatsapp', recipient: phone, status: 'skipped', skipReason: 'no_provider' }));
    } else {
      /* Outside production a missing provider logs, as every other customer message does. */
      console.log(`\n[whatsapp] to ${phone}\n${draft.body}\n${link}\n`);
      results.push(await CustomerMessage.create({ ...base, channel: 'whatsapp', recipient: phone, status: 'sent', providerStatus: 'logged' }));
    }
  } else {
    try {
      const templateSid = whatsappTemplate(form.sendResult?.whatsappTemplate);
      const sent = await sendWhatsApp({
        to: phone,
        body: draft.body,
        document: { url: link, filename: attachment.filename },
        ...(templateSid ? { template: templateSid, variables: { 1: draft.name, 2: draft.about, 3: link } } : {}),
      });
      results.push(await CustomerMessage.create({
        ...base, channel: 'whatsapp', recipient: phone, status: 'sent', providerId: sent.id, providerStatus: sent.status, usedTemplate: Boolean(templateSid),
      }));
    } catch (error) {
      results.push(await CustomerMessage.create({ ...base, channel: 'whatsapp', recipient: phone, status: 'failed', error: error.message }));
    }
  }
  return results;
}
