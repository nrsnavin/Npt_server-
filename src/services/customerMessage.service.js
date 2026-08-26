import CustomerMessage from '../models/CustomerMessage.js';
import Customer from '../models/Customer.js';
import Enquiry from '../models/Enquiry.js';
import { TEMPLATES, contextFor, render } from './customerMessage.templates.js';
import { sendEmail } from './notification.service.js';
import { isWhatsAppConfigured, sendWhatsApp } from '../providers/twilio.js';
import { isProduction } from '../config/env.js';

/**
 * Sending an update to a customer, and recording that it happened [BLUEPRINT §42].
 *
 * The blueprint's core rule is that an internal status change must not reach a customer on
 * its own — a person picks the update, previews a draft, edits it and confirms. This
 * organisation has asked for the two sample stages to go automatically instead, so the
 * decision is inverted for those: the message goes without a human, and everything else §42
 * asks for is kept. Only customer-safe fields feed the draft, every send is audited, and a
 * second attempt is refused rather than duplicated.
 *
 * Whether a stage sends itself is a property of the stage, so turning one back into a manual
 * send is a one-line change rather than a rewrite. See AUTOMATIC below.
 */

/** The stages that message the customer without waiting for anyone. */
export const AUTOMATIC = new Set(['sample_ready', 'sample_dispatched']);

/** Loads the three records a message is built from, whatever the caller already has. */
async function resolve(sample) {
  const [customer, enquiry] = await Promise.all([
    sample.populated('customer') ? sample.customer : Customer.findById(sample.customer),
    sample.populated('enquiry') ? sample.enquiry : Enquiry.findById(sample.enquiry),
  ]);
  return { customer, enquiry };
}

/** The address a channel would use, or nothing if the customer has not given us one. */
const addressFor = (channel, customer) =>
  channel === 'whatsapp' ? customer?.whatsapp || customer?.mobile : customer?.email;

/**
 * Builds the draft a person would see before sending, without sending it [§42].
 *
 * The preview endpoint and the automatic path render the same thing from the same context,
 * so what a person approves is what the automation would have sent.
 */
export async function previewFor(sample, event) {
  const { customer, enquiry } = await resolve(sample);
  const draft = render(event, contextFor({ sample, enquiry, customer }));

  const channels = ['whatsapp', 'email'].map((channel) => ({
    channel,
    address: addressFor(channel, customer),
    enabled: customer?.notifications?.[channel] !== false,
  }));

  const alreadySent = await CustomerMessage.find({
    sample: sample._id,
    event,
    status: 'sent',
  })
    .populate('sentBy', 'name')
    .sort('-sentAt');

  return { ...draft, customer, channels, alreadySent };
}

/** One record per channel, whether or not anything left the building. */
const record = (base, extra) => CustomerMessage.create({ ...base, ...extra });

async function deliver({ channel, address, draft, event, context }) {
  if (channel === 'email') {
    const result = await sendEmail({
      to: address,
      subject: draft.subject,
      text: draft.body,
      html: `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;white-space:pre-wrap">${draft.body
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')}</div>`,
    });
    return { providerId: result.messageId, providerStatus: result.delivered ? 'sent' : 'logged' };
  }

  const template = TEMPLATES[event];
  const contentSid = template.contentSid();

  const result = await sendWhatsApp({
    to: address,
    body: draft.body,
    contentSid,
    contentVariables: contentSid ? template.variables(context) : undefined,
  });

  return { providerId: result.sid, providerStatus: result.status, usedTemplate: Boolean(contentSid) };
}

/**
 * Sends one update on every channel the customer accepts, and logs the outcome per channel.
 *
 * Never throws. A customer notification is a side effect of work that already happened —
 * the sample really is ready — so a provider outage must not undo it or fail the request
 * that triggered it. Failures land in the log, where they can be seen and re-sent.
 */
export async function notifyCustomer({
  sample,
  event,
  user = null,
  channels,
  body,
  subject,
  force = false,
}) {
  if (!TEMPLATES[event]) throw new Error(`No customer message template for ${event}`);

  const { customer, enquiry } = await resolve(sample);
  if (!customer) return [];

  const context = contextFor({ sample, enquiry, customer });
  const generated = render(event, context);
  const draft = { subject: subject ?? generated.subject, body: body ?? generated.body };
  const edited = Boolean((body && body !== generated.body) || (subject && subject !== generated.subject));

  const base = {
    customer: customer._id,
    enquiry: enquiry?._id,
    sample: sample._id,
    event,
    sentBy: user?._id,
    automatic: !user,
    edited,
  };

  const wanted = channels?.length ? channels : ['whatsapp', 'email'];
  const results = [];

  for (const channel of wanted) {
    const address = addressFor(channel, customer);

    // A customer who has said no is not messaged, whoever asked.
    if (customer.notifications?.[channel] === false) {
      results.push(await record(base, { channel, status: 'skipped', skipReason: 'opted_out' }));
      continue;
    }
    if (!address) {
      results.push(await record(base, { channel, status: 'skipped', skipReason: 'no_address' }));
      continue;
    }

    // The duplicate-send rule [§42.7]: telling a customer twice is worse than not at all.
    if (!force) {
      const previous = await CustomerMessage.findOne({
        sample: sample._id,
        event,
        channel,
        status: 'sent',
      });
      if (previous) {
        results.push(await record(base, { channel, status: 'skipped', skipReason: 'already_sent', recipient: address }));
        continue;
      }
    }

    if (channel === 'whatsapp' && !isWhatsAppConfigured()) {
      // Outside production a missing provider logs rather than fails, exactly as OTP does,
      // so the whole flow is exercisable without a WhatsApp account.
      if (isProduction) {
        results.push(await record(base, { channel, status: 'skipped', skipReason: 'no_provider', recipient: address }));
        continue;
      }
      console.log(`\n[whatsapp] to ${address}\n${draft.body}\n`);
      results.push(await record(base, { channel, status: 'sent', recipient: address, ...draft, providerStatus: 'logged' }));
      continue;
    }

    try {
      const delivery = await deliver({ channel, address, draft, event, context });
      results.push(await record(base, { channel, status: 'sent', recipient: address, ...draft, ...delivery }));
    } catch (error) {
      console.error(`[customer-message] ${event} on ${channel} failed:`, error.message);
      results.push(
        await record(base, {
          channel,
          status: 'failed',
          recipient: address,
          ...draft,
          error: error.message,
        })
      );
    }
  }

  return results;
}
