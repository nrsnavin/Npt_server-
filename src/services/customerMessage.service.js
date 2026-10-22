import CustomerMessage from '../models/CustomerMessage.js';
import Customer from '../models/Customer.js';
import Enquiry from '../models/Enquiry.js';
import { TEMPLATES, contextFor, render } from './customerMessage.templates.js';
import { sendEmail } from './notification.service.js';
import { isWhatsAppConfigured, sendWhatsApp } from '../providers/whatsapp.js';
import { isProduction } from '../config/env.js';
import { customerEmail } from './emailSignature.js';
import Attachment from '../models/Attachment.js';
import { bufferOf } from './storage.service.js';
import { publicApiBaseWithoutRequest, signedPath } from '../utils/signedLink.js';

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

/** The notices that carry the finished-piece photos: the buyer approves from a picture of what is coming. */
const WITH_PHOTOS = new Set(['sample_ready', 'sample_ready_collect', 'sample_dispatched']);

/** A signed link to one finished-piece photo, for WhatsApp, which fetches media by URL. Lapses in 30 days. */
export const samplePhotoUrl = (attachment, baseUrl = publicApiBaseWithoutRequest()) =>
  `${baseUrl}/public/sample-photos${signedPath('sample-photo', String(attachment._id), attachment.filename || 'sample.jpg')}`;

/**
 * The finished-piece photos in the bag, one per model row that has one [Sample items `photo`],
 * with the row's model beside each — or none, for a notice that carries no pictures.
 */
export async function photosFor(sample, event) {
  if (!WITH_PHOTOS.has(event)) return [];
  const rows = (sample.items || []).filter((row) => row.photo);
  if (!rows.length) return [];
  const ids = rows.map((row) => row.photo?._id || row.photo);
  const files = await Attachment.find({ _id: { $in: ids } }).select('key filename mimeType size').lean();
  const byId = new Map(files.map((file) => [String(file._id), file]));
  return rows
    .map((row) => ({ model: row.modelNumber || null, attachment: byId.get(String(row.photo?._id || row.photo)) }))
    .filter((entry) => entry.attachment)
    .map((entry) => ({ ...entry, filename: entry.attachment.filename || `${entry.model || 'sample'}.jpg`, key: entry.attachment.key }));
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

  const photos = (await photosFor(sample, event)).map((photo) => ({ model: photo.model, key: photo.key, filename: photo.filename }));
  return { ...draft, customer, channels, alreadySent, photos };
}

/** One record per channel, whether or not anything left the building. */
const record = (base, extra) => CustomerMessage.create({ ...base, ...extra });

async function deliver({ channel, address, draft, event, context, photos = [] }) {
  if (channel === 'email') {
    /* The finished pieces ride on the email, one picture per model. */
    const attachments = [];
    for (const photo of photos) {
      const content = await bufferOf(photo.key).catch(() => null);
      if (content) attachments.push({ filename: photo.filename, content, contentType: photo.attachment.mimeType });
    }
    const result = await sendEmail({
      to: address,
      subject: draft.subject,
      /* Signed with the plant's footer [services/emailSignature.js]. */
      ...customerEmail(draft.body),
      ...(attachments.length ? { attachments } : {}),
    });
    return { providerId: result.messageId, providerStatus: result.delivered ? 'sent' : 'logged', ...(attachments.length ? { photos: attachments.length } : {}) };
  }

  const template = TEMPLATES[event];
  const contentSid = template.contentSid();

  /*
   * WhatsApp carries one picture a message: the words go with the first photo, each further model
   * follows on its own, named. The buyer's phone fetches each from a signed link.
   */
  const parts = photos.length
    ? photos.map((photo, index) => ({ body: index === 0 ? draft.body : (photo.model || 'Sample'), document: { url: samplePhotoUrl(photo.attachment), filename: photo.filename } }))
    : [{ body: draft.body }];
  let first;
  for (const [index, part] of parts.entries()) {
    const result = await sendWhatsApp({
      to: address,
      body: part.body,
      /* The approved template carries the words; a photo that follows is a plain media message. */
      template: index === 0 ? contentSid : undefined,
      variables: index === 0 && contentSid ? template.variables(context) : undefined,
      document: part.document,
    });
    first = first || result;
  }

  return { providerId: first.id, providerStatus: first.status, usedTemplate: Boolean(contentSid), photos: photos.length };
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
  const photos = await photosFor(sample, event);

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
      console.log(`\n[whatsapp] to ${address}\n${draft.body}${photos.map((photo) => `\n${samplePhotoUrl(photo.attachment)}`).join('')}\n`);
      results.push(await record(base, { channel, status: 'sent', recipient: address, ...draft, providerStatus: 'logged', ...(photos.length ? { photos: photos.length } : {}) }));
      continue;
    }

    try {
      const delivery = await deliver({ channel, address, draft, event, context, photos });
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
