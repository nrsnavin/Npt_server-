import Quotation, {
  CLOSED_QUOTATION_STATUSES, UNSENT_STATUSES, settleLine,
} from '../models/Quotation.js';
import Enquiry from '../models/Enquiry.js';
import Customer from '../models/Customer.js';
import Mould, { MATERIALS, mouldWithPhoto } from '../models/Mould.js';
import Material, { grammageFrom } from '../models/Material.js';
import Component from '../models/Component.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { fileSafeNumber, nextQuoteNumber } from '../services/numbering.service.js';
import { listParams, paginated } from '../utils/query.js';
import { expectVersion, withoutVersion } from '../utils/concurrency.js';
import { recordChange, snapshot } from '../services/audit.service.js';
import { EVENTS, publish } from '../services/events.service.js';
import { priceFrom } from '../services/pricing.service.js';
import { narrowToOwner, ownershipFilter, ownsRecord } from '../services/ownership.service.js';
import { assertCanOwnBuyer } from '../services/assignment.service.js';
import { renderQuotationPdf } from '../services/quotationPdf.js';
import { bufferOf } from '../services/storage.service.js';
import { allVisibleTo, assertMayCost, seesCosting, visibleTo } from '../services/pricingVisibility.js';
import { hasRequirement } from '../models/requirement.schema.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import CustomerMessage from '../models/CustomerMessage.js';
import { draftQuoteMessages, recipientOf, sendProblem } from '../services/quotationMessage.js';
import { sendEmail } from '../services/notification.service.js';
import { requireEnquiry } from '../services/enquiryLink.service.js';
import { isWhatsAppConfigured, sendWhatsApp, whatsappTemplate } from '../providers/whatsapp.js';
import { env, isProduction } from '../config/env.js';
import { normalisePhone } from '../utils/phone.js';
import { transactional } from '../utils/transaction.js';

/**
 * Quotations — the costing and the offer on one record [BLUEPRINT §7–§10; models/Quotation.js].
 *
 * The work goes:
 *
 *   1. Raised on an enquiry — by Create Quotation, by the enquiry reaching pricing, or by hand.
 *      One line per model the enquiry asks about, prefilled from the registers.
 *   2. Costed, line by line, by the Quotation department (`/lines/:lineId/cost`). The price on
 *      the line defaults to cost at its markup.
 *   3. A price under its line's minimum waits on Admin (`/lines/:lineId/decision`) [§9].
 *   4. Sent — by marketing or the Quotation department, whoever gets to it.
 *   5. Revised after sending, every revision kept [§10]; answered by the buyer.
 *
 * Two walls run through it. **Cost is hidden from marketing** [§8]: every reply goes through
 * `visibleTo`, and only `assertMayCost` may write a cost. **Marketing sees their own** [§29]:
 * the quotation is ownership-scoped like the enquiry it belongs to.
 */

/** How many models one quotation may carry. Past this it is a price list. */
export const MAX_LINES = 20;

const REGISTER_FIELDS = {
  materialRef: 'name code type colour ratePerKg grammageFactorPercent',
  hookRef: 'name code colour ratePerPiece kind',
  clipRef: 'name code colour ratePerPiece kind',
  printRef: 'name code colour ratePerPiece kind',
};

const POPULATE = [
  { path: 'customer', select: 'code name assignedTo', populate: { path: 'assignedTo', select: 'name' } },
  { path: 'enquiry', select: 'number status stage requirement targetPrice' },
  { path: 'assignedTo', select: 'name' },
  mouldWithPhoto(
    'lines.mould',
    'mouldCode name category sizeMm hookType moq packingQty ' +
      'cavities activeCavities partWeightGrams runnerWeightGrams ' +
      'regrindRecoveryPercent cycleTimeSeconds efficiencyPercent status material machine'
  ),
  ...Object.entries(REGISTER_FIELDS).map(([ref, select]) => ({ path: `lines.${ref}`, select })),
  { path: 'requestedBy', select: 'name' },
  { path: 'costedBy', select: 'name' },
  { path: 'lines.approvedBy', select: 'name' },
];

const isAdmin = (user) => user?.role === 'admin' || user?.department === 'management';

/* ------------------------------ Building a line ------------------------------ */

/**
 * Everything a costing takes from the tool, the resin and the parts registers.
 *
 * Grams per piece come from the tool's consumption figure, converted onto the resin's grammage
 * basis; the resin rate and the parts' rates are *copied*, so a rate that moves next month does
 * not reach back into a price already given. A typed figure still wins — see `costLine`.
 */
export function costingFrom(mould, material, parts = {}) {
  const filled = {};
  if (mould) {
    filled.gramWeight = grammageFrom(mould.consumptionPerPieceGrams, material?.grammageFactorPercent);
    filled.jobWorkCost = mould.jobWorkCost || 0;
    filled.hookCost = mould.hookCost || 0;
    filled.metalClipsCost = mould.clipsCost || 0;
    filled.printingCost = mould.printingCost || 0;
    filled.packingCost = mould.packingCost || 0;
  }
  if (material) filled.rawMaterialRate = material.ratePerKg;
  if (parts.hook) filled.hookCost = parts.hook.ratePerPiece;
  if (parts.clip) filled.metalClipsCost = parts.clip.ratePerPiece;
  if (parts.print) filled.printingCost = parts.print.ratePerPiece;
  return filled;
}

/** The parts named on a request, refusing one not on its register or of the wrong kind. */
async function partsFrom(body) {
  const wanted = [['hook', body.hookRef], ['clip', body.clipRef], ['print', body.printRef]].filter(([, id]) => id);
  if (!wanted.length) return {};

  const found = await Component.find({ _id: { $in: wanted.map(([, id]) => id) } });
  const byId = new Map(found.map((row) => [String(row._id), row]));
  const parts = {};
  for (const [kind, id] of wanted) {
    const row = byId.get(String(id));
    if (!row) throw ApiError.badRequest(`That ${kind} is not on the register`);
    if (row.kind !== kind) throw ApiError.badRequest(`${row.name} is a ${row.kind}, not a ${kind}`);
    parts[kind] = row;
  }
  return parts;
}

/**
 * A new line, from a request or an enquiry item, with the registers resolved and the cost
 * prefilled. A price given with it is the offer; without one the line waits for costing.
 */
async function lineFrom(input = {}, { fallbackModel } = {}) {
  const mouldId = input.mould || undefined;
  const mould = mouldId ? await Mould.findById(mouldId) : null;
  if (mouldId && !mould) throw ApiError.badRequest('That mould is not on the register');

  const material = input.materialRef ? await Material.findById(input.materialRef) : null;
  if (input.materialRef && !material) throw ApiError.badRequest('That material is not on the register');

  const parts = await partsFrom(input);

  const line = {
    mould: mould?._id,
    materialRef: material?._id,
    hookRef: parts.hook?._id,
    clipRef: parts.clip?._id,
    printRef: parts.print?._id,
    modelNumber: String(input.modelNumber || fallbackModel || mould?.mouldCode || '').trim() || undefined,
    material: input.material || (MATERIALS.includes(material?.type) ? material.type : undefined) || mould?.material,
    procurement: input.procurement,
    printing: input.printing,
    markupPercent: input.markupPercent,
    cost: costingFrom(mould, material, parts),
    quantity: input.quantity,
    moq: input.moq ?? mould?.moq ?? 0,
    colour: input.colour,
    remarks: input.remarks,
    unitPrice: input.unitPrice ?? undefined,
    status: 'requested',
  };
  if (!line.mould && !line.modelNumber) {
    throw ApiError.badRequest('Name the model on every line — a mould or a model number');
  }
  return line;
}

/** A model named only by its tool counts — "the 420, same as last time". */
const describesItem = (row) => Boolean(row?.mould || hasRequirement(row));

/** The enquiry's models, one line each, with the registers its requirement names. */
export function linesForEnquiry(enquiry) {
  const items = (enquiry.items || []).filter(describesItem);
  const rows = items.length ? items : [enquiry.requirement || {}];
  /* A model the buyer described rather than named is called by its description, or the enquiry. */
  const described = (item) =>
    [item.category, item.sizeMm && `${item.sizeMm}mm`].filter(Boolean).join(' ') || `As per ${enquiry.number}`;
  return rows.map((item, index) => ({
    mould: item.mould || (index === 0 ? enquiry.mould : undefined),
    modelNumber: item.modelNumber || (item.mould || (index === 0 && enquiry.mould) ? undefined : described(item)),
    materialRef: item.materialRef,
    hookRef: item.hookRef,
    clipRef: item.clipRef,
    printRef: item.printRef,
    material: item.material,
    colour: item.colour,
  }));
}

/** The line a route names by `:lineId`. */
function lineOf(quotation, req) {
  const line = quotation.lines.id(req.params.lineId);
  if (!line) throw ApiError.notFound('That line is not on this quotation');
  return line;
}

/* ------------------------------ Rules on the document ------------------------------ */

/** A validity date that has already gone is refused at every door that sets one. */
function assertValidityAhead(value) {
  if (value === undefined || value === null || value === '') return;
  const until = new Date(value);
  if (Number.isNaN(until.getTime())) return;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (until < today) {
    throw ApiError.badRequest(
      'A quotation cannot be given a validity date that has already passed — it would be expired before it was sent.'
    );
  }
}

/** An enquiry of its own buyer, and an owner only an administrator chooses. */
async function assertQuotationLinks(user, { customerId, enquiryId, assignedTo, owner }) {
  if (enquiryId) {
    const enquiry = await Enquiry.findById(enquiryId).select('customer');
    if (!enquiry) throw ApiError.badRequest('That enquiry does not exist');
    if (String(enquiry.customer) !== String(customerId)) {
      throw ApiError.badRequest('That enquiry is for a different customer');
    }
  }
  if (assignedTo && String(assignedTo) !== String(owner)) {
    if (user.role !== 'admin') throw ApiError.forbidden('Only an administrator can change who a record belongs to');
    await assertCanOwnBuyer(assignedTo);
  }
}

/** What the buyer reads on a line — change any of it after sending and it is a new offer. */
const OFFER_FIELDS = ['modelNumber', 'quantity', 'moq', 'colour', 'unitPrice'];
const DOCUMENT_FIELDS = ['gstPercent', 'isExport', 'paymentTerms', 'deliveryTerms', 'freightTerms', 'packing', 'validUntil', 'remarks'];

const offerOf = (lines = []) =>
  JSON.stringify(lines.map((line) => OFFER_FIELDS.map((field) => String(line[field] ?? ''))));

/** The offer as it stands, frozen for the history [§10]. Only what the buyer reads. */
function snapshotOf(quotation, revision, user, at = new Date()) {
  return {
    revision,
    lines: quotation.lines.map((line) => ({
      mould: line.mould?._id || line.mould,
      modelNumber: line.modelNumber,
      quantity: line.quantity,
      moq: line.moq,
      colour: line.colour,
      unitPrice: line.unitPrice,
      remarks: line.remarks,
    })),
    validUntil: quotation.validUntil,
    paymentTerms: quotation.paymentTerms,
    deliveryTerms: quotation.deliveryTerms,
    freightTerms: quotation.freightTerms,
    packing: quotation.packing,
    remarks: quotation.remarks,
    at,
    by: user?._id,
  };
}

/** Rev 0 follows a quotation until it first goes out; from then on it is what the buyer saw. */
function followRevisionZero(quotation, user) {
  if (!quotation.sentAt && quotation.revision === 0) {
    quotation.revisions = [snapshotOf(quotation, 0, user, quotation.revisions?.[0]?.at)];
  }
}

/**
 * Applying the lines a request sends to the lines on the quotation.
 *
 * A line with an `_id` is that line: its offer fields (and the model, before sending) change in
 * place, so its cost stays with it. A line without one is new. A line left out is dropped —
 * before sending only. Any line whose price moved is settled again [§9].
 */
async function applyLines(quotation, incoming, { sent }) {
  const kept = new Set();
  const next = [];
  /*
   * A row without its id is matched by its model, or by position when there is one line on each
   * side — so a revision that restates "NH-400 at ₹7.30" keeps the cost behind NH-400.
   */
  const unclaimed = (line) => !kept.has(String(line._id));
  const identify = (row) => {
    if (row._id) return quotation.lines.id(row._id);
    if (row.modelNumber) {
      const same = quotation.lines.filter((line) => unclaimed(line) && line.modelNumber === row.modelNumber);
      if (same.length === 1) return same[0];
    }
    if (incoming.length === 1 && quotation.lines.length === 1 && !row.mould) return quotation.lines[0];
    return null;
  };
  for (const row of incoming) {
    const existing = identify(row);
    if (row._id && !existing) throw ApiError.badRequest('That line is not on this quotation');
    if (existing) {
      kept.add(String(existing._id));
      const priceBefore = existing.unitPrice;
      for (const field of ['quantity', 'moq', 'colour', 'remarks', 'unitPrice']) {
        if (row[field] !== undefined) existing[field] = row[field];
      }
      if (!sent && row.modelNumber !== undefined) existing.modelNumber = row.modelNumber;
      if (existing.unitPrice !== priceBefore) settleLine(existing);
      next.push(existing);
    } else {
      if (sent) throw ApiError.badRequest('A model is added to a sent quotation through a revision');
      const fresh = await lineFrom(row);
      next.push(fresh);
    }
  }
  const dropped = quotation.lines.filter((line) => !kept.has(String(line._id)));
  if (dropped.length && sent) {
    throw ApiError.badRequest('A model comes off a sent quotation through a revision');
  }
  if (!next.length) throw ApiError.badRequest('A quotation needs at least one line');
  if (next.length > MAX_LINES) throw ApiError.badRequest(`A quotation holds ${MAX_LINES} models`);
  quotation.lines = next;
  for (const line of quotation.lines) {
    if (line.status === 'requested' && line.unitPrice != null) settleLine(line);
  }
}

/** Why the quotation cannot go out yet, naming the models and never a figure [§8]. */
function whyNotSendable(quotation) {
  const named = (lines) => lines.map((line) => line.modelNumber || 'an unnamed line').join(', ');
  const unpriced = quotation.lines.filter((line) => line.unitPrice == null || line.status === 'requested');
  if (unpriced.length) return `${named(unpriced)} ${unpriced.length === 1 ? 'has' : 'have'} no price yet — it is still with costing`;
  const waiting = quotation.lines.filter((line) => line.status === 'approval_pending');
  if (waiting.length) {
    return `${named(waiting)} ${waiting.length === 1 ? 'is' : 'are'} below the approved minimum — this needs Admin approval first`;
  }
  const refused = quotation.lines.filter((line) => line.status === 'rejected');
  if (refused.length) return `Admin refused the price on ${named(refused)} — change it before sending`;
  return null;
}

/* ------------------------------ Reading ------------------------------ */

const QUOTATION_SORTABLE = ['number', 'createdAt', 'requestedAt', 'status', 'validUntil', 'sentAt', 'respondedAt', 'revision'];

export const listQuotations = asyncHandler(async (req, res) => {
  const { page, limit, sort, filter } = listParams(req.query, {
    searchFields: ['number', 'lines.modelNumber'],
    defaultSort: '-createdAt',
    sortable: QUOTATION_SORTABLE,
  });

  const scope = ownershipFilter(req.user);
  Object.assign(filter, scope);
  const owner = narrowToOwner(scope, req.query.assignedTo);
  if (owner !== undefined) filter.assignedTo = owner;

  if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };
  if (req.query.open === 'true') filter.status = { $nin: CLOSED_QUOTATION_STATUSES };
  /* The Quotation department's queue, and Admin's [§9]. */
  if (req.query.costing === 'true') filter.status = 'costing';
  if (req.query.awaitingApproval === 'true') filter.status = 'approval_pending';
  if (req.query.enquiry) filter.enquiry = req.query.enquiry;
  if (req.query.customer) filter.customer = req.query.customer;

  /* Gone to the buyer is `sentAt`, not a status: revised, accepted and refused all went out. */
  const sentOnly = req.query.sent === 'true' ? { sentAt: { $ne: null } } : req.query.sent === 'false' ? { sentAt: null } : null;
  if (sentOnly) Object.assign(filter, sentOnly);

  const [data, total, stages] = await Promise.all([
    Quotation.find(filter).populate(POPULATE).sort(sort).skip((page - 1) * limit).limit(limit),
    Quotation.countDocuments(filter),
    Quotation.aggregate([
      { $match: sentOnly ? { ...scope, ...sentOnly } : scope },
      { $group: { _id: '$status', leads: { $sum: 1 } } },
    ]),
  ]);

  paginated(res, allVisibleTo(data, req.user), { page, limit, total }, {
    stageCounts: Object.fromEntries(stages.map((row) => [row._id, { leads: row.leads, value: 0 }])),
  });
});

const loadDetail = (id) =>
  Quotation.findById(id)
    .populate('customer', 'code name city state gstin mobile email assignedTo')
    .populate('enquiry', 'number status stage requirement targetPrice')
    .populate('assignedTo', 'name')
    .populate(mouldWithPhoto(
      'lines.mould',
      'mouldCode name category sizeMm material hookType moq packingQty cavities activeCavities ' +
        'partWeightGrams runnerWeightGrams regrindRecoveryPercent cycleTimeSeconds efficiencyPercent status machine'
    ))
    .populate(Object.entries(REGISTER_FIELDS).map(([ref, select]) => ({ path: `lines.${ref}`, select })))
    .populate('lines.approvedBy', 'name')
    .populate('requestedBy', 'name')
    .populate('costedBy', 'name')
    .populate('revisions.by', 'name')
    .populate('statusHistory.by', 'name');

export const getQuotation = asyncHandler(async (req, res) => {
  const quotation = await loadDetail(req.params.id);
  if (!quotation || !ownsRecord(req.user, quotation)) throw ApiError.notFound('Quotation not found');
  res.json({ success: true, data: visibleTo(quotation, req.user) });
});

/** The reply after a write: the record as the detail page reads it, as this person may see it. */
async function replyWith(res, quotation, user, status = 200) {
  const fresh = await loadDetail(quotation._id);
  res.status(status).json({ success: true, data: visibleTo(fresh, user) });
}

/* ------------------------------ Raising one ------------------------------ */

/**
 * Builds and saves a quotation on an enquiry.
 *
 * `system` is the automation raising one when an enquiry reaches pricing: there is no person to
 * check ownership for, and the enquiry's owner is the one it is for.
 */
export async function newQuotation(fields, user, { system = false } = {}) {
  assertValidityAhead(fields.validUntil);

  const enquiry = await requireEnquiry(fields.enquiry, null, { what: 'quotation', customer: fields.customer });
  const customer = await Customer.findById(enquiry.customer);
  if (!customer) throw ApiError.badRequest('That customer does not exist');
  if (!system && !ownsRecord(user, customer)) {
    throw ApiError.forbidden('That customer belongs to another marketing person');
  }
  const owner = enquiry.assignedTo || customer.assignedTo || user?._id;
  if (!system) {
    await assertQuotationLinks(user, { customerId: customer._id, enquiryId: enquiry._id, assignedTo: fields.assignedTo, owner });
  }

  /* Rows the request leaves blank take the enquiry's model and tool at the same position. */
  const fromEnquiry = linesForEnquiry(enquiry);
  const asked = fields.lines?.length
    ? fields.lines.map((row, index) => ({
      ...row,
      mould: row.mould ?? (row.modelNumber ? undefined : fromEnquiry[index]?.mould),
      modelNumber: row.modelNumber ?? (row.mould ? undefined : fromEnquiry[index]?.modelNumber),
    }))
    : fromEnquiry;
  if (asked.length > MAX_LINES) throw ApiError.badRequest(`A quotation holds ${MAX_LINES} models`);
  const lines = await Promise.all(asked.map((row) => lineFrom(row)));

  const { lines: _l, customer: _c, enquiry: _e, assignedTo: _a, ...terms } = fields;
  const quotation = new Quotation({
    ...terms,
    lines,
    customer: customer._id,
    enquiry: enquiry._id,
    assignedTo: fields.assignedTo || owner,
    targetPrice: fields.targetPrice ?? enquiry.targetPrice,
    requestedBy: user?._id || owner,
    number: await nextQuoteNumber(),
  });
  for (const line of quotation.lines) if (line.unitPrice != null) settleLine(line);
  quotation.status = undefined;
  quotation.statusHistory = [];
  quotation.$locals.by = user?._id;
  quotation.revisions = [snapshotOf(quotation, 0, user || { _id: owner })];
  await quotation.validate();
  quotation.statusHistory = [{ to: quotation.status, by: user?._id }];

  await quotation.save();
  await publish(EVENTS.QUOTATION_CREATED, { quotation, by: user });
  /* Somebody has to cost it: the Quotation department takes the enquiry [handoff.subscriber]. */
  if (quotation.status === 'costing') await publish(EVENTS.PRICING_REQUESTED, { quotation, by: user });
  if (quotation.status === 'approval_pending') await publish(EVENTS.PRICING_APPROVAL_REQUIRED, { quotation, by: user });
  return quotation;
}

export const createQuotation = asyncHandler(transactional(async (req, res) => {
  const quotation = await newQuotation(req.body, req.user);
  await replyWith(res, quotation, req.user, 201);
}));

/* ------------------------------ Costing a line ------------------------------ */

/**
 * The Quotation department costs one line: the registers, the cost build-up, the markup, the
 * job's own minimum and, optionally, the price.
 *
 * The calculated price is arithmetic and never typed. The price on the line defaults to it the
 * first time; after that a typed price wins. Before sending, a moved price or cost settles the
 * line again [§9]; after sending, the price changes only through a revision and a re-cost is
 * recorded without touching what the buyer was offered.
 */
export const costLine = asyncHandler(async (req, res) => {
  assertMayCost(req.user);

  const quotation = await Quotation.findById(req.params.id);
  if (!quotation || !ownsRecord(req.user, quotation)) throw ApiError.notFound('Quotation not found');
  if (CLOSED_QUOTATION_STATUSES.includes(quotation.status)) {
    throw ApiError.badRequest(`A ${quotation.status} quotation cannot be re-costed`);
  }
  expectVersion(quotation, req.body);
  const before = snapshot(quotation);
  const line = lineOf(quotation, req);
  const sent = Boolean(quotation.sentAt);

  const {
    cost, markupPercent, unitPrice, minimumOverride, printing, procurement, mould,
    materialRef, hookRef, clipRef, printRef, remarks,
  } = withoutVersion(req.body);

  if (sent && unitPrice !== undefined && unitPrice !== line.unitPrice) {
    throw ApiError.badRequest(`${quotation.number} has gone to the buyer — change the price through a revision`);
  }

  if (mould === null) line.mould = undefined;
  if (materialRef === null) line.materialRef = undefined;
  for (const [field, value] of [['hookRef', hookRef], ['clipRef', clipRef], ['printRef', printRef]]) {
    if (value === null) line[field] = undefined;
  }
  if (mould) line.mould = mould;
  if (materialRef) line.materialRef = materialRef;
  if (hookRef) line.hookRef = hookRef;
  if (clipRef) line.clipRef = clipRef;
  if (printRef) line.printRef = printRef;

  if (mould || materialRef || hookRef || clipRef || printRef) {
    /* Refilled from what the line now holds, so changing the resin keeps the register's hook rate. */
    const [tool, resin, held] = await Promise.all([
      line.mould ? Mould.findById(line.mould) : null,
      line.materialRef ? Material.findById(line.materialRef) : null,
      partsFrom({ hookRef: line.hookRef, clipRef: line.clipRef, printRef: line.printRef }),
    ]);
    if (mould && !tool) throw ApiError.badRequest('That mould is not on the register');
    if (materialRef && !resin) throw ApiError.badRequest('That material is not on the register');
    line.cost = { ...line.cost?.toObject?.(), ...costingFrom(tool, resin, held) };
    if (materialRef && resin && MATERIALS.includes(resin.type)) line.material = resin.type;
    if (mould && tool && !line.modelNumber) line.modelNumber = tool.mouldCode;
  }

  if (cost) line.cost = { ...line.cost?.toObject?.(), ...cost };
  if (markupPercent !== undefined) line.markupPercent = markupPercent;
  if (minimumOverride !== undefined) line.minimumOverride = minimumOverride;
  if (printing !== undefined) line.printing = printing;
  if (procurement !== undefined) line.procurement = procurement;
  if (remarks !== undefined) quotation.remarks = remarks;

  /* A floor beneath the cost is not a floor: it would let any price through unsigned [§9]. */
  if (line.minimumOverride != null && line.totalCost && line.minimumOverride < line.totalCost) {
    throw ApiError.badRequest(
      `A minimum of ${line.minimumOverride.toFixed(2)} is below what the piece costs to make ` +
        `(${line.totalCost.toFixed(2)}), so it would let any price through unchecked. Put the ` +
        'price you want on the line instead — anything under the standing minimum goes to Admin.'
    );
  }

  line.calculatedSellingPrice = priceFrom(line);
  if (!sent) {
    if (unitPrice !== undefined) line.unitPrice = unitPrice;
    else if (line.unitPrice == null) line.unitPrice = line.calculatedSellingPrice;
    settleLine(line);
  }
  quotation.costedBy = req.user._id;
  quotation.$locals.by = req.user._id;
  quotation.$locals.note = line.modelNumber ? `Costed ${line.modelNumber}` : 'Costed';
  followRevisionZero(quotation, req.user);

  const was = quotation.status;
  await quotation.save();
  await recordChange({ model: 'Quotation', doc: quotation, before, by: req.user });
  await announce(quotation, was, req.user);
  await replyWith(res, quotation, req.user);
});

/** Tells whoever is next: Admin when a price waits on them, the owner when it is ready to send. */
async function announce(quotation, was, user) {
  if (quotation.status === 'approval_pending') {
    await publish(EVENTS.PRICING_APPROVAL_REQUIRED, { quotation, by: user });
  } else if (['costing', 'approval_pending'].includes(was) && ['draft', 'revised'].includes(quotation.status)) {
    await publish(EVENTS.PRICING_APPROVED, { quotation, by: user });
  }
}

/**
 * Admin signs off, or refuses, a price under its line's minimum [§9].
 *
 * One line, one decision: a signature stands for the price the signer can see. Approving
 * records the price signed; a later lower price needs signing again. A refusal needs a reason —
 * it goes back to whoever costed it.
 */
export const decideLine = asyncHandler(async (req, res) => {
  if (!isAdmin(req.user)) throw ApiError.forbidden('Only Admin approves a price below the minimum');

  const quotation = await Quotation.findById(req.params.id);
  if (!quotation) throw ApiError.notFound('Quotation not found');
  const line = lineOf(quotation, req);
  if (line.status !== 'approval_pending') {
    throw ApiError.badRequest(`${line.modelNumber || 'This line'} is not waiting on an approval`);
  }

  const { approve, note } = req.body;
  if (!approve && !note?.trim()) {
    throw ApiError.badRequest('Say why the price is refused — it goes back to whoever costed it');
  }
  if (approve) {
    line.status = 'approved';
    line.approvedPrice = line.unitPrice;
    line.approvedBy = req.user._id;
    line.approvedAt = new Date();
    line.rejectedPrice = undefined;
    line.rejectionNote = undefined;
  } else {
    line.status = 'rejected';
    line.rejectedPrice = line.unitPrice;
    line.rejectionNote = note;
  }
  quotation.$locals.by = req.user._id;
  quotation.$locals.note = `${approve ? 'Approved' : 'Refused'} ${line.modelNumber || 'a line'}${note ? ` — ${note}` : ''}`;

  const was = quotation.status;
  await quotation.save();
  if (approve) await announce(quotation, was, req.user);
  else await publish(EVENTS.PRICING_REJECTED, { quotation, lineId: String(line._id), by: req.user });
  await replyWith(res, quotation, req.user);
});

/* ------------------------------ Editing, revising ------------------------------ */

/**
 * Editing a quotation: freely before it goes out, and only the bookkeeping after.
 *
 * Before sending, the prices, minimums, shades, models and terms change in place and Rev 0
 * follows. Once the buyer has it, anything they read changes through a revision, so what they
 * were told stays on record [§10].
 */
export const updateQuotation = asyncHandler(async (req, res) => {
  const quotation = await Quotation.findById(req.params.id);
  if (!quotation || !ownsRecord(req.user, quotation)) throw ApiError.notFound('Quotation not found');
  if (CLOSED_QUOTATION_STATUSES.includes(quotation.status)) {
    throw ApiError.badRequest(`A ${quotation.status} quotation cannot be edited`);
  }
  expectVersion(quotation, req.body);
  const before = snapshot(quotation);
  const patch = withoutVersion(req.body);
  const sent = Boolean(quotation.sentAt);

  if (sent) {
    const changed = DOCUMENT_FIELDS.filter((field) => {
      if (patch[field] === undefined) return false;
      const current = quotation[field];
      if (current instanceof Date) return new Date(patch[field]).getTime() !== current.getTime();
      return patch[field] !== current;
    });
    if (patch.lines && offerOf(patch.lines.map((row) => ({ ...quotation.lines.id(row._id)?.toObject(), ...row }))) !== offerOf(quotation.lines)) {
      changed.push('the lines');
    }
    if (changed.length) {
      throw ApiError.badRequest(
        `This quotation has already gone to the customer, so ${changed.join(', ')} can only change ` +
          'through a revision — that way what they were told is still on record.'
      );
    }
  }

  assertValidityAhead(patch.validUntil);
  await assertQuotationLinks(req.user, {
    customerId: quotation.customer,
    enquiryId: patch.enquiry && String(patch.enquiry) !== String(quotation.enquiry) ? patch.enquiry : null,
    assignedTo: patch.assignedTo,
    owner: quotation.assignedTo,
  });

  const { lines, ...rest } = patch;
  if (lines) await applyLines(quotation, lines, { sent });
  for (const field of [...DOCUMENT_FIELDS, 'enquiry', 'assignedTo', 'targetPrice']) {
    if (rest[field] !== undefined) quotation[field] = rest[field];
  }
  quotation.$locals.by = req.user._id;
  followRevisionZero(quotation, req.user);

  const was = quotation.status;
  await quotation.save();
  await recordChange({ model: 'Quotation', doc: quotation, before, by: req.user });
  await announce(quotation, was, req.user);
  await replyWith(res, quotation, req.user);
});

/**
 * A new offer on the same quotation [§10]: Rev 0 ₹7.50, Rev 1 ₹7.30, Rev 2 ₹7.20, all kept.
 * A price cut under a line's minimum waits on Admin before the revision can go out.
 */
export const reviseQuotation = asyncHandler(transactional(async (req, res) => {
  const quotation = await Quotation.findById(req.params.id);
  if (!quotation || !ownsRecord(req.user, quotation)) throw ApiError.notFound('Quotation not found');
  if (CLOSED_QUOTATION_STATUSES.includes(quotation.status)) {
    throw ApiError.badRequest(`A ${quotation.status} quotation cannot be revised — raise a new one`);
  }
  const { lines, note, ...terms } = req.body;
  assertValidityAhead(terms.validUntil);

  const offerBefore = offerOf(quotation.lines);
  if (lines) {
    /* A revision may add or drop a model too; that is what it is for. */
    await applyLines(quotation, lines, { sent: false });
  }
  const linesMoved = offerOf(quotation.lines) !== offerBefore;
  const termsMoved = DOCUMENT_FIELDS.some((field) => terms[field] !== undefined);
  if (!linesMoved && !termsMoved) {
    throw ApiError.badRequest('Nothing has changed — a revision has to revise something');
  }
  for (const field of DOCUMENT_FIELDS) if (terms[field] !== undefined) quotation[field] = terms[field];

  quotation.revision += 1;
  quotation.revisions.push(snapshotOf(quotation, quotation.revision, req.user));

  const from = quotation.status;
  quotation.status = 'revised';
  quotation.statusHistory.push({ from, to: 'revised', by: req.user._id, note });
  quotation.$locals.by = req.user._id;

  await quotation.save();
  if (quotation.status === 'approval_pending') await publish(EVENTS.PRICING_APPROVAL_REQUIRED, { quotation, by: req.user });
  await replyWith(res, quotation, req.user);
}));

/* ------------------------------ Sending, answering ------------------------------ */

/**
 * Sending it — by marketing or the Quotation department. Every line has to be priced and
 * cleared [§9]; the refusal names the models and never a figure [§8].
 */
export const sendQuotation = asyncHandler(async (req, res) => {
  const channels = { email: req.body?.email, whatsapp: req.body?.whatsapp };
  const invalid = sendProblem(channels);
  if (invalid) throw ApiError.badRequest(invalid);

  const quotation = await Quotation.findById(req.params.id);
  if (!quotation || !ownsRecord(req.user, quotation)) throw ApiError.notFound('Quotation not found');
  if (CLOSED_QUOTATION_STATUSES.includes(quotation.status)) {
    throw ApiError.badRequest(`A ${quotation.status} quotation has already been answered`);
  }
  /* Sending again what the buyer already has would reset how long it has waited unanswered. */
  if (quotation.status === 'sent') {
    throw ApiError.badRequest(
      `${quotation.number} has already gone to the customer. Revise it if the offer has changed, or record their answer.`
    );
  }
  const why = whyNotSendable(quotation);
  if (why) throw ApiError.badRequest(why);

  /* Deliver first; mark it sent only if something went, or nobody asked for a channel (handed over). */
  let deliveries = [];
  if (channels.email?.send || channels.whatsapp?.send) {
    const full = await loadForPdf(quotation._id);
    deliveries = await deliverQuotation(req, full, channels);
    if (!deliveries.some((row) => row.status === 'sent')) {
      const failed = deliveries.map((row) => `${row.channel === 'email' ? 'Email' : 'WhatsApp'}: ${
        row.status === 'skipped' ? (row.skipReason === 'opted_out' ? 'the customer has asked not to be messaged this way' : 'not set up on this server') : row.error || 'failed'
      }`).join('. ');
      throw new ApiError(502, `The quotation was not sent. ${failed}.`);
    }
  }

  const from = quotation.status;
  quotation.status = 'sent';
  quotation.sentAt = new Date();
  const went = deliveries.filter((row) => row.status === 'sent').map((row) => `${row.channel} to ${row.recipient}`);
  quotation.statusHistory.push({
    from, to: 'sent', by: req.user._id,
    note: [req.body?.note, went.length ? `Sent by ${went.join(' and ')}` : null].filter(Boolean).join(' — ') || undefined,
  });
  const current = quotation.revisions.at(-1);
  if (current) current.sentAt = quotation.sentAt;

  await quotation.save();
  await publish(EVENTS.QUOTATION_SENT, { quotation, by: req.user });
  res.json({ success: true, data: visibleTo(await loadDetail(quotation._id), req.user), deliveries });
});

/** What the customer said. Accepting one is what moves the enquiry towards a PO. */
export const respondToQuotation = asyncHandler(transactional(async (req, res) => {
  const quotation = await Quotation.findById(req.params.id);
  if (!quotation || !ownsRecord(req.user, quotation)) throw ApiError.notFound('Quotation not found');
  if (CLOSED_QUOTATION_STATUSES.includes(quotation.status)) {
    throw ApiError.badRequest(`This quotation is already ${quotation.status}`);
  }
  if (!quotation.sentAt) throw ApiError.badRequest('This quotation has not been sent, so there is nothing to answer');

  const { accepted, note } = req.body;
  if (!accepted && !note?.trim()) {
    throw ApiError.badRequest('Say why it was refused — it is what the next quote is priced against');
  }
  const to = accepted ? 'accepted' : 'rejected';
  quotation.statusHistory.push({ from: quotation.status, to, by: req.user._id, note });
  quotation.status = to;
  quotation.respondedAt = new Date();
  if (!accepted) quotation.rejectionNote = note;

  await quotation.save();
  await publish(accepted ? EVENTS.QUOTATION_ACCEPTED : EVENTS.QUOTATION_REJECTED, { quotation, by: req.user });
  await replyWith(res, quotation, req.user);
}));

/* ------------------------------ The document ------------------------------ */

/** The resin each line prints as: the register's name where one was picked, else the line's material. */
function costedResins(quotation) {
  const resins = new Map();
  for (const line of quotation.lines || []) {
    const resin = line.materialRef?.name || line.material;
    if (resin) resins.set(String(line._id), resin);
  }
  return resins;
}

/** A quotation with everything its PDF prints. */
const loadForPdf = (id) =>
  Quotation.findById(id)
    .populate('customer', 'code name address city state gstin mobile whatsapp email contacts notifications')
    .populate('enquiry', 'number')
    .populate('assignedTo', 'name phone')
    .populate('lines.materialRef', 'name type')
    .populate(mouldWithPhoto('lines.mould', 'mouldCode name category sizeMm material hookType'));

async function renderPdfFor(quotation) {
  const keys = [...new Set((quotation.lines || []).map((line) => line.mould?.photo?.key).filter(Boolean))];
  const photos = new Map(
    (await Promise.all(keys.map(async (key) => [key, await bufferOf(key)]))).filter(([, bytes]) => bytes)
  );
  return renderQuotationPdf(quotation, photos, costedResins(quotation));
}

export const quotationPdf = asyncHandler(async (req, res) => {
  const quotation = await loadForPdf(req.params.id);
  if (!quotation || !ownsRecord(req.user, quotation)) throw ApiError.notFound('Quotation not found');
  const pdf = await renderPdfFor(quotation);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', pdf.length);
  res.setHeader('Content-Disposition', `inline; filename="${fileSafeNumber(quotation.number)}.pdf"`);
  res.send(pdf);
});

/* A signed link to one quotation's PDF, for WhatsApp, which fetches documents by URL. */
const PDF_LINK_DAYS = 30;
const pdfSignature = (id, expires) =>
  createHmac('sha256', env.jwtSecret).update(`quotation-pdf:${id}:${expires}`).digest('hex');

export function publicPdfUrl(req, quotation) {
  const expires = Date.now() + PDF_LINK_DAYS * 86400000;
  const base = process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}/api`;
  return `${base}/public/quotations/${quotation._id}/${expires}/${pdfSignature(quotation._id, expires)}/${fileSafeNumber(quotation.number)}.pdf`;
}

/** The PDF behind a signed link. No session: the signature is the permission. */
export const publicQuotationPdf = asyncHandler(async (req, res) => {
  const { id, expires, signature } = req.params;
  const expected = Buffer.from(pdfSignature(id, expires));
  const given = Buffer.from(String(signature || ''));
  const valid = given.length === expected.length && timingSafeEqual(given, expected) && Number(expires) > Date.now();
  if (!valid) throw ApiError.notFound('This link has expired. Ask for the quotation again.');

  const quotation = await loadForPdf(id).catch(() => null);
  if (!quotation) throw ApiError.notFound('This link has expired. Ask for the quotation again.');
  const pdf = await renderPdfFor(quotation);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', pdf.length);
  res.setHeader('Content-Disposition', `inline; filename="${fileSafeNumber(quotation.number)}.pdf"`);
  res.send(pdf);
});

/** What the send dialog opens with: the email and WhatsApp texts, pre-filled, for the sender to change. */
export const sendPreview = asyncHandler(async (req, res) => {
  const quotation = await loadForPdf(req.params.id);
  if (!quotation || !ownsRecord(req.user, quotation)) throw ApiError.notFound('Quotation not found');

  const customer = quotation.customer;
  const recipient = recipientOf(customer);
  const drafts = draftQuoteMessages({ quotation, customer, sender: req.user });
  const sent = await CustomerMessage.find({ quotation: quotation._id }).populate('sentBy', 'name').sort('-sentAt').limit(20);

  res.json({
    success: true,
    data: {
      number: quotation.number,
      status: quotation.status,
      customer: { _id: customer?._id, name: customer?.name },
      email: {
        to: recipient.email,
        subject: drafts.subject,
        body: drafts.email,
        optedOut: customer?.notifications?.email === false,
        configured: Boolean(env.smtp.host),
      },
      whatsapp: {
        to: recipient.whatsapp,
        body: drafts.whatsapp,
        optedOut: customer?.notifications?.whatsapp === false,
        configured: isWhatsAppConfigured(),
        template: Boolean(whatsappTemplate('quote')),
      },
      attachment: `${fileSafeNumber(quotation.number)}.pdf`,
      sent,
    },
  });
});

const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Sends the quotation the way the dialog left it; each channel delivered and logged on its own. */
async function deliverQuotation(req, quotation, { email, whatsapp }) {
  const customer = quotation.customer;
  const generated = draftQuoteMessages({ quotation, customer, sender: req.user });
  const base = { customer: customer._id, enquiry: quotation.enquiry?._id || quotation.enquiry, quotation: quotation._id, event: 'quotation_sent', sentBy: req.user._id };
  const results = [];
  let pdf = null;

  if (email?.send) {
    const to = String(email.to).trim().toLowerCase();
    const log = { ...base, channel: 'email', recipient: to, subject: email.subject, body: email.body, edited: email.subject !== generated.subject || email.body !== generated.email };
    if (customer.notifications?.email === false) {
      results.push(await CustomerMessage.create({ ...log, status: 'skipped', skipReason: 'opted_out' }));
    } else {
      try {
        pdf = pdf || (await renderPdfFor(quotation));
        const sent = await sendEmail({
          to,
          subject: email.subject,
          text: email.body,
          html: `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;white-space:pre-wrap">${escapeHtml(email.body)}</div>`,
          attachments: [{ filename: `${fileSafeNumber(quotation.number)}.pdf`, content: pdf, contentType: 'application/pdf' }],
        });
        results.push(await CustomerMessage.create({ ...log, status: 'sent', providerId: sent.messageId, providerStatus: sent.delivered ? 'sent' : 'logged' }));
      } catch (error) {
        results.push(await CustomerMessage.create({ ...log, status: 'failed', error: error.message }));
      }
    }
  }

  if (whatsapp?.send) {
    const to = normalisePhone(whatsapp.to);
    const log = { ...base, channel: 'whatsapp', recipient: to, body: whatsapp.body, edited: whatsapp.body !== generated.whatsapp };
    if (customer.notifications?.whatsapp === false) {
      results.push(await CustomerMessage.create({ ...log, status: 'skipped', skipReason: 'opted_out' }));
    } else if (!isWhatsAppConfigured()) {
      if (isProduction) {
        results.push(await CustomerMessage.create({ ...log, status: 'skipped', skipReason: 'no_provider' }));
      } else {
        console.log(`\n[whatsapp] to ${to}\n${whatsapp.body}\n${publicPdfUrl(req, quotation)}\n`);
        results.push(await CustomerMessage.create({ ...log, status: 'sent', providerStatus: 'logged' }));
      }
    } else {
      try {
        const link = publicPdfUrl(req, quotation);
        const templateSid = whatsappTemplate('quote');
        const sent = await sendWhatsApp({
          to,
          body: whatsapp.body,
          document: { url: link, filename: `${fileSafeNumber(quotation.number)}.pdf` },
          ...(templateSid
            ? { template: templateSid, variables: { 1: recipientOf(customer).name || customer.name, 2: quotation.number, 3: link } }
            : {}),
        });
        results.push(await CustomerMessage.create({ ...log, status: 'sent', providerId: sent.id, providerStatus: sent.status, usedTemplate: Boolean(templateSid) }));
      } catch (error) {
        results.push(await CustomerMessage.create({ ...log, status: 'failed', error: error.message }));
      }
    }
  }
  return results;
}

/* Exported for the registers' "where is this used" lists and the seeds. */
export { lineFrom, seesCosting };
