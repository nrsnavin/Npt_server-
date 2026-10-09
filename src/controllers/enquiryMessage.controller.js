import Enquiry from '../models/Enquiry.js';
import Customer from '../models/Customer.js';
import CustomerMessage from '../models/CustomerMessage.js';
import Sample from '../models/Sample.js';
import WhatsappThread from '../models/WhatsappThread.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { ownsRecord } from '../services/ownership.service.js';
import { canRead } from '../services/access.service.js';
import { mayHandOff } from '../services/handoff.service.js';
import { sendEmail } from '../services/notification.service.js';
import { isWhatsAppConfigured, sendWhatsApp } from '../providers/whatsapp.js';
import { isProduction } from '../config/env.js';
import { QUEUE_STATUSES } from './sampleDashboard.controller.js';

/**
 * Writing to the buyer from the enquiry, on the company's WhatsApp number and the company's
 * mail, and the enquiry's activity timeline.
 *
 * **The conversation is the owner's.** Only the marketing person the enquiry is assigned to
 * sends from here and reads what was said. Everyone else who may open the enquiry — Admin, a
 * department holding it — sees that a message went, when and by whom, on the timeline, and
 * not its words. The buyer is talking to their account manager, not to the plant.
 */

/** The event a hand-written message is logged under, beside the automatic sample notices. */
export const DIRECT_MESSAGE = 'direct_message';

const isOwner = (user, enquiry) =>
  Boolean(enquiry.assignedTo) && String(enquiry.assignedTo._id || enquiry.assignedTo) === String(user._id);

async function readable(req) {
  const enquiry = await Enquiry.findById(req.params.id);
  if (!enquiry) throw ApiError.notFound('Enquiry not found');
  const mayRead = canRead(req.user, 'enquiries')
    ? ownsRecord(req.user, enquiry)
    : await mayHandOff(req.user, enquiry);
  if (!mayRead) throw ApiError.notFound('Enquiry not found');
  return enquiry;
}

const addressFor = (channel, customer) =>
  channel === 'whatsapp' ? customer?.whatsapp || customer?.mobile : customer?.email;

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/**
 * Sends one message to the buyer and records it twice: the words in the customer message log
 * (the owner's conversation), and the fact of it on the enquiry's call log (everyone's timeline).
 */
export const sendEnquiryMessage = asyncHandler(async (req, res) => {
  const enquiry = await readable(req);
  if (!isOwner(req.user, enquiry)) {
    throw ApiError.forbidden('Only the person this enquiry is assigned to writes to the buyer from here');
  }

  const { channel, subject, body } = req.body;
  const customer = await Customer.findById(enquiry.customer);
  const address = addressFor(channel, customer);
  if (!address) {
    throw ApiError.badRequest(
      channel === 'whatsapp'
        ? `${customer?.name || 'This buyer'} has no WhatsApp or mobile number on their record`
        : `${customer?.name || 'This buyer'} has no email address on their record`
    );
  }
  if (channel === 'whatsapp' && !isWhatsAppConfigured() && isProduction) {
    throw ApiError.badRequest('The company WhatsApp number is not connected yet');
  }

  const base = {
    customer: customer._id,
    enquiry: enquiry._id,
    event: DIRECT_MESSAGE,
    channel,
    recipient: address,
    subject: channel === 'email' ? subject : undefined,
    body,
    sentBy: req.user._id,
  };

  let delivery;
  try {
    if (channel === 'email') {
      const result = await sendEmail({
        to: address,
        subject,
        text: body,
        html: `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;white-space:pre-wrap">${escapeHtml(body)}</div>`,
      });
      delivery = { providerId: result.messageId, providerStatus: result.delivered ? 'sent' : 'logged' };
    } else if (!isWhatsAppConfigured()) {
      /* Outside production a missing provider logs rather than fails, as the sample notices do. */
      console.log(`\n[whatsapp] to ${address}\n${body}\n`);
      delivery = { providerStatus: 'logged' };
    } else {
      const result = await sendWhatsApp({ to: address, body });
      delivery = { providerId: result.id, providerStatus: result.status };
    }
  } catch (error) {
    await CustomerMessage.create({ ...base, status: 'failed', error: error.message });
    throw error.status ? error : new ApiError(502, `The ${channel === 'email' ? 'email' : 'WhatsApp'} did not go: ${error.message}`);
  }

  const message = await CustomerMessage.create({ ...base, status: 'sent', ...delivery });

  const at = new Date();
  enquiry.activities.push({
    type: channel,
    /* The fact, not the words: this line is read by Admin and the departments too. */
    note: channel === 'email' ? 'Email sent from the company mail' : 'WhatsApp sent from the company number',
    spokeTo: customer.name,
    at,
    by: req.user._id,
  });
  enquiry.lastActivityAt = at;
  await enquiry.save();

  res.status(201).json({ success: true, data: await message.populate('sentBy', 'name') });
});

/**
 * The conversation with the buyer on this enquiry: what went out — by hand and automatically —
 * and what came back on WhatsApp. The owner's only; anyone else gets the timeline instead.
 */
export const listEnquiryMessages = asyncHandler(async (req, res) => {
  const enquiry = await readable(req);
  if (!isOwner(req.user, enquiry)) {
    return res.json({ success: true, data: [], meta: { mayRead: false } });
  }

  const [outbound, threads] = await Promise.all([
    CustomerMessage.find({ enquiry: enquiry._id, status: { $ne: 'skipped' } })
      .populate('sentBy', 'name')
      .sort('-sentAt')
      .limit(100)
      .lean(),
    WhatsappThread.find({ customer: enquiry.customer }).select('messages number').lean(),
  ]);

  const inbound = threads.flatMap((thread) =>
    (thread.messages || []).map((message) => ({
      _id: message._id,
      direction: 'in',
      channel: 'whatsapp',
      body: message.body,
      at: message.receivedAt,
      from: thread.number,
    }))
  );

  const data = [
    ...outbound.map((message) => ({
      _id: message._id,
      direction: 'out',
      channel: message.channel,
      subject: message.subject,
      body: message.body,
      at: message.sentAt,
      status: message.status,
      automatic: message.automatic,
      by: message.sentBy?.name || null,
      to: message.recipient,
    })),
    ...inbound,
  ]
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 100);

  res.json({ success: true, data, meta: { mayRead: true } });
});

const queueLabel = (status) =>
  QUEUE_STATUSES.find((entry) => entry.statuses.includes(status))?.label || status;

/**
 * Everything that happened on the enquiry, newest first: stage moves, calls and messages,
 * hand-overs between marketing people, and each sample's moves on the bench in the sampling
 * team's own words.
 *
 * Message *words* are not here — see the note at the top. A sample move carries its note,
 * and the request it was raised with, because that is the bench's instruction, not the buyer's
 * conversation.
 */
export const enquiryTimeline = asyncHandler(async (req, res) => {
  const enquiry = await readable(req);
  await enquiry.populate([
    { path: 'activities.by', select: 'name' },
    { path: 'statusHistory.by', select: 'name' },
    { path: 'handovers.from handovers.to handovers.by', select: 'name' },
  ]);

  const samples = await Sample.find({ enquiry: enquiry._id })
    .select('number statusHistory items modelNumber material colour colourMandatory quantity remarks deliveryMethod courier awbNumber handedTo createdAt')
    .populate('statusHistory.by', 'name')
    .lean();

  const automatic = await CustomerMessage.find({ enquiry: enquiry._id, automatic: true, status: 'sent' })
    .select('event channel sentAt')
    .lean();

  const entries = [];

  for (const move of enquiry.statusHistory || []) {
    entries.push({
      kind: 'stage', at: move.at, from: move.from || null, to: move.to, note: move.note || null,
      by: move.by?.name || null,
    });
  }
  for (const activity of enquiry.activities || []) {
    entries.push({
      kind: 'activity', at: activity.at, type: activity.type, note: activity.note,
      spokeTo: activity.spokeTo || null, by: activity.by?.name || null,
    });
  }
  for (const handover of enquiry.handovers || []) {
    entries.push({
      kind: 'handover', at: handover.at, from: handover.from?.name || null, to: handover.to?.name || null,
      note: handover.note || null, by: handover.by?.name || null,
    });
  }
  for (const sample of samples) {
    const items = sample.items?.length ? sample.items : [sample];
    const request = [
      sample.remarks,
      items
        .map((item) => [
          item.modelNumber || 'New model',
          [item.material?.toUpperCase(), item.colour?.toUpperCase()].filter(Boolean).join(' : ') || null,
          item.colour ? (item.colourMandatory ? 'Exact colour' : 'Preferred colour') : null,
          `${item.quantity || 1} pcs`,
        ].filter(Boolean).join(' — '))
        .join('; '),
    ].filter(Boolean).join(' | ');

    for (const move of sample.statusHistory || []) {
      let detail = move.note || null;
      /* Arriving, the request is the instruction the bench works to — that is what to show. */
      if (move.to === 'request_received') detail = request || detail;
      if (move.to === 'dispatched' && !detail) {
        detail = sample.deliveryMethod === 'direct'
          ? `Handed over to ${sample.handedTo || 'the buyer'}`
          : [sample.courier, sample.awbNumber].filter(Boolean).join(' · ') || null;
      }
      entries.push({
        kind: 'sample', at: move.at, department: 'Sampling Team', sample: sample.number,
        title: queueLabel(move.to), status: move.to, note: detail, by: move.by?.name || null,
      });
    }
    /* When it arrived, whether or not the history opened with it. */
    if (!sample.statusHistory?.some((move) => move.to === 'request_received')) {
      entries.push({
        kind: 'sample', at: sample.createdAt, department: 'Sampling Team', sample: sample.number,
        title: queueLabel('request_received'), status: 'request_received', note: request, by: null,
      });
    }
  }
  for (const message of automatic) {
    entries.push({ kind: 'notice', at: message.sentAt, event: message.event, channel: message.channel });
  }

  entries.sort((a, b) => new Date(b.at) - new Date(a.at));
  res.json({ success: true, data: entries.slice(0, 300) });
});
