import Sample, {
  BACKWARD_REASON_MIN, CLOSED_SAMPLE_STATUSES, FEEDBACK_STATUSES, NOT_ESCALATED_STATUSES,
  ON_THE_BENCH_STATUSES, isBackwardSampleMove, SAMPLE_STATUSES, WITH_CUSTOMER_STATUSES,
} from '../models/Sample.js';
import Enquiry from '../models/Enquiry.js';
import Lead from '../models/Lead.js';
import Customer from '../models/Customer.js';
import Mould, { mouldWithPhoto } from '../models/Mould.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { ownershipFilter, ownsRecord } from '../services/ownership.service.js';
import { canWrite } from '../services/access.service.js';
import { EVENTS, publish, sampleStatusEvent } from '../services/events.service.js';
import { createSampleRequest, defaultRequiredDate } from '../services/sampling.service.js';
import { assertAssignable } from '../services/assignment.service.js';
import { applySpec, buildSpec } from '../services/registers.service.js';
import { stalledSamples, stallAfterDays } from '../services/anomaly.service.js';
import { notifyCustomer, previewFor } from '../services/customerMessage.service.js';
import CustomerMessage from '../models/CustomerMessage.js';
import { listParams, paginated } from '../utils/query.js';
import { buildBoard, perColumnFrom } from '../services/board.service.js';
import { expectVersion, withoutVersion } from '../utils/concurrency.js';
import { recordChange, snapshot } from '../services/audit.service.js';
import { raiseTask } from '../services/task.service.js';
/* A sample for a lead raises that lead's first enquiry, which is a conversion — shared with
   the endpoint rather than copied, so the two can never disagree about what conversion is. */
import { convertLeadRecord } from './pipeline.controller.js';

/**
 * Marketing's view of a sample runs through `requestedBy`, not `assignedTo` — the sample is
 * worked by the sample team, so scoping on who is doing the work would hide every sample from
 * the person who asked for it. Sampling itself is not ownership-scoped and sees the lot.
 */
const scope = (user) => ownershipFilter(user, 'requestedBy');
const owns = (user, sample) => ownsRecord(user, sample, 'requestedBy');

const POPULATE = [
  /*
   * The customer, and *who owns them* [§29].
   *
   * The owner is not the same person as `requestedBy` and the difference matters on the bench.
   * A request is often raised by whoever took the call; the customer belongs to one marketing
   * person, and they are who has to be told when a sample slips and who the buyer will ring.
   * Nested populate rather than a second query — it is one field on a record already loaded.
   */
  { path: 'customer', select: 'code name assignedTo', populate: { path: 'assignedTo', select: 'name' } },
  { path: 'enquiry', select: 'number status requirement.modelNumber requirement.colour' },
  { path: 'lead', select: 'number company status' },
  { path: 'requestedBy', select: 'name' },
  { path: 'assignedTo', select: 'name' },
  mouldWithPhoto('mould', 'mouldCode name category sizeMm'),
  /* The registers behind the request [§28]. Name and code only — a sample screen has no
     business with what a hook costs, which is what those records exist for. */
  { path: 'materialRef', select: 'name code type colour' },
  { path: 'hookRef', select: 'name code colour kind' },
  { path: 'clipRef', select: 'name code colour kind' },
  { path: 'printRef', select: 'name code kind' },
  /*
   * And the same again for every other model in the bag, so a request for three hangers names
   * three resins rather than one resin and two ids. The first row is the four above — it is
   * the top line kept in step — but populating it twice costs nothing and leaving it out would
   * make row one the odd one that renders as a reference.
   */
  mouldWithPhoto('items.mould', 'mouldCode name category sizeMm'),
  { path: 'items.materialRef', select: 'name code type colour' },
  { path: 'items.hookRef', select: 'name code colour kind' },
  { path: 'items.clipRef', select: 'name code colour kind' },
  { path: 'items.printRef', select: 'name code kind' },
  { path: 'referencePhoto', select: 'key filename mimeType size' },
];

const LINKED = [
  { path: 'previousSample', select: 'number status' },
  { path: 'supersededBy', select: 'number status' },
  /* Who made each move — a step back carries a reason, and a reason with no name on it is
     half an answer. Here rather than in POPULATE so the list does not carry every history. */
  { path: 'statusHistory.by', select: 'name' },
];

/**
 * Every response carries the same shape, including the ones that answer an action.
 *
 * A save() returns the raw document, so responding with it would hand the screen a thinner
 * record than the one it is already showing — the customer, enquiry and model would blank
 * out until the next reload. Re-reading is one query and keeps the contract identical.
 */
const withRefs = (sample) => sample.populate([...POPULATE, ...LINKED]);

/**
 * What the sample queue understands, shared by the list and the board.
 *
 * Pulled out of the list rather than copied into the board: the two show the same requests
 * arranged differently, and a filter that means one thing on a table and another on a board is
 * a difference nobody can see and everybody eventually trips over.
 *
 * `withStatus: false` is the board's escape hatch — its columns are the status, so a status in
 * the filter underneath them would empty every other one.
 */
function sampleFilters(req, { withStatus = true } = {}) {
  const { filter } = listParams(req.query, {
    searchFields: ['number', 'modelNumber', 'colour', 'remarks'],
    defaultSort: 'requiredDate',
  });

  Object.assign(filter, scope(req.user));
  if (withStatus && req.query.status) filter.status = { $in: String(req.query.status).split(',') };
  if (withStatus && req.query.open === 'true') filter.status = { $nin: CLOSED_SAMPLE_STATUSES };
  if (req.query.purpose) filter.purpose = req.query.purpose;
  if (req.query.customer) filter.customer = req.query.customer;
  if (req.query.enquiry) filter.enquiry = req.query.enquiry;
  /* What was made for one lead — the list its own screen reads. */
  if (req.query.lead) filter.lead = req.query.lead;
  // Matches a field that was never set and one that was cleared, which are the same thing
  // to the queue but not to Mongo.
  if (req.query.unassigned === 'true') filter.assignedTo = null;
  if (req.query.mine === 'true') filter.assignedTo = req.user._id;

  /**
   * The escalation query [§25]. Overdue is a virtual on the model, so it cannot be sorted or
   * paged on; this expresses the same rule as a filter, from the same list of exclusions.
   *
   * The date half applies on a board too — an overdue board is a real thing to want. The status
   * half is what `withStatus` governs: dropping it would let a cancelled request count as
   * overdue, so on a board the exclusion is expressed as columns instead, by the screen.
   */
  if (req.query.overdue === 'true') {
    filter.requiredDate = { $lt: new Date() };
    if (withStatus) filter.status = { $nin: NOT_ESCALATED_STATUSES };
  }

  return filter;
}

/**
 * Late, expressed as a filter rather than as the `isOverdue` virtual.
 *
 * Same rule the day screen triages by and the §25 sweep escalates on — past its date, and not
 * one of the statuses where the delay is the customer's or the request is closed. Written out
 * again here because a virtual is computed after the rows are chosen, so it can be *read* on a
 * page but never sorted or paged on. Built fresh per call: a module-level constant would freeze
 * `new Date()` at boot and stop finding anything that went late afterwards.
 */
const lateClause = () => ({
  requiredDate: { $lt: new Date() },
  status: { $nin: NOT_ESCALATED_STATUSES },
});

export const listSamples = asyncHandler(async (req, res) => {
  const { page, limit, sort } = listParams(req.query, {
    searchFields: ['number', 'modelNumber', 'colour', 'remarks'],
    /*
     * Within a group: first come, first served — oldest request number at the top.
     *
     * `SMP-YYYY-NNNN` is zero-padded and fixed-width, so a plain string sort is chronological
     * within a year and across years both, and no date field is needed to get it right. It is
     * also the same order the day screen uses inside each of its groups, which is the point:
     * the two screens now differ in what they *show*, never in how they are read.
     */
    defaultSort: 'number',
    /*
     * The columns the register draws, and no more.
     *
     * Asking for any of these is also asking for the late-first grouping below to be dropped —
     * see the note there. That is the right trade and it is the reader's to make: somebody who
     * clicks "Required by" wants the requests in date order, not lateness first and date second,
     * which would produce a column that sorts within invisible bands.
     */
    sortable: ['number', 'requestedAt', 'requiredDate', 'quantity', 'status', 'modelNumber'],
  });

  const filter = sampleFilters(req);

  /*
   * Late first, then the rest — the day screen's order, applied to the register.
   *
   * The register used to be flat FCFS on the argument that a register is read rather than
   * triaged. That was wrong in the one way that matters: it is read *by the bench*, who then
   * has to hold a second ordering in their head to reconcile it with the day screen they just
   * came from. Two screens listing the same requests in two orders is a difference nobody can
   * see and everybody eventually trips over.
   *
   * Done as two queries rather than one aggregation, and deliberately. An `$addFields` stage
   * could rank lateness in a single pass, but `aggregate` does not cast a filter the way `find`
   * does — `customer`, `enquiry` and `lead` arrive off the query string as plain strings, and
   * against an ObjectId column they would match nothing at all, silently. The same reason keeps
   * the virtuals and the populate working: these are still ordinary documents.
   *
   * An explicit `?sort=` skips all of it. Somebody who asked for an order gets that order.
   */
  const grouped = !req.query.sort;
  const late = { $and: [filter, lateClause()] };
  const rest = { $and: [filter, { $nor: [lateClause()] }] };

  const skip = (page - 1) * limit;
  const [total, lateTotal] = await Promise.all([
    Sample.countDocuments(filter),
    grouped ? Sample.countDocuments(late) : 0,
  ]);

  const read = (where, from, take) =>
    take <= 0 ? [] : Sample.find(where).populate(POPULATE).sort(sort).skip(from).limit(take);

  /*
   * How much of this page comes from the late group. Clamped at both ends so a page wholly
   * inside either group asks the other for nothing, and the page that straddles the boundary
   * takes the tail of one and the head of the other.
   */
  const fromLate = grouped ? Math.max(0, Math.min(limit, lateTotal - skip)) : 0;

  const data = grouped
    ? [
        ...(await read(late, skip, fromLate)),
        ...(await read(rest, Math.max(0, skip - lateTotal), limit - fromLate)),
      ]
    : await read(filter, skip, limit);

  paginated(res, data, { page, limit, total });
});

/**
 * The sample bench as a board.
 *
 * The one that differs from its two siblings, because four of the thirteen columns cannot be
 * dropped into at all. The three feedback outcomes are the customer's verdict and only the
 * person who spoke to them may record one — `setSampleStatus` refuses them outright — and
 * `cancelled` ends a request rather than advancing it. The board still draws those columns,
 * because what has been approved and what has been rejected is most of what a bench manager
 * wants to see; it simply does not accept a card dropped on them, and says why.
 *
 * That distinction is the screen's to draw, not this endpoint's. Here they are four statuses
 * like any other.
 */
export const sampleBoard = asyncHandler(async (req, res) => {
  /*
   * By required date, soonest first. Undated requests surface at the top of their column for
   * the same reason an unpromised lead does — a sample with no date is one nothing can chase.
   */
  const sort = 'requiredDate';

  const columns = await buildBoard({
    Model: Sample,
    filter: sampleFilters(req, { withStatus: false }),
    statuses: SAMPLE_STATUSES,
    sort,
    perColumn: perColumnFrom(req.query),
    /* Pieces, not rupees: a sample has a quantity and no price, and inventing one would be a
     * number on a screen that means nothing. The column line says so in its unit. */
    valueField: 'quantity',
    select:
      'number customer enquiry lead mould modelNumber colour printing quantity purpose status ' +
      'requiredDate requestedAt assignedTo requestedBy courier awbNumber dispatchedQuantity ' +
      'colourMandatory dispatchedColour ' +
      'statusHistory.from statusHistory.to statusHistory.at createdAt updatedAt',
    populate: [
      /* The customer and its owner, for the same reason the list carries them — see POPULATE. */
      {
        path: 'customer',
        select: 'code name assignedTo',
        populate: { path: 'assignedTo', select: 'name' },
      },
      { path: 'enquiry', select: 'number status' },
      /* So a request made for a lead names the company rather than reading as a trial for
         nobody — the card has no other way to tell those two apart. */
      { path: 'lead', select: 'number company' },
      mouldWithPhoto('mould', 'mouldCode name category sizeMm'),
      { path: 'assignedTo', select: 'name' },
      { path: 'requestedBy', select: 'name' },
    ],
  });

  res.json({ success: true, data: { columns }, meta: { sort } });
});

/**
 * Samples nobody has touched [the anomaly list].
 *
 * Separate from `?overdue=true`, which asks whether a date has passed. This asks whether
 * anyone is working on it, and catches the sample that is quietly on its way to being overdue
 * while there is still time to do something about it.
 */
export const listStalledSamples = asyncHandler(async (req, res) => {
  const data = await stalledSamples({ filter: scope(req.user) });
  res.json({ success: true, data, meta: { stallAfterDays: stallAfterDays() } });
});

export const getSample = asyncHandler(async (req, res) => {
  const sample = await Sample.findById(req.params.id).populate([...POPULATE, ...LINKED]);
  if (!sample) throw ApiError.notFound('Sample not found');
  if (!owns(req.user, sample)) throw ApiError.notFound('Sample not found');

  res.json({ success: true, data: sample });
});

/** The requirement fields an enquiry carries, so a sample's spec can seed one [§28]. */
const REQUIREMENT_FIELDS = [
  'modelNumber', 'category', 'sizeMm',
  'materialRef', 'hookRef', 'clipRef', 'printRef',
  'material', 'colour', 'colourMandatory', 'printing', 'packing',
];

/**
 * A sample asked for on behalf of a lead raises that lead's first enquiry [§5, added].
 *
 * Asking for a sample is the clearest signal a lead gives: somebody has described a piece
 * well enough to make it, and is waiting to see it. Leaving that as a bare sample request
 * meant the requirement lived only on the bench's card — the enquiry pipeline showed nothing,
 * §3's follow-up discipline had no record to act on, and the quotation that follows a sample
 * approval had nothing to be raised against. So the enquiry is raised here, seeded from the
 * specification the request was just resolved against, and nothing is re-keyed [§41.4].
 *
 * An enquiry needs a customer, so **raising one for a lead is converting that lead** — that is
 * the whole of why this calls conversion rather than creating an enquiry directly. It is a
 * real consequence and it is the right one: a buyer who is being sent a sample is a buyer, and
 * the alternatives were a customer master with a `null` in it or a sample the pipeline cannot
 * see.
 *
 * One case conversion refuses that this must not: the lead's company is already on the
 * customer master. That is an attachment, not a duplicate — the enquiry belongs on the record
 * that exists — and conversion already hands back which customer when the caller may see it.
 * When they may not, the refusal is theirs to read: somebody else holds that buyer, and a
 * sample raised here would put work in their book without them knowing.
 */
async function enquiryForLead(lead, spec, user) {
  const requirement = Object.fromEntries(
    REQUIREMENT_FIELDS.map((field) => [field, spec[field]]).filter(([, value]) => value != null)
  );

  /*
   * §3 asks an open enquiry for a next action *and* a date, and the marketing dashboard counts
   * one without both as an exception. Seeding only the action produced an enquiry that arrived
   * on that exception list at birth, already carrying the action — a screen saying "this needs
   * a next step" about a record that visibly had one.
   *
   * The date is the day the sample is wanted, because that is the day there is something to
   * say: the bench is done, or it is late and the buyer should hear why. A caller may back-date
   * a sample — a request written up the morning after it was made — and a follow-up already in
   * the past is refused by `assertFutureFollowUp` and would read on somebody's morning list as
   * neglect on the day it was created, so a past date falls back to the standing default.
   */
  const wanted = spec.requiredDate ? new Date(spec.requiredDate) : null;
  const chaseOn = wanted && wanted > new Date() ? wanted : defaultRequiredDate();

  const seed = {
    mould: spec.mould || undefined,
    requirement,
    remarks: spec.remarks || undefined,
    /* The reason it exists, on the record rather than inferable from the dates. */
    nextAction: 'Sample requested — show it to them when the bench is done',
    nextFollowUpDate: chaseOn,
  };

  try {
    return await convertLeadRecord(lead, user, { enquiry: seed });
  } catch (problem) {
    if (problem.statusCode !== 409) throw problem;

    /* Ours to attach to: the enquiry is raised against the customer that already exists. */
    if (problem.details?.customer?.id) {
      return convertLeadRecord(lead, user, {
        existingCustomer: problem.details.customer.id,
        enquiry: seed,
      });
    }

    throw ApiError.conflict(
      `${lead.company} is already a customer of ${problem.details?.owner || 'somebody else'}. ` +
        'Ask them to raise the enquiry, and the sample against it.',
      problem.details
    );
  }
}

/**
 * Whether a list of rows actually names something to make.
 *
 * A row somebody added and left blank is not a model, so a request carrying three of them is
 * still a request that says nothing — and the bench would get a job it cannot start with a
 * list on it that looks like it should be able to.
 */
const namesAModel = (rows = []) => rows.some((row) => row?.mould || row?.modelNumber);

/**
 * Every row through the registers, the same way the top line goes [§28].
 *
 * Done per row rather than once for the request, because each row is its own specification: a
 * clip booked into row two's hook field is exactly as wrong as one in row one's, and a resin
 * fills the colour and the family of the model it was picked for. Running this only on the
 * first row would make the registers a rule that applies to the model you happened to type
 * first.
 */
const specRows = (rows) => Promise.all(rows.map((row) => buildSpec(row)));

/**
 * Raises a request by hand.
 *
 * The usual path is the automation: moving an enquiry to `sample_required` raises one [§6].
 * This exists for the cases automation cannot see — a second sample after a modification, or
 * a request the sample team takes directly.
 */
export const createSample = asyncHandler(async (req, res) => {
  const { enquiry: enquiryId, customer: customerId, lead: leadId, ...input } = req.body;

  /*
   * A sample is owned through `requestedBy`, so naming somebody else there puts the request
   * in their list — the same hand-off of a relationship that customers and leads reserve to
   * management, reachable through a create field nobody was checking. It also has to be a
   * real, active person, for the same reason every other owner does.
   */
  if (input.requestedBy) {
    if (String(input.requestedBy) !== String(req.user._id) && req.user.role !== 'admin') {
      throw ApiError.forbidden('Only an administrator can raise a sample in someone else’s name');
    }
    await assertAssignable(input.requestedBy);
  }

  let enquiry = null;
  if (enquiryId) {
    enquiry = await Enquiry.findById(enquiryId);
    if (!enquiry) throw ApiError.badRequest('That enquiry does not exist');
    // Raising a request against an enquiry you cannot see would put it in its owner's list.
    if (!ownsRecord(req.user, enquiry)) throw ApiError.notFound('Enquiry not found');
  }

  let customer = null;
  if (customerId) {
    customer = await Customer.findById(customerId);
    if (!customer) throw ApiError.badRequest('That customer does not exist');
    if (!ownsRecord(req.user, customer)) throw ApiError.notFound('Customer not found');
  }

  /*
   * A sample for a party that is not a customer yet.
   *
   * The checks are the ones the other two links carry, plus two about the lead's own state.
   * A converted lead is refused because it has *become* a customer and that customer is where
   * the work now lives — adding to the lead would file the request against a record nobody
   * opens again. A disqualified one is refused because making a sample for a party already
   * written off is a decision somebody should have to reverse deliberately.
   */
  let lead = null;
  if (leadId) {
    if (customerId) {
      throw ApiError.badRequest(
        'A request names the lead or the customer, not both — a lead is a party who is not a customer yet'
      );
    }
    /*
     * And not an enquiry either. An enquiry already names a customer, so a request naming both
     * says the party is and is not a customer at the same time — and since a lead request now
     * raises its own enquiry, the two would end up as two enquiries for one conversation.
     */
    if (enquiryId) {
      throw ApiError.badRequest(
        'A request names the lead or the enquiry, not both — an enquiry already belongs to a customer'
      );
    }

    lead = await Lead.findById(leadId);
    if (!lead) throw ApiError.badRequest('That lead does not exist');
    /* Raising against a lead you cannot see would put the request in its owner's list. */
    if (!ownsRecord(req.user, lead)) throw ApiError.notFound('Lead not found');

    if (lead.status === 'converted') {
      throw ApiError.badRequest(
        'This lead has been converted — raise the sample against the customer it became'
      );
    }
    if (lead.status === 'disqualified') {
      throw ApiError.badRequest('This lead was disqualified, so nothing more is being made for it');
    }
  }

  /*
   * With no enquiry to inherit from, the request has to say what to make on its own. A
   * sample nobody can identify is a job the bench cannot start, so this is refused here
   * rather than discovered at the bench.
   */
  if (!enquiry && !input.mould && !input.modelNumber && !namesAModel(input.items)) {
    throw ApiError.badRequest(
      'Pick a mould, or describe what to make, when there is no enquiry to take it from'
    );
  }

  /*
   * And the tool has to be one that exists — the same rule enquiries have always had. The
   * specification is inherited from it, and the inheritance step returns nothing for a tool
   * it cannot find, so an unknown id produced a request with no category, material, size or
   * hook and nothing saying why. That is the guard above being satisfied on paper and
   * defeated in fact: the bench still gets a job it cannot start.
   */
  if (input.mould && !(await Mould.exists({ _id: input.mould }))) {
    throw ApiError.badRequest('That mould is not on the register');
  }

  /*
   * The registers have their say before the request is raised [§28], the same way they do on an
   * order line. A clip booked as a hook, or a resin the plant has stopped buying, is refused
   * here by name — and the resin's own colour and family fill themselves in, so nobody is asked
   * a question the register has already answered. See `registers.service.js`.
   */
  const spec = await buildSpec(input);
  /* And every other model in the bag through the same registers — see `specRows`. */
  if (input.items) spec.items = await specRows(input.items);

  /*
   * A lead's request raises the lead's first enquiry, which converts the lead [§5]. See
   * `enquiryForLead`.
   *
   * Before the sample rather than after, deliberately. Conversion is the step that can be
   * refused — a company already on the master, a mould that has gone off the register — and a
   * sample written first would survive that refusal as a request against a lead that never
   * became anybody, which is the orphan §6 and §42 have nobody to tell about.
   */
  let converted = null;
  if (lead) {
    converted = await enquiryForLead(lead, spec, req.user);
    enquiry = converted.enquiry;
    customer = converted.customer;
  }

  const { sample, created } = await createSampleRequest(
    {
      enquiry,
      customer: customer?._id ?? undefined,
      /* Kept alongside the customer it became: it is where the request came from, and the
         lead's own screen lists what was made for it. */
      lead: lead?._id ?? undefined,
      ...spec,
    },
    req.user
  );

  if (!created) {
    throw ApiError.conflict(
      `${sample.number} is already open against ${enquiry.number}. Work that one, or record its outcome first.`
    );
  }

  /*
   * What happened to the lead travels with the answer, because it was not asked for.
   *
   * The person pressed "request a sample" and a customer and an enquiry came into being. That
   * is the right behaviour and a surprise, so the screen is given the two records by name to
   * say so — a consequence nobody is told about is one they discover later as a record they
   * cannot account for.
   */
  res.status(201).json({
    success: true,
    data: await withRefs(sample),
    ...(converted
      ? {
          converted: {
            lead: { id: converted.lead._id, number: converted.lead.number },
            customer: { id: converted.customer._id, code: converted.customer.code, name: converted.customer.name },
            enquiry: { id: converted.enquiry._id, number: converted.enquiry.number },
            attached: converted.attached,
          },
        }
      : {}),
  });
});

/**
 * Attaches a standalone request to the enquiry that turns up after it.
 *
 * The walk-in who asked for a sample on Monday raises an enquiry on Thursday, and the two
 * should be one story. Only ever set, never moved: re-pointing a sample at a different
 * enquiry would rewrite what was made for whom.
 */
export const linkEnquiry = asyncHandler(async (req, res) => {
  const sample = await Sample.findById(req.params.id);
  if (!sample) throw ApiError.notFound('Sample not found');
  if (!owns(req.user, sample)) throw ApiError.notFound('Sample not found');
  if (sample.enquiry) throw ApiError.badRequest('This request already belongs to an enquiry');

  const enquiry = await Enquiry.findById(req.body.enquiry);
  if (!enquiry) throw ApiError.badRequest('That enquiry does not exist');
  if (!ownsRecord(req.user, enquiry)) throw ApiError.notFound('Enquiry not found');
  if (sample.customer && String(sample.customer) !== String(enquiry.customer)) {
    throw ApiError.badRequest('That enquiry belongs to a different customer');
  }

  sample.enquiry = enquiry._id;
  if (!sample.customer) sample.customer = enquiry.customer;
  sample.statusHistory.push({
    from: sample.status,
    to: sample.status,
    by: req.user._id,
    note: `Attached to ${enquiry.number}`,
  });
  await sample.save();

  res.json({ success: true, data: await withRefs(sample) });
});

/**
 * Names the buyer on a request raised without one.
 *
 * The counter request and the internal trial both start with nobody attached — that is the
 * point of allowing it — but a trial that turns into real work needs the buyer on it, and
 * re-keying the whole request to get them there loses the history of what was already made.
 *
 * Set once, like the enquiry: moving a sample to a different customer would rewrite what was
 * made for whom. A sample that came from an enquiry takes its customer from that enquiry, so
 * this refuses rather than letting the two disagree.
 */
export const linkCustomer = asyncHandler(async (req, res) => {
  const sample = await Sample.findById(req.params.id);
  if (!sample) throw ApiError.notFound('Sample not found');
  if (!owns(req.user, sample)) throw ApiError.notFound('Sample not found');
  if (sample.customer) throw ApiError.badRequest('This request already names a customer');
  if (sample.enquiry) {
    throw ApiError.badRequest(
      'This request belongs to an enquiry, and takes its customer from there'
    );
  }

  const customer = await Customer.findById(req.body.customer);
  if (!customer) throw ApiError.badRequest('That customer does not exist');
  if (!ownsRecord(req.user, customer)) throw ApiError.notFound('Customer not found');

  sample.customer = customer._id;
  sample.statusHistory.push({
    from: sample.status,
    to: sample.status,
    by: req.user._id,
    note: `Customer set to ${customer.name}`,
  });
  await sample.save();

  res.json({ success: true, data: await withRefs(sample) });
});

export const updateSample = asyncHandler(async (req, res) => {
  const sample = await Sample.findById(req.params.id);
  if (!sample) throw ApiError.notFound('Sample not found');
  if (!owns(req.user, sample)) throw ApiError.notFound('Sample not found');
  if (req.body.status) {
    throw ApiError.badRequest('Use the status action to move a sample through its stages');
  }
  if (CLOSED_SAMPLE_STATUSES.includes(sample.status)) {
    throw ApiError.badRequest(`A ${sample.status} sample can no longer be edited`);
  }

  // `assignedTo` is reachable here as well as through the assign action, and reached the
  // field with no check at all. A rule enforced on one door and not the other is not a rule.
  if (req.body.assignedTo) await assertAssignable(req.body.assignedTo);

  expectVersion(sample, req.body);
  const before = snapshot(sample);
  /*
   * The same registers as the create door — a rule enforced on one and not the other is a gap
   * with a witness, and a correction is exactly where a clip gets typed into a hook box.
   * `applySpec` rather than `buildSpec` because this is a *partial* change: whether somebody
   * has typed a colour is a question about the merged record, not about the two fields in
   * front of us.
   */
  const patch = withoutVersion(req.body);
  /* The rows get the same resolution the top line does, on this door as on the create one. */
  if (patch.items) patch.items = await specRows(patch.items);
  Object.assign(sample, await applySpec(sample, patch));
  await sample.save();
  await recordChange({ model: 'Sample', doc: sample, before, by: req.user });

  res.json({ success: true, data: await withRefs(sample) });
});

/** Picking a request off the shared queue, or handing it to a colleague. */
export const assignSample = asyncHandler(async (req, res) => {
  const sample = await Sample.findById(req.params.id);
  if (!sample) throw ApiError.notFound('Sample not found');
  if (!owns(req.user, sample)) throw ApiError.notFound('Sample not found');

  /*
   * An explicit null hands it back to the shared queue; omitting it takes it yourself. Any
   * other name has to be somebody who is actually here — a sample assigned to a bench member
   * who has left is in nobody's queue and is not unassigned either, so it is not on the
   * shared list waiting to be picked up. It is on no screen at all.
   */
  const named = req.body.assignedTo;
  if (named) await assertAssignable(named);

  sample.assignedTo = named === null ? null : named || req.user._id;
  await sample.save();
  res.json({ success: true, data: await withRefs(sample) });
});

/** Two shades are the same shade if they differ only in spacing or case. */
const sameShade = (a, b) =>
  String(a || '').trim().toLowerCase().replace(/\s+/g, ' ') ===
  String(b || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The strict colour rule, enforced rather than merely printed.
 *
 * `colourMandatory` has been carried from the enquiry to the sample since the module was built,
 * and shown on three screens — and the request form promises in as many words that "the sample
 * is only sent in this colour". Nothing checked it. A bench could send white against an Ivory
 * condition, the register would say Ivory for ever, and the rejection three weeks later would
 * have no explanation in it.
 *
 * There is deliberately no reason box to type past this. The escape is to go back to whoever
 * set the condition and have them relax it on the record — which is a real conversation with a
 * buyer at the end of it, not a field the bench fills in for itself at five o'clock. Any
 * override the maker can grant themselves is the same as no rule.
 */
function assertColourAllowed(sample) {
  if (!sample.colourMandatory || !sample.colour || !sample.dispatchedColour) return;
  if (sameShade(sample.colour, sample.dispatchedColour)) return;

  throw ApiError.badRequest(
    `${sample.number} was asked for in ${sample.colour} exactly, so it cannot be sent in ` +
      `${sample.dispatchedColour}. Either send it in ${sample.colour}, or have whoever asked ` +
      'for it drop the exact-colour condition first.'
  );
}

/**
 * Courier, tracking number, date and quantity — recorded whenever they are known.
 *
 * Separate from the dispatch move for two reasons. They are often arranged before the sample
 * leaves, and knowing them early changes what the customer is told when it is ready. And a
 * tracking number typed wrong is worth correcting afterwards, which the move cannot do
 * because a sample only dispatches once.
 */
export const setDispatchDetails = asyncHandler(async (req, res) => {
  const sample = await Sample.findById(req.params.id);
  if (!sample) throw ApiError.notFound('Sample not found');
  if (!owns(req.user, sample)) throw ApiError.notFound('Sample not found');
  if (CLOSED_SAMPLE_STATUSES.includes(sample.status)) {
    throw ApiError.badRequest(`A ${sample.status} sample can no longer be edited`);
  }

  for (const field of ['courier', 'awbNumber', 'dispatchedAt', 'dispatchedQuantity', 'dispatchedColour']) {
    if (req.body[field] !== undefined) sample[field] = req.body[field] ?? undefined;
  }

  /* The strict colour rule holds here too. Arranging the details in advance is the natural way
     round the check on the move itself, and a rule with a documented way round it is not one. */
  assertColourAllowed(sample);

  await sample.save();
  res.json({ success: true, data: await withRefs(sample) });
});

/** A stage as a person says it: "sample ready", not `sample_ready`. */
const stageWords = (status) => status.replace(/_/g, ' ');

/**
 * Moves a sample to a new stage.
 *
 * Two rules from §6 are enforced here rather than reported afterwards. Dispatching demands
 * the courier, AWB, date and quantity, because a sample the customer cannot be told how to
 * expect is a sample nobody chases. And the three feedback stages are not the sample team's
 * to set — see `recordFeedback`.
 */
export const setSampleStatus = asyncHandler(async (req, res) => {
  const sample = await Sample.findById(req.params.id);
  if (!sample) throw ApiError.notFound('Sample not found');
  if (!owns(req.user, sample)) throw ApiError.notFound('Sample not found');

  expectVersion(sample, req.body);

  const { status, note, courier, awbNumber, dispatchedAt, dispatchedQuantity, dispatchedColour } =
    req.body;

  if (status === sample.status) throw ApiError.badRequest(`Already at ${status}`);
  if (CLOSED_SAMPLE_STATUSES.includes(sample.status)) {
    throw ApiError.badRequest(`A ${sample.status} sample cannot be moved again`);
  }
  if (FEEDBACK_STATUSES.includes(status)) {
    throw ApiError.badRequest(
      'What the customer said is recorded through the feedback action, by whoever spoke to them'
    );
  }

  /*
   * Two rules about which way a request may move, and both are about the piece itself rather
   * than about tidiness of the funnel.
   *
   * There is deliberately no general "no going backwards" here, which is what the enquiry
   * module has. A sample legitimately goes back: one that breaks on the bench returns to
   * `production_required`, one that fails a check returns to `checking_stock`. Forbidding that
   * would be forbidding the plant's ordinary day.
   *
   * **Once it has left the building, the bench's stages are behind it.** The status said the
   * bench was still choosing stock for a piece sitting on a buyer's desk — and because the
   * bench statuses are the ones §25 escalates, the sample re-entered the overdue queue and
   * chased somebody for work that was already done. The way out of a dispatch made in error is
   * to cancel the request or record the outcome, not to pretend it never went.
   *
   * **Delivered means it arrived, so it has to have gone.** Reached straight from the bench it
   * set `deliveredAt`, skipped §6's paperwork gate entirely — no courier, no AWB, nothing for
   * marketing to tell the buyer — and then satisfied the feedback action, which accepts any
   * with-customer status. One dropdown click removed the whole promise of §6.
   */
  if (WITH_CUSTOMER_STATUSES.includes(sample.status) && ON_THE_BENCH_STATUSES.includes(status)) {
    throw ApiError.badRequest(
      `${sample.number} has already gone to the customer, so it cannot go back to the bench. ` +
        'Cancel the request if it should not have been sent, or record what the customer said.'
    );
  }
  /*
   * **Dispatching is the only door into the customer's hands**, and it is the door §6's
   * paperwork gate stands in.
   *
   * Written as "any with-customer status except dispatched" rather than naming `delivered`,
   * because naming one of them was the first version of this fix and it left the hole open
   * next to it: a request could go straight from `request_received` to `customer_feedback_pending`
   * — never made, never sent, no courier, no AWB — and `recordFeedback` accepts any
   * with-customer status, so the next click marked it **approved**. An approved sample is what
   * §13 checks an order against, so the end of that path is an order verified against a piece
   * that was never made.
   */
  if (
    WITH_CUSTOMER_STATUSES.includes(status) &&
    status !== 'dispatched' &&
    !WITH_CUSTOMER_STATUSES.includes(sample.status)
  ) {
    throw ApiError.badRequest(
      `${sample.number} has not been sent yet, so it cannot be ${status.replace(/_/g, ' ')}. ` +
        'Dispatch it first, with the courier and AWB.'
    );
  }

  /*
   * **A step back needs a reason.** Going back is allowed — see above — but it is the one move
   * somebody will ask about later ("why did this sit in production for a second week?"), and
   * the answer is only ever in the head of whoever clicked. So the move is refused until it
   * says why, and the reason goes into the history beside it.
   */
  if (isBackwardSampleMove(sample.status, status) && (note || '').trim().length < BACKWARD_REASON_MIN) {
    throw ApiError.badRequest(
      `Moving ${sample.number} back from ${stageWords(sample.status)} to ${stageWords(status)} ` +
        'needs a reason. Say what went wrong, so the history explains it.'
    );
  }

  if (status === 'dispatched') {
    // Whatever was arranged earlier stands unless this call overrides it, so details entered
    // in advance do not have to be typed a second time to get the sample out of the door.
    const details = {
      courier: courier ?? sample.courier,
      awbNumber: awbNumber ?? sample.awbNumber,
      dispatchedQuantity: dispatchedQuantity ?? sample.dispatchedQuantity,
      /* Defaults to the shade asked for, so the ordinary case — it went out as requested —
         is not a field somebody has to retype to get the sample out of the door. */
      dispatchedColour: dispatchedColour ?? sample.dispatchedColour ?? sample.colour,
    };

    const missing = [
      !details.courier && 'courier',
      !details.awbNumber && 'AWB number',
      details.dispatchedQuantity == null && 'dispatched quantity',
      /* Only where a colour was named. A request that never asked for one has no answer to
         give, and demanding it would be inventing a field for the bench to make up. */
      sample.colour && !details.dispatchedColour && 'colour it was sent in',
    ].filter(Boolean);

    if (missing.length) {
      throw ApiError.badRequest(`Dispatching needs the ${missing.join(', ')}`);
    }

    Object.assign(sample, details);
    assertColourAllowed(sample);
    sample.dispatchedAt = dispatchedAt || sample.dispatchedAt || new Date();
  }

  if (status === 'delivered') sample.deliveredAt = new Date();

  const from = sample.status;
  sample.status = status;
  sample.statusHistory.push({ from, to: status, by: req.user._id, note: note?.trim() || undefined });
  await sample.save();

  /*
   * A sample that went out in a different shade from the one on the sheet.
   *
   * Only reachable on a preference — the strict ones were refused above — and on a preference
   * it is allowed, which is the whole point of the flag. But allowed is not the same as
   * unremarkable: the buyer is about to open a bag that does not match what they asked for, and
   * whoever spoke to them should hear it from this record rather than from the buyer. Undated,
   * so it sits in the to-do list as something to mention on the next call rather than
   * interrupting today.
   */
  if (
    status === 'dispatched' &&
    sample.colour &&
    sample.dispatchedColour &&
    !sameShade(sample.colour, sample.dispatchedColour) &&
    sample.requestedBy
  ) {
    await raiseTask({
      user: sample.requestedBy,
      title: `${sample.number} went out in ${sample.dispatchedColour}, not ${sample.colour}`,
      notes:
        'The colour was a preference rather than a condition, so the bench sent the nearest it ' +
        'had. Worth saying before the buyer opens the bag.',
      link: `/samples/${sample._id}`,
      originKey: `sample-colour-substituted:${sample._id}`,
    }).catch(() => null);
  }

  publish(EVENTS.SAMPLE_STATUS_CHANGED, { sample, from, to: status, by: req.user });
  const specific = sampleStatusEvent(status);
  if (specific) publish(specific, { sample, from, by: req.user });

  res.json({ success: true, data: await withRefs(sample) });
});

/**
 * Records what the customer said.
 *
 * Deliberately a separate action on a separate grant. The sample team owns making the
 * sample; only the person talking to the customer knows the answer, and letting the maker
 * mark their own work approved is how a sample register stops being worth reading.
 */
export const recordFeedback = asyncHandler(async (req, res) => {
  const sample = await Sample.findById(req.params.id);
  if (!sample) throw ApiError.notFound('Sample not found');
  if (!owns(req.user, sample)) throw ApiError.notFound('Sample not found');

  const { outcome, note } = req.body;

  /*
   * The rule that the maker does not mark their own work approved protects the customer's
   * verdict. A request with no customer has none to protect — an internal trial is the
   * bench's to judge — so the check applies only where there is somebody to have spoken to.
   */
  if (sample.customer && !canWrite(req.user, 'enquiries')) {
    throw ApiError.forbidden(
      'Recording what the customer said needs write access to enquiries — the person who spoke to them.'
    );
  }

  if (CLOSED_SAMPLE_STATUSES.includes(sample.status)) {
    throw ApiError.badRequest(`This sample was already ${sample.status}`);
  }
  /*
   * A verdict needs the sample to have reached whoever gives it. For a customer that means
   * dispatched; for an internal trial with no customer it means made, since the bench is
   * looking at the thing on its own bench.
   */
  const ready = sample.customer
    ? WITH_CUSTOMER_STATUSES.includes(sample.status)
    : ['sample_ready', ...WITH_CUSTOMER_STATUSES].includes(sample.status);

  if (!ready) {
    throw ApiError.badRequest(
      sample.customer
        ? 'The customer cannot have an opinion on a sample that has not reached them yet'
        : 'Judge it once it has been made — move it to sample ready first'
    );
  }

  const from = sample.status;
  sample.status = outcome;
  sample.feedbackAt = new Date();
  sample.feedbackBy = req.user._id;
  sample.feedbackNote = note;
  sample.statusHistory.push({ from, to: outcome, by: req.user._id, note });
  await sample.save();

  publish(EVENTS.SAMPLE_STATUS_CHANGED, { sample, from, to: outcome, by: req.user });
  publish(sampleStatusEvent(outcome), { sample, from, by: req.user });

  res.json({ success: true, data: await withRefs(sample) });
});

/**
 * Raises the next attempt after `modification_required`, carrying everything forward and
 * linking the two, so the register reads as a sequence of attempts rather than a pile of
 * unrelated requests.
 */
export const resample = asyncHandler(async (req, res) => {
  const previous = await Sample.findById(req.params.id);
  if (!previous) throw ApiError.notFound('Sample not found');
  if (!owns(req.user, previous)) throw ApiError.notFound('Sample not found');
  if (previous.status !== 'modification_required') {
    throw ApiError.badRequest('Only a sample the customer asked to modify can be re-sampled');
  }
  if (previous.supersededBy) throw ApiError.conflict('A follow-up sample already exists');

  // A standalone request re-samples too: there is simply no enquiry to inherit from.
  const enquiry = previous.enquiry ? await Enquiry.findById(previous.enquiry) : null;
  if (previous.enquiry && !enquiry) {
    throw ApiError.badRequest('The enquiry behind this sample no longer exists');
  }

  const carried = {
    customer: previous.customer,
    mould: previous.mould,
    modelNumber: previous.modelNumber,
    category: previous.category,
    sizeMm: previous.sizeMm,
    // The register rows, not just the words. A re-sample is "the same thing, change one part",
    // so dropping which resin and which hook was tried is dropping the half of the attempt the
    // next one is meant to hold constant.
    materialRef: previous.materialRef,
    hookRef: previous.hookRef,
    clipRef: previous.clipRef,
    printRef: previous.printRef,
    material: previous.material,
    standaloneReason: previous.standaloneReason,
    colour: previous.colour,
    colourMandatory: previous.colourMandatory,
    printing: previous.printing,
    hookType: previous.hookType,
    quantity: previous.quantity,
    /*
     * The whole bag, not only its first model. "Change one part and send it again" is about
     * the envelope that went out — a three-model attempt re-sampled as one model is two
     * hangers the buyer was looking at and will not get back.
     *
     * Rebuilt rather than handed over, because these rows belong to the previous attempt: a
     * sub-document carries its own `_id`, and reusing it would give two requests rows that
     * claim to be the same row.
     */
    items: (previous.items || []).map((row) => {
      const { _id, ...fields } = row.toObject?.() ?? row;
      return fields;
    }),
    purpose: previous.purpose,
    remarks: previous.feedbackNote,
    ...req.body,
    previousSample: previous._id,
    requiredDate: req.body.requiredDate || defaultRequiredDate(enquiry),
  };

  const { sample, created } = await createSampleRequest({ enquiry, ...carried }, req.user);
  if (!created) throw ApiError.conflict(`${sample.number} is already open against ${enquiry.number}`);

  previous.supersededBy = sample._id;
  await previous.save();

  res.status(201).json({ success: true, data: { sample: await withRefs(sample), previous } });
});

/** Counts and overdue per stage, for the sampling dashboard [§22]. */
export const samplePipeline = asyncHandler(async (req, res) => {
  const match = scope(req.user);
  const now = new Date();

  const rows = await Sample.aggregate([
    ...(Object.keys(match).length ? [{ $match: match }] : []),
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        overdue: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $ne: ['$requiredDate', null] },
                  { $lt: ['$requiredDate', now] },
                  { $not: [{ $in: ['$status', NOT_ESCALATED_STATUSES] }] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
    { $project: { _id: 0, status: '$_id', count: 1, overdue: 1 } },
  ]);

  // Report every stage, including the empty ones: a funnel with gaps hides where work stalls.
  const byStatus = Object.fromEntries(rows.map((row) => [row.status, row]));
  const data = SAMPLE_STATUSES.map(
    (status) => byStatus[status] || { status, count: 0, overdue: 0 }
  );

  res.json({ success: true, data });
});

/* --------------------------- Telling the customer [§42] --------------------------- */

/** Which eligible update a stage corresponds to, if any [§42.5]. */
const eventForStatus = (status) =>
  ({ sample_ready: 'sample_ready', dispatched: 'sample_dispatched' })[status] || null;

/**
 * The draft a person sees before sending, and what has already gone [§42.7].
 *
 * Rendered from the same context the automation uses, so what is approved here is what
 * would otherwise have been sent.
 */
export const previewCustomerMessage = asyncHandler(async (req, res) => {
  const sample = await Sample.findById(req.params.id);
  if (!sample) throw ApiError.notFound('Sample not found');
  if (!owns(req.user, sample)) throw ApiError.notFound('Sample not found');

  const event = req.query.event || eventForStatus(sample.status);
  if (!event) throw ApiError.badRequest('There is nothing to tell the customer at this stage');

  res.json({ success: true, data: await previewFor(sample, event) });
});

/**
 * Sends it, after the person has read and possibly edited the draft.
 *
 * This is §42's own flow, kept alongside the automatic path: a stage that stops sending
 * itself is still reachable by hand, and a failed automatic send can be retried without
 * moving the sample backwards.
 */
export const sendCustomerMessage = asyncHandler(async (req, res) => {
  const sample = await Sample.findById(req.params.id);
  if (!sample) throw ApiError.notFound('Sample not found');
  if (!owns(req.user, sample)) throw ApiError.notFound('Sample not found');

  const event = req.body.event || eventForStatus(sample.status);
  if (!event) throw ApiError.badRequest('There is nothing to tell the customer at this stage');

  const messages = await notifyCustomer({
    sample,
    event,
    user: req.user,
    channels: req.body.channels,
    subject: req.body.subject,
    body: req.body.body,
    force: req.body.force,
  });

  res.status(201).json({ success: true, data: messages });
});

/** Everything ever sent to this customer about this sample [§42.6]. */
export const listCustomerMessages = asyncHandler(async (req, res) => {
  const sample = await Sample.findById(req.params.id);
  if (!sample) throw ApiError.notFound('Sample not found');
  if (!owns(req.user, sample)) throw ApiError.notFound('Sample not found');

  const data = await CustomerMessage.find({ sample: sample._id })
    .populate('sentBy', 'name')
    .sort('-sentAt');

  res.json({ success: true, data });
});
