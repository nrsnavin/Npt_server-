import LeadCard, { OPEN_CARD_STATUSES } from '../models/LeadCard.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { isOwnershipScoped } from '../services/ownership.service.js';
import { assertCanOwnBuyer } from '../services/assignment.service.js';
import { streamOf } from '../services/storage.service.js';
import { cardFromUpload, confirmCard, discardCard } from '../services/leadCard.service.js';
import { cardModelConfigured } from '../services/leadCard.llm.js';

/**
 * Cards to confirm: photos of leads the model has read, waiting for a person [LeadCard.js].
 *
 * Marketing sees the cards they sent; management and administrators see every card. A card is
 * made a lead here or by a YES on WhatsApp, and the same checks run either way (leadCard.service).
 */

const POPULATE = [
  { path: 'sender', select: 'name department' },
  { path: 'matchedLead', select: 'number company assignedTo' },
  { path: 'matchedCustomer', select: 'code name' },
  { path: 'lead', select: 'number company' },
  { path: 'decidedBy', select: 'name' },
];

const scope = (user) => (isOwnershipScoped(user) ? { sender: user._id } : {});

async function cardFor(req) {
  const card = await LeadCard.findOne({ _id: req.params.id, ...scope(req.user) });
  if (!card) throw ApiError.notFound('Card not found');
  return card;
}

const asApi = (error) => {
  if (error.status === 400) return ApiError.badRequest(error.message);
  if (error.status === 409) return ApiError.conflict(error.message);
  return error;
};

export const listLeadCards = asyncHandler(async (req, res) => {
  const open = req.query.status !== 'decided';
  const filter = { ...scope(req.user), status: open ? { $in: OPEN_CARD_STATUSES } : { $nin: OPEN_CARD_STATUSES } };
  const [data, waiting] = await Promise.all([
    LeadCard.find(filter).populate(POPULATE).sort({ createdAt: -1 }).limit(100),
    LeadCard.countDocuments({ ...scope(req.user), status: { $in: OPEN_CARD_STATUSES } }),
  ]);
  res.json({ success: true, data, waiting, reading: cardModelConfigured() });
});

export const getLeadCard = asyncHandler(async (req, res) => {
  const card = await cardFor(req);
  res.json({ success: true, data: await card.populate(POPULATE) });
});

/** The picture — `?n=1`, `?n=2` for the later screenshots of a long chat. */
export const leadCardImage = asyncHandler(async (req, res) => {
  const card = await cardFor(req);
  const n = Number(req.query.n) || 0;
  const image = n === 0 ? card : card.moreImages?.[n - 1];
  if (!image) throw ApiError.notFound('Photo not found');
  const stream = streamOf(image.imageKey);
  if (!stream) throw ApiError.notFound('Photo not found');
  res.setHeader('Content-Type', image.mimeType);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

export const uploadLeadCard = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('Attach a photo of the card');
  const card = await cardFromUpload({
    sender: req.user,
    buffer: req.file.buffer,
    mimeType: req.file.mimetype,
    caption: req.body.caption ? String(req.body.caption).slice(0, 1000) : undefined,
  });
  res.status(201).json({ success: true, data: await card.populate(POPULATE) });
});

export const confirmLeadCard = asyncHandler(async (req, res) => {
  const card = await cardFor(req);
  const { assignedTo, ...edits } = req.body;
  const owner = assignedTo ? (await assertCanOwnBuyer(assignedTo))._id : undefined;
  let lead;
  try {
    lead = await confirmCard(card, req.user, edits, { owner });
  } catch (error) {
    throw asApi(error);
  }
  res.json({ success: true, data: { card: await card.populate(POPULATE), lead } });
});

export const discardLeadCard = asyncHandler(async (req, res) => {
  const card = await cardFor(req);
  try {
    await discardCard(card, req.user);
  } catch (error) {
    throw asApi(error);
  }
  res.json({ success: true, data: await card.populate(POPULATE) });
});
