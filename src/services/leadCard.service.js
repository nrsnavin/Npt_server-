import Lead from '../models/Lead.js';
import Customer from '../models/Customer.js';
import User from '../models/User.js';
import LeadCard, { OPEN_CARD_STATUSES } from '../models/LeadCard.js';
import { readCard } from './leadCard.llm.js';
import { put, bufferOf } from './storage.service.js';
import { fetchMedia, isWhatsAppConfigured, sendWhatsApp } from '../providers/twilio.js';
import { canOwnBuyer, nextInRotation } from './assignment.service.js';
import { nextNumber } from './numbering.service.js';
import { normalisePhone } from '../utils/phone.js';
import { env } from '../config/env.js';
import { syncFollowUpReminder } from '../subscribers/leadFollowUp.subscriber.js';
import { recordChange } from './audit.service.js';

/**
 * Leads from photos: a card sent to the WhatsApp number, or uploaded, read by the model, and
 * made a lead only when a person says so [house rule: the model never produces a stored fact].
 *
 * Only staff can send cards. A photo from a number that belongs to no active staff member is a
 * customer's message and goes to the WhatsApp inbox, exactly as it always has.
 */

const MOST_PHOTOS = 3;
const YES = /^\s*(y|yes|ok|okay|confirm|add)\s*[.!]*\s*$/i;
const NO = /^\s*(n|no|drop|discard|cancel)\s*[.!]*\s*$/i;

/** The active staff member this number belongs to, or null. */
export async function staffForNumber(number) {
  const phone = normalisePhone(number);
  if (!phone) return null;
  return User.findOne({ phone, isActive: { $ne: false } });
}

async function reply(to, body) {
  if (!to) return;
  if (!isWhatsAppConfigured()) {
    console.log(`\n[whatsapp] to ${to}\n${body}\n`);
    return;
  }
  await sendWhatsApp({ to, body }).catch((error) => console.error(`[lead-card] reply to ${to} not sent: ${error.message}`));
}

const cardLink = (card) => `${env.appUrl}/leads/cards?card=${card._id}`;

/** A lead or customer already holding this card's phone or email. */
async function existingFor(reading) {
  const phones = [reading.mobile, reading.whatsapp].filter(Boolean);
  const email = reading.email;
  if (!phones.length && !email) return {};
  const or = [
    ...phones.flatMap((phone) => [{ mobile: phone }, { whatsapp: phone }]),
    ...(email ? [{ email }] : []),
  ];
  const lead = await Lead.findOne({ $or: or, status: { $nin: ['converted', 'disqualified'] } }).select('number company assignedTo');
  const customer = lead ? null : await Customer.findOne({
    $or: [...or, ...phones.flatMap((phone) => [{ 'contacts.mobile': phone }, { 'contacts.whatsapp': phone }])],
  }).select('code name assignedTo');
  return { lead, customer };
}

function summary(reading) {
  const lines = [
    reading.company && `Company: ${reading.company}`,
    reading.contactName && `Name: ${reading.contactName}${reading.designation ? ` (${reading.designation})` : ''}`,
    reading.mobile && `Mobile: ${reading.mobile}`,
    reading.email && `Email: ${reading.email}`,
    (reading.city || reading.state) && `Place: ${[reading.city, reading.state].filter(Boolean).join(', ')}`,
    reading.productInterest && `Wants: ${reading.productInterest}`,
  ].filter(Boolean);
  return lines.join('\n');
}

/**
 * Reads a card and tells the sender what was read. Never throws — a card that cannot be read
 * waits for a person to type it in, and says why.
 */
export async function processCard(card, { notify = true } = {}) {
  try {
    const buffer = await bufferOf(card.imageKey);
    const { reading, problem } = buffer
      ? await readCard({ buffer, mimeType: card.mimeType, caption: card.caption })
      : { reading: {}, problem: 'The photo could not be opened.' };

    const { lead, customer } = await existingFor(reading);
    card.reading = reading;
    card.readBy = problem && !Object.keys(reading).length ? 'none' : 'model';
    card.problem = problem || undefined;
    card.matchedLead = lead?._id;
    card.matchedCustomer = customer?._id;
    card.status = problem && !reading.company ? 'unreadable' : 'ready';
    await card.save();

    if (notify && card.via === 'whatsapp') {
      if (card.status === 'unreadable') {
        await reply(card.from, `Got the photo, but ${problem.charAt(0).toLowerCase()}${problem.slice(1)}\nOpen it here: ${cardLink(card)}`);
      } else if (lead || customer) {
        const holder = lead ? `lead ${lead.number} (${lead.company})` : `customer ${customer.code} (${customer.name})`;
        await reply(card.from, `Read this card:\n${summary(reading)}\n\nThis buyer is already ${holder}, so nothing was added. Check it here: ${cardLink(card)}`);
      } else {
        await reply(card.from, `Read this card:\n${summary(reading)}\n\nReply YES to add it as a lead, or NO to drop it. To correct anything first: ${cardLink(card)}`);
      }
    }
  } catch (error) {
    console.error(`[lead-card] ${card._id} could not be processed: ${error.message}`);
    card.status = 'unreadable';
    card.readBy = 'none';
    card.problem = 'Something went wrong reading this card. Type the details in from the photo.';
    await card.save().catch(() => null);
  }
  return card;
}

/** A card taken from a photo the sender uploaded in the app. */
export async function cardFromUpload({ sender, buffer, mimeType, caption }) {
  const imageKey = await put({ buffer, mimeType });
  const card = await LeadCard.create({ sender: sender._id, via: 'upload', imageKey, mimeType, caption });
  return processCard(card, { notify: false });
}

/**
 * A message from a staff member's phone to the plant's number. Photos become cards; YES and NO
 * answer the latest card waiting on them. Returns null for anything else, which then goes to the
 * WhatsApp inbox as before.
 */
export async function handleStaffMessage({ staff, from, body, media = [], providerId }) {
  const photos = (media || []).filter((item) => /^image\//i.test(item.contentType || '')).slice(0, MOST_PHOTOS);

  if (photos.length) {
    const cards = [];
    for (const [index, photo] of photos.entries()) {
      const id = providerId ? `${providerId}:${index}` : undefined;
      if (id && (await LeadCard.exists({ providerId: id }))) continue;
      let image;
      try {
        image = await fetchMedia(photo.url);
      } catch (error) {
        console.error(`[lead-card] photo from ${from} not fetched: ${error.message}`);
        await reply(from, 'The photo could not be fetched. Please send it again.');
        continue;
      }
      const imageKey = await put({ buffer: image.buffer, mimeType: image.mimeType || photo.contentType });
      const card = await LeadCard.create({
        sender: staff._id, via: 'whatsapp', from, providerId: id, caption: body || undefined,
        imageKey, mimeType: image.mimeType || photo.contentType,
      }).catch((error) => (error.code === 11000 ? null : Promise.reject(error)));
      if (!card) continue;
      cards.push(card);
      /* After the webhook has answered: the provider waits fifteen seconds at most, and reading a
         card can take longer. The sender hears back on WhatsApp. */
      setImmediate(() => processCard(card).catch((error) => console.error(`[lead-card] ${error.message}`)));
    }
    return { outcome: 'lead_card', cards };
  }

  const text = String(body || '');
  const yes = YES.test(text);
  if (!yes && !NO.test(text)) return null;

  const card = await LeadCard.findOne({ sender: staff._id, status: 'ready', via: 'whatsapp' }).sort({ createdAt: -1 });
  if (!card) return null;

  if (!yes) {
    await discardCard(card, staff);
    await reply(from, 'Dropped. Nothing was added.');
    return { outcome: 'lead_card_discarded', card };
  }

  try {
    const lead = await confirmCard(card, staff, {});
    await reply(from, `Added lead ${lead.number} — ${lead.company}. ${env.appUrl}/leads/${lead._id}`);
    return { outcome: 'lead_card_confirmed', card, lead };
  } catch (error) {
    await reply(from, `Not added: ${error.message} Fix it here: ${cardLink(card)}`);
    return { outcome: 'lead_card_refused', card, why: error.message };
  }
}

/** Why a card cannot become a lead as it stands, or null. The same checks, however it is confirmed. */
export function confirmProblem(fields) {
  if (!fields.company || String(fields.company).trim().length < 2) return 'A lead needs a company name.';
  if (!fields.mobile && !fields.email && !fields.whatsapp) return 'A lead needs a phone number or an email to reach them on.';
  return null;
}

/**
 * Makes the card a lead, with the fields as a person has seen them — the reading, with whatever
 * they corrected laid over it. Refuses a buyer the plant already has, and a card already decided.
 */
export async function confirmCard(card, user, edits = {}, { owner } = {}) {
  if (!OPEN_CARD_STATUSES.includes(card.status) || card.status === 'reading') {
    const error = new Error(card.status === 'reading' ? 'This card is still being read.' : `This card was already ${card.status}.`);
    error.status = 409;
    throw error;
  }

  const fields = { ...(card.reading?.toObject?.() || card.reading || {}), ...edits };
  for (const key of ['mobile', 'whatsapp']) {
    if (fields[key]) {
      const phone = normalisePhone(fields[key]);
      if (!phone) {
        const error = new Error(`${fields[key]} is not a phone number.`);
        error.status = 400;
        throw error;
      }
      fields[key] = phone;
    }
  }
  const problem = confirmProblem(fields);
  if (problem) {
    const error = new Error(problem);
    error.status = 400;
    throw error;
  }

  const { lead: dupLead, customer: dupCustomer } = await existingFor(fields);
  if (dupLead || dupCustomer) {
    const error = new Error(dupLead
      ? `This buyer is already lead ${dupLead.number} (${dupLead.company}).`
      : `This buyer is already customer ${dupCustomer.code} (${dupCustomer.name}).`);
    error.status = 409;
    throw error;
  }

  /* The sender keeps it if they can hold a buyer; otherwise the marketing rotation does. */
  let assignedTo = owner;
  let rotated = null;
  if (!assignedTo) {
    const sender = await User.findById(card.sender);
    if (await canOwnBuyer(sender)) assignedTo = sender._id;
    else {
      const next = await nextInRotation();
      if (next) {
        assignedTo = next._id;
        rotated = next.name;
      } else assignedTo = sender?._id;
    }
  }

  const sender = await User.findById(card.sender).select('name');
  const lead = await Lead.create({
    number: await nextNumber('LEAD'),
    company: fields.company,
    contactName: fields.contactName,
    designation: fields.designation,
    mobile: fields.mobile,
    whatsapp: fields.whatsapp,
    email: fields.email,
    city: fields.city,
    state: fields.state,
    productInterest: fields.productInterest,
    source: edits.source || 'manual',
    assignedTo,
    status: 'new',
    visitingCardUrl: `/api/lead-cards/${card._id}/image`,
    nextAction: `Call ${fields.contactName || fields.company} — their card came in`,
    nextActionType: 'call',
    nextFollowUpDate: new Date(),
    activities: [
      {
        type: 'note',
        summary: [
          `From a card ${card.via === 'whatsapp' ? 'sent on WhatsApp' : 'uploaded'} by ${sender?.name || 'a colleague'}`,
          card.readBy === 'model' ? 'read by AI and checked by' : 'typed in by',
          `${user.name}.`,
          card.caption ? `Note with it: "${card.caption}"` : '',
          fields.notes ? `On the card: ${fields.notes}` : '',
        ].filter(Boolean).join(' '),
        createdBy: user._id,
      },
      ...(rotated ? [{ type: 'note', summary: `Assigned to ${rotated} by rotation` }] : []),
    ],
  });
  await syncFollowUpReminder(lead);

  card.status = 'confirmed';
  card.lead = lead._id;
  card.decidedBy = user._id;
  card.decidedAt = new Date();
  await card.save();
  await recordChange({ model: 'Lead', doc: lead, by: user, action: 'created', note: 'Created from a visiting card' });
  return lead;
}

export async function discardCard(card, user) {
  if (!OPEN_CARD_STATUSES.includes(card.status)) {
    const error = new Error(`This card was already ${card.status}.`);
    error.status = 409;
    throw error;
  }
  card.status = 'discarded';
  card.decidedBy = user._id;
  card.decidedAt = new Date();
  await card.save();
  return card;
}
