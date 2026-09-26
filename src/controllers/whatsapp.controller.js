import WhatsappThread, { CLOSED_THREAD_STATUSES, THREAD_STATUSES } from '../models/WhatsappThread.js';
import Customer from '../models/Customer.js';
import Lead from '../models/Lead.js';
import { receiveMessage } from '../services/whatsapp.inbox.js';
import { handleStaffMessage, staffForNumber } from '../services/leadCard.service.js';
import { createEnquiryRecord } from './pipeline.controller.js';
import { assertAssignable, assertCanOwnBuyer, marketingTeam } from '../services/assignment.service.js';
import {
  isOwnershipScoped, narrowToOwner, ownershipFilter, ownsRecord,
} from '../services/ownership.service.js';
import { recordChange, snapshot } from '../services/audit.service.js';
import { listParams, paginated } from '../utils/query.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import CustomerMessage from '../models/CustomerMessage.js';
import { isMetaWebhook, metaConfig, parseMetaWebhook, verifyMetaSignature } from '../providers/meta.js';
import { transactional } from '../utils/transaction.js';

/**
 * The WhatsApp inbox [BLUEPRINT §41].
 *
 * A screen marketing works down, not a log they occasionally read. So every endpoint here is
 * shaped around one of the four things §41 says happen to an inbound message — it is matched,
 * de-duplicated, assigned, and eventually converted — and the queue counts travel with the
 * rows, because a count fetched separately disagrees with the list under it the moment anything
 * else moves.
 *
 * The matching and de-duplication live in `whatsapp.inbox.js`, deliberately: they run from a
 * webhook with no user attached, and a rule that only exists inside an authenticated controller
 * is a rule the integration cannot use.
 */

const POPULATE = [
  { path: 'customer', select: 'code name city state assignedTo' },
  { path: 'lead', select: 'number company status' },
  { path: 'enquiry', select: 'number status' },
  { path: 'assignedTo', select: 'name' },
];

/* -------------------------------- The front door -------------------------------- */

/**
 * One message arriving at the plant's number, from whichever provider: a staff member's photo
 * becomes a lead card (leadCard.service), YES or NO answers the card waiting on them, and
 * everything else — every message from anybody else — goes to the inbox.
 */
async function takeMessage({ from, body, media, providerId, profileName, receivedAt }) {
  const staff = await staffForNumber(from);
  if (staff) {
    const handled = await handleStaffMessage({ staff, from, body, media, providerId });
    if (handled) return { outcome: handled.outcome, ...(handled.why ? { why: handled.why } : {}) };
  }

  const result = await receiveMessage({ from, body, media, providerId, profileName, receivedAt });
  return {
    outcome: result.outcome,
    ...(result.why ? { why: result.why } : {}),
    ...(result.thread ? { thread: result.thread._id } : {}),
  };
}

/**
 * Meta's one-time check when the webhook is registered: it sends the verify token it was given
 * and expects its challenge echoed back, as plain text.
 */
export const verifyWebhook = (req, res) => {
  const { verifyToken } = metaConfig();
  const mode = req.query['hub.mode'];
  const offered = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  /* Not set up for Meta: there is no webhook to verify here — not a server fault. */
  if (!verifyToken) return res.status(404).type('text/plain').send('Not found');
  if (mode !== 'subscribe' || offered !== verifyToken || !challenge) return res.status(403).type('text/plain').send('Forbidden');
  return res.status(200).type('text/plain').send(String(challenge));
};

/**
 * Meta's webhook: signed with the app secret over the exact bytes, carrying any number of
 * messages and delivery updates. A delivery update settles the send it belongs to — Meta only
 * says "accepted" when a message is sent, and a refusal (the 24-hour window, a number not on
 * WhatsApp) arrives here later, so this is where a sent message can still become a failed one.
 */
async function metaWebhook(req, res) {
  if (!metaConfig().appSecret) {
    throw new ApiError(503, 'The WhatsApp webhook is not configured — set META_WA_APP_SECRET.');
  }
  if (!verifyMetaSignature(req.rawBody, req.get('x-hub-signature-256'))) {
    throw ApiError.unauthorized('Bad webhook signature');
  }

  const { messages, statuses } = parseMetaWebhook(req.body);
  const outcomes = [];
  for (const message of messages) outcomes.push(await takeMessage(message));

  for (const update of statuses) {
    if (!update.id) continue;
    const change = { providerStatus: update.status };
    if (update.status === 'failed') Object.assign(change, { status: 'failed', error: update.error || 'WhatsApp could not deliver it.' });
    await CustomerMessage.updateMany({ channel: 'whatsapp', providerId: update.id }, { $set: change });
  }

  res.json({ success: true, outcomes, statuses: statuses.length });
}

/**
 * The provider's webhook. Unauthenticated by necessity, guarded by a secret.
 *
 * Meta signs its posts with the app secret; Twilio (and the plain JSON shape) carry the shared
 * token. There is no session and there never will be, so those are the only things standing
 * between this route and the open internet, and the route is mounted outside every module grant
 * for that reason — see the note where it is mounted.
 *
 * It answers 200 even for a message it refuses. That is not laziness: a provider reads a
 * non-2xx as "retry", so returning 4xx for a message we have decided not to keep buys an
 * endless redelivery loop for a message we did not want in the first place. What happened is
 * in the body, where a person debugging can read it.
 */
export const inboundWebhook = asyncHandler(async (req, res) => {
  if (isMetaWebhook(req.body)) return metaWebhook(req, res);

  const expected = process.env.WHATSAPP_WEBHOOK_TOKEN;
  if (!expected) {
    throw new ApiError(503, 'The WhatsApp webhook is not configured — set WHATSAPP_WEBHOOK_TOKEN.');
  }
  const offered = req.get('x-webhook-token') || req.query.token;
  if (offered !== expected) throw ApiError.unauthorized('Bad webhook token');

  /* Twilio's form fields, and a plain JSON shape beside them. */
  const payload = req.body || {};
  const media = [];
  const count = Number(payload.NumMedia || 0);
  for (let index = 0; index < count; index += 1) {
    const url = payload[`MediaUrl${index}`];
    if (url) media.push({ url, contentType: payload[`MediaContentType${index}`] });
  }

  /* `whatsapp:+9198…` is how Twilio addresses the channel; the number is what we key on. */
  const result = await takeMessage({
    from: String(payload.From || payload.from || '').replace(/^whatsapp:/i, ''),
    body: payload.Body ?? payload.body,
    media: media.length ? media : payload.media,
    providerId: payload.MessageSid || payload.messageId,
    profileName: payload.ProfileName || payload.profileName,
    receivedAt: payload.receivedAt,
  });

  res.json({ success: result.outcome !== 'rejected', ...result });
});

/* ---------------------------------- The inbox ---------------------------------- */

/** Which threads this person may see. Marketing sees their own [§29]; management sees all. */
const scopeFor = (req) => ownershipFilter(req.user);

export const listThreads = asyncHandler(async (req, res) => {
  const { page, limit, sort, filter } = listParams(req.query, {
    searchFields: ['number', 'profileName', 'lastMessagePreview'],
    defaultSort: '-lastMessageAt',
    sortable: ['lastMessageAt', 'createdAt', 'status', 'messageCount', 'number'],
  });

  const scope = scopeFor(req);
  Object.assign(filter, scope);

  const owner = narrowToOwner(scope, req.query.assignedTo);
  if (owner !== undefined) filter.assignedTo = owner;

  if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };
  /* The working inbox: everything not yet finished with. The default view of the screen. */
  if (req.query.open === 'true') filter.status = { $nin: CLOSED_THREAD_STATUSES };
  /* §41.5's Unassigned queue. A thread nobody owns is the one that goes unanswered. */
  if (req.query.unassigned === 'true') filter.assignedTo = { $eq: null };
  if (req.query.matchedBy) filter.matchedBy = req.query.matchedBy;

  const [rows, total, stages, unassigned] = await Promise.all([
    WhatsappThread.find(filter)
      .select('-messages')
      .populate(POPULATE)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit),
    WhatsappThread.countDocuments(filter),
    /*
     * The queue tally, over the reader's whole inbox rather than the queue they are looking at
     * — otherwise choosing "New" leaves every other chip reading zero and there is no way back.
     */
    WhatsappThread.aggregate([
      { $match: scope },
      { $group: { _id: '$status', leads: { $sum: 1 } } },
    ]),
    WhatsappThread.countDocuments({
      ...scope,
      assignedTo: { $eq: null },
      status: { $nin: CLOSED_THREAD_STATUSES },
    }),
  ]);

  paginated(res, rows, { page, limit, total }, {
    stageCounts: Object.fromEntries(stages.map((row) => [row._id, { leads: row.leads }])),
    unassigned,
  });
});

/**
 * Who a conversation can be handed to, and who is already holding some.
 *
 * Two questions in one reply because the screen asks both at once, and because they have
 * different answers. **Who holds threads** is the inbox's owner filter. **Who may take one** is
 * the §41.3 rotation, which is a different set: the person a conversation should go to next may
 * be holding none at all, so an assign picker built from the first list could never reach them.
 *
 * Both are scoped like every other list [§29], and the second one is the half worth arguing
 * about. A marketing person gets exactly one name in each — their own — which means their assign
 * control is "Take it" and nothing else. That is the right shape rather than a limitation: the
 * queue a marketing person needs to act on is Unassigned, and taking a conversation off it is
 * the whole action. Handing somebody else's conversation to a third person is a decision about
 * who owns an account, which is management's, and returning the roster to everyone so the UI
 * could offer a control most of them should not use would put every colleague's name and id on
 * a screen that is not allowed to show their records.
 */
export const threadOwners = asyncHandler(async (req, res) => {
  const scope = scopeFor(req);

  const [rows, roster] = await Promise.all([
    WhatsappThread.aggregate([
      { $match: { ...scope, status: { $nin: CLOSED_THREAD_STATUSES } } },
      { $group: { _id: '$assignedTo', open: { $sum: 1 } } },
    ]),
    marketingTeam(),
  ]);

  const counts = new Map(rows.map((row) => [String(row._id), row.open]));
  /* The scope, applied to people rather than to records — same rule, same one-name answer. */
  const team = isOwnershipScoped(req.user)
    ? roster.filter((person) => String(person._id) === String(req.user._id))
    : roster;

  res.json({
    success: true,
    /* Currently holding something, for the filter. */
    data: team
      .filter((person) => counts.has(String(person._id)))
      .map((person) => ({ _id: person._id, name: person.name, open: counts.get(String(person._id)) })),
    /* Able to hold something, for the assign picker. */
    team: team.map((person) => ({
      _id: person._id,
      name: person.name,
      open: counts.get(String(person._id)) || 0,
    })),
    /* Said outright rather than left to be inferred from a total that will not add up. */
    unassigned: counts.get('null') || counts.get('undefined') || 0,
  });
});

export const getThread = asyncHandler(async (req, res) => {
  const thread = await WhatsappThread.findById(req.params.id).populate(POPULATE);
  if (!thread) throw ApiError.notFound('Conversation not found');
  if (!ownsRecord(req.user, thread)) throw ApiError.notFound('Conversation not found');

  res.json({ success: true, data: thread });
});

/**
 * Opening a conversation marks it read.
 *
 * Separate from `getThread` because reading is a side effect and a GET that writes is one
 * nobody expects — a link preview or a retry would silently clear somebody's unread flag.
 */
export const markRead = asyncHandler(async (req, res) => {
  const thread = await WhatsappThread.findById(req.params.id);
  if (!thread) throw ApiError.notFound('Conversation not found');
  if (!ownsRecord(req.user, thread)) throw ApiError.notFound('Conversation not found');

  thread.readAt = new Date();
  thread.readBy = req.user._id;
  await thread.save();
  await thread.populate(POPULATE);

  res.json({ success: true, data: thread });
});

/**
 * Assignment, status, notes, and attaching the conversation to a record it belongs to.
 *
 * Linking a customer by hand is the escape hatch for the case matching cannot solve: a buyer
 * messaging from a number nobody has on file. Doing it here rather than making somebody edit
 * the customer record first is the point — the number goes onto the customer as their WhatsApp
 * number at the same time, so the *next* message from them matches by itself and this is a
 * one-off rather than a chore.
 */
export const updateThread = asyncHandler(async (req, res) => {
  const thread = await WhatsappThread.findById(req.params.id);
  if (!thread) throw ApiError.notFound('Conversation not found');
  if (!ownsRecord(req.user, thread)) throw ApiError.notFound('Conversation not found');

  const before = snapshot(thread);
  const { assignedTo, status, notes, customer, lead } = req.body;

  if (assignedTo !== undefined) {
    /* The thread's owner is who the lead it becomes will belong to. */
    if (assignedTo) await assertCanOwnBuyer(assignedTo);
    thread.assignedTo = assignedTo;
    /* No longer the rotation's doing once a person has chosen. */
    thread.assignedByRotation = false;
  }

  if (status !== undefined) {
    if (!THREAD_STATUSES.includes(status)) throw ApiError.badRequest('That is not a queue');
    /*
     * Converted is not a status somebody sets — it is what raising an enquiry does. Letting it
     * be typed would produce threads marked converted with no enquiry behind them, and the
     * inbox would then be lying about the one thing it exists to track.
     */
    if (status === 'converted' && !thread.enquiry) {
      throw ApiError.badRequest('A conversation is converted by raising an enquiry from it');
    }
    thread.status = status;
  }

  if (notes !== undefined) thread.notes = notes;

  if (customer !== undefined) {
    const record = await Customer.findById(customer);
    if (!record) throw ApiError.badRequest('That customer does not exist');
    if (!ownsRecord(req.user, record)) {
      throw ApiError.forbidden('That customer belongs to another marketing person');
    }
    thread.customer = record._id;
    thread.matchedBy = 'customer';
    /* The conversation follows the account [§29] unless somebody has already taken it. */
    if (!thread.assignedTo) thread.assignedTo = record.assignedTo;

    /*
     * So the next message from this number matches without anybody doing this again — which is
     * the entire justification for linking by hand here rather than sending somebody to edit
     * the customer record.
     *
     * The first version of this only filed the number when the customer had **no** phone number
     * at all, and that is the case that almost never happens: a customer on file has an office
     * mobile, and the buyer messaging is a person at that company whose WhatsApp is a different
     * number. So the link was remembered for nobody and the chore came back with every message.
     *
     * Two places it can go, and both are already in the matcher's lookup [§41.2]:
     *
     * - The customer's own `whatsapp`, when that is empty. Their `mobile` is a different fact
     *   about the same company and is left alone — overwriting a phone number with a WhatsApp
     *   number loses something nobody asked to lose.
     * - Otherwise a contact, because the company already has a WhatsApp number on file and this
     *   is a second person at it. Named from the sender's own profile so the record says who,
     *   falling back to the number itself rather than inventing a name.
     */
    const known = [record.whatsapp, record.mobile, ...(record.contacts || []).flatMap(
      (contact) => [contact.whatsapp, contact.mobile]
    )].filter(Boolean);

    if (!known.includes(thread.number)) {
      if (!record.whatsapp) {
        record.whatsapp = thread.number;
      } else {
        record.contacts.push({
          name: thread.profileName || thread.number,
          whatsapp: thread.number,
          /* Not primary: somebody who messaged once is not automatically the main contact. */
          isPrimary: false,
        });
      }
      await record.save();
    }
  }

  if (lead !== undefined) {
    const record = await Lead.findById(lead);
    if (!record) throw ApiError.badRequest('That lead does not exist');
    if (!ownsRecord(req.user, record)) {
      throw ApiError.forbidden('That lead belongs to another marketing person');
    }
    thread.lead = record._id;
    if (thread.matchedBy === 'unknown') thread.matchedBy = 'lead';
    if (!thread.assignedTo) thread.assignedTo = record.assignedTo;
  }

  await thread.save();
  await recordChange({ model: 'WhatsappThread', doc: thread, before, by: req.user });
  await thread.populate(POPULATE);

  res.json({ success: true, data: thread });
});

/**
 * The conversion §41.4 asks for: a qualified conversation becomes an enquiry **without
 * re-entering core data**.
 *
 * The customer, the owner and the origin come off the thread; what the caller supplies is the
 * requirement, which is the part that was never in the system — a buyer saying "400mm shirt
 * hanger, 40,000, need it by Diwali" over WhatsApp has told you the requirement in prose, and
 * somebody still has to turn that into a quantity and a model from the register [§28].
 *
 * The conversation reference goes onto the enquiry so the history stays reachable from the
 * record [§41.6]: six weeks later, "what did they actually ask for" is answered from the
 * enquiry rather than from somebody's personal chat.
 */
export const convertToEnquiry = asyncHandler(transactional(async (req, res) => {
  const thread = await WhatsappThread.findById(req.params.id);
  if (!thread) throw ApiError.notFound('Conversation not found');
  if (!ownsRecord(req.user, thread)) throw ApiError.notFound('Conversation not found');

  if (thread.enquiry) {
    throw ApiError.conflict('This conversation has already been converted');
  }
  if (!thread.customer) {
    /*
     * Said as the next step rather than as a refusal. An unknown number is the ordinary case
     * for a new buyer, and "link a customer first" is a thing the same screen can do.
     */
    throw ApiError.badRequest(
      'Link this conversation to a customer before raising an enquiry from it'
    );
  }

  const customer = await Customer.findById(thread.customer);
  if (!customer) throw ApiError.badRequest('That customer no longer exists');
  if (!ownsRecord(req.user, customer)) {
    throw ApiError.forbidden('That customer belongs to another marketing person');
  }

  const enquiry = await createEnquiryRecord(
    {
      ...req.body,
      customer: customer._id,
      /* The conversation's owner keeps it. They are the one who has been talking to the buyer. */
      assignedTo: thread.assignedTo || customer.assignedTo,
      source: 'whatsapp',
      conversation: { provider: 'whatsapp', reference: thread.number },
    },
    req.user
  );

  const before = snapshot(thread);
  thread.enquiry = enquiry._id;
  thread.status = 'converted';
  await thread.save();
  await recordChange({
    model: 'WhatsappThread',
    doc: thread,
    before,
    by: req.user,
    note: `Converted to enquiry ${enquiry.number}`,
  });
  await thread.populate(POPULATE);

  res.status(201).json({ success: true, data: enquiry, thread });
}));
