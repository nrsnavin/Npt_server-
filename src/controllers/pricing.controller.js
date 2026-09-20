import Pricing, { CLOSED_PRICING_STATUSES } from '../models/Pricing.js';
import Enquiry from '../models/Enquiry.js';
import Customer from '../models/Customer.js';
import Mould, { mouldWithPhoto } from '../models/Mould.js';
import Material, { grammageFrom } from '../models/Material.js';
import Component from '../models/Component.js';
import Quotation, { CLOSED_QUOTATION_STATUSES } from '../models/Quotation.js';
import { newQuotation } from './quotation.controller.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { nextNumber } from '../services/numbering.service.js';
import { listParams, paginated } from '../utils/query.js';
import { expectVersion, withoutVersion } from '../utils/concurrency.js';
import { recordChange, snapshot } from '../services/audit.service.js';
import { EVENTS, publish } from '../services/events.service.js';
import { allVisibleTo, assertMayCost, seesCosting, visibleTo } from '../services/pricingVisibility.js';
import { ownsRecord } from '../services/ownership.service.js';
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
/** How many models one sheet may price. Past this it is a price list, not a costing. */
export const MAX_LINES = 12;

const POPULATE = [
  { path: 'enquiry', select: 'number status requirement targetPrice' },
  /*
   * `assignedTo` because quoting is scoped to the buyer's owner [§29], and the register could
   * not tell. Every approved sheet offered marketing a Raise a quote button, including the ones
   * for accounts a colleague works — where the quote door answers "that customer belongs to
   * another marketing person" after the form has been filled in. Carrying the owner lets the
   * row say whose it is instead of offering a step that cannot be taken.
   */
  { path: 'customer', select: 'code name assignedTo', populate: { path: 'assignedTo', select: 'name' } },
  /*
   * Named fields rather than a bare populate. The mould's virtuals recompute on serialisation
   * whatever is projected — that is what a virtual is — so the derived figures come through
   * regardless, and listing the measured ones explicitly keeps a future field on the register
   * from arriving on a costing response nobody meant to widen.
   *
   * The first line is what the product master used to supply — the model's own code, size,
   * category, hook and minimum — which the costing screen reads to say what is being priced.
   */
  /*
   * The part photo comes with it, like everywhere else a mould is named. The costing screen
   * draws the thumbnail beside the code, and a named select that omits `photo` does not fail —
   * it quietly hands back a mould with no picture, so the screen falls through to its "no photo
   * on the register" placeholder and every costing looks like a model nobody photographed.
   */
  mouldWithPhoto(
    'lines.mould',
    'mouldCode name category sizeMm hookType moq packingQty ' +
      'cavities activeCavities partWeightGrams runnerWeightGrams ' +
      'regrindRecoveryPercent cycleTimeSeconds efficiencyPercent status material machine'
  ),
  { path: 'lines.materialRef', select: 'name code type colour ratePerKg grammageFactorPercent' },
  { path: 'lines.hookRef', select: 'name code colour ratePerPiece kind' },
  { path: 'lines.clipRef', select: 'name code colour ratePerPiece kind' },
  { path: 'lines.printRef', select: 'name code colour ratePerPiece kind' },
  { path: 'requestedBy', select: 'name' },
  { path: 'costedBy', select: 'name' },
  /* Who signed a price off sits on the line they signed, now that §9 is decided per model. */
  { path: 'lines.approvedBy', select: 'name' },
];

/**
 * Everything a costing takes from the tool and the resin, worked out once.
 *
 * **The grammage is the whole reason this exists.** A costing needs grams per piece, and three
 * separate facts go into that figure: the part weight, its share of the runner moulded
 * alongside it, and the density of the resin it is actually run in. The mould records the
 * first two on a PP basis; the material register carries the third as an uplift, which is 0 for
 * PP and LD and 18 for HIPS. Doing that arithmetic on a screen — or worse, in somebody's head
 * — is how a HIPS job gets costed at its PP weight and quoted 18% light on the resin.
 *
 * The conversion lines come across too, because they are facts about the part rather than about
 * this particular job: this hanger takes a clip, that one is packed 200 to a carton. Every one
 * of them stays editable on the sheet, since a particular job sometimes genuinely differs.
 */
export function costingFrom(mould, material, parts = {}) {
  const filled = {};

  if (mould) {
    /*
     * Part plus this piece's share of the runner, less any regrind recovery — the mould's own
     * consumption figure — and then converted into the resin actually being used.
     */
    filled.gramWeight = grammageFrom(
      mould.consumptionPerPieceGrams,
      material?.grammageFactorPercent
    );
    filled.jobWorkCost = mould.jobWorkCost || 0;
    filled.hookCost = mould.hookCost || 0;
    filled.metalClipsCost = mould.clipsCost || 0;
    filled.printingCost = mould.printingCost || 0;
    filled.packingCost = mould.packingCost || 0;
  }

  /*
   * The rate is *copied*, not referenced. A costing is a record of what was priced, so a resin
   * rate that moves next month must not retrospectively change a price a customer already has.
   */
  if (material) filled.rawMaterialRate = material.ratePerKg;

  /*
   * The parts registers win over the mould's own figures, and that ordering is the point.
   *
   * The mould says *this part takes a hook* — a fact about the piece, and a reasonable default.
   * The hook register says *a swivel hook costs ₹0.70 this week* — a purchase fact that moves.
   * When both have an opinion the priced one is newer and has a name attached, so it should be
   * the one on the sheet. A typed figure still beats both.
   */
  if (parts.hook) filled.hookCost = parts.hook.ratePerPiece;
  if (parts.clip) filled.metalClipsCost = parts.clip.ratePerPiece;
  if (parts.print) filled.printingCost = parts.print.ratePerPiece;

  return filled;
}

/**
 * Resolves the three parts references on a request, refusing any that is not on its register.
 *
 * The kind is checked as well as the id: `hookRef` pointing at a clip would price a hanger's
 * hook at the clip's rate and look entirely ordinary on the sheet.
 */
async function partsFrom(body) {
  const wanted = [
    ['hook', body.hookRef],
    ['clip', body.clipRef],
    ['print', body.printRef],
  ].filter(([, id]) => id);
  if (!wanted.length) return {};

  const found = await Component.find({ _id: { $in: wanted.map(([, id]) => id) } });
  const byId = new Map(found.map((row) => [String(row._id), row]));

  const parts = {};
  for (const [kind, id] of wanted) {
    const row = byId.get(String(id));
    if (!row) throw ApiError.badRequest(`That ${kind} is not on the register`);
    if (row.kind !== kind) {
      throw ApiError.badRequest(`${row.name} is a ${row.kind}, not a ${kind}`);
    }
    parts[kind] = row;
  }
  return parts;
}

/**
 * What the costing register will order by, and the one place on these screens where the answer
 * depends on who is asking.
 *
 * An ordering is information about the field it orders by. §8 keeps the cost base and the floor
 * away from marketing, and `?sort=markupPercent` would hand them back the same sheets ranked by
 * a figure `visibleTo` had just deleted — cheapest job first is a fact about the cost base, and
 * a few requests with a moving filter narrow it a long way. A redaction the sort parameter walks
 * around is not a redaction. So the confidential keys are offered only to a reader who could
 * already read those columns.
 *
 * The split follows `CONFIDENTIAL` and `PUBLIC_FIGURES` in `pricingVisibility` rather than a
 * fresh judgement about each field: the approved price, the target and the quantity are money
 * marketing is *meant* to see, and the markup and the override are not.
 *
 * Most of `CONFIDENTIAL` appears on neither list, for a second and simpler reason: `totalCost`,
 * `minimumSellingPrice`, `grossMarginPercent` and the tiers are virtuals, computed on the way
 * out of the document, so there is nothing in the collection for Mongo to order by. Offering
 * them would produce a table that draws a sort arrow and does not sort — which is worse than a
 * column that cannot be sorted at all, because it looks like it worked.
 */
const PRICING_SORTABLE = [
  'number', 'requestedAt', 'quantity', 'status', 'modelNumber',
  'approvedSellingPrice', 'calculatedSellingPrice', 'targetPrice',
];
const PRICING_COSTING_SORTABLE = ['markupPercent', 'minimumOverride'];

/**
 * The sort keys that used to be fields on the sheet and are now fields on a line.
 *
 * The request still asks for `approvedSellingPrice`, because that is the column the screen
 * shows and renaming it would break every saved view — but the sheet no longer has such a path,
 * and mongo asked to sort on one that does not exist returns the rows in whatever order it
 * likes. That is precisely what a sort control must never do: a table that ignores the header
 * somebody clicked is worse than one that has no header at all.
 *
 * Mongo sorts an array field by its smallest element ascending and its largest descending,
 * which on a one-model sheet is that model, and on a sheet of four is the cheapest or dearest
 * of them. Both are honest readings of "order these sheets by price".
 */
const ON_A_LINE = new Set([
  'quantity', 'modelNumber', 'approvedSellingPrice', 'calculatedSellingPrice',
  'markupPercent', 'minimumOverride',
]);

const sortOnLines = (sort) => {
  /* `listParams` hands back mongoose's string form — "-requestedAt", or several separated by
     spaces — so this reads that rather than an object. Written for the object form first, which
     turned the string into its characters and asked mongo to sort on a field called "0". */
  if (typeof sort !== 'string') return sort;

  return sort
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const descending = token.startsWith('-');
      const field = descending ? token.slice(1) : token;
      return `${descending ? '-' : ''}${ON_A_LINE.has(field) ? `lines.${field}` : field}`;
    })
    .join(' ');
};

/**
 * Which line an action is about.
 *
 * Named by `:lineId` on the route, or by `line` in the body, or — when neither says — the first
 * one. That default is what let every caller written before the sheet had lines go on working
 * unchanged: a one-model sheet has one line, and "the costing" and "the first line of the
 * costing" are the same thing there. It is not a guess on a sheet with four models, because a
 * screen that can show four lines is a screen that names the one it is acting on.
 */
function lineOf(pricing, req) {
  const id = req.params.lineId || req.body?.line;

  if (id) {
    const named = pricing.lines.id(id);
    if (!named) throw ApiError.notFound('That line is not on this costing');
    return named;
  }

  const [only] = pricing.lines;
  if (!only) throw ApiError.badRequest('This costing has no lines to work on');
  return only;
}

/**
 * One line's worth of a request, with the registers already resolved.
 *
 * Shared by the raise door and the line-adding door so a line entered either way goes through
 * the same register checks — a clip named as a hook is refused in both, or the two doors
 * disagree about what a valid line is.
 */
async function lineFrom(input, { enquiry, fallbackModel } = {}) {
  const mouldId = input.mould || undefined;
  const mould = mouldId ? await Mould.findById(mouldId) : null;
  if (mouldId && !mould) throw ApiError.badRequest('That mould is not on the register');

  const material = input.materialRef ? await Material.findById(input.materialRef) : null;
  if (input.materialRef && !material) throw ApiError.badRequest('That material is not on the register');

  const parts = await partsFrom(input);

  return {
    mould: mould?._id,
    materialRef: material?._id,
    hookRef: parts.hook?._id,
    clipRef: parts.clip?._id,
    printRef: parts.print?._id,
    modelNumber: input.modelNumber || fallbackModel || mould?.mouldCode,
    material: input.material || material?.type || mould?.material,
    procurement: input.procurement,
    printing: input.printing,
    markupPercent: input.markupPercent,
    /*
     * No cost from this door, and that is not an omission — it is the rule the single-model
     * raise already held. This route *raises* a costing; building the sheet is `/cost`, which
     * is where a typed figure may overrule the registers.
     */
    cost: costingFrom(mould, material, parts),
    status: 'requested',
  };
}

export const listPricings = asyncHandler(async (req, res) => {
  const { page, limit, sort, filter } = listParams(req.query, {
    searchFields: ['number', 'lines.modelNumber'],
    defaultSort: '-requestedAt',
    sortable: seesCosting(req.user)
      ? [...PRICING_SORTABLE, ...PRICING_COSTING_SORTABLE]
      : PRICING_SORTABLE,
  });

  if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };
  if (req.query.enquiry) filter.enquiry = req.query.enquiry;
  if (req.query.customer) filter.customer = req.query.customer;
  if (req.query.open === 'true') filter.status = { $nin: CLOSED_PRICING_STATUSES };
  /** §9's queue: the sheets somebody has to sign off before anything can be quoted. */
  if (req.query.awaitingApproval === 'true') filter.status = 'approval_pending';

  const [rows, total, stages] = await Promise.all([
    Pricing.find(filter).populate(POPULATE).sort(sortOnLines(sort)).skip((page - 1) * limit).limit(limit),
    Pricing.countDocuments(filter),
    Pricing.aggregate([{ $group: { _id: '$status', leads: { $sum: 1 } } }]),
  ]);

  /*
   * Which of these sheets already has an offer out on it.
   *
   * One costing raises one live quotation — the quote door refuses a second — and without this
   * the register cannot say so. Every approved row offered "Raise a quote" and the ones already
   * quoted answered with a refusal, which teaches people to distrust the button rather than to
   * read the rule. Scoped to the rows on this page, so it is one bounded query however large
   * the register grows.
   */
  const live = rows.length
    ? await Quotation.find({
        'lines.pricing': { $in: rows.map((row) => row._id) },
        status: { $nin: CLOSED_QUOTATION_STATUSES },
      }).select('number status lines.pricing')
    : [];

  const quotedOn = {};
  for (const quotation of live) {
    for (const line of quotation.lines || []) {
      if (line.pricing) {
        quotedOn[String(line.pricing)] = { _id: quotation._id, number: quotation.number, status: quotation.status };
      }
    }
  }

  paginated(res, allVisibleTo(rows, req.user), { page, limit, total }, {
    stageCounts: Object.fromEntries(stages.map((row) => [row._id, { leads: row.leads, value: 0 }])),
    quotedOn,
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

  /* The costing reference lives on the lines now, so that is where the match has to look. */
  const quotations = await Quotation.find({ 'lines.pricing': pricing._id })
    .select('number status lines revision validUntil sentAt createdAt')
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
   * The models this sheet is to price.
   *
   * `lines` when the caller sent them, and the single-model shape otherwise — the request that
   * names a mould and a model number at the top level is still exactly how most costings are
   * raised, and it becomes the one line on the sheet. One door, both shapes, because a second
   * endpoint for "a costing with several models" would be a second place for the register
   * checks and §9 to be got slightly wrong.
   *
   * The tool comes from the enquiry when the request does not name one. There is no lookup
   * beyond that: the enquiry names the mould directly, so the costing takes the same one rather
   * than guessing from a model code — which is what the old catalogue hop cost, since a model
   * with two tools on the register had no single right answer. Empty is a real answer and means
   * a traded piece; `procurement` says so on the line.
   */
  const asked = req.body.lines?.length
    ? req.body.lines
    : [{ ...req.body, mould: req.body.mould || enquiry?.mould }];

  if (asked.length > MAX_LINES) {
    throw ApiError.badRequest(
      `A costing sheet holds ${MAX_LINES} models. Past that it is a price list, and nobody can `
      + 'check a floor they have to scroll to find.'
    );
  }

  /*
   * The enquiry's own items fill in the model numbers the request left out, row for row. An
   * enquiry now carries a list too, and a costing raised off one is usually being raised for
   * exactly those models in exactly that order.
   */
  const lines = await Promise.all(
    asked.map((row, index) =>
      lineFrom(
        { ...row, mould: row.mould ?? (index === 0 ? enquiry?.mould : undefined) },
        { fallbackModel: enquiry?.items?.[index]?.modelNumber ?? enquiry?.requirement?.modelNumber }
      )
    )
  );

  const pricing = await Pricing.create({
    customer: customerId,
    enquiry: req.body.enquiry || undefined,
    targetPrice: req.body.targetPrice,
    remarks: req.body.remarks,
    lines,
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
  const line = lineOf(pricing, req);

  const wasSettled = CLOSED_PRICING_STATUSES.includes(line.status);
  if (wasSettled) {
    pricing.statusHistory.push({
      from: line.status,
      to: 'costed',
      by: req.user._id,
      note: `Re-costed after being settled${line.modelNumber ? ` — ${line.modelNumber}` : ''}`,
    });
    // Actually moved, not just noted: the §9 route below reads the line's status to write its
    // own history entry, and leaving it settled would record that move as coming from a stage
    // the line had already left.
    line.status = 'costed';
  }

  expectVersion(pricing, req.body);
  const before = snapshot(pricing);

  const {
    cost, markupPercent, approvedSellingPrice, minimumOverride, printing, procurement, mould,
    materialRef, hookRef, clipRef, printRef, remarks,
  } = withoutVersion(req.body);

  /*
   * The two registers first, because they write cost lines. Attaching a mould sets the gram
   * weight to what the tool says a piece consumes — part plus its share of the runner — and the
   * material converts that onto its own grammage basis and brings its rate. An explicit `cost`
   * in the same request still wins, so somebody who has weighed a bag of finished pieces is not
   * overruled by the registers.
   */
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
    /*
     * Refilled from what the *line* holds, not from what this request happened to mention.
     *
     * Switching only the resin sent `parts` in empty, so the three parts lines fell back to the
     * mould's own figures and silently discarded rates that had come from the registers — a
     * hook priced at ₹1.10 quietly reverting to the tool's ₹0.70 because somebody changed PP to
     * HIPS. Nothing errored and no line the person touched looked wrong.
     */
    const [tool, resin, held] = await Promise.all([
      line.mould ? Mould.findById(line.mould) : null,
      line.materialRef ? Material.findById(line.materialRef) : null,
      partsFrom({ hookRef: line.hookRef, clipRef: line.clipRef, printRef: line.printRef }),
    ]);

    line.cost = { ...line.cost?.toObject?.(), ...costingFrom(tool, resin, held) };
  }

  if (cost) line.cost = { ...line.cost?.toObject?.(), ...cost };
  if (markupPercent !== undefined) line.markupPercent = markupPercent;
  if (minimumOverride !== undefined) line.minimumOverride = minimumOverride;
  if (printing !== undefined) line.printing = printing;
  if (procurement !== undefined) line.procurement = procurement;
  /* Remarks are the sheet's, not the line's — they are about the job, not about one model. */
  if (remarks !== undefined) pricing.remarks = remarks;

  /*
   * A floor beneath the cost is not a floor [§9].
   *
   * `minimumOverride` exists because a particular buyer or job sometimes has a minimum of its
   * own, and a rule with no exception is one people work around by keeping the real number
   * somewhere the system cannot see. But the override was unbounded, and an override under the
   * cost quietly dismantles the whole gate rather than bending it: `belowMinimum` compares the
   * price against this number, so a floor of one paisa is false for every price there is. The
   * line then approves itself, the quotation gate finds nothing to stop, and a price that loses
   * money on every piece goes out with nobody's signature on it — which is the one outcome §9
   * was written to prevent.
   *
   * Refused rather than routed for approval, because the escape already exists and is the
   * better one: put the price you actually want on the sheet and let §9 send *that* for a
   * signature. Somebody then approves a price they can see, rather than approving a floor whose
   * consequence is invisible.
   */
  if (line.minimumOverride != null && line.totalCost && line.minimumOverride < line.totalCost) {
    throw ApiError.badRequest(
      `A minimum of ${line.minimumOverride.toFixed(2)} is below what the piece costs to make ` +
        `(${line.totalCost.toFixed(2)}), so it would let any price through unchecked. Put the ` +
        'price you want on the sheet instead — anything under the standing minimum goes for ' +
        'approval, which is the decision being made here.'
    );
  }

  // Derived, never typed — see the note above.
  line.calculatedSellingPrice = priceFrom(line);
  line.approvedSellingPrice =
    approvedSellingPrice !== undefined ? approvedSellingPrice : line.calculatedSellingPrice;
  pricing.costedBy = req.user._id;

  /*
   * §9, on this line and no other.
   *
   * This is the whole reason the sheet has lines: a costing under the floor cannot be quoted
   * until somebody signs it off, and that is a judgement about one model's price against one
   * model's cost. Routing it at the moment the number is written is what makes the block
   * enforceable rather than a rule somebody is supposed to remember when they build the quote —
   * and routing it *per line* is what stops one signature clearing seven prices nobody read.
   */
  const to = line.belowMinimum ? 'approval_pending' : 'approved';
  if (line.status !== to) {
    pricing.statusHistory.push({
      from: line.status,
      to,
      by: req.user._id,
      note: line.modelNumber || undefined,
    });
    line.status = to;
  }
  if (to === 'approved') {
    line.approvedBy = req.user._id;
    line.approvedAt = new Date();
  } else {
    /*
     * A line waiting on a signature must not still claim to carry one. Re-costing an approved
     * price below the floor lands here, and leaving the old approver on it would put "signed
     * off by MD" beside "needs approval" — the screen contradicting itself, and the reader
     * believing whichever half suits them.
     */
    line.approvedBy = undefined;
    line.approvedAt = undefined;
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

  /*
   * One line, one decision.
   *
   * Without a `:lineId` this settles the first line, which is what every caller written before
   * the sheet had lines means — and on a one-model sheet it is the only reading there is. On a
   * sheet with four prices under the floor it is four presses, deliberately: the alternative is
   * a single signature standing for models whose costs the signer never saw, which is the case
   * §9 exists to prevent and the reason the floor lives on the line.
   */
  const line = lineOf(pricing, req);
  if (line.status !== 'approval_pending') {
    throw ApiError.badRequest(
      line.modelNumber
        ? `${line.modelNumber} is not waiting on an approval`
        : 'This costing is not waiting on an approval'
    );
  }

  const { approve, note } = req.body;
  if (!approve && !note?.trim()) {
    throw ApiError.badRequest('Say why the price is refused — it goes back to whoever costed it');
  }

  const to = approve ? 'approved' : 'rejected';
  /* The history is the sheet's, and the entry names the model, or a sheet with four decisions
     on it reads as four moves nobody can tell apart. */
  pricing.statusHistory.push({
    from: line.status,
    to,
    by: req.user._id,
    note: line.modelNumber ? `${line.modelNumber}${note ? ` — ${note}` : ''}` : note,
  });
  line.status = to;

  if (approve) {
    line.approvedBy = req.user._id;
    line.approvedAt = new Date();
  } else {
    line.rejectionNote = note;
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
 * Here the sheet is the source — customer, enquiry, mould and model come across with it, and
 * `pricing` is set, which is what §9's floor check reads before anything can be sent.
 *
 * **The minimum comes across, and there is no quantity at all** [§10]. The approved price holds
 * down to the MOQ and no further, so the minimum is the one quantity the offer is genuinely
 * conditional on — and it is what a buyer reads off the document. How many they actually take
 * is settled by the purchase order, which is the first thing in the chain anybody has committed
 * to. The register's minimum for the tool is the starting point; whoever quotes may set another
 * for this buyer.
 *
 * Only an approved costing may be quoted. A sheet still in costing has no price yet, and one
 * waiting on §9 is precisely the case the approval route exists to stop.
 */
export const quoteFromPricing = asyncHandler(async (req, res) => {
  const pricing = await Pricing.findById(req.params.id);
  if (!pricing) throw ApiError.notFound('Costing not found');

  /*
   * The lines that actually have a price on them.
   *
   * **Read per line rather than off the sheet, and that changes who is held up.** A sheet with
   * five models settled and one still under discussion used to be refused whole, because its
   * roll-up read `approval_pending` — so one price waiting on a signature stopped the other five
   * being offered, and the way round it was to raise the five somewhere else. The five are
   * quoted now and the sixth stays on the sheet, to be added to the same document the day it
   * clears. Nothing unapproved goes out either way: that is what this filter is.
   */
  const quotable = (pricing.lines || []).filter(
    (line) => line.status === 'approved' && line.approvedSellingPrice
  );

  if (!quotable.length) {
    /* Nothing to offer, and the reason is the state of the lines rather than of the sheet. */
    const why = {
      requested: 'This costing has no price on it yet',
      costed: 'This costing has no price on it yet',
      approval_pending: 'This costing is waiting on approval — it cannot be quoted yet',
      rejected: 'This costing was refused — it needs re-costing before it can be quoted',
    }[pricing.status];
    throw ApiError.badRequest(why || 'This costing has no approved price to quote');
  }

  /*
   * The minimum each price will be offered at.
   *
   * Read from the mould register rather than from the sheet: the MOQ is a term of the offer,
   * not a fact about the cost, so the costing does not carry one. Whoever is quoting may set a
   * different minimum for this buyer — the register is only the starting point, and a traded
   * piece has no tool to ask, so it starts at nothing and the quoter says.
   */
  const moulds = new Map(
    (
      await Mould.find({ _id: { $in: quotable.map((line) => line.mould).filter(Boolean) } }).select('moq')
    ).map((row) => [String(row._id), row])
  );

  /*
   * There is deliberately no quantity here [§10].
   *
   * A quotation from this plant offers a **rate against a minimum**, not a lot: the buyer is
   * told ₹4.90 a piece with a 5,000 minimum, and the purchase order decides how many, months
   * later. The quantity that used to be computed here came off the enquiry by way of the
   * costing — a figure nobody had agreed to — and then sat on the quote looking like one that
   * had. The minimum above is the only quantity the offer is actually conditional on.
   */
  const { moq: _m, unitPrice: _u, quotation: _q, ...terms } = req.body;

  /*
   * A quotation line per approved costing line, each carrying the line it came from.
   *
   * The sheet is the source of the models, not this door: it offers exactly what was priced and
   * invents nothing. `pricingLine` is what lets the order booked from this quote read back the
   * resin and the parts *that model* was costed against, rather than the first model on a sheet
   * that now holds several.
   *
   * A rate or a minimum typed on the request applies only when there is one model to apply it
   * to. On a sheet of five it would mean "offer all five at this price", which is not something
   * anybody means — those are edited on the quotation, model by model.
   */
  const only = quotable.length === 1;
  const lines = quotable.map((costed) => ({
    moq: (only ? req.body.moq : undefined) ?? moulds.get(String(costed.mould))?.moq ?? 0,
    unitPrice: (only ? req.body.unitPrice : undefined) ?? costed.approvedSellingPrice,
    pricing: pricing._id,
    pricingLine: costed._id,
    mould: costed.mould || undefined,
    modelNumber: costed.modelNumber,
  }));

  /*
   * Onto a quotation already being drafted, when one is named.
   *
   * Without this, eight approved costings for one buyer produced eight quotation numbers, and
   * the person quoting had to choose between the plant's real document and the system's idea of
   * one. A costing is per model and a quotation is per conversation; this is the join.
   */
  if (req.body.quotation) {
    const quotation = await Quotation.findById(req.body.quotation);
    if (!quotation) throw ApiError.badRequest('That quotation does not exist');
    if (!ownsRecord(req.user, quotation)) {
      throw ApiError.badRequest('That quotation does not exist');
    }

    /*
     * A draft, and only a draft. Once a quote has been sent, adding a model to it changes what
     * the buyer was told — §10 routes that through a revision, and quietly appending a line
     * here would be the offer moving with nothing in the history to say so.
     */
    if (quotation.sentAt || quotation.status !== 'draft') {
      throw ApiError.badRequest(
        `${quotation.number} has already gone out — raise a revision on it, or start a new quote`
      );
    }
    if (String(quotation.customer) !== String(pricing.customer)) {
      throw ApiError.badRequest(`${quotation.number} is for a different customer`);
    }
    /*
     * A model already on that document is not offered twice — but the others on the same sheet
     * still are. A line quoted before the sheet had lines names no line of it, and on those the
     * sheet was one model, so it stands for the whole of it.
     */
    const already = (row) =>
      quotation.lines.some(
        (existing) =>
          String(existing.pricing) === String(pricing._id)
          && (!existing.pricingLine || String(existing.pricingLine) === String(row.pricingLine))
      );

    const fresh = lines.filter((row) => !already(row));
    if (!fresh.length) {
      throw ApiError.badRequest(`${pricing.number} is already on ${quotation.number}`);
    }

    quotation.lines.push(...fresh);
    /* Rev 0 is what will be offered, and nothing has been offered yet — see `updateQuotation`. */
    quotation.revisions[0] = {
      ...quotation.revisions[0].toObject(),
      lines: quotation.lines.map((row) => {
        const plain = row.toObject();
        delete plain._id;
        return plain;
      }),
    };
    await quotation.save();

    return res.status(200).json({ success: true, data: quotation });
  }

  /*
   * One live quotation per sheet.
   *
   * Adding a sheet to an existing quotation is carefully guarded a few lines above — it refuses
   * a sheet already on that document. Starting a *new* one was guarded by nothing, and the
   * button that does it sits on a screen somebody presses on their way past: two presses, and
   * there are two quotation numbers offering the same model to the same buyer at the same
   * price. Which of them the buyer holds is then whichever was emailed, and the other sits in
   * the sent board being chased.
   *
   * Refused rather than handed back, because a second press is usually a mistake and the useful
   * answer names the document that already exists. A quotation the customer has *answered* is
   * not in the way: they said no to that price, so re-costing and re-quoting is the ordinary
   * next move and exactly what this door is for.
   */
  const live = await Quotation.findOne({
    'lines.pricing': pricing._id,
    status: { $nin: CLOSED_QUOTATION_STATUSES },
  });

  if (live) {
    throw ApiError.conflict(
      `${pricing.number} is already quoted on ${live.number}. Revise that one, or record what ` +
        'the customer said about it first.'
    );
  }

  const quotation = await newQuotation(
    {
      ...terms,
      lines,
      customer: pricing.customer,
      enquiry: pricing.enquiry || undefined,
    },
    req.user
  );

  return res.status(201).json({ success: true, data: quotation });
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

  const rows = await Quotation.find({ 'lines.pricing': pricing._id })
    .select('number status lines revision createdAt sentAt')
    .sort('-createdAt');

  res.json({ success: true, data: rows });
});

/**
 * Correcting what the costing is *of*.
 *
 * The model, the material, what the buyer said they wanted to pay. None of it was editable
 * before, which meant a costing raised against the wrong model could only be abandoned and
 * re-raised, leaving two sheets for one job and no way to tell which price was live.
 *
 * The prices are not here. They move through the costing sheet, where §9's floor is checked, so
 * that a description correction cannot quietly re-open an approved price and a price change
 * cannot quietly skip the approval route. Two doors because they are two different decisions.
 *
 * A settled sheet is still editable, on the same argument as re-costing one.
 */
export const updatePricing = asyncHandler(async (req, res) => {
  assertMayCost(req.user);

  const pricing = await Pricing.findById(req.params.id);
  if (!pricing) throw ApiError.notFound('Costing not found');

  expectVersion(pricing, req.body);
  const before = snapshot(pricing);
  const patch = withoutVersion(req.body);

  /*
   * A correction splits in two: what is about the *job* stays on the sheet, what is about a
   * *model* goes to the line this request names. Assigning the lot to the sheet would have
   * written the model fields onto virtuals, where they would have vanished without a word.
   */
  const LINE_FIELDS = ['mould', 'materialRef', 'hookRef', 'clipRef', 'printRef',
    'modelNumber', 'material', 'procurement', 'printing', 'markupPercent'];

  if (LINE_FIELDS.some((field) => patch[field] !== undefined)) {
    const line = lineOf(pricing, req);

    if (patch.mould) {
      const tool = await Mould.findById(patch.mould);
      if (!tool) throw ApiError.badRequest('That mould is not on the register');
      // The register fills in what it knows, unless this request says otherwise.
      patch.modelNumber = patch.modelNumber || tool.mouldCode;
      patch.material = patch.material || tool.material;
    }

    for (const field of LINE_FIELDS) {
      if (patch[field] !== undefined) line[field] = patch[field];
      delete patch[field];
    }
  }

  /*
   * There is no longer a quantity to move. A costing is a per-piece cost — grams at a rate per
   * kilo, plus per-piece parts — so nothing in it varies with the lot size, and the event that
   * used to be recorded here ("the quantity changed after the price was settled") was recording
   * a change to a figure the price never depended on. See the model's note.
   */
  Object.assign(pricing, patch);

  await pricing.save();
  await recordChange({ model: 'Pricing', doc: pricing, before, by: req.user });

  res.json({ success: true, data: visibleTo(pricing, req.user) });
});
