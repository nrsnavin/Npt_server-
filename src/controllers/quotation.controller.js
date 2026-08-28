import Quotation, { CLOSED_QUOTATION_STATUSES } from '../models/Quotation.js';
import Pricing from '../models/Pricing.js';
import Enquiry from '../models/Enquiry.js';
import Customer from '../models/Customer.js';
import Product from '../models/Product.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { nextNumber } from '../services/numbering.service.js';
import { listParams, paginated } from '../utils/query.js';
import { expectVersion, withoutVersion } from '../utils/concurrency.js';
import { recordChange, snapshot } from '../services/audit.service.js';
import { EVENTS, publish } from '../services/events.service.js';
import { narrowToOwner, ownershipFilter, ownsRecord } from '../services/ownership.service.js';
import { renderQuotationPdf } from '../services/quotationPdf.js';

/**
 * Quotations [BLUEPRINT §10], and the price gate in front of them [§9].
 *
 * A quotation is a customer conversation, so unlike a costing it *is* ownership-scoped: a
 * marketing person sees their own [§29].
 *
 * Two rules do most of the work here.
 *
 * **Every revision stays in history.** Changing the price never overwrites it — it appends,
 * and the live fields become the newest entry. Six weeks into a negotiation the only way to
 * answer "what did we last tell them?" is that list, and a quote that overwrites itself cannot
 * answer it at all, which is how a plant honours a number it never sent.
 *
 * **Nothing goes out below the floor without a signature.** The costing knows where the floor
 * is and marketing is not allowed to [§8], so the check happens here, against the linked
 * costing, and the refusal says only that approval is needed — never what the figure is.
 */

const POPULATE = [
  { path: 'customer', select: 'code name' },
  { path: 'enquiry', select: 'number status' },
  { path: 'assignedTo', select: 'name' },
];

/**
 * Whether this price may be sent [§9].
 *
 * Read off the costing rather than trusted from the request: the whole point is that the person
 * building the quote cannot see the minimum, so they cannot be the one to decide they are above
 * it. A quote with no costing behind it is not blocked — plenty of repeat jobs are quoted from
 * a known price — but one that *has* a costing must respect it.
 */
async function priceIsCleared(quotation) {
  if (!quotation.pricing) return { cleared: true };

  const pricing = await Pricing.findById(quotation.pricing);
  if (!pricing) return { cleared: true };

  if (pricing.status === 'approval_pending') {
    return { cleared: false, why: 'The costing behind this quote is still waiting on approval' };
  }
  if (pricing.status === 'rejected') {
    return { cleared: false, why: 'The costing behind this quote was refused — it needs re-costing' };
  }
  /*
   * The floor, after any signature on it.
   *
   * §9 blocks a price below the approved minimum *until MD approves*. So once the sheet has
   * been signed off, that signature is the sanction: a costing approved at ₹6 against a floor
   * of ₹8 means ₹6 is allowed, and continuing to block it would make the approval route a
   * dead end — the one thing §9 exists to provide.
   *
   * Where the sanctioned price is above the floor, the floor still governs: marketing may
   * discount to it without asking, which is what a minimum is for.
   */
  const floor = Math.min(
    pricing.minimumSellingPrice ?? Infinity,
    pricing.approvedSellingPrice ?? Infinity
  );

  if (Number.isFinite(floor) && quotation.unitPrice < floor) {
    return {
      cleared: false,
      // Deliberately does not name the figure: §8 keeps the floor away from marketing, and a
      // refusal that quotes it hands over the very number the rule protects.
      why: 'This price is below the approved minimum and needs management approval first',
    };
  }
  return { cleared: true };
}

export const listQuotations = asyncHandler(async (req, res) => {
  const { page, limit, sort, filter } = listParams(req.query, {
    searchFields: ['number', 'modelNumber'],
    defaultSort: '-createdAt',
  });

  const scope = ownershipFilter(req.user);
  Object.assign(filter, scope);

  const owner = narrowToOwner(scope, req.query.assignedTo);
  if (owner !== undefined) filter.assignedTo = owner;

  if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };
  if (req.query.open === 'true') filter.status = { $nin: CLOSED_QUOTATION_STATUSES };
  if (req.query.enquiry) filter.enquiry = req.query.enquiry;
  if (req.query.customer) filter.customer = req.query.customer;

  const [data, total, stages] = await Promise.all([
    Quotation.find(filter).populate(POPULATE).sort(sort).skip((page - 1) * limit).limit(limit),
    Quotation.countDocuments(filter),
    Quotation.aggregate([
      { $match: scope },
      {
        $group: {
          _id: '$status',
          leads: { $sum: 1 },
          value: { $sum: { $multiply: ['$unitPrice', '$quantity'] } },
        },
      },
    ]),
  ]);

  paginated(res, data, { page, limit, total }, {
    stageCounts: Object.fromEntries(
      stages.map((row) => [row._id, { leads: row.leads, value: Math.round(row.value || 0) }])
    ),
  });
});

export const getQuotation = asyncHandler(async (req, res) => {
  const quotation = await Quotation.findById(req.params.id).populate(POPULATE);
  if (!quotation) throw ApiError.notFound('Quotation not found');
  if (!ownsRecord(req.user, quotation)) throw ApiError.notFound('Quotation not found');
  res.json({ success: true, data: quotation });
});

/**
 * Builds and saves a quotation, whoever asked for it.
 *
 * Shared by the two doors into this module — marketing writing one from scratch, and a costing
 * being turned into a quote — because the interesting parts are the same either way: the
 * customer has to resolve, the owner has to be settled, and Rev 0 has to exist. A second copy
 * of that for the pricing route is a second place for the revision history to start wrong.
 */
export async function newQuotation(fields, user) {
  const enquiry = fields.enquiry ? await Enquiry.findById(fields.enquiry) : null;
  if (fields.enquiry && !enquiry) throw ApiError.badRequest('That enquiry does not exist');

  const customerId = fields.customer || enquiry?.customer;
  if (!customerId) throw ApiError.badRequest('A quotation needs the customer it is for');

  const customer = await Customer.findById(customerId);
  if (!customer) throw ApiError.badRequest('That customer does not exist');
  if (!ownsRecord(user, customer)) {
    throw ApiError.forbidden('That customer belongs to another marketing person');
  }

  /*
   * The product master's minimum, when the quote does not name one [§28]. Copied rather than
   * looked up on read: a catalogue edited next month must not change what an issued quotation
   * says it was offered at.
   */
  const product = fields.product ? await Product.findById(fields.product) : null;

  const quotation = new Quotation({
    ...fields,
    moq: fields.moq ?? product?.moq ?? 0,
    customer: customerId,
    assignedTo: fields.assignedTo || customer.assignedTo || user._id,
    number: await nextNumber('QTN'),
    statusHistory: [{ to: 'draft', by: user._id }],
  });

  /*
   * Rev 0 is written at creation rather than at the first send. §10's example starts at Rev 0
   * with a price, so the first thing offered has to be in the list like every later one — a
   * history that begins at Rev 1 has silently lost the original quote.
   */
  quotation.revisions = [
    {
      revision: 0,
      unitPrice: quotation.unitPrice,
      quantity: quotation.quantity,
      moq: quotation.moq,
      validUntil: quotation.validUntil,
      paymentTerms: quotation.paymentTerms,
      deliveryTerms: quotation.deliveryTerms,
      freightTerms: quotation.freightTerms,
      packing: quotation.packing,
      remarks: quotation.remarks,
      by: user._id,
    },
  ];

  await quotation.save();
  publish(EVENTS.QUOTATION_CREATED, { quotation, by: user });

  return quotation;
}

export const createQuotation = asyncHandler(async (req, res) => {
  const quotation = await newQuotation(req.body, req.user);
  res.status(201).json({ success: true, data: quotation });
});

/** Editing the terms of a draft. The price has its own door — see `reviseQuotation`. */
export const updateQuotation = asyncHandler(async (req, res) => {
  const quotation = await Quotation.findById(req.params.id);
  if (!quotation) throw ApiError.notFound('Quotation not found');
  if (!ownsRecord(req.user, quotation)) throw ApiError.notFound('Quotation not found');
  if (CLOSED_QUOTATION_STATUSES.includes(quotation.status)) {
    throw ApiError.badRequest(`A ${quotation.status} quotation cannot be edited`);
  }
  if (req.body.unitPrice !== undefined && req.body.unitPrice !== quotation.unitPrice) {
    throw ApiError.badRequest('Use a revision to change the price, so the old one is kept');
  }

  expectVersion(quotation, req.body);
  const before = snapshot(quotation);
  Object.assign(quotation, withoutVersion(req.body));
  await quotation.save();
  await recordChange({ model: 'Quotation', doc: quotation, before, by: req.user });

  res.json({ success: true, data: quotation });
});

/**
 * A new price on the same quotation [§10].
 *
 * The old figures are already in `revisions`; this appends the new one and moves the live
 * fields onto it. Rev 0 ₹7.50, Rev 1 ₹7.30, Rev 2 ₹7.20 — all three answerable afterwards.
 */
export const reviseQuotation = asyncHandler(async (req, res) => {
  const quotation = await Quotation.findById(req.params.id);
  if (!quotation) throw ApiError.notFound('Quotation not found');
  if (!ownsRecord(req.user, quotation)) throw ApiError.notFound('Quotation not found');
  if (CLOSED_QUOTATION_STATUSES.includes(quotation.status)) {
    throw ApiError.badRequest(`A ${quotation.status} quotation cannot be revised — raise a new one`);
  }

  const { unitPrice, note, ...terms } = req.body;
  if (unitPrice === quotation.unitPrice && !Object.keys(terms).length) {
    throw ApiError.badRequest('Nothing has changed — a revision has to revise something');
  }

  Object.assign(quotation, terms);
  quotation.unitPrice = unitPrice ?? quotation.unitPrice;
  quotation.revision += 1;
  quotation.revisions.push({
    revision: quotation.revision,
    unitPrice: quotation.unitPrice,
    quantity: quotation.quantity,
    moq: quotation.moq,
    validUntil: quotation.validUntil,
    paymentTerms: quotation.paymentTerms,
    deliveryTerms: quotation.deliveryTerms,
    freightTerms: quotation.freightTerms,
    packing: quotation.packing,
    remarks: quotation.remarks,
    by: req.user._id,
  });

  /*
   * A revised quote is not a sent one. Whatever it was before, the customer has not seen this
   * price — leaving it at `sent` would mean the list of what is with customers includes a
   * figure nobody has been given.
   */
  const from = quotation.status;
  quotation.status = 'revised';
  quotation.statusHistory.push({ from, to: 'revised', by: req.user._id, note });

  await quotation.save();
  res.json({ success: true, data: quotation });
});

/**
 * Sending it, which is the moment §9's gate applies.
 *
 * Checked here rather than at the draft, because a draft below the floor is a perfectly
 * reasonable thing to be working on — it is putting it in front of a customer that has to wait
 * for a signature.
 */
export const sendQuotation = asyncHandler(async (req, res) => {
  const quotation = await Quotation.findById(req.params.id);
  if (!quotation) throw ApiError.notFound('Quotation not found');
  if (!ownsRecord(req.user, quotation)) throw ApiError.notFound('Quotation not found');
  if (CLOSED_QUOTATION_STATUSES.includes(quotation.status)) {
    throw ApiError.badRequest(`A ${quotation.status} quotation has already been answered`);
  }

  const { cleared, why } = await priceIsCleared(quotation);
  if (!cleared) {
    /*
     * Moved to `approval_pending` rather than simply refused. A refusal leaves the quote in a
     * state that looks ready and is not; this puts it visibly in the queue it is actually in,
     * so the person waiting can see what they are waiting for.
     */
    if (quotation.status !== 'approval_pending') {
      quotation.statusHistory.push({
        from: quotation.status,
        to: 'approval_pending',
        by: req.user._id,
        note: why,
      });
      quotation.status = 'approval_pending';
      await quotation.save();
      publish(EVENTS.QUOTATION_APPROVAL_REQUIRED, { quotation, by: req.user, why });
    }
    throw ApiError.badRequest(why);
  }

  const from = quotation.status;
  quotation.status = 'sent';
  quotation.sentAt = new Date();
  quotation.statusHistory.push({ from, to: 'sent', by: req.user._id, note: req.body?.note });

  // The revision that actually went out, marked as such: a revision drafted and superseded is
  // not the same thing as one the customer has seen.
  const current = quotation.revisions.at(-1);
  if (current) current.sentAt = quotation.sentAt;

  await quotation.save();
  publish(EVENTS.QUOTATION_SENT, { quotation, by: req.user });

  res.json({ success: true, data: quotation });
});

/** What the customer said. Accepting one is what moves the enquiry towards a PO. */
export const respondToQuotation = asyncHandler(async (req, res) => {
  const quotation = await Quotation.findById(req.params.id);
  if (!quotation) throw ApiError.notFound('Quotation not found');
  if (!ownsRecord(req.user, quotation)) throw ApiError.notFound('Quotation not found');
  if (CLOSED_QUOTATION_STATUSES.includes(quotation.status)) {
    throw ApiError.badRequest(`This quotation is already ${quotation.status}`);
  }
  if (!quotation.sentAt) {
    throw ApiError.badRequest('This quotation has not been sent, so there is nothing to answer');
  }

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
  publish(accepted ? EVENTS.QUOTATION_ACCEPTED : EVENTS.QUOTATION_REJECTED, {
    quotation,
    by: req.user,
  });

  res.json({ success: true, data: quotation });
});

/**
 * The quotation as a document [§10].
 *
 * Rendered on demand from the record rather than stored: a quotation's price changes with
 * every revision, and a stored file is a copy that stops agreeing with the thing it came from.
 * The customer and product are populated here beyond the list's needs because a document is
 * not a row — it carries the buyer's address and the model's description.
 *
 * `inline` so a browser shows it rather than dropping it in the downloads folder; the filename
 * is still set, so "save as" produces something recognisable rather than `123abc.pdf`.
 */
export const quotationPdf = asyncHandler(async (req, res) => {
  const quotation = await Quotation.findById(req.params.id)
    .populate('customer', 'code name address city state gstin mobile email')
    .populate('enquiry', 'number')
    .populate('assignedTo', 'name')
    .populate('product', 'modelCode name sizeMm material');

  if (!quotation) throw ApiError.notFound('Quotation not found');
  if (!ownsRecord(req.user, quotation)) throw ApiError.notFound('Quotation not found');

  const pdf = await renderQuotationPdf(quotation);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', pdf.length);
  res.setHeader('Content-Disposition', `inline; filename="${quotation.number}.pdf"`);
  res.send(pdf);
});
