import BuyerCard, { OPEN_CARD_STATUSES } from '../models/BuyerCard.js';
import Enquiry from '../models/Enquiry.js';
import { ownsRecord } from '../services/ownership.service.js';
import { assertTaskAnswers, sendHandoff } from '../services/handoff.service.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { isOwnershipScoped } from '../services/ownership.service.js';
import { assertCanOwnBuyer } from '../services/assignment.service.js';
import { streamOf } from '../services/storage.service.js';
import { cardFromUpload, confirmCard, discardCard } from '../services/buyerCard.service.js';
import { cardModelConfigured } from '../services/buyerCard.llm.js';
import { catalogue, shortlist } from '../services/modelCatalogue.service.js';
import { transactional } from '../utils/transaction.js';

/**
 * Cards to confirm: photos of new buyers the model has read, waiting for a person [BuyerCard.js].
 *
 * Marketing sees the cards they sent; management and administrators see every card. Confirming
 * one makes the customer and its first enquiry (buyerCard.service).
 */

const POPULATE = [
  { path: 'sender', select: 'name department' },
  { path: 'matchedCustomer', select: 'code name' },
  { path: 'customer', select: 'code name' },
  { path: 'enquiry', select: 'number status' },
  { path: 'decidedBy', select: 'name' },
];

const scope = (user) => (isOwnershipScoped(user) ? { sender: user._id } : {});

async function cardFor(req) {
  const card = await BuyerCard.findOne({ _id: req.params.id, ...scope(req.user) });
  if (!card) throw ApiError.notFound('Card not found');
  return card;
}

const asApi = (error) => {
  if (error.status === 400) return ApiError.badRequest(error.message);
  if (error.status === 409) return ApiError.conflict(error.message);
  if (error.status === 403) return ApiError.forbidden(error.message);
  return error;
};

export const listBuyerCards = asyncHandler(async (req, res) => {
  const open = req.query.status !== 'decided';
  const filter = { ...scope(req.user), status: open ? { $in: OPEN_CARD_STATUSES } : { $nin: OPEN_CARD_STATUSES } };
  const [data, waiting] = await Promise.all([
    BuyerCard.find(filter).populate(POPULATE).sort({ createdAt: -1 }).limit(100),
    BuyerCard.countDocuments({ ...scope(req.user), status: { $in: OPEN_CARD_STATUSES } }),
  ]);
  res.json({ success: true, data, waiting, reading: cardModelConfigured() });
});

/**
 * The plant's models, both masters in one list — the moulds made here and the trading items
 * bought in — for the model dropdown on a draft. `?search=` finds by code or name; `?ref=` reads
 * back one already picked (`m<id>` a mould, `t<id>` a trading item).
 */
export const draftModels = asyncHandler(async (req, res) => {
  const rows = await catalogue();
  const shown = (row) => ({ ref: row.ref, kind: row.kind, id: row.id, code: row.code, name: row.name || undefined });
  if (req.query.ref) {
    const row = rows.find((entry) => entry.ref === String(req.query.ref));
    if (!row) throw ApiError.notFound('That model is not on the master.');
    return res.json({ success: true, data: shown(row) });
  }
  const search = String(req.query.search || '').trim().toLowerCase().slice(0, 80);
  const PAGE = 20;
  let found;
  if (!search) found = [...rows].sort((a, b) => String(a.code).localeCompare(String(b.code)));
  else {
    /* What the code or name says outright first, then what the buyer's words could mean. */
    const plain = rows.filter((row) => `${row.code} ${row.name || ''}`.toLowerCase().includes(search));
    const likely = shortlist(search, rows, { limit: PAGE }).map((entry) => entry.row);
    found = [...new Map([...plain, ...likely].map((row) => [row.ref, row])).values()];
  }
  res.json({ success: true, data: found.slice(0, PAGE).map(shown), pagination: { total: found.length, limit: PAGE } });
});

export const getBuyerCard = asyncHandler(async (req, res) => {
  const card = await cardFor(req);
  res.json({ success: true, data: await card.populate(POPULATE) });
});

/** The picture — `?n=1`, `?n=2` for the later screenshots of a long chat. */
export const buyerCardImage = asyncHandler(async (req, res) => {
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

/**
 * The picture an enquiry was read from — the chat screenshot or the card — for whoever works the
 * enquiry, who is not always the colleague who sent it in [the dashboard's "View screenshot"].
 */
async function sourceCardOf(req) {
  const enquiry = await Enquiry.findById(req.params.id).select('assignedTo customer');
  if (!enquiry || !ownsRecord(req.user, enquiry)) throw ApiError.notFound('Enquiry not found');
  return BuyerCard.findOne({ enquiry: enquiry._id }).sort({ createdAt: 1 });
}

export const enquirySource = asyncHandler(async (req, res) => {
  const card = await sourceCardOf(req);
  res.json({
    success: true,
    data: card ? { kind: card.kind || 'card', images: 1 + (card.moreImages?.length || 0), at: card.createdAt } : null,
  });
});

export const enquirySourceImage = asyncHandler(async (req, res) => {
  const card = await sourceCardOf(req);
  if (!card) throw ApiError.notFound('This enquiry was not read from a picture');
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

export const uploadBuyerCard = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('Attach a photo of the card');
  const card = await cardFromUpload({
    sender: req.user,
    buffer: req.file.buffer,
    mimeType: req.file.mimetype,
    caption: req.body.caption ? String(req.body.caption).slice(0, 1000) : undefined,
  });
  res.status(201).json({ success: true, data: await card.populate(POPULATE) });
});

/**
 * Saving a draft: the customer and the enquiry — and, when the next step is a sample or a
 * quotation, that department's task on it, in the same save. The person saving has just read
 * the details through, so the enquiry is marked checked for the task to be raised [Enquiry
 * `checkPending`]; a task the department cannot take undoes the whole save.
 */
export const confirmBuyerCard = asyncHandler(transactional(async (req, res) => {
  const card = await cardFor(req);
  const { assignedTo, task, modelNumber, items, customer, ...edits } = req.body;
  const owner = assignedTo ? (await assertCanOwnBuyer(assignedTo))._id : undefined;
  /* The task's form first: a short one is said before the customer and enquiry are made. */
  if (task) assertTaskAnswers(task.kind, task.brief, task.note);
  let made;
  try {
    made = await confirmCard(card, req.user, edits, { owner, items, customer });
  } catch (error) {
    throw asApi(error);
  }
  let raised = null;
  if (made.enquiry && (modelNumber || task)) {
    const enquiry = await Enquiry.findById(made.enquiry._id).populate('customer', 'code name');
    if (modelNumber && !items?.length) enquiry.requirement = { ...(enquiry.requirement?.toObject?.() ?? enquiry.requirement ?? {}), modelNumber };
    if (task) {
      enquiry.checkedAt = new Date();
      enquiry.checkedBy = req.user._id;
    }
    await enquiry.save();
    if (task) {
      raised = await sendHandoff({ enquiry, kind: task.kind, note: task.note, brief: task.brief, user: req.user });
    }
    made.enquiry = enquiry;
  }
  res.json({
    success: true,
    data: { ...made, card: await (made.card || card).populate(POPULATE), task: raised ? { _id: raised._id, kind: raised.kind, title: raised.title } : null },
  });
}));

export const discardBuyerCard = asyncHandler(async (req, res) => {
  const card = await cardFor(req);
  try {
    await discardCard(card, req.user);
  } catch (error) {
    throw asApi(error);
  }
  res.json({ success: true, data: await card.populate(POPULATE) });
});
