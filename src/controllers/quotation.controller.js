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
import { lineCosting } from '../services/pricingVisibility.js';

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
 * Whether one line's price may be sent [§9].
 *
 * Read off the costing rather than trusted from the request: the whole point is that the person
 * building the quote cannot see the minimum, so they cannot be the one to decide they are above
 * it. A line with no costing behind it is not blocked — plenty of repeat jobs are quoted from
 * a known price — but one that *has* a costing must respect it.
 */
async function lineIsCleared(line) {
  if (!line.pricing) return { cleared: true };

  const pricing = await Pricing.findById(line.pricing);
  if (!pricing) return { cleared: true };

  if (pricing.status === 'approval_pending') {
    return { cleared: false, why: 'waiting', one: 'its costing is still waiting on approval', many: 'their costings are still waiting on approval' };
  }
  if (pricing.status === 'rejected') {
    return { cleared: false, why: 'refused', one: 'its costing was refused and needs re-costing', many: 'their costings were refused and need re-costing' };
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

  if (Number.isFinite(floor) && line.unitPrice < floor) {
    return {
      cleared: false,
      // Deliberately does not name the figure: §8 keeps the floor away from marketing, and a
      // refusal that quotes it hands over the very number the rule protects.
      why: 'floor',
      one: 'it is below the approved minimum',
      many: 'they are below their approved minimums',
    };
  }
  return { cleared: true };
}

/**
 * Whether the whole document may go out — which means every line on it.
 *
 * **Every line, not the document.** This is the difference a multi-line quotation makes to §9,
 * and it is not a detail: a quote with seven prices comfortably above their floors and one
 * beneath is precisely what a single document-level check waves through, because there is no
 * one price for it to look at. The block is all-or-nothing because the document is — you cannot
 * send seven eighths of a quotation — and the message names the offending models so the person
 * holding it knows which price to argue about.
 *
 * Still never names a figure. §8 keeps the floor away from marketing whether it is refusing one
 * line or eight.
 */
async function priceIsCleared(quotation) {
  const blocked = [];

  for (const line of quotation.lines) {
    const result = await lineIsCleared(line);
    if (!result.cleared) blocked.push({ model: line.modelNumber || 'an unnamed line', ...result });
  }

  if (!blocked.length) return { cleared: true };

  /*
   * One reason repeated across every line reads better said once — "3 lines are below their
   * approved minimums" rather than the same sentence three times with different model codes in
   * front of it — but the models still have to be named, because that is what the reader acts
   * on. Each reason carries a singular and a plural phrasing because it is written into a
   * sentence whose subject is a count: "3 lines ... because its costing is waiting" is the sort
   * of thing that makes a person read a message twice and trust it less.
   */
  const single = blocked.length === 1;
  const kinds = [...new Map(blocked.map((entry) => [entry.why, entry])).values()];
  const reasons = kinds.map((entry) => (single ? entry.one : entry.many)).join(', and ');
  const models = blocked.map((entry) => entry.model).join(', ');

  return {
    cleared: false,
    blocked,
    why: single
      ? `${models} cannot be sent because ${reasons} — this needs management approval first`
      : `${blocked.length} lines cannot be sent (${models}) because ${reasons}` +
        ' — this needs management approval first',
  };
}

export const listQuotations = asyncHandler(async (req, res) => {
  const { page, limit, sort, filter } = listParams(req.query, {
    /* Model codes moved onto the lines, so searching for one has to look inside them. */
    searchFields: ['number', 'lines.modelNumber'],
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
    /*
     * The value of a quotation is the sum of its lines, so the total has to be reduced over
     * them inside the pipeline. Multiplying a document-level price by a document-level quantity
     * was the old shape and would now multiply two missing fields into nothing — a stage board
     * reading zero against a full pipeline, which looks like a reporting fault rather than a
     * schema one and gets chased for a day.
     */
    Quotation.aggregate([
      { $match: scope },
      {
        $group: {
          _id: '$status',
          leads: { $sum: 1 },
          value: {
            $sum: {
              $reduce: {
                input: { $ifNull: ['$lines', []] },
                initialValue: 0,
                in: {
                  $add: [
                    '$$value',
                    {
                      $multiply: [
                        { $ifNull: ['$$this.unitPrice', 0] },
                        { $ifNull: ['$$this.quantity', 0] },
                      ],
                    },
                  ],
                },
              },
            },
          },
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

/**
 * One quotation, with everything a person needs to read it.
 *
 * More than the list carries, because a row and a document answer different questions. A row
 * says which quotations exist; this has to answer "what did we offer, and how did we get here"
 * — which needs the names against each revision, the model behind the line, and the costing the
 * price came from.
 *
 * The costing behind each line comes through `lineCosting`, which is an explicit allow-list and
 * not a `select`. That matters and is worth knowing: the costing's totals are *virtuals*, so
 * they are recomputed on the way out whatever the projection said, and `totalCost` arrived as
 * `0` — a figure that reveals nothing today but reads as "this costs nothing" on a screen, and
 * would start reporting real money the moment somebody widened the select. An allow-list cannot
 * drift that way.
 *
 * What it adds is the figure neither record holds alone: the margin on **this line's** price.
 * A costing knows what it would earn at the price it was approved at; a line knows what was
 * actually offered, and the two diverge the moment anybody negotiates. Someone who may open the
 * costing now sees that answer on the quotation instead of opening two screens and doing the
 * subtraction; someone who may not sees exactly what they saw before, plus whether the line
 * sits under its floor — the same "whether, not where" §8 already draws for `belowMinimum`.
 */
export const getQuotation = asyncHandler(async (req, res) => {
  const quotation = await Quotation.findById(req.params.id)
    .populate('customer', 'code name city state gstin mobile email')
    .populate('enquiry', 'number status')
    .populate('assignedTo', 'name')
    .populate('lines.product', 'modelCode name sizeMm material moq')
    /* Whole, and narrowed per line below: what may be shown depends on who is asking. */
    .populate('lines.pricing')
    .populate('revisions.by', 'name')
    .populate('statusHistory.by', 'name');

  if (!quotation) throw ApiError.notFound('Quotation not found');
  if (!ownsRecord(req.user, quotation)) throw ApiError.notFound('Quotation not found');

  const data = quotation.toJSON();
  /*
   * Narrowed once per line, against the price that line actually quotes. Done on the document
   * rather than in the populate, because the answer is different for two people reading the
   * same quotation — which a projection cannot express.
   */
  for (const line of data.lines || []) {
    line.pricing = lineCosting(line.pricing, line.unitPrice, req.user);
  }

  res.json({ success: true, data });
});

/**
 * Builds and saves a quotation, whoever asked for it.
 *
 * Shared by the two doors into this module — marketing writing one from scratch, and a costing
 * being turned into a quote — because the interesting parts are the same either way: the
 * customer has to resolve, the owner has to be settled, and Rev 0 has to exist. A second copy
 * of that for the pricing route is a second place for the revision history to start wrong.
 */
/**
 * Fills each line's MOQ from the product master where the line does not name one [§28].
 *
 * Copied rather than looked up on read: a catalogue edited next month must not change what an
 * issued quotation says it was offered at. One query for the whole set rather than one per
 * line, because an eight-model quotation should not be eight round trips.
 */
async function withProductDefaults(lines = [], existing = []) {
  /*
   * A line that does not name its costing keeps the one it already had.
   *
   * This is the quiet failure the shape invites. A revision restates the offer — that is what
   * makes it a revision — and a screen or a script that sends back `{ modelNumber, quantity,
   * unitPrice }` without repeating `pricing` would detach the costing from the line. Nothing
   * errors: the quote saves, and §9's floor check silently stops applying to it, at the exact
   * moment somebody is cutting the price. Matched on the line's own id where the caller kept
   * it, and on the model code otherwise, which is what a person restating a line actually
   * holds on to.
   */
  const byId = new Map();
  const byModel = new Map();
  for (const line of existing) {
    if (line._id) byId.set(String(line._id), line);
    if (line.modelNumber) byModel.set(line.modelNumber, line);
  }

  /*
   * Position is identity only when there is exactly one line on each side. Then "the line" is
   * unambiguous and a revision that just restates a new price keeps its costing. Beyond that,
   * matching by position would happily hand model B's floor to model A the first time somebody
   * reorders a quote — so a multi-line revision has to name its models, which every screen does
   * and which the API fills in from the product anyway.
   */
  const positional = lines.length === 1 && existing.length === 1 ? existing[0] : null;

  const inherited = lines.map((line) => {
    if (line.pricing) return line;
    const previous =
      (line._id && byId.get(String(line._id))) ||
      (line.modelNumber && byModel.get(line.modelNumber)) ||
      positional;
    if (!previous?.pricing) return line;
    return { ...line, pricing: previous.pricing, product: line.product ?? previous.product };
  });

  const ids = inherited.map((line) => line.product).filter(Boolean);
  if (!ids.length) return inherited.map((line) => ({ ...line, moq: line.moq ?? 0 }));

  const products = Object.fromEntries(
    (await Product.find({ _id: { $in: ids } }).select('moq modelCode')).map((product) => [
      String(product._id),
      product,
    ])
  );

  return inherited.map((line) => {
    const product = line.product ? products[String(line.product)] : null;
    return {
      ...line,
      modelNumber: line.modelNumber || product?.modelCode,
      moq: line.moq ?? product?.moq ?? 0,
    };
  });
}

/**
 * The offer as it stands, frozen for the history [§10].
 *
 * The lines are deep-copied through `toObject` rather than handed over as subdocuments: pushing
 * the live array into `revisions` would store references that move with the next edit, and the
 * history would then agree with the present no matter what it used to say — a revision list
 * that cannot disagree with the current price is not a history at all.
 */
function snapshotOf(quotation, revision, user, at = new Date()) {
  return {
    revision,
    lines: quotation.lines.map((line) => {
      const plain = typeof line.toObject === 'function' ? line.toObject() : { ...line };
      delete plain._id;
      return plain;
    }),
    validUntil: quotation.validUntil,
    paymentTerms: quotation.paymentTerms,
    deliveryTerms: quotation.deliveryTerms,
    freightTerms: quotation.freightTerms,
    packing: quotation.packing,
    remarks: quotation.remarks,
    at,
    by: user._id,
  };
}

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

  const quotation = new Quotation({
    ...fields,
    lines: await withProductDefaults(fields.lines),
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
  quotation.revisions = [snapshotOf(quotation, 0, user)];

  await quotation.save();
  publish(EVENTS.QUOTATION_CREATED, { quotation, by: user });

  return quotation;
}

export const createQuotation = asyncHandler(async (req, res) => {
  const quotation = await newQuotation(req.body, req.user);
  res.status(201).json({ success: true, data: quotation });
});

/**
 * Everything on a quotation that the customer actually reads.
 *
 * Named as a list because the rule below turns on it: once a quote has gone out, none of these
 * may move except through a revision. The links behind it — which enquiry, which costing, whose
 * name is on it — are bookkeeping and stay editable, because correcting them changes nothing
 * the buyer was told.
 */
const DOCUMENT_FIELDS = [
  'gstPercent', 'isExport',
  'paymentTerms', 'deliveryTerms', 'freightTerms', 'packing', 'validUntil', 'remarks',
];

/** What the buyer reads on a line: change any of it after sending and it is a new offer. */
const LINE_FIELDS = ['modelNumber', 'quantity', 'moq', 'unitPrice'];

/** The lines reduced to what the customer was told, so two sets can be compared. */
const offerOf = (lines = []) =>
  JSON.stringify(
    lines.map((line) => LINE_FIELDS.map((field) => String(line[field] ?? '')))
  );

/** True when this patch would change something the customer has already been shown. */
function changesTheOffer(quotation, patch) {
  const changed = DOCUMENT_FIELDS.filter((field) => {
    if (patch[field] === undefined) return false;
    const current = quotation[field];
    // Dates arrive as strings or Dates depending on the door; compare what they mean.
    if (current instanceof Date) return new Date(patch[field]).getTime() !== current.getTime();
    return patch[field] !== current;
  });

  /*
   * The lines as a whole, because on a multi-line quote the offer can change without any single
   * field doing so — a model dropped, or two lines swapped for one. Comparing field by field
   * across a list would miss both.
   */
  if (patch.lines && offerOf(patch.lines) !== offerOf(quotation.lines)) {
    changed.push('the lines');
  }

  return changed;
}

/**
 * Editing a quotation.
 *
 * **Free while it is still a draft, revisions only once it has been sent.** The doc comment
 * here used to say "editing the terms of a draft" and the code never checked — so the payment
 * terms, the validity, even the quantity of a quote already sitting in a buyer's inbox could
 * be rewritten in place, with nothing in the history to say the offer had changed. That is the
 * same failure §10 exists to prevent for price, and it is arguably worse: a price at least had
 * its own door.
 *
 * A revision can express any of it — the revision record carries the quantity, the terms and
 * the validity as well as the price — so nothing is lost by routing changes through it. What is
 * gained is that six weeks later "what did we last tell them?" still has an answer.
 */
export const updateQuotation = asyncHandler(async (req, res) => {
  const quotation = await Quotation.findById(req.params.id);
  if (!quotation) throw ApiError.notFound('Quotation not found');
  if (!ownsRecord(req.user, quotation)) throw ApiError.notFound('Quotation not found');
  if (CLOSED_QUOTATION_STATUSES.includes(quotation.status)) {
    throw ApiError.badRequest(`A ${quotation.status} quotation cannot be edited`);
  }
  /*
   * A price change on any line goes through a revision, whatever else the patch carries. The
   * check is over the whole set rather than one field, because with lines there are as many
   * prices as models and any of them moving is the thing §10 wants recorded.
   */
  if (req.body.lines) {
    const priced = req.body.lines.map((line) => line.unitPrice).join();
    if (priced !== quotation.lines.map((line) => line.unitPrice).join()) {
      throw ApiError.badRequest('Use a revision to change a price, so the old one is kept');
    }
  }

  /*
   * `sentAt` rather than the status, because the status moves on afterwards — `revised`,
   * `approval_pending` — and what matters is only whether the customer has ever seen it.
   */
  if (quotation.sentAt) {
    const changed = changesTheOffer(quotation, withoutVersion(req.body));
    if (changed.length) {
      throw ApiError.badRequest(
        `This quotation has already gone to the customer, so ${changed.join(', ')} ` +
          'can only change through a revision — that way what they were told is still on record.'
      );
    }
  }

  expectVersion(quotation, req.body);
  const before = snapshot(quotation);

  const patch = withoutVersion(req.body);
  if (patch.lines) patch.lines = await withProductDefaults(patch.lines, quotation.lines);
  Object.assign(quotation, patch);

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

  const { lines, note, ...terms } = req.body;

  /*
   * Defaults first, then compare. A line that leaves `moq` out is asking for the product
   * master's figure, which is usually the one already stored — so comparing the raw request
   * against the saved lines reads a blank as a change and lets a revision through that revises
   * nothing. Resolving both to the same shape is what makes "has anything moved?" answerable.
   */
  const resolved = lines ? await withProductDefaults(lines, quotation.lines) : null;

  const linesMoved = resolved && offerOf(resolved) !== offerOf(quotation.lines);
  if (!linesMoved && !Object.keys(terms).length) {
    throw ApiError.badRequest('Nothing has changed — a revision has to revise something');
  }

  Object.assign(quotation, terms);
  if (resolved) quotation.lines = resolved;

  quotation.revision += 1;
  quotation.revisions.push(snapshotOf(quotation, quotation.revision, req.user));

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
 * The customer and every line's product are populated here beyond the list's needs because a
 * document is not a row — it carries the buyer's address and a description per model.
 *
 * `inline` so a browser shows it rather than dropping it in the downloads folder; the filename
 * is still set, so "save as" produces something recognisable rather than `123abc.pdf`.
 */
export const quotationPdf = asyncHandler(async (req, res) => {
  const quotation = await Quotation.findById(req.params.id)
    .populate('customer', 'code name address city state gstin mobile email')
    .populate('enquiry', 'number')
    .populate('assignedTo', 'name')
    /* Per line now: the document's item table describes each model it carries. */
    .populate('lines.product', 'modelCode name sizeMm material');

  if (!quotation) throw ApiError.notFound('Quotation not found');
  if (!ownsRecord(req.user, quotation)) throw ApiError.notFound('Quotation not found');

  const pdf = await renderQuotationPdf(quotation);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', pdf.length);
  res.setHeader('Content-Disposition', `inline; filename="${quotation.number}.pdf"`);
  res.send(pdf);
});
