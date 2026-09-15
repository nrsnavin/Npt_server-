import WhatsappThread, { CLOSED_THREAD_STATUSES, THREAD_STATUSES } from '../models/WhatsappThread.js';
import Customer from '../models/Customer.js';
import Lead from '../models/Lead.js';
import { receiveMessage } from '../services/whatsapp.inbox.js';
import { createEnquiryRecord } from './pipeline.controller.js';
import { assertAssignable } from '../services/assignment.service.js';
import { ownershipFilter, ownsRecord } from '../services/ownership.service.js';
import { recordChange, snapshot } from '../services/audit.service.js';
import { listParams, paginated } from '../utils/query.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';

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
 * The provider's webhook. Unauthenticated by necessity, guarded by a shared secret.
 *
 * Twilio posts here; there is no session and there never will be. So the only thing standing
 * between this route and the open internet is the token, and the route is mounted outside every
 * module grant for that reason — see the note where it is mounted.
 *
 * It answers 200 even for a message it refuses. That is not laziness: a provider reads a
 * non-2xx as "retry", so returning 4xx for a message we have decided not to keep buys an
 * endless redelivery loop for a message we did not want in the first place. What happened is
 * in the body, where a person debugging can read it.
 */
export const inboundWebhook = asyncHandler(async (req, res) => {
  const expected = process.env.WHATSAPP_WEBHOOK_TOKEN;
  if (!expected) {
    throw new ApiError(503, 'The WhatsApp webhook is not configured — set WHATSAPP_WEBHOOK_TOKEN.');
  }
  const offered = req.get('x-webhook-token') || req.query.token;
  if (offered !== expected) throw ApiError.unauthorized('Bad webhook token');

  /*
   * Twilio's form fields, and a plain JSON shape beside them. Two providers is the ordinary
   * case for this kind of integration and the mapping is three lines, so it is done here rather
   * than in a provider abstraction that would have exactly one implementation.
   */
  const payload = req.body || {};
  const media = [];
  const count = Number(payload.NumMedia || 0);
  for (let index = 0; index < count; index += 1) {
    const url = payload[`MediaUrl${index}`];
    if (url) media.push({ url, contentType: payload[`MediaContentType${index}`] });
  }

  const result = await receiveMessage({
    /* `whatsapp:+9198…` is how Twilio addresses the channel; the number is what we key on. */
    from: String(payload.From || payload.from || '').replace(/^whatsapp:/i, ''),
    body: payload.Body ?? payload.body,
    media: media.length ? media : payload.media,
    providerId: payload.MessageSid || payload.messageId,
    profileName: payload.ProfileName || payload.profileName,
    receivedAt: payload.receivedAt,
  });

  res.json({
    success: result.outcome !== 'rejected',
    outcome: result.outcome,
    ...(result.why ? { why: result.why } : {}),
    ...(result.thread ? { thread: result.thread._id } : {}),
  });
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
    await assertAssignable(assignedTo);
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

    /* So the next message from this number matches without anybody doing this again. */
    if (!record.whatsapp && !record.mobile) {
      record.whatsapp = thread.number;
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
export const convertToEnquiry = asyncHandler(async (req, res) => {
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
});
