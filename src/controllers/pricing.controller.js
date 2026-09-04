import Pricing, { CLOSED_PRICING_STATUSES } from '../models/Pricing.js';
import Enquiry from '../models/Enquiry.js';
import Customer from '../models/Customer.js';
import Mould from '../models/Mould.js';
import Material, { grammageFrom } from '../models/Material.js';
import Component from '../models/Component.js';
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
  /*
   * Named fields rather than a bare populate. The mould's virtuals recompute on serialisation
   * whatever is projected — that is what a virtual is — so the derived figures come through
   * regardless, and listing the measured ones explicitly keeps a future field on the register
   * from arriving on a costing response nobody meant to widen.
   *
   * The first line is what the product master used to supply — the model's own code, size,
   * category, hook and minimum — which the costing screen reads to say what is being priced.
   */
  {
    path: 'mould',
    select:
      'mouldCode name category sizeMm hookType moq packingQty ' +
      'cavities activeCavities partWeightGrams runnerWeightGrams ' +
      'regrindRecoveryPercent cycleTimeSeconds efficiencyPercent status material machine',
  },
  { path: 'materialRef', select: 'name code type colour ratePerKg grammageFactorPercent' },
  { path: 'hookRef', select: 'name code colour ratePerPiece kind' },
  { path: 'clipRef', select: 'name code colour ratePerPiece kind' },
  { path: 'printRef', select: 'name code colour ratePerPiece kind' },
  { path: 'requestedBy', select: 'name' },
  { path: 'costedBy', select: 'name' },
  { path: 'approvedBy', select: 'name' },
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
   * The tool, from the request or from the enquiry that asked for the price.
   *
   * There is no lookup to do beyond this any more. The enquiry names the mould directly, so the
   * costing takes the same one rather than guessing from a model code — which is what the old
   * catalogue hop cost: a model with two tools on the register had no single right answer, and
   * a model with none silently produced a sheet built on nothing. Empty is a real answer here,
   * and means a traded piece: `procurement` says so on the record.
   */
  const mouldId = req.body.mould || enquiry?.mould;
  const mould = mouldId ? await Mould.findById(mouldId) : null;
  if (mouldId && !mould) throw ApiError.badRequest('That mould is not on the register');

  const material = req.body.materialRef ? await Material.findById(req.body.materialRef) : null;
  if (req.body.materialRef && !material) {
    throw ApiError.badRequest('That material is not on the register');
  }

  const parts = await partsFrom(req.body);

  /* Everything the tool, the resin and the parts already know. */
  const filled = costingFrom(mould, material, parts);

  const pricing = await Pricing.create({
    ...req.body,
    mould: mould?._id,
    materialRef: material?._id,
    hookRef: parts.hook?._id,
    clipRef: parts.clip?._id,
    printRef: parts.print?._id,
    customer: customerId,
    modelNumber: req.body.modelNumber || enquiry?.requirement?.modelNumber || mould?.mouldCode,
    material: req.body.material || material?.type || mould?.material,
    /*
     * The gram weight is the one cost line the plant already knows, and re-typing it is how a
     * costing ends up priced for a piece that weighs something else. The rate is not copied: it
     * is today's resin price, which no master has any business remembering.
     *
     * What the mould gives is what a piece *consumes* — the part weight plus its share of the
     * runner moulded alongside it — and not what the piece weighs. On a four-cavity tool with a
     * 12 g runner that gap is 3 g on a 30 g part: a tenth of the resin on every quotation off
     * that mould, always understated, and never visible on the sheet because the arithmetic
     * below it is perfectly correct. A costing that starts from a part weight starts wrong.
     *
     * The material then converts that PP figure into the resin actually being run, and brings
     * its own rate and the tool's conversion lines with it. An explicit `cost` in the request
     * still wins over all of it: somebody who has weighed a bag of finished pieces is not
     * overruled by two registers.
     */
    /*
     * No `req.body.cost` here, and that is not an omission: `pricingSchema` does not declare
     * one, so a cost sent to this door is stripped before the controller sees it. This route
     * *raises* a costing; building the sheet is `/cost`, which is where a typed figure can
     * overrule the registers. The spread that used to sit here read as though it worked.
     */
    cost: filled,
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
  if (mould === null) pricing.mould = undefined;
  if (materialRef === null) pricing.materialRef = undefined;
  for (const [field, value] of [['hookRef', hookRef], ['clipRef', clipRef], ['printRef', printRef]]) {
    if (value === null) pricing[field] = undefined;
  }

  const parts = await partsFrom({ hookRef, clipRef, printRef });
  if (parts.hook) pricing.hookRef = parts.hook._id;
  if (parts.clip) pricing.clipRef = parts.clip._id;
  if (parts.print) pricing.printRef = parts.print._id;

  if (mould) {
    const tool = await Mould.findById(mould);
    if (!tool) throw ApiError.badRequest('That mould is not on the register');
    pricing.mould = tool._id;
  }
  if (materialRef) {
    const resin = await Material.findById(materialRef);
    if (!resin) throw ApiError.badRequest('That material is not on the register');
    pricing.materialRef = resin._id;
    pricing.material = resin.type;
  }

  /*
   * Refilled whenever either reference moves, because the grammage depends on both: switching
   * a PP job to HIPS changes the weight by 18% without anything else on the sheet moving, and
   * a person who picked the new resin and saw the old weight would reasonably assume it had
   * been handled. Any line explicitly sent in the same request still wins.
   */
  if (mould || materialRef || hookRef || clipRef || printRef) {
    /*
     * Refilled from what the sheet *holds*, not from what this request happened to mention.
     *
     * Switching only the resin sent `parts` in empty, so the three parts lines fell back to the
     * mould's own figures and silently discarded rates that had come from the registers — a
     * hook priced at ₹1.10 quietly reverting to the tool's ₹0.70 because somebody changed PP to
     * HIPS. Nothing errored and no line the person touched looked wrong.
     */
    const [tool, resin, held] = await Promise.all([
      pricing.mould ? Mould.findById(pricing.mould) : null,
      pricing.materialRef ? Material.findById(pricing.materialRef) : null,
      partsFrom({
        hookRef: pricing.hookRef,
        clipRef: pricing.clipRef,
        printRef: pricing.printRef,
      }),
    ]);

    pricing.cost = {
      ...pricing.cost?.toObject?.(),
      ...costingFrom(tool, resin, held),
    };
  }

  if (cost) pricing.cost = { ...pricing.cost?.toObject?.(), ...cost };
  if (markupPercent !== undefined) pricing.markupPercent = markupPercent;
  if (minimumOverride !== undefined) pricing.minimumOverride = minimumOverride;
  if (printing !== undefined) pricing.printing = printing;
  if (procurement !== undefined) pricing.procurement = procurement;
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
 * Here the sheet is the source — customer, enquiry, mould and model come across with it, and
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
   * Read from the mould register rather than from the sheet: the MOQ is a term of the offer,
   * not a fact about the cost, so the costing does not carry one. Whoever is quoting may set a
   * different minimum for this buyer — the register is only the starting point, and a traded
   * piece has no tool to ask, so it starts at nothing and the quoter says.
   */
  const mould = pricing.mould ? await Mould.findById(pricing.mould).select('moq') : null;
  const moq = req.body.moq ?? mould?.moq ?? 0;

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

  /*
   * One line, because one costing prices one model. The quotation can carry more — that is the
   * whole point of it having lines — but they arrive by editing the quote afterwards or by
   * quoting a second costing onto it, not by this door inventing models the sheet never priced.
   */
  const { quantity: _q, moq: _m, unitPrice: _u, ...terms } = req.body;

  const quotation = await newQuotation(
    {
      ...terms,
      lines: [
        {
          quantity,
          moq,
          unitPrice: req.body.unitPrice ?? pricing.approvedSellingPrice,
          pricing: pricing._id,
          mould: pricing.mould || undefined,
          modelNumber: pricing.modelNumber,
        },
      ],
      customer: pricing.customer,
      enquiry: pricing.enquiry || undefined,
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

  const rows = await Quotation.find({ 'lines.pricing': pricing._id })
    .select('number status lines revision createdAt sentAt')
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

  if (patch.mould) {
    const tool = await Mould.findById(patch.mould);
    if (!tool) throw ApiError.badRequest('That mould is not on the register');
    // The register fills in what it knows, unless this request says otherwise.
    patch.modelNumber = patch.modelNumber || tool.mouldCode;
    patch.material = patch.material || tool.material;
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
