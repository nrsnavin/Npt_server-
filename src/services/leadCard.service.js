import Lead from '../models/Lead.js';
import Customer from '../models/Customer.js';
import User from '../models/User.js';
import LeadCard, { OPEN_CARD_STATUSES } from '../models/LeadCard.js';
import { hasIdentity, readCard } from './leadCard.llm.js';
import { put, bufferOf } from './storage.service.js';
import { fetchMedia, isWhatsAppConfigured, sendWhatsApp } from '../providers/whatsapp.js';
import { canOwnBuyer, nextInRotation } from './assignment.service.js';
import { nextNumber } from './numbering.service.js';
import { normalisePhone } from '../utils/phone.js';
import { env } from '../config/env.js';
import { syncFollowUpReminder } from '../subscribers/leadFollowUp.subscriber.js';
import { recordChange } from './audit.service.js';

/**
 * Draft leads from pictures: a card or a chat screenshot sent to the WhatsApp number, or uploaded,
 * read by the model into a draft. The draft holds only what was recognised in the picture; the
 * rest — the next step, when to follow up, how we met them — is the salesperson's to fill in, and
 * the draft becomes a lead only when they do [house rule: the model never produces a stored fact].
 *
 * Only staff can send cards. A photo from a number that belongs to no active staff member is a
 * customer's message and goes to the WhatsApp inbox, exactly as it always has.
 */

const MOST_PHOTOS = 3;
/* A screenshot with no header, sent within this long of a chat's first, is the rest of that chat. */
const SAME_CHAT_MINUTES = 10;

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

function summary(reading, { companyFromName } = {}) {
  const lines = [
    reading.company && `Company: ${reading.company}${companyFromName ? ' (the person\'s name — no business was named)' : ''}`,
    reading.contactName && reading.contactName !== reading.company && `Name: ${reading.contactName}${reading.designation ? ` (${reading.designation})` : ''}`,
    reading.mobile && `Mobile: ${reading.mobile}`,
    reading.email && `Email: ${reading.email}`,
    (reading.city || reading.state) && `Place: ${[reading.city, reading.state].filter(Boolean).join(', ')}`,
    reading.productInterest && `Wants: ${reading.productInterest}`,
    reading.estimatedQuantity && `Quantity: ${Number(reading.estimatedQuantity).toLocaleString('en-IN')} pcs`,
    reading.notes && `Notes: ${reading.notes}`,
  ].filter(Boolean);
  return lines.join('\n');
}

const what = (card) => (card.kind === 'chat' ? 'this chat' : 'this card');

/**
 * The WhatsApp message that tells the sender what was recognised. It saves a draft and says so —
 * finishing the lead is theirs to do, in the app.
 */
async function tellSender(card) {
  if (card.via !== 'whatsapp') return;
  const reading = card.reading?.toObject?.() || card.reading || {};
  const read = summary(reading, { companyFromName: card.companyFromName });
  if (card.status === 'unreadable') {
    const problem = card.problem || 'it could not be read.';
    await reply(card.from, `Saved as a draft lead, but ${problem.charAt(0).toLowerCase()}${problem.slice(1)}${read ? `\n\nWhat could be read:\n${read}` : ''}\n\nFill it in here: ${cardLink(card)}`);
    return;
  }
  const [lead, customer] = await Promise.all([
    card.matchedLead ? Lead.findById(card.matchedLead).select('number company') : null,
    card.matchedCustomer ? Customer.findById(card.matchedCustomer).select('code name') : null,
  ]);
  const already = lead
    ? `\n\nNote: this buyer is already lead ${lead.number} (${lead.company}).`
    : customer ? `\n\nNote: this buyer is already customer ${customer.code} (${customer.name}).` : '';
  await reply(card.from, `Saved as a draft lead from ${what(card)}:\n${read}${already}\n\nFinish it in the app — add the next step and anything the picture did not show: ${cardLink(card)}`);
}

/** Marks who already holds this buyer, if anybody. */
async function matchExisting(card) {
  const { lead, customer } = await existingFor(card.reading?.toObject?.() || card.reading || {});
  card.matchedLead = lead?._id;
  card.matchedCustomer = customer?._id;
}

/**
 * The chat an unheaded screenshot belongs to: the same person's chat screenshot from the last
 * few minutes that is still waiting. Null when there is none — the screenshot then stands alone.
 */
async function chatItContinues(card) {
  return LeadCard.findOne({
    _id: { $ne: card._id },
    sender: card.sender,
    kind: 'chat',
    status: { $in: ['ready', 'unreadable'] },
    createdAt: { $gte: new Date(Date.now() - SAME_CHAT_MINUTES * 60000) },
  }).sort({ createdAt: -1 });
}

/** Folds a later screenshot's reading into the chat it continues: blanks filled, notes added to. */
function mergeInto(target, reading, image) {
  const current = target.reading?.toObject?.() || target.reading || {};
  const merged = { ...current };
  for (const [key, value] of Object.entries(reading)) {
    if (key === 'notes') continue;
    if (merged[key] === undefined || merged[key] === '' || merged[key] === null) merged[key] = value;
  }
  if (reading.notes) merged.notes = [current.notes, reading.notes].filter(Boolean).join(' ').slice(0, 600);
  target.reading = merged;
  target.moreImages = [...(target.moreImages || []), image];
}

/**
 * Reads a card and tells the sender what was read. Never throws — a card that cannot be read
 * waits for a person to type it in, and says why.
 */
export async function processCard(card, { notify = true } = {}) {
  try {
    const buffer = await bufferOf(card.imageKey);
    const { kind, reading, problem } = buffer
      ? await readCard({ buffer, mimeType: card.mimeType, caption: card.caption })
      : { kind: null, reading: {}, problem: 'The picture could not be opened.' };

    /* The rest of a long chat: no header, so no buyer — it belongs with the screenshot that had one. */
    if (kind === 'chat' && !hasIdentity(reading)) {
      const target = await chatItContinues(card);
      if (target) {
        mergeInto(target, reading, { imageKey: card.imageKey, mimeType: card.mimeType });
        await matchExisting(target);
        await target.save();
        await LeadCard.deleteOne({ _id: card._id });
        if (notify) await tellSender(target);
        return target;
      }
    }

    card.kind = kind || undefined;
    card.reading = reading;
    /* A chat names a person more often than a business. The lead still needs a company, so the
       person's name stands in — and the reply and the screen say so before anybody confirms. */
    if (!reading.company && reading.contactName) {
      card.reading = { ...reading, company: reading.contactName };
      card.companyFromName = true;
    }
    card.readBy = problem && !Object.keys(reading).length ? 'none' : 'model';
    card.problem = problem
      || (kind === 'chat' && !hasIdentity(reading)
        ? 'This screenshot does not show who the buyer is. Send the one with their name or number at the top, or reply with their number.'
        : undefined);
    card.status = card.problem && !card.reading.company ? 'unreadable' : 'ready';
    await matchExisting(card);
    await card.save();

    if (notify) await tellSender(card);
  } catch (error) {
    console.error(`[lead-card] ${card._id} could not be processed: ${error.message}`);
    card.status = 'unreadable';
    card.readBy = 'none';
    card.problem = 'Something went wrong reading this picture. Type the details in from it.';
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
 * A message from a staff member's phone to the plant's number. Pictures become draft leads.
 * Returns null for anything else, which then goes to the WhatsApp inbox as before.
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
        image = await fetchMedia(photo);
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

  /* Anything else a colleague sends goes to the inbox, as before. Drafts are finished in the app. */
  return null;
}

/** Why a card cannot become a lead as it stands, or null. The same checks, however it is confirmed. */
export function confirmProblem(fields) {
  if (!fields.company || String(fields.company).trim().length < 2) return 'A lead needs a company name.';
  if (!fields.mobile && !fields.email && !fields.whatsapp) return 'A lead needs a phone number or an email to reach them on.';
  if (!String(fields.nextAction || '').trim()) return 'Say what the next step is.';
  if (!fields.nextFollowUpDate) return 'Say when to follow up.';
  const due = new Date(fields.nextFollowUpDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (Number.isNaN(due.getTime()) || due < today) return 'The follow-up date cannot be in the past.';
  if (!fields.source) return 'Say how we met them.';
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
    estimatedQuantity: fields.estimatedQuantity || undefined,
    estimatedValue: fields.estimatedValue || undefined,
    source: fields.source,
    assignedTo,
    status: 'new',
    visitingCardUrl: `/api/lead-cards/${card._id}/image`,
    /* The salesperson's own next step — not one the app made up. */
    nextAction: String(fields.nextAction).trim(),
    nextActionType: fields.nextActionType || 'call',
    nextFollowUpDate: new Date(fields.nextFollowUpDate),
    activities: [
      {
        type: 'note',
        summary: [
          `From a ${card.kind === 'chat' ? 'WhatsApp chat screenshot' : 'card'} ${card.via === 'whatsapp' ? 'sent on WhatsApp' : 'uploaded'} by ${sender?.name || 'a colleague'}`,
          card.readBy === 'model' ? 'read by AI, checked and completed by' : 'typed in by',
          `${user.name}.`,
          card.caption ? `Note with it: "${card.caption}"` : '',
          fields.notes ? `${card.kind === 'chat' ? 'The conversation' : 'On the card'}: ${fields.notes}` : '',
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
