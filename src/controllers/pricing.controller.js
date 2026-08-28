import Pricing, { CLOSED_PRICING_STATUSES } from '../models/Pricing.js';
import Enquiry from '../models/Enquiry.js';
import Customer from '../models/Customer.js';
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

export const getPricing = asyncHandler(async (req, res) => {
  const pricing = await Pricing.findById(req.params.id).populate(POPULATE);
  if (!pricing) throw ApiError.notFound('Costing not found');
  res.json({ success: true, data: visibleTo(pricing, req.user) });
});

/**
 * Raising a costing request by hand.
 *
 * The ordinary route is the automation — an enquiry reaching `pricing_required` raises one —
 * so this exists for the case the automation cannot cover: a price wanted before the enquiry
 * has moved, or a re-costing after the buyer changed the quantity. It is the same record
 * either way.
 */
export const createPricing = asyncHandler(async (req, res) => {
  const enquiry = req.body.enquiry ? await Enquiry.findById(req.body.enquiry) : null;
  if (req.body.enquiry && !enquiry) throw ApiError.badRequest('That enquiry does not exist');

  const customerId = req.body.customer || enquiry?.customer;
  if (!customerId) throw ApiError.badRequest('A costing needs the customer it is for');
  if (!(await Customer.findById(customerId))) throw ApiError.badRequest('That customer does not exist');

  const pricing = await Pricing.create({
    ...req.body,
    customer: customerId,
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
 */
export const costPricing = asyncHandler(async (req, res) => {
  assertMayCost(req.user);

  const pricing = await Pricing.findById(req.params.id);
  if (!pricing) throw ApiError.notFound('Costing not found');
  if (CLOSED_PRICING_STATUSES.includes(pricing.status)) {
    throw ApiError.badRequest(`A ${pricing.status} costing cannot be rebuilt — raise a new one`);
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
