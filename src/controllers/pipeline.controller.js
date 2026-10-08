import { customerSummaries } from '../services/customerSummary.service.js';
import { customerMap } from '../services/customerMap.service.js';
import Mould, { mouldWithPhoto } from '../models/Mould.js';
import Customer from '../models/Customer.js';
import Enquiry, {
  CLOSED_STATUSES, ENQUIRY_STAGE_ORDER, ENQUIRY_STATUSES, fallsBack, furthestStage, stageLabel,
} from '../models/Enquiry.js';
import Sample from '../models/Sample.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { nextNumber } from '../services/numbering.service.js';
import {
  customerScope, narrowToOwner, ownershipFilter, ownsCustomer, ownsRecord,
} from '../services/ownership.service.js';
import {
  assertCanOwnBuyer,
  canOwnBuyer,
  marketingTeam,
} from '../services/assignment.service.js';
import { EVENTS, publish, statusEvent } from '../services/events.service.js';
import { normalisePhone } from '../utils/phone.js';
import { listParams, paginated } from '../utils/query.js';
import { expectVersion, withoutVersion } from '../utils/concurrency.js';
import { recordChange, snapshot } from '../services/audit.service.js';
import { collect, sendCsv } from '../utils/csv.js';
import { ENQUIRY_ACTIONS, actionsFrom } from '../services/enquiryActions.js';
import { buildBoard, perColumnFrom } from '../services/board.service.js';
import { applySpec, buildSpec } from '../services/registers.service.js';
import { hasRequirement } from '../models/requirement.schema.js';
import { transactional } from '../utils/transaction.js';
import { STAGE_KEYS } from '../config/enquiryStages.js';

/**
 * How many rows an export may take.
 *
 * Higher than a page because the point of an export is to get the lot, and low enough that
 * one click cannot spool the database into memory. When it bites, the file says so in a
 * final row rather than quietly stopping — a truncated export that looks complete is how a
 * wrong figure ends up in a meeting.
 */
const EXPORT_LIMIT = 5000;

/**
 * True when a write actually moves a record to a different owner.
 *
 * The id arrives either bare or as the populated record the screen was handed, and comparing
 * the raw values would read those two as different owners when they are the same one.
 */
const isReassignment = (current, incoming) => {
  if (incoming === undefined || incoming === null) return false;
  const next = String(incoming?._id ?? incoming);
  return next !== String(current?._id ?? current);
};

/**
 * The whole rule for handing a record to somebody else, in one place.
 *
 * Giving a relationship away is management's call, not the holder's, and the person it goes
 * to has to exist. Both halves belong together: customers enforced the first and not the
 * second, and enquiries — the record the follow-up sweep chases and the
 * one most worth taking — enforced neither. A rule applied to two of three records is not a
 * rule, it is a gap with two witnesses.
 */
async function assertReassignment(current, incoming, user) {
  if (!isReassignment(current, incoming)) return;
  if (user.role !== 'admin') {
    throw ApiError.forbidden('Only an administrator can change who a record belongs to');
  }
  await assertCanOwnBuyer(incoming);
}

/** How much of a customer's enquiry history the detail screen carries inline. */
const TIMELINE_PAGE = 10;

/* ------------------------------ Bulk actions ------------------------------ */

/**
 * Moving a batch of records to another owner.
 *
 * Offboarding already hands over a whole book, but the ordinary case is smaller and just as
 * common: somebody goes on leave, a territory is split, a colleague picks up a handful of
 * accounts. Doing that one record at a time through the detail screen is where people give
 * up and keep a spreadsheet instead.
 *
 * An administrator's action, the same as reassigning one record is — giving a relationship
 * away is management's call [§29], and doing it in bulk does not change whose call it is.
 */
const REASSIGNABLE = {
  customers: { model: Customer, module: 'customers', field: 'assignedTo', label: 'Customer' },
  enquiries: { model: Enquiry, module: 'enquiries', field: 'assignedTo', label: 'Enquiry' },
  samples: { model: Sample, module: 'samples', field: 'requestedBy', label: 'Sample' },
};

export const bulkReassign = asyncHandler(async (req, res) => {
  const source = REASSIGNABLE[req.params.collection];
  if (!source) throw ApiError.notFound('Nothing of that kind can be reassigned');

  if (req.user.role !== 'admin') {
    throw ApiError.forbidden('Only an administrator can reassign records');
  }

  const { ids, assignTo } = req.body;
  /* Every record this door moves is a buyer's, so the new owner must be able to hold one. */
  const successor = await assertCanOwnBuyer(assignTo);

  /*
   * Read them first. The update itself is one statement, but the trail is per record — an
   * ownership move nobody can attribute afterwards is exactly what the audit trail exists
   * to prevent, and a bulk action is the one most worth attributing.
   */
  const records = await source.model.find({ _id: { $in: ids } });
  if (!records.length) throw ApiError.badRequest('None of those records exist');

  await source.model.updateMany(
    { _id: { $in: records.map((row) => row._id) } },
    { $set: { [source.field]: successor._id } }
  );

  await Promise.all(
    records.map((record) =>
      recordChange({
        model: source.label,
        doc: record,
            by: req.user,
        action: 'transferred',
        note: `Reassigned to ${successor.name}`,
      })
    )
  );

  res.json({
    success: true,
    data: { moved: records.length, assignTo: successor._id, requested: ids.length },
  });
});

/* -------------------------------- Exports -------------------------------- */

/**
 * The list somebody is looking at, as a file.
 *
 * Deliberately built from the same `listParams` the list route uses, so an export is the
 * screen's own filters rather than a second query that drifts from them: exporting "overdue
 * follow-ups" and getting every enquiry is worse than having no export, because the file
 * looks right.
 *
 * Ownership and grants apply exactly as they do on screen. An export is a read.
 */
/**
 * The customer scope, folded into a filter that may already carry a search.
 *
 * Both halves are an `$or`: the scope is "mine, or shared with me by a query", and the text
 * search `listParams` builds is "name or code or GSTIN or…". Assigning one over the other is
 * one `$or` with the second winning — which would drop the search and hand back every buyer
 * the reader can see, a list that looks like a broken search box and is actually a wrong answer.
 *
 * Shared by the list and the export, because the export's own note promises it shows what the
 * screen shows, and two copies of this is where that stops being true.
 */
function scopeCustomers(filter, user) {
  const scope = customerScope(user);
  if (scope.$or) filter.$and = [...(filter.$and || []), { $or: scope.$or }];
  else Object.assign(filter, scope);
  return filter;
}

export const exportCustomers = asyncHandler(async (req, res) => {
  const { sort, filter } = listParams(req.query, {
    searchFields: ['name', 'code', 'gstin', 'mobile', 'whatsapp', 'email'],
    defaultSort: 'name',
  });

  scopeCustomers(filter, req.user);
  if (req.query.customerType) filter.customerType = req.query.customerType;
  if (req.query.rating) filter.rating = req.query.rating;
  if (req.query.status) filter.status = req.query.status;

  const rows = await collect(Customer.find(filter).populate('assignedTo', 'name').sort(sort).limit(EXPORT_LIMIT));

  await sendCsv(res, 'customers', rows, [
    ['Code', (row) => row.code],
    ['Name', (row) => row.name],
    ['Type', (row) => row.customerType],
    ['Rating', (row) => row.rating],
    ['Mobile', (row) => row.mobile],
    ['WhatsApp', (row) => row.whatsapp],
    ['Email', (row) => row.email],
    ['GST number', (row) => row.gstin],
    ['City', (row) => row.city],
    ['State', (row) => row.state],
    ['Country', (row) => row.country],
    ['Credit terms (days)', (row) => row.creditTermsDays],
    ['Payment terms', (row) => row.paymentTerms],
    ['Owner', (row) => row.assignedTo?.name],
    ['Source', (row) => row.source],
    ['Status', (row) => row.status],
    ['Created', (row) => row.createdAt],
  ]);
});

export const exportEnquiries = asyncHandler(async (req, res) => {
  const { sort } = listParams(req.query, {
    searchFields: ENQUIRY_SEARCH_FIELDS,
    defaultSort: '-enquiryDate',
  });

  // The same filter the screen used, so the file is what was on it.
  const filter = await enquiryFilters(req);

  const rows = await collect(Enquiry.find(filter)
    .populate('customer', 'code name')
    .populate('assignedTo', 'name')
    .sort(sort)
    .limit(EXPORT_LIMIT));

  await sendCsv(res, 'enquiries', rows, [
    ['Number', (row) => row.number],
    ['Date', (row) => row.enquiryDate],
    ['Customer', (row) => row.customer?.name],
    ['Customer code', (row) => row.customer?.code],
    ['Model', (row) => row.requirement?.modelNumber],
    ['Category', (row) => row.requirement?.category],
    ['Size (mm)', (row) => row.requirement?.sizeMm],
    ['Material', (row) => row.requirement?.material],
    ['Colour', (row) => row.requirement?.colour],
    ['Material', (row) => row.requirement?.materialRef?.name || row.requirement?.material],
    ['Hook', (row) => row.requirement?.hookRef?.name],
    ['Clip', (row) => row.requirement?.clipRef?.name],
    ['Printing', (row) => row.requirement?.printRef?.name || row.requirement?.printing],
    ['Packing', (row) => row.requirement?.packing],
    ['Target price', (row) => row.targetPrice],
    ['Required delivery', (row) => row.requiredDeliveryDate],
    ['Stage', (row) => row.status],
    ['Est. value', (row) => row.estimatedValue],
    ['Owner', (row) => row.assignedTo?.name],
    ['Next action', (row) => row.nextAction],
    ['Next follow-up', (row) => row.nextFollowUpDate],
    ['Lost reason', (row) => row.lostReason],
    ['Source', (row) => row.source],
  ]);
});

/**
 * What the customer table will order by.
 *
 * The three money columns — business, outstanding, last order — are **deliberately absent**,
 * and this is the sharpest example in the app of why a sortable list has to be written by hand.
 *
 * Customer carries stored fields by those names, so `?sort=totalBusinessValue` looks like it
 * should work and Mongo would happily accept it. But nothing in the running system writes any
 * of them: `customerSummaries` recomputes all three from the orders and receivables on every
 * read and overwrites them on the way out, and the only code that ever set the stored copies is
 * the seed. So that ordering would rank the page by a dead figure and then draw a different,
 * live one in the column — a table visibly disagreeing with its own sort arrow, which is the
 * worst of the three possible outcomes and the hardest to diagnose.
 *
 * Sorting the page in memory after summarising would be worse still: it would order the
 * twenty-five rows that happened to be fetched and call it a ranking, so page two would hold
 * larger values than page one. Making these sortable means storing the summaries for real,
 * which is a different piece of work.
 */
const CUSTOMER_SORTABLE = [
  'name', 'code', 'customerType', 'city', 'state', 'rating', 'status',
  'creditTermsDays', 'createdAt',
];

export const listCustomers = asyncHandler(async (req, res) => {
  const { page, limit, sort, filter } = listParams(req.query, {
    searchFields: ['name', 'code', 'gstin', 'mobile', 'whatsapp', 'email'],
    defaultSort: 'name',
    sortable: CUSTOMER_SORTABLE,
  });

  scopeCustomers(filter, req.user);
  if (req.query.customerType) filter.customerType = req.query.customerType;
  if (req.query.rating) filter.rating = req.query.rating;
  if (req.query.status) filter.status = req.query.status;

  const [data, total] = await Promise.all([
    Customer.find(filter).populate('assignedTo', 'name').sort(sort).skip((page - 1) * limit).limit(limit),
    Customer.countDocuments(filter),
  ]);

  paginated(res, await customerSummaries(data), { page, limit, total });
});

/**
 * One buyer's whole relationship, for the map view [§2].
 *
 * Its own endpoint rather than more of `getCustomer`, and that is a decision about the screen
 * everybody opens: this reaches eight collections and runs six counts, and most visits to a
 * customer never switch to the map. Paying for it on every open would slow the common case to
 * serve the rare one.
 */
export const getCustomerMap = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id).select('_id name code assignedTo status');
  if (!customer) throw ApiError.notFound('Customer not found');
  if (!ownsCustomer(req.user, customer)) throw ApiError.notFound('Customer not found');

  res.json({ success: true, data: await customerMap(customer, req.user) });
});

export const getCustomer = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id)
    .populate('assignedTo', 'name email')
    /* Who stood at the gate — the pin's whole claim to being right. */
    .populate('site.setBy', 'name');
  if (!customer) throw ApiError.notFound('Customer not found');
  /* Theirs, or shared with them by a query they are a participant on — see `sharedWith`. */
  if (!ownsCustomer(req.user, customer)) throw ApiError.notFound('Customer not found');

  /*
   * The timeline the blueprint asks for [§2]. It grows as later modules land.
   *
   * The first page only, with the count beside it. A bare `.limit(50)` was worse than either
   * paging or not: a customer with sixty enquiries showed fifty and said nothing, so the
   * screen quietly disagreed with the business. The rest come from `/enquiries?customer=`,
   * which is the same list this is a preview of.
   */
  const filter = { customer: customer._id };
  const [enquiries, total, samples, sampleTotal] = await Promise.all([
    Enquiry.find(filter)
      .select('number enquiryDate status requirement.modelNumber estimatedValue')
      .sort('-enquiryDate')
      .limit(TIMELINE_PAGE),
    Enquiry.countDocuments(filter),
    /*
     * §2 asks for the whole story on one screen — enquiries, then samples, then quotations,
     * orders, dispatch and payments as those modules land. Each strand joins as it is built;
     * leaving samples out while they exist is what sends marketing back to asking the bench,
     * which is the phone call this CRM is measured on not needing [§40].
     */
    Sample.find(filter)
      .select('number requestedAt status modelNumber quantity purpose requiredDate enquiry')
      .sort('-requestedAt')
      .limit(TIMELINE_PAGE),
    Sample.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: {
      customer: (await customerSummaries([customer]))[0],
      timeline: { enquiries, total, samples, sampleTotal },
    },
  });
});

export const createCustomer = asyncHandler(transactional(async (req, res) => {
  const duplicate = await findDuplicateCustomer(req.body);
  if (duplicate) {
    throw ApiError.conflict(
      `${duplicate.name} (${duplicate.code}) already exists with the same ${duplicate.matchedOn}`
    );
  }

  /*
   * The owner is chosen, never assumed.
   *
   * It used to default to whoever created the record. That is a guess that looks like a
   * decision: an administrator entering a buyer from a card became its account owner, which
   * under §29 means the one marketing person who should have been chasing them cannot see them
   * at all. The form asks, from the marketing team, and the answer is somebody's.
   */
  await assertCanOwnBuyer(req.body.assignedTo);

  const customer = await Customer.create({
    ...req.body,
    code: await nextNumber('CUST'),
    assignedTo: req.body.assignedTo,
  });

  res.status(201).json({ success: true, data: customer });
}));

export const updateCustomer = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw ApiError.notFound('Customer not found');
  /*
   * `ownsRecord`, not `ownsCustomer`, and the difference is the shape of the grant. A query
   * shares the buyer so a participant can *read* them — the delivery address, the contact, the
   * history behind the question. Editing is still the account owner's: despatch being asked
   * where a load went is not a reason for despatch to change the credit terms.
   */
  if (!ownsRecord(req.user, customer)) throw ApiError.notFound('Customer not found');

  /*
   * Reassigning an owner is a management decision, not the owner's own — but the rule is
   * about *changing* the owner, not about the field being present. A detail screen loads the
   * record with `assignedTo` populated and sends it straight back, so firing on presence
   * refused every save the owner made from their own screen, naming a field they never
   * touched.
   */
  await assertReassignment(customer.assignedTo, req.body.assignedTo, req.user);

  expectVersion(customer, req.body);
  const before = snapshot(customer);
  Object.assign(customer, withoutVersion(req.body));
  await customer.save();
  await recordChange({ model: 'Customer', doc: customer, before, by: req.user });

  res.json({ success: true, data: (await customerSummaries([customer]))[0] });
});

/**
 * Finds an existing customer matching a new one, by GST first and then by number.
 * GST is the strongest key in India; numbers catch the common re-entry case.
 */
async function findDuplicateCustomer({ gstin, mobile, whatsapp }, excludeId) {
  const base = excludeId ? { _id: { $ne: excludeId } } : {};

  if (gstin) {
    const match = await Customer.findOne({ ...base, gstin: gstin.toUpperCase() }).populate(
      'assignedTo',
      'name'
    );
    if (match) return Object.assign(match, { matchedOn: 'GST number' });
  }

  const numbers = [normalisePhone(mobile), normalisePhone(whatsapp)].filter(Boolean);
  if (numbers.length) {
    const match = await Customer.findOne({
      ...base,
      $or: [{ mobile: { $in: numbers } }, { whatsapp: { $in: numbers } }],
    }).populate('assignedTo', 'name');
    if (match) return Object.assign(match, { matchedOn: 'phone number' });
  }

  return null;
}

/**
 * Exposed so the UI can warn before submitting, and so WhatsApp can reuse it later.
 *
 * The search deliberately ignores ownership — a duplicate the caller cannot see is still a
 * duplicate, and answering "no match" would produce the second master record the rule exists
 * to prevent. What it returns does respect ownership: someone else's customer is reported as
 * existing, with who to talk to, but never handed over.
 */
export const checkDuplicateCustomer = asyncHandler(async (req, res) => {
  const match = await findDuplicateCustomer(req.query);

  if (!match) return res.json({ success: true, data: { duplicate: false } });

  const visible = ownsRecord(req.user, match);
  res.json({
    success: true,
    data: {
      duplicate: true,
      matchedOn: match.matchedOn,
      owner: match.assignedTo?.name,
      ...(visible
        ? { customer: { id: match._id, code: match.code, name: match.name } }
        : {}),
    },
  });
});

/* --------------------------------- Owners --------------------------------- */

/**
 * Who is holding records, so the list can be narrowed to one of them.
 *
 * Scoped like everything else, which is what makes the filter safe to show to everybody: a
 * marketing person gets exactly one name — their own — so the picker has nothing to offer them
 * and the screen simply does not draw it. No role check in the client, and no way to learn a
 * colleague's id from a screen that is not allowed to show their records.
 */
async function ownersOf(Model, req, res) {
  const rows = await Model.aggregate([
    { $match: ownershipFilter(req.user) },
    { $group: { _id: '$assignedTo', count: { $sum: 1 } } },
  ]);

  const owners = await User.find({ _id: { $in: rows.map((row) => row._id).filter(Boolean) } })
    .select('name department')
    .sort('name');

  const counts = new Map(rows.map((row) => [String(row._id), row.count]));

  res.json({
    success: true,
    data: owners.map((owner) => ({
      _id: owner._id,
      name: owner.name,
      department: owner.department,
      count: counts.get(String(owner._id)) || 0,
    })),
    // Said rather than left to be inferred from a total that does not add up.
    unassigned: counts.get('null') || counts.get('undefined') || 0,
  });
}

/** Who holds enquiries — see `ownersOf`. */
export const enquiryOwners = asyncHandler((req, res) => ownersOf(Enquiry, req, res));

/**
 * Who a new customer may be given to: the marketing team.
 *
 * A different question from `ownersOf`, which answers "who currently *holds* records" for the
 * owner filter and is therefore ownership-scoped down to one name. This one answers "who *may*
 * hold a new one", and it is deliberately the whole team for everybody who can reach it.
 *
 * That is the point of asking. A picker offering a marketing person only themselves would be a
 * label, not a choice, and the reason the form asks at all is that the plant wants a person to
 * decide which of them is going to chase this buyer — which is a decision about the team, made
 * by whoever is looking at the enquiry in front of them.
 *
 * The consequence is worth being plain about: under §29, choosing a colleague hands the record
 * away, and a marketing person who does that will not see it on their own list afterwards. The
 * screen says so rather than hiding it.
 *
 * **And the reader's own name, when they may hold a buyer without being on that team.** An
 * administrator or a manager already passes `assertCanOwnBuyer` — they hold every module,
 * `ownsRecord` never scopes them, and the seeded administrator owns records today — so the
 * server would have accepted them as the owner all along. The form could not express it: the
 * field is required and the list was marketing only, so the one person allowed to keep a buyer
 * themselves was the one who could not say so. That is a screen contradicting its own server,
 * and the answer is not to widen the rule but to offer the answer the rule already permits.
 *
 * Only *themselves*, never every administrator. Putting the admins into every marketing
 * person's dropdown would invite handing a buyer to somebody who is not working it, which is
 * the stranding this whole check exists to prevent. Self-allocation is a different act from
 * assignment, and the flag says which one an entry is.
 */
export const marketingRoster = asyncHandler(async (req, res) => {
  const team = await marketingTeam();
  const onTeam = team.some((person) => String(person._id) === String(req.user._id));

  /* Asked as a question rather than caught as a refusal — see `canOwnBuyer`. The roster is
     passed in because it is already loaded. */
  const mayKeepIt = !onTeam && (await canOwnBuyer(req.user, team));

  res.json({
    success: true,
    data: [
      ...team.map((person) => ({ _id: person._id, name: person.name })),
      ...(mayKeepIt ? [{ _id: req.user._id, name: req.user.name, self: true }] : []),
    ],
    meta: {
      /* So the form can say who it would be, and mark the reader's own name in the list. */
      you: onTeam || mayKeepIt ? req.user._id : null,
    },
  });
});

/* -------------------------------- Enquiries -------------------------------- */

/**
 * §3's rule: an open enquiry carries a next action and a date.
 *
 * Enforced at the two doors that *move* an enquiry, and deliberately not at the two that
 * create or correct one. Moving it is the moment somebody is working it, and both movement
 * doors pre-fill a next step from the action's own recipe — so the guard costs nothing there
 * and catches only somebody who cleared the field on purpose.
 *
 * Capture is the opposite case. See the note in `assertEnquiryValid` for why blocking it there
 * produced worse data rather than more diligence.
 */
function assertNextAction(enquiry) {
  if (CLOSED_STATUSES.includes(enquiry.status)) return;
  if (!enquiry.nextAction || !enquiry.nextFollowUpDate) {
    throw ApiError.badRequest('An open enquiry needs a next action and a follow-up date');
  }
}

/**
 * A follow-up date somebody is setting now may not already be in the past.
 *
 * Checked against what the request supplies rather than what the record holds, and that
 * distinction is the whole of it: an enquiry whose follow-up fell due last Tuesday is
 * *correctly* overdue, and refusing to save an edit to its remarks because of that would make
 * the overdue list unusable. What is refused is *setting* a date that is already gone — a
 * reminder born overdue, which lands in the morning list looking like neglect on the day it
 * was created.
 */
/**
 * An enquiry captured without a model [the fourth way, in `assertEnquiryValid`] has to name
 * one before it is worked any further. Sampling, costing and quoting all start from the model,
 * and an enquiry reaching them saying only "plastic hangers" hands the next department a phone
 * call instead of a job. Waiting, holding and losing need no model.
 */
const NEEDS_NO_MODEL = ['new', 'requirement_clarification', 'hold', 'lost'];

function assertSaysWhatIsWanted(enquiry, status) {
  if (NEEDS_NO_MODEL.includes(status)) return;
  const rows = (enquiry.items || []).filter(describesItem);
  const says = enquiry.mould
    || enquiry.isNewDevelopment
    || enquiry.requirement?.modelNumber
    || rows.some((row) => row.mould || row.modelNumber || row.isNewDevelopment);
  if (!says) {
    throw ApiError.badRequest(
      'Name the model the buyer wants (or mark it a new development) before moving this enquiry on'
    );
  }
}

function assertFutureFollowUp(value) {
  if (value === undefined || value === null || value === '') return;

  const due = new Date(value);
  if (Number.isNaN(due.getTime())) return; // The schema has its own opinion about shape.

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (due < today) throw ApiError.badRequest('A follow-up date cannot be in the past');
}

/**
 * Everything about a proposed enquiry that can be judged before anything is written.
 *
 * Separated from creation so a caller that writes other records first — a group writes several
 * enquiries — can find out it is going to fail
 * before it has left half a conversion behind. Rolling back afterwards is not equivalent:
 * this database is not necessarily a replica set, so there is no transaction to lean on.
 */
async function assertEnquiryValid(input) {
  const { mould, isNewDevelopment } = input;

  /*
   * An enquiry has to say what was asked for, in one of the three ways there are.
   *
   * The tool, when we make the piece. The buyer's own model number, when we do not — five of
   * the twenty-five models on the plant's 26-27 sheet are traded, bought in and resold, and
   * there is no steel of ours to point at for any of them. Or a declared new development,
   * which is the case where nobody knows yet and saying so is the honest answer.
   *
   * This used to demand a catalogue entry or a new-development tick, which meant a traded item
   * could only be entered by lying about it — marking a hanger we buy from a supplier as
   * something we were about to develop, and then leaving it that way.
   */
  /*
   * A caller may send either shape, so all three are looked for in both — an enquiry raised as
   * a list of three has its model on the first row and nothing in `requirement` yet.
   *
   * And a *row* may now be the thing that answers it. An enquiry whose rows each name their own
   * tool sends no enquiry-level mould at all: the model lifts the first row's up to the document
   * on save, but that is after this runs, so judging on `input.mould` alone would refuse a
   * perfectly well-described enquiry for naming its tools one row at a time.
   */
  const rows = (input.items || []).filter(describesItem);
  const named = input.requirement?.modelNumber
    || rows.find((row) => row.modelNumber)?.modelNumber;
  const anyTool = mould || rows.some((row) => row.mould);
  const anyNew = isNewDevelopment || rows.some((row) => row.isNewDevelopment);

  /*
   * Or, a fourth: nobody knows yet, and the enquiry says so. An IndiaMART message or a visiting
   * card is a buyer asking about "plastic hangers" — real work with a name and a number on it,
   * and the model is the first thing the call finds out. Such an enquiry is captured in
   * requirement clarification with the buyer's words in the remarks, and cannot move on to
   * sampling or pricing until it names a model [`assertSaysWhatIsWanted`].
   */
  const clarifying = input.status === 'requirement_clarification' && Boolean(String(input.remarks || '').trim());

  if (!anyTool && !anyNew && !named && !clarifying) {
    throw ApiError.badRequest(
      'Name the mould, or the model the buyer asked for, or mark this as a new development'
    );
  }
  if (isNewDevelopment && !named && !input.remarks) {
    throw ApiError.badRequest('Describe the new development in the model number or remarks');
  }
  /*
   * There is deliberately no next-action requirement here [§3, softened].
   *
   * §3's rule is that an *open enquiry* always carries a next action, and enforcing it at the
   * moment of capture enforces it against the one moment when nobody may know yet: a walk-in
   * at the counter, a WhatsApp message pasted in at seven in the evening, a name taken at a
   * trade show. A rule that blocks capture does not produce next actions — it produces
   * "follow up" and a date three days out, which is a next action in form and not in
   * substance, and which then reads on every screen as though somebody had decided something.
   *
   * So the discipline moves to where it means something: it is still required to *move* an
   * enquiry (see `assertNextAction` at the two stage doors, where every action pre-fills one
   * anyway), and an enquiry sitting without one is counted as an exception on the marketing
   * dashboard rather than refused at the door.
   */
  assertFutureFollowUp(input.nextFollowUpDate);
  if (mould) {
    const exists = await Mould.findById(mould);
    if (!exists) throw ApiError.badRequest('That mould is not on the register');
  }
  if (input.assignedTo) await assertCanOwnBuyer(input.assignedTo);
}

/**
 * An enquiry's requirement, as the registers say it should read [§28].
 *
 * The mould sits on the enquiry rather than inside its requirement, so it is folded in here and
 * taken back out: `buildSpec` decides the family, the colour and the model number from the tool
 * and the resin together, and doing that without the tool would give the resin the last word on
 * a model number it knows nothing about.
 */
async function requirementSpec(input = {}) {
  const spec = await buildSpec({ ...(input.requirement || {}), mould: input.mould || undefined });
  const { mould, ...requirement } = spec;
  return requirement;
}

/**
 * Whether a row describes a model at all.
 *
 * A tool on its own is enough. "The 380 top hanger, same as last time" is a complete answer
 * containing no text, and judging a row only on its described fields would throw it away on
 * save as though it were the blank one somebody tabbed past.
 */
const describesItem = (row) => Boolean(row?.mould || hasRequirement(row));

/**
 * Every item on an enquiry, each put through the registers the same way the first one is.
 *
 * The first row and `requirement` are one fact — the model keeps them in step — so the list is
 * built from `items` when the caller sent one and from `requirement` when it did not. That is
 * what lets a form that knows nothing about lists and a form that does both write to the same
 * endpoint.
 *
 * **Each row names its own tool.** It did not use to: one mould was named on the enquiry and
 * belonged to the first item, because folding it into every row would have claimed the buyer's
 * second model is made on the first one's steel. That was the right rule for a list of
 * mentions and the wrong one for a list of models — it made every item after the first unable
 * to point at the register [§28], and so unable to be costed, sampled or quoted as the same
 * piece. Now the row carries it, and `fallback` is what the enquiry's own flat fields mean: the
 * first row's, for a caller that sends the old shape.
 *
 * Empty rows are dropped rather than refused. Somebody tabbing through a form leaves them
 * behind, and a refusal about a row containing nothing is a refusal about nothing.
 */
async function itemSpecs(rows = [], fallback = {}) {
  const given = rows.filter(describesItem);
  if (!given.length) return undefined;

  return Promise.all(
    given.map(async (item, index) => {
      /* `undefined` means the row did not speak; `null` or '' means it was cleared. Only the
         first can fall back, or clearing a tool on the first row would silently restore it. */
      const tool = item.mould !== undefined
        ? item.mould
        : (index === 0 ? fallback.mould : undefined);
      const development = item.isNewDevelopment !== undefined
        ? item.isNewDevelopment
        : (index === 0 ? fallback.isNewDevelopment : undefined);

      const spec = await buildSpec({ ...item, mould: tool || undefined });
      return { ...spec, isNewDevelopment: Boolean(development) };
    })
  );
}

/** Shared by the create endpoints and by intake (IndiaMART, visiting cards). */
export async function createEnquiryRecord(input, user) {
  await assertEnquiryValid(input);

  const enquiry = new Enquiry({
    ...input,
    /*
     * The requirement goes through the registers [§28], the same as a sample or an order line.
     * A clip named as a hook is refused here rather than at the bench, and the resin's own
     * colour and family fill themselves in — so the chain from this record to the order booked
     * against it points at the same rows the whole way down.
     */
    requirement: await requirementSpec(input),
    /* When a list was sent, it is the truth and the model copies its first row over the
       requirement above. When it was not, the model seeds the list from that requirement, so
       both kinds of caller end up with a record of the same shape. */
    items: await itemSpecs(input.items, input),
    number: await nextNumber('ENQ'),
    /* `user` is null for the IndiaMART import, which has nobody at the keyboard. */
    assignedTo: input.assignedTo || user?._id,
    statusHistory: [{ to: input.status || 'new', by: user?._id }],
  });

  await enquiry.save();

  await publish(EVENTS.ENQUIRY_CREATED, { enquiry, by: user });
  return enquiry;
}

/** The fields an enquiry search looks at on the enquiry itself. */
const ENQUIRY_SEARCH_FIELDS = ['number', 'requirement.modelNumber', 'remarks'];

/**
 * The filters an enquiry list understands, in one place — the list, the tally and the export.
 *
 * `withStatus` is off for the stage tally, which has to say how many each stage *would* show:
 * narrowed to the stage already chosen it would read "Negotiation 7" beside a row of zeroes,
 * and there would be no way back to the others.
 */
async function enquiryFilters(req, { withStatus = true } = {}) {
  const { filter } = listParams(req.query, {
    searchFields: ENQUIRY_SEARCH_FIELDS,
    defaultSort: '-enquiryDate',
  });

  const scope = ownershipFilter(req.user);
  Object.assign(filter, scope);

  const owner = narrowToOwner(scope, req.query.assignedTo);
  if (owner !== undefined) filter.assignedTo = owner;

  /*
   * Searching by the customer's name, which is how people actually look for an enquiry.
   *
   * Nobody remembers ENQ-2026-0042. They remember Sri Kumaran Knits, and the box searched the
   * number, the model and the remarks — every field except the one thing the reader knows —
   * so the honest answer to a real search was "no enquiries here" for a customer with nine.
   *
   * Two queries rather than a join: the name lives on the customer, and denormalising it onto
   * every enquiry would be a second copy to keep true.
   */
  if (req.query.search && filter.$or) {
    const escaped = String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const named = new RegExp(escaped, 'i');
    const customers = await Customer.find({
      ...ownershipFilter(req.user),
      $or: [{ name: named }, { code: named }],
    }).select('_id');

    if (customers.length) filter.$or.push({ customer: { $in: customers.map((row) => row._id) } });
  }

  if (req.query.customer) filter.customer = req.query.customer;
  /* Where it came from — the IndiaMART screen links to what its feed has raised. */
  if (req.query.source) filter.source = String(req.query.source);
  if (req.query.groupRef) filter.groupRef = req.query.groupRef;
  /*
   * Where it sits on the plant's twelve stages — what a department's workspace links to
   * ("the enquiries at PO & SO"). Unknown keys are dropped rather than matching nothing.
   */
  if (req.query.stage) {
    const stages = String(req.query.stage).split(',').filter((key) => STAGE_KEYS.includes(key));
    if (stages.length) filter.stage = { $in: stages };
  }

  if (withStatus) {
    /*
     * A chosen stage wins over the open-only view rather than being overwritten by it.
     *
     * The two were applied in order, so `?status=new&open=true` became "everything open" — and
     * the Open view is the default. Picking a stage off the strip therefore did nothing at all
     * unless you had first switched to All: the tile said New 1, the table showed the seven
     * open ones, and the only signal that the click had missed was a count that did not match.
     */
    if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };
    else if (req.query.open === 'true') filter.status = { $nin: CLOSED_STATUSES };
  }

  // The follow-up list marketing works from each morning [§37].
  if (req.query.dueBy) {
    filter.nextFollowUpDate = { $lte: new Date(req.query.dueBy) };
    // Chasing a won enquiry is not a follow-up; without this the due list carries the closed.
    if (!filter.status) filter.status = { $nin: CLOSED_STATUSES };
  }

  return filter;
}

/**
 * The enquiry table's orderings.
 *
 * `requirement.quantity` is reachable by its path, which is how Mongoose spells a nested field
 * and what the column shows. The estimated value is marketing's own figure here too — the
 * costing that §8 protects does not exist yet at this stage, which is the whole reason an
 * enquiry becomes one.
 */
const ENQUIRY_SORTABLE = [
  'number', 'enquiryDate', 'requirement.quantity', 'estimatedValue',
  'nextFollowUpDate', 'status', 'createdAt',
];

export const listEnquiries = asyncHandler(async (req, res) => {
  const { page, limit, sort } = listParams(req.query, {
    searchFields: ENQUIRY_SEARCH_FIELDS,
    defaultSort: '-enquiryDate',
    sortable: ENQUIRY_SORTABLE,
  });

  const filter = await enquiryFilters(req);

  /*
   * The stage tally travels with the rows.
   *
   * The funnel above this table used to come from its own endpoint, fetched once when the
   * screen mounted: it counted the whole book while the table showed one customer, never
   * moved when a filter did, and still showed yesterday's figures after an enquiry was
   * raised. A count that disagrees with the list beneath it is read as the list being wrong.
   */
  const tallyFilter = await enquiryFilters(req, { withStatus: false });

  const [data, total, stages] = await Promise.all([
    Enquiry.find(filter)
      .populate('customer', 'code name')
      .populate('assignedTo', 'name')
      .populate(mouldWithPhoto())
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit),
    Enquiry.countDocuments(filter),
    Enquiry.aggregate([
      { $match: tallyFilter },
      {
        $group: {
          _id: '$status',
          leads: { $sum: 1 },
          value: { $sum: { $ifNull: ['$estimatedValue', 0] } },
        },
      },
    ]),
  ]);

  const stageCounts = Object.fromEntries(
    stages.map((row) => [row._id, { leads: row.leads, value: row.value || 0 }])
  );

  paginated(res, data, { page, limit, total }, { stageCounts });
});

/**
 * The enquiry book as a board.
 *
 * `statusHistory` is on the card and everything else is trimmed away, which looks backwards
 * until you remember what the board has to decide before a card is dropped: §3 refuses a move
 * back down the ladder, and how far an enquiry has *been* is not readable from where it is —
 * an enquiry parked at `hold` sits off the ladder entirely. Without the history the board would
 * have to offer every column and let the server refuse half of them, which teaches people that
 * the screen guesses. Only the three fields the rule reads are sent.
 */
export const enquiryBoard = asyncHandler(async (req, res) => {
  const sort = 'nextFollowUpDate';

  const columns = await buildBoard({
    Model: Enquiry,
    filter: await enquiryFilters(req, { withStatus: false }),
    statuses: ENQUIRY_STATUSES,
    sort,
    perColumn: perColumnFrom(req.query),
    valueField: 'estimatedValue',
    select:
      'number customer mould assignedTo status estimatedValue enquiryDate nextAction ' +
      'nextActionType nextFollowUpDate requirement holdReason lostReason ' +
      'statusHistory.from statusHistory.to statusHistory.at createdAt updatedAt',
    populate: [
      { path: 'customer', select: 'code name' },
      mouldWithPhoto(),
      { path: 'assignedTo', select: 'name' },
    ],
  });

  res.json({ success: true, data: { columns }, meta: { sort } });
});

export const getEnquiry = asyncHandler(async (req, res) => {
  const enquiry = await Enquiry.findById(req.params.id)
    .populate('customer', 'code name mobile email assignedTo')
    .populate('assignedTo', 'name email')
    .populate(mouldWithPhoto('mould', 'mouldCode name category sizeMm material hookType'))
    /* The registers the requirement names [§28], so a screen can say what was asked for
       without four more requests. Name and code only — a rate is not an enquiry's business. */
    .populate('requirement.materialRef', 'name code type colour')
    .populate('requirement.hookRef', 'name code colour kind')
    .populate('requirement.clipRef', 'name code colour kind')
    .populate('requirement.printRef', 'name code kind');
  if (!enquiry) throw ApiError.notFound('Enquiry not found');
  if (!ownsRecord(req.user, enquiry)) throw ApiError.notFound('Enquiry not found');
  res.json({ success: true, data: enquiry });
});

export const createEnquiry = asyncHandler(transactional(async (req, res) => {
  const customer = await Customer.findById(req.body.customer);
  if (!customer) throw ApiError.badRequest('That customer does not exist');
  if (!ownsRecord(req.user, customer)) {
    throw ApiError.forbidden('That customer belongs to another marketing person');
  }

  const enquiry = await createEnquiryRecord(
    { ...req.body, assignedTo: req.body.assignedTo || customer.assignedTo },
    req.user
  );

  res.status(201).json({ success: true, data: enquiry });
}));

/**
 * Creates several enquiries from one conversation — one per model, sharing a group
 * reference so follow-up keeps them together while sample and price stay answerable
 * per model.
 */
export const createEnquiryGroup = asyncHandler(transactional(async (req, res) => {
  const customer = await Customer.findById(req.body.customer);
  if (!customer) throw ApiError.badRequest('That customer does not exist');
  if (!ownsRecord(req.user, customer)) {
    throw ApiError.forbidden('That customer belongs to another marketing person');
  }

  /*
   * Every model is judged first: a group that stops half way is worse than one refused.
   *
   * The owner follows the same rule the single create does. It used to be pinned to the
   * customer's owner regardless, so an administrator raising three models for a colleague got
   * three enquiries assigned to somebody else — the same request answered two different ways
   * depending on how many models were on it.
   */
  const assignedTo = req.body.assignedTo || customer.assignedTo;
  if (req.body.assignedTo) await assertReassignment(customer.assignedTo, req.body.assignedTo, req.user);

  const items = req.body.enquiries.map((item) => ({
    ...req.body.shared,
    ...item,
    customer: customer._id,
    assignedTo,
  }));
  for (const item of items) await assertEnquiryValid(item);

  const groupRef = await nextNumber('GRP');
  const created = [];

  for (const item of items) {
    created.push(await createEnquiryRecord({ ...item, groupRef }, req.user));
  }

  res.status(201).json({ success: true, data: { groupRef, enquiries: created } });
}));

export const updateEnquiry = asyncHandler(async (req, res) => {
  const enquiry = await Enquiry.findById(req.params.id);
  if (!enquiry) throw ApiError.notFound('Enquiry not found');
  if (!ownsRecord(req.user, enquiry)) throw ApiError.notFound('Enquiry not found');
  if (req.body.status) {
    throw ApiError.badRequest('Use the status action to move an enquiry through its stages');
  }

  await assertReassignment(enquiry.assignedTo, req.body.assignedTo, req.user);
  assertFutureFollowUp(req.body.nextFollowUpDate);

  expectVersion(enquiry, req.body);
  const before = snapshot(enquiry);
  const patch = withoutVersion(req.body);

  /*
   * The requirement goes through the registers on a correction too, and `applySpec` rather than
   * `buildSpec` because this is a *partial* change: whether somebody has already typed a colour
   * is a question about the merged record, not about the two fields in the request. Resolving
   * the patch alone would let a request that changed only the resin overwrite a shade the buyer
   * had named.
   */
  if (patch.requirement || patch.mould !== undefined) {
    patch.requirement = await applySpec(
      { ...(enquiry.requirement?.toObject?.() ?? enquiry.requirement), mould: enquiry.mould },
      { ...(patch.requirement || {}), ...(patch.mould !== undefined ? { mould: patch.mould } : {}) }
    );
    delete patch.requirement.mould;
  }

  /*
   * A list sent on a correction replaces the list. Not merged row by row: a person editing
   * items is adding, removing and reordering them, and there is no row identity a partial
   * merge could follow — "the third one" is not the same row it was before a deletion. The
   * form sends what the enquiry should now say, which is the only reading that can express a
   * removal at all.
   *
   * Each row still goes through the registers, and the model copies the first one over
   * `requirement`, so a correction cannot leave the two disagreeing.
   */
  if (patch.items) {
    if (!patch.items.filter(describesItem).length) {
      throw ApiError.badRequest('An enquiry has to say what the buyer asked about — keep a row');
    }
    /* The same builder the create door uses, so the two cannot come to disagree about what a
       row means. What the enquiry already says is the fallback for a row that stays silent. */
    patch.items = await itemSpecs(patch.items, {
      mould: patch.mould !== undefined ? patch.mould : enquiry.mould,
      isNewDevelopment: patch.isNewDevelopment !== undefined
        ? patch.isNewDevelopment
        : enquiry.isNewDevelopment,
    });
  }

  Object.assign(enquiry, patch);
  /*
   * No next-action guard on a correction either, and that is not laxity — it is the other half
   * of letting one be captured without it. An enquiry raised at the counter with no next step
   * would otherwise be a record nobody could fix a typo on: every PATCH refused for a field the
   * create door had just allowed to be empty.
   */
  await enquiry.save();
  await recordChange({ model: 'Enquiry', doc: enquiry, before, by: req.user });

  res.json({ success: true, data: enquiry });
});

/**
 * Moves an enquiry to a new stage.
 *
 * Every transition is recorded, and the stages that hand work to another department
 * publish an event: sampling raises the request on `sample_required`, and `pricing_required`
 * queues whoever prices a job [§5, §41.8] until the pricing module itself lands in Phase 3.
 */
/**
 * Moving an enquiry, with every guard in one place.
 *
 * Two doors reach this: the stage picker, and the named actions. They must not drift — an
 * action that skipped the won-needs-a-value rule would be a hole with a friendly button on it
 * — so the rules live here and both doors call in.
 */
async function moveEnquiry(enquiry, body, user) {
  const {
    status, note, lostReason, lostNote, holdReason,
    nextAction, nextActionType, nextFollowUpDate, estimatedValue,
  } = body;

  if (status === enquiry.status) throw ApiError.badRequest(`Already at ${status}`);

  /*
   * Reopening a closed enquiry, which used to be impossible.
   *
   * A lost enquiry the buyer revives, or one marked won by mistake, could only be re-keyed as
   * a new record — which contradicts §41.4 and throws away the history that explains why it
   * was lost in the first place. The reason it was refused was sound: a closed enquiry must
   * not drift back open by accident, and the figures behind a weekly review must not move
   * quietly under whoever read them.
   *
   * So it reopens deliberately or not at all: only to an open stage, with a note saying why,
   * and with the next step it is coming back to. The note lands in the history beside the
   * close it undoes, so the record explains itself to whoever reads it next.
   *
   * The next step is named here rather than left to `assertNextAction` at the bottom, and the
   * difference is only in what the refusal says. Closing an enquiry clears its follow-up, so a
   * reopen always arrives with both fields empty and the generic guard answered "an open
   * enquiry needs a next action and a follow-up date" — true, and no help at all to somebody
   * who had just supplied the note the rule above asked them for. A refusal that names one
   * requirement at a time is a form somebody fills in twice.
   */
  const reopening = CLOSED_STATUSES.includes(enquiry.status);
  if (reopening) {
    if (CLOSED_STATUSES.includes(status)) {
      throw ApiError.badRequest(`A ${enquiry.status} enquiry cannot be closed again`);
    }
    const missing = [
      !note?.trim() && 'why it is being reopened',
      !(nextAction ?? enquiry.nextAction) && 'what happens next',
      !(nextFollowUpDate ?? enquiry.nextFollowUpDate) && 'when to come back to it',
    ].filter(Boolean);

    if (missing.length) {
      throw ApiError.badRequest(
        `Reopening a ${enquiry.status} enquiry needs ${missing.join(', ')}.`
      );
    }
  }

  /*
   * An enquiry does not go backwards [§3].
   *
   * The stages it has passed are facts about the job — the sample went out, the price was
   * asked for, the quote was sent — and none of them un-happen because somebody picked the
   * wrong row from a dropdown. Left open, a funnel that slides backwards lies to every figure
   * built on it: the same job is counted twice at the same stage, and its ageing clock resets
   * each time it slips.
   *
   * Reopening is exempt, and deliberately so: it is the one move whose whole purpose is to
   * rewind, and it already costs a note explaining why.
   *
   * The way out of a stalled enquiry is `hold` or `lost`, both of which stay available from
   * anywhere — a rule with no legitimate escape is one people work around by not recording
   * the truth at all.
   */
  if (!reopening && fallsBack(enquiry, status)) {
    const reached = ENQUIRY_STAGE_ORDER[furthestStage(enquiry)];
    throw ApiError.badRequest(
      `This enquiry has already reached ${stageLabel(reached)}, so it cannot go back to ` +
        `${stageLabel(status)}. Put it on hold if it has stalled, or mark it lost.`
    );
  }

  if (status === 'lost' && !lostReason) {
    throw ApiError.badRequest('Give a reason when marking an enquiry lost');
  }
  /*
   * Parking an enquiry needs a reason for the same argument losing one does, and it is the
   * more dangerous of the two: a lost enquiry is finished, and one on hold with no reason is
   * simply invisible — nobody knows what would have to change for it to move again.
   */
  if (status === 'hold' && !holdReason?.trim()) {
    throw ApiError.badRequest('Say what this enquiry is waiting on');
  }
  /*
   * Winning without a value silently drops the enquiry out of the one figure the weekly
   * review is for [§38] — and it is the moment the number is actually known, which is why it
   * is asked for here rather than left to be filled in later by nobody.
   */
  if (status === 'won' && !(estimatedValue ?? enquiry.estimatedValue)) {
    throw ApiError.badRequest('Put the confirmed value on it before marking it won');
  }

  assertFutureFollowUp(nextFollowUpDate);
  assertSaysWhatIsWanted(enquiry, status);

  const from = enquiry.status;
  enquiry.status = status;
  enquiry.statusHistory.push({ from, to: status, by: user._id, note });

  if (status === 'lost') {
    enquiry.lostReason = lostReason;
    enquiry.lostNote = lostNote;
  }
  if (status === 'hold') enquiry.holdReason = holdReason;
  if (estimatedValue !== undefined) enquiry.estimatedValue = estimatedValue;

  /*
   * Reopening clears what closed it. Left in place, a revived enquiry still reads "lost —
   * price" on every screen that shows the reason, which is a record contradicting itself.
   */
  if (reopening) {
    enquiry.lostReason = undefined;
    enquiry.lostNote = undefined;
  }
  if (status !== 'hold') enquiry.holdReason = undefined;

  if (nextAction !== undefined) enquiry.nextAction = nextAction;
  if (nextActionType !== undefined) enquiry.nextActionType = nextActionType;
  if (nextFollowUpDate !== undefined) enquiry.nextFollowUpDate = nextFollowUpDate;

  // Closing clears the follow-up: there is nothing left to chase.
  if (CLOSED_STATUSES.includes(status)) {
    enquiry.nextAction = undefined;
    enquiry.nextActionType = undefined;
    enquiry.nextFollowUpDate = undefined;
  }

  assertNextAction(enquiry);
  await enquiry.save();

  await publish(EVENTS.ENQUIRY_STATUS_CHANGED, { enquiry, from, to: status, by: user });
  const specific = statusEvent(status);
  if (specific) await publish(specific, { enquiry, from, by: user });

  return enquiry;
}

export const setEnquiryStatus = asyncHandler(async (req, res) => {
  const enquiry = await Enquiry.findById(req.params.id);
  if (!enquiry) throw ApiError.notFound('Enquiry not found');
  if (!ownsRecord(req.user, enquiry)) throw ApiError.notFound('Enquiry not found');

  expectVersion(enquiry, req.body);

  await moveEnquiry(enquiry, req.body, req.user);
  res.json({ success: true, data: enquiry });
});

/**
 * Doing a named thing to an enquiry, rather than picking a database word out of a dropdown.
 *
 * The action says what the work *is* — raise a sample, ask for a price, confirm the order —
 * and this turns it into the stage move that work implies plus the follow-up that comes with
 * it. The automation on the far side is unchanged and was always there; it simply had no door
 * a marketing person would find.
 *
 * The next action is written from the action rather than typed, which is the point of the
 * whole exercise: "chase sample", "follow up sampling" and "ask bench" were one intention in
 * three spellings, and no list could group them. Whoever is doing it can still edit the text
 * when their case is unusual — it is a default, not a cage.
 */
export const applyEnquiryAction = asyncHandler(async (req, res) => {
  const enquiry = await Enquiry.findById(req.params.id);
  if (!enquiry) throw ApiError.notFound('Enquiry not found');
  if (!ownsRecord(req.user, enquiry)) throw ApiError.notFound('Enquiry not found');

  expectVersion(enquiry, req.body);

  const { action, note, nextAction, nextFollowUpDate, ...rest } = req.body;
  const recipe = ENQUIRY_ACTIONS[action];
  if (!recipe) throw ApiError.badRequest('That is not something you can do to an enquiry');

  if (CLOSED_STATUSES.includes(enquiry.status)) {
    throw ApiError.badRequest(
      `A ${enquiry.status} enquiry has to be reopened before anything else can happen to it`
    );
  }
  if (recipe.to && recipe.to === enquiry.status) {
    throw ApiError.badRequest(`This enquiry is already at ${enquiry.status}`);
  }

  const closing = CLOSED_STATUSES.includes(recipe.to);

  /*
   * The follow-up the action implies, unless the person supplied their own. A date is only
   * defaulted when none was given — never overriding a person who picked one.
   */
  const due = new Date();
  due.setDate(due.getDate() + (recipe.inDays ?? 0));

  const payload = {
    ...rest,
    note,
    // `follow_up` moves no stage, so it is not a status change at all — see below.
    status: recipe.to,
    nextAction: closing ? undefined : nextAction || recipe.nextAction,
    nextActionType: closing ? undefined : recipe.type || undefined,
    nextFollowUpDate: closing
      ? undefined
      : nextFollowUpDate || due.toISOString().slice(0, 10),
  };

  if (recipe.to) {
    await moveEnquiry(enquiry, payload, req.user);
  } else {
    /*
     * Setting a follow-up without moving anything. It goes through the same date rule and the
     * same §3 check, but writes no status history — a chase that changed nothing is not a
     * stage change, and recording it as one is how a funnel fills with movement that never
     * happened.
     */
    assertFutureFollowUp(payload.nextFollowUpDate);
    enquiry.nextAction = payload.nextAction;
    enquiry.nextActionType = payload.nextActionType;
    enquiry.nextFollowUpDate = payload.nextFollowUpDate;
    assertNextAction(enquiry);
    await enquiry.save();
  }

  res.json({ success: true, data: enquiry, did: recipe.label });
});

/** The actions this enquiry can take from where it is, so the screen need not guess. */
export const listEnquiryActions = asyncHandler(async (req, res) => {
  const enquiry = await Enquiry.findById(req.params.id);
  if (!enquiry) throw ApiError.notFound('Enquiry not found');
  if (!ownsRecord(req.user, enquiry)) throw ApiError.notFound('Enquiry not found');

  const due = (days) => {
    const date = new Date();
    date.setDate(date.getDate() + (days ?? 0));
    return date.toISOString().slice(0, 10);
  };

  res.json({
    success: true,
    /*
     * Actions that would drag the enquiry back down the funnel are not offered at all.
     *
     * Filtered here rather than inside the catalogue because the rule needs the enquiry's
     * history, and the catalogue is imported *by* the enquiry model — reaching the other way
     * would close a circular import for the sake of one predicate.
     *
     * The move is refused either way, so offering the button would only be a promise the next
     * screen breaks, and a button that always fails teaches people to distrust the ones beside
     * it.
     */
    data: actionsFrom(enquiry.status)
      .filter((key) => !fallsBack(enquiry, ENQUIRY_ACTIONS[key].to))
      .map((key) => ({
      action: key,
      ...ENQUIRY_ACTIONS[key],
      // Resolved here so the form shows the same date the server would have used.
      defaultFollowUpDate: ENQUIRY_ACTIONS[key].inDays === null ? null : due(ENQUIRY_ACTIONS[key].inDays),
      })),
  });
});

/**
 * Puts a developed model on the mould register once the tool has been cut, and links the
 * enquiry to it [§28].
 *
 * This is what "promote a new development" now means, and it is a stricter and more useful
 * gate than the one it replaces. Promoting used to write a catalogue row — a model code, a
 * name, a tick saying a mould existed — which could be done the afternoon the buyer said yes
 * and long before anything was cut. The register cannot be filled in on a promise: it wants
 * the part weight and the cycle time, and those exist only once there is steel to measure.
 * So a model reaches the master at the moment it becomes real, which is the whole point of
 * having a gate here.
 */
export const promoteToMould = asyncHandler(async (req, res) => {
  const enquiry = await Enquiry.findById(req.params.id);
  if (!enquiry) throw ApiError.notFound('Enquiry not found');
  if (!ownsRecord(req.user, enquiry)) throw ApiError.notFound('Enquiry not found');
  if (enquiry.mould) throw ApiError.badRequest('This enquiry already points at a mould');
  if (!enquiry.isNewDevelopment) {
    throw ApiError.badRequest('Only a new development can be promoted onto the register');
  }

  const mouldCode = req.body.mouldCode.toUpperCase();
  if (await Mould.findOne({ mouldCode })) {
    throw ApiError.conflict(`Mould ${mouldCode} is already on the register`);
  }

  const mould = await Mould.create({
    ...req.body,
    mouldCode,
    /* What the buyer asked for, where the tool room has not said otherwise. */
    category: req.body.category || enquiry.requirement.category,
    sizeMm: req.body.sizeMm ?? enquiry.requirement.sizeMm,
    material: req.body.material || enquiry.requirement.material,
    developedFromEnquiry: enquiry._id,
  });

  enquiry.mould = mould._id;
  enquiry.isNewDevelopment = false;
  await enquiry.save();

  res.status(201).json({ success: true, data: { mould, enquiry } });
});

/** Counts per stage, for the marketing dashboard funnel [§21]. */
export const enquiryPipeline = asyncHandler(async (req, res) => {
  const match = ownershipFilter(req.user);

  const rows = await Enquiry.aggregate([
    ...(Object.keys(match).length ? [{ $match: match }] : []),
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        value: { $sum: { $ifNull: ['$estimatedValue', 0] } },
      },
    },
    { $project: { _id: 0, status: '$_id', count: 1, value: 1 } },
  ]);

  res.json({ success: true, data: rows });
});
