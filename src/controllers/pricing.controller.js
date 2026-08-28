import Pricing, { CLOSED_PRICING_STATUSES } from '../models/Pricing.js';
import Enquiry from '../models/Enquiry.js';
import Customer from '../models/Customer.js';
import Product from '../models/Product.js';
import Quotation from '../models/Quotation.js';
import { newQuotation } from './quotation.controller.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { nextNumber } from '../services/numbering.service.js';
import { listParams, paginated } from '../utils/query.js';
import { expectVersion, withoutVersion } from '../utils/concurrency.js';
import { recordChange, snapshot } from '../services/audit.service.js';
import { EVENTS, publish } from '../services/events.service.js';
import { allVisibleTo, assertMayCost, visibleTo } from '../services/pricingVisibility.js';
import { priceFrom } from '../services/pricing.service.js';

/**
 * Costing sheets [BLUEPRINT §7, §9].
 *
 * Two things run through every handler here and are worth stating once.
 *
 * **Reading is split by field, writing is not split at all.** §8 says marketing may see the
 * quoted price and never the cost behind it, so every response goes through `visibleTo`.
 * Building the sheet is costing's job end to end, so every write goes through `assertMayCost`.
 * Splitting a write by field would mean a sheet half-built by two people who cannot see each
 * other's half.
 *
 * **Ownership is not applied here, and that is deliberate.** A costing belongs to the plant,
 * not to a marketing person — §29 scopes customers and enquiries because they carry the
 * relationship, and a cost sheet carries no relationship. Management sees all of them because
 * management is who prices them.
 */

/** Marketing can see whose enquiry it is; the ownership rule lives on the enquiry, not here. */
const POPULATE = [
  { path: 'enquiry', select: 'number status requirement targetPrice' },
  { path: 'customer', select: 'code name' },
  { path: 'product', select: 'modelCode name category sizeMm material moq packingQty standardPrice' },
  { path: 'requestedBy', select: 'name' },
  { path: 'costedBy', select: 'name' },
  { path: 'approvedBy', select: 'name' },
];

export const listPricings = asyncHandler(async (req, res) => {
  const { page, limit, sort, filter } = listParams(req.query, {
    searchFields: ['number', 'modelNumber'],
    defaultSort: '-requestedAt',
  });

  if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };
  if (req.query.enquiry) filter.enquiry = req.query.enquiry;
  if (req.query.customer) filter.customer = req.query.customer;
  if (req.query.open === 'true') filter.status = { $nin: CLOSED_PRICING_STATUSES };
  /** §9's queue: the sheets somebody has to sign off before anything can be quoted. */
  if (req.query.awaitingApproval === 'true') filter.status = 'approval_pending';

  const [rows, total, stages] = await Promise.all([
    Pricing.find(filter).populate(POPULATE).sort(sort).skip((page - 1) * limit).limit(limit),
    Pricing.countDocuments(filter),
    Pricing.aggregate([{ $group: { _id: '$status', leads: { $sum: 1 } } }]),
  ]);

  paginated(res, allVisibleTo(rows, req.user), { page, limit, total }, {
    stageCounts: Object.fromEntries(stages.map((row) => [row._id, { leads: row.leads, value: 0 }])),
  });
});

/**
 * One costing, with everything the detail screen answers *from* rather than about.
 *
 * A sheet on its own says what a piece costs. The questions that follow are always the same
 * three, and each needs something the record does not hold: how this price compares to what
 * the buyer asked for (the enquiry), what has actually been quoted off it (the quotations),
 * and where the model's own standard sits (the master). Fetched together because they are one
 * question — "is this price right?" — and three round trips to answer it is three chances for
 * the screen to show a half-loaded story.
 *
 * The costing itself still goes through §8's redaction, so a marketing reader gets the price
 * and the terms and none of the cost behind them.
 */
export const getPricing = asyncHandler(async (req, res) => {
  const pricing = await Pricing.findById(req.params.id).populate(POPULATE);
  if (!pricing) throw ApiError.notFound('Costing not found');

  const quotations = await Quotation.find({ pricing: pricing._id })
    .select('number status quantity unitPrice moq revision validUntil sentAt createdAt')
    .sort('-createdAt');

  res.json({ success: true, data: visibleTo(pricing, req.user), quotations });
});

/**
 * Raising a costing request by hand.
 *
 * **An enquiry is optional, and that is the point of this route.** The automation covers the
 * ordinary case — an enquiry reaching `pricing_required` raises one — but plenty of real
 * costings have no enquiry behind them at all: a rate wanted for a tender, a standing price
 * refreshed because the resin rate moved, a walk-in asking what a model would cost. Requiring
 * an enquiry would mean inventing a fake one to get a number, which is how a pipeline fills
 * with enquiries nobody is working.
 *
 * The customer is required either way. A cost is of a *job*, and the same hanger costs
 * different money for a buyer who takes 40,000 and one who takes 2,000.
 */
export const createPricing = asyncHandler(async (req, res) => {
  const enquiry = req.body.enquiry ? await Enquiry.findById(req.body.enquiry) : null;
  if (req.body.enquiry && !enquiry) throw ApiError.badRequest('That enquiry does not exist');

  const customerId = req.body.customer || enquiry?.customer;
  if (!customerId) throw ApiError.badRequest('A costing needs the customer it is for');
  if (!(await Customer.findById(customerId))) throw ApiError.badRequest('That customer does not exist');

  /*
   * The product master fills in what it already knows [§28]. Copied rather than referenced:
   * a costing is a record of what was priced, and a master that is edited next month must not
   * retrospectively change the MOQ a quote went out against.
   */
  const productId = req.body.product || enquiry?.product;
  const product = productId ? await Product.findById(productId) : null;

  const pricing = await Pricing.create({
    ...req.body,
    product: productId || undefined,
    customer: customerId,
    modelNumber: req.body.modelNumber || product?.modelCode,
    material: req.body.material || product?.material,
    number: await nextNumber('PRC'),
    requestedBy: req.user._id,
    statusHistory: [{ to: 'requested', by: req.user._id }],
  });

  publish(EVENTS.PRICING_REQUESTED, { pricing, by: req.user });
  res.status(201).json({ success: true, data: visibleTo(pricing, req.user) });
});

/**
 * Building the sheet: the costs, the margin, and the three prices.
 *
 * The calculated price is never accepted from the request — it is arithmetic over the costs and
 * the margin, and a figure that can be typed is a figure that can disagree with the lines above
 * it. Whoever is costing decides the *approved* price, which is the one marketing may quote.
 *
 * **A settled sheet can be re-costed, and that used to be refused.** It sent people to raise a
 * second costing for the same job, which is how one job ends up with three sheets and nobody
 * can say which price is live. Costings go stale for ordinary reasons — the resin rate moves, a
 * gram weight was typed wrong, the buyer changes the quantity — and the honest answer is to
 * correct the sheet rather than to abandon it.
 *
 * What protects the decision is not the refusal; it is that **the approval belongs to the sheet
 * as it stood.** Editing re-runs §9 from scratch, so a price that no longer clears the floor
 * goes back for signature even though it was approved a minute ago. Quotations already sent
 * keep their own prices and are untouched — a quotation records what was offered, not a pointer
 * to a number that can move under it.
 */
export const costPricing = asyncHandler(async (req, res) => {
  assertMayCost(req.user);

  const pricing = await Pricing.findById(req.params.id);
  if (!pricing) throw ApiError.notFound('Costing not found');

  /*
   * Re-opening a settled sheet is worth a line in its own history, because the §9 route below
   * may well land it back where it already was — approved to approved — and push nothing.
   * Without this the audit trail would show a sheet approved once and never touched again,
   * while its numbers had changed underneath.
   */
  const wasSettled = CLOSED_PRICING_STATUSES.includes(pricing.status);
  if (wasSettled) {
    pricing.statusHistory.push({
      from: pricing.status,
      to: 'costed',
      by: req.user._id,
      note: 'Re-costed after being settled',
    });
    // Actually moved, not just noted: the §9 route below reads `status` to write its own
    // history entry, and leaving it settled would record that move as coming from a stage the
    // sheet had already left.
    pricing.status = 'costed';
  }

  expectVersion(pricing, req.body);
  const before = snapshot(pricing);

  const { cost, targetMargin, approvedSellingPrice, minimumSellingPrice, remarks } =
    withoutVersion(req.body);

  if (cost) pricing.cost = { ...pricing.cost?.toObject?.(), ...cost };
  if (targetMargin !== undefined) pricing.targetMargin = targetMargin;
  if (minimumSellingPrice !== undefined) pricing.minimumSellingPrice = minimumSellingPrice;
  if (remarks !== undefined) pricing.remarks = remarks;

  // Derived, never typed — see the note above.
  pricing.calculatedSellingPrice = priceFrom(pricing);
  pricing.approvedSellingPrice =
    approvedSellingPrice !== undefined ? approvedSellingPrice : pricing.calculatedSellingPrice;
  pricing.costedBy = req.user._id;

  /*
   * §9, and the reason this module exists rather than a price field on the enquiry: a costing
   * under the floor cannot be quoted until somebody signs it off. Routing it here — at the
   * moment the number is written — is what makes the block enforceable, rather than a rule
   * somebody is supposed to remember when they build the quote.
   */
  const to = pricing.belowMinimum ? 'approval_pending' : 'approved';
  if (pricing.status !== to) {
    pricing.statusHistory.push({ from: pricing.status, to, by: req.user._id });
    pricing.status = to;
  }
  if (to === 'approved') {
    pricing.approvedBy = req.user._id;
    pricing.approvedAt = new Date();
  } else {
    /*
     * A sheet waiting on a signature must not still claim to carry one. Re-costing an approved
     * price below the floor lands here, and leaving the old approver on it would put "signed
     * off by MD" beside "needs approval" — the screen contradicting itself, and the reader
     * believing whichever half suits them.
     */
    pricing.approvedBy = undefined;
    pricing.approvedAt = undefined;
  }

  await pricing.save();
  await recordChange({ model: 'Pricing', doc: pricing, before, by: req.user });

  publish(to === 'approved' ? EVENTS.PRICING_APPROVED : EVENTS.PRICING_APPROVAL_REQUIRED, {
    pricing,
    by: req.user,
  });

  res.json({ success: true, data: visibleTo(pricing, req.user) });
});

/**
 * Signing off, or refusing, a price below the floor [§9].
 *
 * Only somebody who can see the floor may rule on it, which `assertMayCost` already says. The
 * note is required on a refusal for the same reason a lost enquiry needs a reason: "no" with no
 * explanation sends the costing round the loop again unchanged.
 */
export const decidePricing = asyncHandler(async (req, res) => {
  assertMayCost(req.user);

  const pricing = await Pricing.findById(req.params.id);
  if (!pricing) throw ApiError.notFound('Costing not found');
  if (pricing.status !== 'approval_pending') {
    throw ApiError.badRequest('This costing is not waiting on an approval');
  }

  const { approve, note } = req.body;
  if (!approve && !note?.trim()) {
    throw ApiError.badRequest('Say why the price is refused — it goes back to whoever costed it');
  }

  const to = approve ? 'approved' : 'rejected';
  pricing.statusHistory.push({ from: pricing.status, to, by: req.user._id, note });
  pricing.status = to;

  if (approve) {
    pricing.approvedBy = req.user._id;
    pricing.approvedAt = new Date();
  } else {
    pricing.rejectionNote = note;
  }

  await pricing.save();
  publish(approve ? EVENTS.PRICING_APPROVED : EVENTS.PRICING_REJECTED, { pricing, by: req.user });

  res.json({ success: true, data: visibleTo(pricing, req.user) });
});

/**
 * Turning a costing into a quotation [§7 → §10].
 *
 * This is the join between the two modules, and it exists so the chain is *made* rather than
 * retyped. A quote built by hand off a costing means somebody reading the number on one screen
 * and typing it into another: the model, the customer and the enquiry are re-entered, the link
 * back to the sheet is never set, and the price is one transcription slip away from wrong.
 * Here the sheet is the source — customer, enquiry, product and model come across with it, and
 * `pricing` is set, which is what §9's floor check reads before anything can be sent.
 *
 * **The quantity defaults to the MOQ, not to the quantity the sheet was costed at.** That is
 * the whole reason MOQ is on the costing: the approved price holds down to the MOQ and no
 * further, so the first quantity offered is the smallest one the price is good for. Marketing
 * can raise it — a buyer asking for more only makes the price safer — and passing a quantity
 * explicitly overrides it.
 *
 * Only an approved costing may be quoted. A sheet still in costing has no price yet, and one
 * waiting on §9 is precisely the case the approval route exists to stop.
 */
export const quoteFromPricing = asyncHandler(async (req, res) => {
  const pricing = await Pricing.findById(req.params.id);
  if (!pricing) throw ApiError.notFound('Costing not found');

  if (pricing.status !== 'approved') {
    const why = {
      requested: 'This costing has no price on it yet',
      costed: 'This costing has no price on it yet',
      approval_pending: 'This costing is waiting on approval — it cannot be quoted yet',
      rejected: 'This costing was refused — it needs re-costing before it can be quoted',
    }[pricing.status];
    throw ApiError.badRequest(why || 'Only an approved costing can be quoted');
  }

  if (!pricing.approvedSellingPrice) {
    throw ApiError.badRequest('This costing has no approved price to quote');
  }

  /*
   * The minimum this price will be offered at.
   *
   * Read from the product master rather than from the sheet: the MOQ is a term of the offer,
   * not a fact about the cost, so the costing does not carry one. Whoever is quoting may set a
   * different minimum for this buyer — the master is only the starting point.
   */
  const product = pricing.product ? await Product.findById(pricing.product) : null;
  const moq = req.body.moq ?? product?.moq ?? 0;

  /*
   * The MOQ, then what the sheet was costed at, then nothing. A costing with neither cannot
   * name a quantity, and guessing one is how a quote goes out for a lot size nobody agreed.
   */
  const quantity = req.body.quantity ?? (moq || pricing.quantity);
  if (!quantity) throw ApiError.badRequest('Say what quantity this quote is for');

  if (moq && quantity < moq) {
    throw ApiError.badRequest(
      `This quote states a minimum of ${moq} pieces — quote at least that, or lower the minimum`
    );
  }

  const quotation = await newQuotation(
    {
      ...req.body,
      quantity,
      moq,
      unitPrice: req.body.unitPrice ?? pricing.approvedSellingPrice,
      customer: pricing.customer,
      enquiry: pricing.enquiry || undefined,
      pricing: pricing._id,
      product: pricing.product || undefined,
      modelNumber: pricing.modelNumber,
    },
    req.user
  );

  res.status(201).json({ success: true, data: quotation });
});

/**
 * What a costing produced.
 *
 * The reverse of the link above. A sheet is not finished when it is approved — the question
 * that follows it is always "did we quote this, and at what?", and without the reverse view
 * that answer lives only in whoever remembers raising it.
 */
export const pricingQuotations = asyncHandler(async (req, res) => {
  const pricing = await Pricing.findById(req.params.id);
  if (!pricing) throw ApiError.notFound('Costing not found');

  const rows = await Quotation.find({ pricing: pricing._id })
    .select('number status quantity unitPrice revision createdAt sentAt')
    .sort('-createdAt');

  res.json({ success: true, data: rows });
});

/**
 * Correcting what the costing is *of*.
 *
 * The quantity, the model, the material, what the buyer said they wanted to pay. None of it was
 * editable before, which meant a costing raised for the wrong quantity — the commonest mistake
 * there is, since the automation copies it off the enquiry — could only be abandoned and
 * re-raised, leaving two sheets for one job and no way to tell which price was live.
 *
 * The prices are not here. They move through the costing sheet, where §9's floor is checked, so
 * that correcting a quantity cannot quietly re-open an approved price and a price change cannot
 * quietly skip the approval route. Two doors because they are two different decisions.
 *
 * A settled sheet is still editable — the same argument as re-costing one — but the quantity is
 * the one field that changes what the price *means*, so moving it on an approved sheet says so
 * rather than letting the sheet drift away from the number that was signed off.
 */
export const updatePricing = asyncHandler(async (req, res) => {
  assertMayCost(req.user);

  const pricing = await Pricing.findById(req.params.id);
  if (!pricing) throw ApiError.notFound('Costing not found');

  expectVersion(pricing, req.body);
  const before = snapshot(pricing);
  const patch = withoutVersion(req.body);

  if (patch.product) {
    const product = await Product.findById(patch.product);
    if (!product) throw ApiError.badRequest('That model does not exist');
    // The master fills in what it knows, unless this request says otherwise.
    patch.modelNumber = patch.modelNumber || product.modelCode;
    patch.material = patch.material || product.material;
  }

  const quantityMoved =
    patch.quantity !== undefined && patch.quantity !== pricing.quantity;

  Object.assign(pricing, patch);

  /*
   * A quantity change on a settled sheet is recorded as an event rather than left to the audit
   * log alone. The approved price was arrived at for a lot size, and somebody reading the sheet
   * later needs to see that the lot size moved after it was signed off — that is the whole
   * reason the two figures are worth comparing.
   */
  if (quantityMoved && CLOSED_PRICING_STATUSES.includes(pricing.status)) {
    pricing.statusHistory.push({
      from: pricing.status,
      to: pricing.status,
      by: req.user._id,
      note: `Quantity changed to ${patch.quantity} after the price was settled`,
    });
  }

  await pricing.save();
  await recordChange({ model: 'Pricing', doc: pricing, before, by: req.user });

  res.json({ success: true, data: visibleTo(pricing, req.user) });
});
