import mongoose from 'mongoose';
import Product from '../models/Product.js';
import Customer from '../models/Customer.js';
import Lead, { LEAD_STATUSES } from '../models/Lead.js';
import Enquiry, {
  CLOSED_STATUSES, ENQUIRY_STAGE_ORDER, ENQUIRY_STATUSES, fallsBack, furthestStage, stageLabel,
} from '../models/Enquiry.js';
import Sample from '../models/Sample.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { nextNumber } from '../services/numbering.service.js';
import { narrowToOwner, ownershipFilter, ownsRecord } from '../services/ownership.service.js';
import { assertAssignable, ownerForNewLead } from '../services/assignment.service.js';
import { EVENTS, publish, statusEvent } from '../services/events.service.js';
import { normalisePhone } from '../utils/phone.js';
import { listParams, paginated } from '../utils/query.js';
import { expectVersion, withoutVersion } from '../utils/concurrency.js';
import { recordChange, snapshot } from '../services/audit.service.js';
import { syncFollowUpReminder } from '../subscribers/leadFollowUp.subscriber.js';
import { suggestNextStep, coachConfigured } from '../services/leadCoach.service.js';
import { analyse, followUpQueue, leadAnalytics, untouchedLeads } from '../services/leadLog.service.js';
import { scoreFor, teamScoreboard } from '../services/scoreboard.service.js';
import { sendCsv } from '../utils/csv.js';
import { spelledLike } from '../data/places.js';
import { ENQUIRY_ACTIONS, actionsFrom } from '../services/enquiryActions.js';
import { buildBoard, perColumnFrom } from '../services/board.service.js';

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
 * The filters a lead list understands, in one place.
 *
 * One function rather than the same block in the list and the export, because the export's
 * whole promise is that the file is what was on the screen. Two copies of this had already
 * started to drift — the screen would have narrowed to a town and the download would have
 * quietly handed over the lot, which is the kind of wrong figure that reaches a meeting.
 */
const LEAD_SEARCH_FIELDS = ['company', 'contactName', 'mobile', 'email', 'number'];

function leadFilters(req, { withStatus = true } = {}) {
  /*
   * The search belongs in here rather than in each caller.
   *
   * It used to be assembled by the list endpoint and merged over the top of this, which meant
   * every *other* reader of the lead book — the board, most recently — silently searched
   * nothing at all: typing a company name narrowed the table beside it and left the columns
   * showing the whole book. Nothing errors, the screen simply ignores you. Held here, a caller
   * cannot forget it, which is the only version of this that stays true.
   */
  const { filter } = listParams(req.query, { searchFields: LEAD_SEARCH_FIELDS });

  const scope = ownershipFilter(req.user);
  Object.assign(filter, scope);

  // Narrowing to one marketing person's leads, which may only ever narrow — see the service.
  const owner = narrowToOwner(scope, req.query.assignedTo);
  if (owner !== undefined) filter.assignedTo = owner;

  /*
   * The stage tally is the one caller that wants every other filter and not this one — it has
   * to say how many each stage *would* show, and a tally narrowed to the stage already chosen
   * would read "Qualified 7" beside four zeroes.
   */
  if (withStatus && req.query.status) filter.status = req.query.status;
  if (req.query.source) filter.source = req.query.source;
  /*
   * Narrowing to a place, so a dot on the map is something you can click through to. Matched
   * on the spelling key rather than the string: the book holds "tirupur" beside "Tiruppur",
   * the map draws them as one dot of eleven, and a click that returned four of them would be
   * read as the map being wrong rather than the spelling.
   */
  if (req.query.city) filter.city = spelledLike(req.query.city);
  if (req.query.state) filter.state = spelledLike(req.query.state);
  if (withStatus && req.query.open === 'true') {
    filter.status = { $nin: ['converted', 'disqualified'] };
  }

  return filter;
}

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
 * to has to exist. Both halves belong together: customers and leads enforced the first and
 * neither enforced the second, and enquiries — the record the follow-up sweep chases and the
 * one most worth taking — enforced neither. A rule applied to two of three records is not a
 * rule, it is a gap with two witnesses.
 */
async function assertReassignment(current, incoming, user) {
  if (!isReassignment(current, incoming)) return;
  if (user.role !== 'admin') {
    throw ApiError.forbidden('Only an administrator can change who a record belongs to');
  }
  await assertAssignable(incoming);
}

/** How much of a customer's enquiry history the detail screen carries inline. */
const TIMELINE_PAGE = 10;

/* ------------------------------- Products ------------------------------- */

export const listProducts = asyncHandler(async (req, res) => {
  const { page, limit, sort, filter } = listParams(req.query, {
    searchFields: ['modelCode', 'name', 'mouldNumber'],
    defaultSort: 'modelCode',
  });

  if (req.query.category) filter.category = req.query.category;
  if (req.query.material) filter.material = req.query.material;
  if (req.query.mouldAvailable !== undefined && req.query.mouldAvailable !== '') {
    filter.mouldAvailable = req.query.mouldAvailable === 'true';
  }
  if (req.query.isActive !== undefined && req.query.isActive !== '') {
    filter.isActive = req.query.isActive === 'true';
  }

  const [data, total] = await Promise.all([
    Product.find(filter).sort(sort).skip((page - 1) * limit).limit(limit),
    Product.countDocuments(filter),
  ]);

  paginated(res, data, { page, limit, total });
});

export const getProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw ApiError.notFound('Product not found');
  res.json({ success: true, data: product });
});

export const createProduct = asyncHandler(async (req, res) => {
  if (await Product.findOne({ modelCode: req.body.modelCode.toUpperCase() })) {
    throw ApiError.conflict(`Model code ${req.body.modelCode} is already in use`);
  }
  const product = await Product.create(req.body);
  res.status(201).json({ success: true, data: product });
});

export const updateProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw ApiError.notFound('Product not found');

  // Read first so the version can be checked; the catalogue is shared, so two people
  // correcting the same model at once is the ordinary case rather than the unlucky one.
  expectVersion(product, req.body);
  const before = snapshot(product);
  Object.assign(product, withoutVersion(req.body));
  await product.save();
  await recordChange({ model: 'Product', doc: product, before, by: req.user });

  res.json({ success: true, data: product });
});



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
  leads: { model: Lead, module: 'enquiries', field: 'assignedTo', label: 'Lead' },
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
  const successor = await assertAssignable(assignTo);

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
export const exportCustomers = asyncHandler(async (req, res) => {
  const { sort, filter } = listParams(req.query, {
    searchFields: ['name', 'code', 'gstin', 'mobile', 'whatsapp', 'email'],
    defaultSort: 'name',
  });

  Object.assign(filter, ownershipFilter(req.user));
  if (req.query.customerType) filter.customerType = req.query.customerType;
  if (req.query.rating) filter.rating = req.query.rating;
  if (req.query.status) filter.status = req.query.status;

  const rows = await Customer.find(filter).populate('assignedTo', 'name').sort(sort).limit(EXPORT_LIMIT);

  sendCsv(res, 'customers', rows, [
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

export const exportLeads = asyncHandler(async (req, res) => {
  const { sort, filter } = listParams(req.query, {
    searchFields: ['company', 'contactName', 'mobile', 'email', 'number'],
  });

  Object.assign(filter, leadFilters(req));

  const rows = await Lead.find(filter).populate('assignedTo', 'name').sort(sort).limit(EXPORT_LIMIT);

  sendCsv(res, 'leads', rows, [
    ['Number', (row) => row.number],
    ['Company', (row) => row.company],
    ['Contact', (row) => row.contactName],
    ['Mobile', (row) => row.mobile],
    ['Email', (row) => row.email],
    ['City', (row) => row.city],
    ['Status', (row) => row.status],
    ['Interest', (row) => row.productInterest],
    ['Est. quantity', (row) => row.estimatedQuantity],
    ['Est. value', (row) => row.estimatedValue],
    ['Owner', (row) => row.assignedTo?.name],
    ['Source', (row) => row.source],
    ['Next action', (row) => row.nextAction],
    ['Next follow-up', (row) => row.nextFollowUpDate],
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

  const rows = await Enquiry.find(filter)
    .populate('customer', 'code name')
    .populate('assignedTo', 'name')
    .sort(sort)
    .limit(EXPORT_LIMIT);

  sendCsv(res, 'enquiries', rows, [
    ['Number', (row) => row.number],
    ['Date', (row) => row.enquiryDate],
    ['Customer', (row) => row.customer?.name],
    ['Customer code', (row) => row.customer?.code],
    ['Model', (row) => row.requirement?.modelNumber],
    ['Category', (row) => row.requirement?.category],
    ['Size (mm)', (row) => row.requirement?.sizeMm],
    ['Material', (row) => row.requirement?.material],
    ['Colour', (row) => row.requirement?.colour],
    ['Quantity', (row) => row.requirement?.quantity],
    ['Printing', (row) => row.requirement?.printing],
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

export const exportProducts = asyncHandler(async (req, res) => {
  const { sort, filter } = listParams(req.query, {
    searchFields: ['modelCode', 'name', 'mouldNumber'],
    defaultSort: 'modelCode',
  });

  if (req.query.category) filter.category = req.query.category;
  if (req.query.material) filter.material = req.query.material;

  const rows = await Product.find(filter).sort(sort).limit(EXPORT_LIMIT);

  sendCsv(res, 'products', rows, [
    ['Model code', (row) => row.modelCode],
    ['Name', (row) => row.name],
    ['Category', (row) => row.category],
    ['Size (mm)', (row) => row.sizeMm],
    ['Material', (row) => row.material],
    ['Hook', (row) => row.hookType],
    ['Weight (g)', (row) => row.standardWeightGrams],
    ['Colours', (row) => (row.availableColours || []).join(' / ')],
    ['Mould available', (row) => (row.mouldAvailable ? 'Yes' : 'No')],
    ['Mould number', (row) => row.mouldNumber],
    ['Standard price', (row) => row.standardPrice],
    ['MOQ', (row) => row.moq],
    ['Packing qty', (row) => row.packingQty],
    ['Active', (row) => (row.isActive === false ? 'No' : 'Yes')],
  ]);
});

/* ------------------------------- Customers ------------------------------- */

export const listCustomers = asyncHandler(async (req, res) => {
  const { page, limit, sort, filter } = listParams(req.query, {
    searchFields: ['name', 'code', 'gstin', 'mobile', 'whatsapp', 'email'],
    defaultSort: 'name',
  });

  Object.assign(filter, ownershipFilter(req.user));
  if (req.query.customerType) filter.customerType = req.query.customerType;
  if (req.query.rating) filter.rating = req.query.rating;
  if (req.query.status) filter.status = req.query.status;

  const [data, total] = await Promise.all([
    Customer.find(filter).populate('assignedTo', 'name').sort(sort).skip((page - 1) * limit).limit(limit),
    Customer.countDocuments(filter),
  ]);

  paginated(res, data, { page, limit, total });
});

export const getCustomer = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id).populate('assignedTo', 'name email');
  if (!customer) throw ApiError.notFound('Customer not found');
  if (!ownsRecord(req.user, customer)) throw ApiError.notFound('Customer not found');

  /*
   * The timeline the blueprint asks for [§2]. It grows as later modules land.
   *
   * The first page only, with the count beside it. A bare `.limit(50)` was worse than either
   * paging or not: a customer with sixty enquiries showed fifty and said nothing, so the
   * screen quietly disagreed with the business. The rest come from `/enquiries?customer=`,
   * which is the same list this is a preview of.
   */
  const filter = { customer: customer._id };
  const [enquiries, total, samples, sampleTotal, leads] = await Promise.all([
    Enquiry.find(filter)
      .select('number enquiryDate status requirement.modelNumber requirement.quantity estimatedValue')
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
    /*
     * Where this customer came from, and what else was folded into it.
     *
     * Read off `lead.convertedCustomer` rather than a field on the customer, and that is the
     * whole point: a customer is *created from* at most one lead, but any number of later leads
     * can turn out to be the same buyer and be attached to it — a new contact filling in the
     * website form, an IndiaMART enquiry from a company already supplied. One field could hold
     * the first and would silently lose every one after it, and it would be a second copy of
     * something the lead already records. Asking the leads is the only version that stays true.
     *
     * `convertedFromStatus` comes along because it is the honest label: a lead that reached
     * `qualified` before it closed reads differently from one converted straight off the rank.
     */
    Lead.find({ convertedCustomer: customer._id })
      .select('number company convertedAt convertedFromStatus convertedEnquiry')
      .sort('-convertedAt')
      .limit(TIMELINE_PAGE),
  ]);

  res.json({
    success: true,
    data: {
      customer,
      timeline: { enquiries, total, samples, sampleTotal, leads },
    },
  });
});

export const createCustomer = asyncHandler(async (req, res) => {
  const duplicate = await findDuplicateCustomer(req.body);
  if (duplicate) {
    throw ApiError.conflict(
      `${duplicate.name} (${duplicate.code}) already exists with the same ${duplicate.matchedOn}`
    );
  }

  if (req.body.assignedTo) await assertAssignable(req.body.assignedTo);

  const customer = await Customer.create({
    ...req.body,
    code: await nextNumber('CUST'),
    // Ownership defaults to whoever created the record, unless an admin assigns it.
    assignedTo: req.body.assignedTo || req.user._id,
  });

  res.status(201).json({ success: true, data: customer });
});

export const updateCustomer = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw ApiError.notFound('Customer not found');
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

  res.json({ success: true, data: customer });
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

/* --------------------------------- Leads --------------------------------- */

export const listLeads = asyncHandler(async (req, res) => {
  const { page, limit, sort } = listParams(req.query, { searchFields: LEAD_SEARCH_FIELDS });

  const filter = leadFilters(req);

  /*
   * How many sit at each stage, and what they are worth.
   *
   * The stage buttons above the list used to say "Show" — five identical cards carrying no
   * information, which is a row of chrome where the shape of somebody's week should be. The
   * tally comes back with the rows rather than from its own endpoint because it has to be
   * computed from the same filter: fetched separately, it would disagree with the list
   * underneath it the moment a town or a colleague was chosen.
   */
  const tallyFilter = leadFilters(req, { withStatus: false });

  const [data, total, stages] = await Promise.all([
    Lead.find(filter).populate('assignedTo', 'name').sort(sort).skip((page - 1) * limit).limit(limit),
    Lead.countDocuments(filter),
    Lead.aggregate([
      { $match: tallyFilter },
      { $group: { _id: '$status', leads: { $sum: 1 }, value: { $sum: '$estimatedValue' } } },
    ]),
  ]);

  const stageCounts = Object.fromEntries(
    stages.map((row) => [row._id, { leads: row.leads, value: row.value || 0 }])
  );

  paginated(res, data, { page, limit, total }, { stageCounts });
});

/**
 * The lead book as a board: every stage a column, the head of each in follow-up order.
 *
 * Deliberately not the list endpoint with a bigger page. A list narrowed to one stage and read
 * five times is five different moments in time, and bucketing one page of fifty in the browser
 * gives columns made of whatever sorted first. The tally and the cards here come off the same
 * filter in the same breath.
 *
 * The stage filter is dropped — `withStatus: false`, the same escape hatch the tally beside the
 * list already uses. On a board the columns *are* the stage filter, and a board showing one
 * column is a list that scrolls sideways. Every other filter still applies, so switching a
 * search or an owner from the list to the board keeps the same set of leads.
 */
export const leadBoard = asyncHandler(async (req, res) => {
  /*
   * Soonest promise first — and, because Mongo sorts a missing date before every real one, the
   * leads nobody promised anything about rise to the top of their column. That is not a
   * side effect worth fixing: §3 asks that an open record always carry a defined next step, so
   * a lead with no date is the one genuine failure on the board and belongs where it is seen.
   */
  const sort = 'nextFollowUpDate';

  const columns = await buildBoard({
    Model: Lead,
    filter: leadFilters(req, { withStatus: false }),
    statuses: LEAD_STATUSES,
    sort,
    perColumn: perColumnFrom(req.query),
    valueField: 'estimatedValue',
    select:
      'number company contactName city state source status estimatedValue estimatedQuantity ' +
      'productInterest nextAction nextActionType nextFollowUpDate assignedTo activities ' +
      /* `updatedAt` so a move from the board can carry the same optimistic-concurrency check a
         move from the lead screen does — a card is a stale copy the moment somebody else edits. */
      'createdAt updatedAt',
    populate: [{ path: 'assignedTo', select: 'name' }],
    lastActivityOnly: true,
  });

  /* The sort travels with the answer so "show more" pages the list in the board's own order. */
  res.json({ success: true, data: { columns }, meta: { sort } });
});

export const getLead = asyncHandler(async (req, res) => {
  const lead = await Lead.findById(req.params.id)
    .populate('assignedTo', 'name email')
    .populate('convertedCustomer', 'code name')
    .populate('convertedEnquiry', 'number status');
  if (!lead) throw ApiError.notFound('Lead not found');
  if (!ownsRecord(req.user, lead)) throw ApiError.notFound('Lead not found');
  res.json({ success: true, data: lead });
});

export const createLead = asyncHandler(async (req, res) => {
  // The same rule `updateLead` holds. Enforced on one and not the other, it is not a rule:
  // handing a lead to a colleague was refused by a PATCH and allowed by the POST, so anyone
  // could do in one step what they were forbidden from doing in two.
  if (req.body.assignedTo && req.user.role !== 'admin') {
    throw ApiError.forbidden('Only an administrator can assign a lead to someone else');
  }
  if (req.body.assignedTo) await assertAssignable(req.body.assignedTo);

  // Round-robin across marketing for a lead that arrives with nobody attached [§41.3]. A
  // marketing person entering their own call keeps it; see the service for why.
  const owner = await ownerForNewLead({ requested: req.body.assignedTo, creator: req.user });

  const lead = await Lead.create({
    ...req.body,
    number: await nextNumber('LEAD'),
    assignedTo: owner.user,
  });

  await syncFollowUpReminder(lead);

  // Said out loud on the record, so nobody has to guess why it landed with them.
  if (owner.rotated) {
    lead.activities.push({
      type: 'note',
      summary: `Assigned to ${owner.name} by rotation`,
      createdBy: req.user._id,
    });
    await lead.save();
  }

  res.status(201).json({ success: true, data: lead });
});

export const updateLead = asyncHandler(async (req, res) => {
  const lead = await Lead.findById(req.params.id);
  if (!lead) throw ApiError.notFound('Lead not found');
  if (!ownsRecord(req.user, lead)) throw ApiError.notFound('Lead not found');
  if (lead.status === 'converted') {
    throw ApiError.badRequest('This lead has been converted and can no longer be edited');
  }

  await assertReassignment(lead.assignedTo, req.body.assignedTo, req.user);

  const { status, disqualifyReason } = req.body;
  if (status === 'disqualified' && !disqualifyReason && !lead.disqualifyReason) {
    throw ApiError.badRequest('Give a reason when disqualifying a lead');
  }
  if (status === 'converted') {
    throw ApiError.badRequest('Use the convert action rather than setting the status directly');
  }

  expectVersion(lead, req.body);
  const before = snapshot(lead);
  Object.assign(lead, withoutVersion(req.body));
  await lead.save();
  await recordChange({ model: 'Lead', doc: lead, before, by: req.user });
  // A moved date replaces its reminder rather than leaving the old one to be chased.
  await syncFollowUpReminder(lead);

  res.json({ success: true, data: lead });
});

export const addLeadActivity = asyncHandler(async (req, res) => {
  const lead = await Lead.findById(req.params.id);
  if (!lead) throw ApiError.notFound('Lead not found');
  if (!ownsRecord(req.user, lead)) throw ApiError.notFound('Lead not found');

  lead.activities.push({ ...req.body, createdBy: req.user._id });
  // Logging contact is itself progress, so a new lead stops being new.
  if (lead.status === 'new') lead.status = 'contacted';

  /*
   * The moment somebody records a call is the moment they know what happens next, so the form
   * offers it here and this saves it — rather than making them open the edit dialog to set a
   * date they have already decided on, which is where the next step gets skipped.
   */
  if (req.body.nextAction !== undefined) lead.nextAction = req.body.nextAction;
  if (req.body.nextActionType !== undefined) lead.nextActionType = req.body.nextActionType;
  if (req.body.nextFollowUpDate !== undefined) lead.nextFollowUpDate = req.body.nextFollowUpDate;

  await lead.save();
  await syncFollowUpReminder(lead);

  res.status(201).json({ success: true, data: lead, meta: { log: analyse(lead) } });
});

/**
 * What the log says, and what to do about it.
 *
 * Proposes; never writes. The reply is a draft the marketing person accepts, edits or
 * dismisses — so a misread is a suggestion somebody declines rather than a wrong follow-up
 * date on a real buyer that nobody can tell a model set.
 */
export const suggestLeadNextStep = asyncHandler(async (req, res) => {
  const lead = await Lead.findById(req.params.id);
  if (!lead) throw ApiError.notFound('Lead not found');
  if (!ownsRecord(req.user, lead)) throw ApiError.notFound('Lead not found');

  const suggestion = await suggestNextStep(lead);
  res.json({ success: true, data: suggestion, meta: { model: coachConfigured() } });
});

/** The arithmetic over the log, without asking a model anything. */
export const leadLogAnalytics = asyncHandler(async (req, res) => {
  const lead = await Lead.findById(req.params.id);
  if (!lead) throw ApiError.notFound('Lead not found');
  if (!ownsRecord(req.user, lead)) throw ApiError.notFound('Lead not found');

  res.json({ success: true, data: analyse(lead) });
});

/** Whose leads need somebody today — overdue, due, undecided, and quietly cooling. */
export const leadFollowUps = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await followUpQueue(ownershipFilter(req.user)) });
});

/**
 * The shape of the lead book, and the leads that have gone quiet in it.
 *
 * One endpoint rather than two because they are read together: the funnel says how many are
 * at each stage, and the anomaly list says how many of those are only nominally there.
 */
/**
 * Who is holding leads, so the list can be narrowed to one of them.
 *
 * Scoped like everything else, which is what makes the filter safe to show to everybody: a
 * marketing person gets exactly one name — their own — so the picker has nothing to offer them
 * and the screen simply does not draw it. No role check in the client, and no way to learn a
 * colleague's id from a screen that is not allowed to show their records.
 */
async function ownersOf(Model, req, res) {
  const rows = await Model.aggregate([
    { $match: ownershipFilter(req.user) },
    { $group: { _id: '$assignedTo', leads: { $sum: 1 } } },
  ]);

  const owners = await User.find({ _id: { $in: rows.map((row) => row._id).filter(Boolean) } })
    .select('name department')
    .sort('name');

  const counts = new Map(rows.map((row) => [String(row._id), row.leads]));

  res.json({
    success: true,
    data: owners.map((owner) => ({
      _id: owner._id,
      name: owner.name,
      department: owner.department,
      leads: counts.get(String(owner._id)) || 0,
    })),
    // Said rather than left to be inferred from a total that does not add up.
    unassigned: counts.get('null') || counts.get('undefined') || 0,
  });
}

export const leadOwners = asyncHandler((req, res) => ownersOf(Lead, req, res));

/** The same question about enquiries, answered by the same rule — see `ownersOf`. */
export const enquiryOwners = asyncHandler((req, res) => ownersOf(Enquiry, req, res));

export const leadsOverview = asyncHandler(async (req, res) => {
  const scope = ownershipFilter(req.user);
  const [analytics, untouched] = await Promise.all([
    leadAnalytics(scope),
    untouchedLeads(scope),
  ]);

  res.json({ success: true, data: { ...analytics, untouchedLeads: untouched } });
});

/**
 * The scoreboard: one card for the person asking, and the team for management.
 *
 * Nothing here counts activity — see `scoreboard.service.js` for why that would be the one
 * change guaranteed to make the data worse.
 */
export const leadScoreboard = asyncHandler(async (req, res) => {
  const mine = await scoreFor(req.user);
  const canSeeTeam = req.user.role === 'admin' || req.user.department === 'management';

  res.json({
    success: true,
    data: { mine, team: canSeeTeam ? await teamScoreboard() : null },
  });
});

/**
 * Converts a qualified lead into a Customer, its first Contact and the first Enquiry, in
 * one action [BLUEPRINT §41.4 — nothing may be re-keyed].
 *
 * The enquiry is optional: sometimes a lead is worth keeping as a customer before any firm
 * requirement exists. When one is given it follows the same rules as any other enquiry.
 */
export const convertLead = asyncHandler(async (req, res) => {
  const lead = await Lead.findById(req.params.id);
  if (!lead) throw ApiError.notFound('Lead not found');
  if (!ownsRecord(req.user, lead)) throw ApiError.notFound('Lead not found');
  if (lead.status === 'converted') throw ApiError.conflict('This lead has already been converted');
  if (lead.status === 'disqualified') throw ApiError.badRequest('A disqualified lead cannot be converted');

  const {
    customer: customerOverrides = {},
    existingCustomer: existingCustomerId,
    enquiry: enquiryInput,
  } = req.body;

  /*
   * The lead is a party we already supply.
   *
   * The commonest awkward case in the book: a new contact at a customer fills in the website
   * form, or an IndiaMART enquiry arrives from a company we shipped to last month. The
   * duplicate check below correctly refused to make a second master record and advised linking
   * the enquiry to the existing one — advice nothing could follow, so the only way to clear the
   * lead was to disqualify a real buyer as a duplicate and re-key their requirement by hand.
   *
   * Attaching does everything conversion does except create the customer: the enquiry is raised
   * against the record that already exists, the lead is closed against it, and the lead's log
   * stays reachable from the customer it belonged to all along.
   */
  let existing = null;
  if (existingCustomerId) {
    if (Object.keys(customerOverrides).length) {
      throw ApiError.badRequest(
        'Either make a customer from this lead or attach it to one that exists — not both'
      );
    }

    existing = await Customer.findById(existingCustomerId);
    if (!existing) throw ApiError.badRequest('That customer does not exist');
    /*
     * Ownership is checked on the customer, not on the lead alone. Attaching writes an enquiry
     * into somebody else's book otherwise — the duplicate check deliberately finds customers
     * the caller cannot see, so this is the door that has to be shut.
     */
    if (!ownsRecord(req.user, existing)) throw ApiError.notFound('Customer not found');
  }

  const merged = {
    name: customerOverrides.name || lead.company,
    gstin: customerOverrides.gstin,
    mobile: customerOverrides.mobile || lead.mobile,
    whatsapp: customerOverrides.whatsapp || lead.whatsapp,
  };

  const duplicate = existing ? null : await findDuplicateCustomer(merged);
  if (duplicate) {
    /*
     * The match travels with the refusal so the screen can offer it, and only when the caller
     * may actually see it — a customer somebody else holds is reported as existing, with who to
     * talk to, and never handed over. Same rule as `checkDuplicateCustomer`.
     */
    const visible = ownsRecord(req.user, duplicate);
    throw ApiError.conflict(
      `${duplicate.name} (${duplicate.code}) already exists with the same ${duplicate.matchedOn}. ` +
        (visible
          ? 'Attach this lead to that customer instead of converting.'
          : `It belongs to ${duplicate.assignedTo?.name || 'somebody else'} — ask them to raise the enquiry.`),
      {
        matchedOn: duplicate.matchedOn,
        owner: duplicate.assignedTo?.name,
        ...(visible ? { customer: { id: duplicate._id, code: duplicate.code, name: duplicate.name } } : {}),
      }
    );
  }

  /*
   * Conversion writes three records and must not half-happen. A customer left behind by a
   * rejected enquiry would match the duplicate check on the retry, and the lead could then
   * never be converted at all — so the enquiry is judged before the customer is written.
   */
  if (enquiryInput) {
    await assertEnquiryValid({ ...enquiryInput, assignedTo: lead.assignedTo });
  }

  /* Attaching writes no customer: the record already exists and stays exactly as it is. */
  const customer = existing || await Customer.create({
    code: await nextNumber('CUST'),
    name: merged.name,
    customerType: customerOverrides.customerType || 'garment_factory',
    city: customerOverrides.city || lead.city,
    state: customerOverrides.state || lead.state,
    mobile: merged.mobile,
    whatsapp: merged.whatsapp,
    email: customerOverrides.email || lead.email,
    gstin: merged.gstin,
    contacts: lead.contactName
      ? [
          {
            name: lead.contactName,
            designation: lead.designation,
            mobile: lead.mobile,
            whatsapp: lead.whatsapp,
            email: lead.email,
            isPrimary: true,
          },
        ]
      : [],
    // Ownership follows the lead, so converting never quietly moves a relationship.
    assignedTo: lead.assignedTo,
    creditTermsDays: customerOverrides.creditTermsDays,
    paymentTerms: customerOverrides.paymentTerms,
    rating: customerOverrides.rating || 'B',
    source: lead.source,
    // §41.6: the thread stays attached to every record the lead becomes, or the history is
    // linked to a lead nobody opens again once it has been converted.
    conversation: lead.conversation,
    convertedFromLead: lead._id,
    notes: lead.notes,
  });

  let enquiry = null;
  if (enquiryInput) {
    enquiry = await createEnquiryRecord(
      {
        ...enquiryInput,
        customer: customer._id,
        /*
         * A new customer inherits the lead's owner, so the enquiry does too. An existing one
         * already has an owner and the enquiry follows *them* — putting it on the lead's holder
         * would hand a relationship over through a side door, which is precisely what §29
         * reserves to management.
         */
        assignedTo: existing ? existing.assignedTo : lead.assignedTo,
        source: lead.source,
        conversation: lead.conversation,
        lead: lead._id,
      },
      req.user
    );
  }

  /*
   * The samples made for this lead gain the customer it became.
   *
   * Without this, asking for a sample before anybody is a customer means the request is
   * orphaned at the exact moment the relationship becomes real: the lead stops being a screen
   * anybody opens, and the sample it carried has no buyer on it — so §6 and §42 have nobody to
   * tell when it is ready or when it goes out.
   *
   * The customer is set and the enquiry deliberately is not. That the lead became this customer
   * is a fact; which of two samples belongs to the one enquiry conversion happened to create is
   * a judgement, and `linkEnquiry` already exists for somebody to make it deliberately. Only
   * requests that do not already name a customer are touched, so nothing that was set by hand
   * is overwritten.
   */
  const carried = await Sample.updateMany(
    { lead: lead._id, customer: { $in: [null, undefined] } },
    { $set: { customer: customer._id } }
  );

  /* What the lead was before it closed, so skipping the qualified rung is countable [R2]. */
  lead.convertedFromStatus = lead.status;
  lead.status = 'converted';
  lead.convertedCustomer = customer._id;
  lead.convertedEnquiry = enquiry?._id;
  lead.convertedAt = new Date();
  await lead.save();

  publish(EVENTS.LEAD_CONVERTED, {
    lead, customer, enquiry, samples: carried.modifiedCount, attached: Boolean(existing),
  });

  res.status(201).json({ success: true, data: { lead, customer, enquiry } });
});

/* -------------------------------- Enquiries -------------------------------- */

/**
 * The blueprint's hard rule [§3]: an open enquiry always carries a next action and a date.
 * Enforced on write rather than reported afterwards, because an enquiry with no next step
 * is exactly the one that goes quiet.
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
 * Separated from creation so a caller that writes other records first — lead conversion
 * writes a customer, a group writes several enquiries — can find out it is going to fail
 * before it has left half a conversion behind. Rolling back afterwards is not equivalent:
 * this database is not necessarily a replica set, so there is no transaction to lean on.
 */
async function assertEnquiryValid(input) {
  const { product, isNewDevelopment } = input;

  if (!product && !isNewDevelopment) {
    throw ApiError.badRequest(
      'Pick a model from the catalogue, or mark this as a new development'
    );
  }
  if (isNewDevelopment && !input.requirement?.modelNumber && !input.remarks) {
    throw ApiError.badRequest('Describe the new development in the model number or remarks');
  }
  if (
    !CLOSED_STATUSES.includes(input.status || 'new') &&
    (!input.nextAction || !input.nextFollowUpDate)
  ) {
    throw ApiError.badRequest('An open enquiry needs a next action and a follow-up date');
  }
  assertFutureFollowUp(input.nextFollowUpDate);
  if (product) {
    const exists = await Product.findById(product);
    if (!exists) throw ApiError.badRequest('That model is not in the catalogue');
  }
  if (input.assignedTo) await assertAssignable(input.assignedTo);
}

/** Shared by the create endpoint and by lead conversion. */
async function createEnquiryRecord(input, user) {
  await assertEnquiryValid(input);

  const enquiry = new Enquiry({
    ...input,
    number: await nextNumber('ENQ'),
    assignedTo: input.assignedTo || user._id,
    statusHistory: [{ to: input.status || 'new', by: user._id }],
  });

  await enquiry.save();

  publish(EVENTS.ENQUIRY_CREATED, { enquiry, by: user });
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
  if (req.query.groupRef) filter.groupRef = req.query.groupRef;

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

export const listEnquiries = asyncHandler(async (req, res) => {
  const { page, limit, sort } = listParams(req.query, {
    searchFields: ENQUIRY_SEARCH_FIELDS,
    defaultSort: '-enquiryDate',
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
      .populate('product', 'modelCode name')
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
 * The enquiry book as a board. Same construction as the lead board, and the same argument.
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
      'number customer product assignedTo status estimatedValue enquiryDate nextAction ' +
      'nextActionType nextFollowUpDate requirement holdReason lostReason ' +
      'statusHistory.from statusHistory.to statusHistory.at createdAt',
    populate: [
      { path: 'customer', select: 'code name' },
      { path: 'product', select: 'modelCode name' },
      { path: 'assignedTo', select: 'name' },
    ],
  });

  res.json({ success: true, data: { columns }, meta: { sort } });
});

export const getEnquiry = asyncHandler(async (req, res) => {
  const enquiry = await Enquiry.findById(req.params.id)
    .populate('customer', 'code name mobile email assignedTo')
    .populate('assignedTo', 'name email')
    .populate('product', 'modelCode name sizeMm material')
    .populate('lead', 'number company');
  if (!enquiry) throw ApiError.notFound('Enquiry not found');
  if (!ownsRecord(req.user, enquiry)) throw ApiError.notFound('Enquiry not found');
  res.json({ success: true, data: enquiry });
});

export const createEnquiry = asyncHandler(async (req, res) => {
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
});

/**
 * Creates several enquiries from one conversation — one per model, sharing a group
 * reference so follow-up keeps them together while sample and price stay answerable
 * per model.
 */
export const createEnquiryGroup = asyncHandler(async (req, res) => {
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
});

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
  Object.assign(enquiry, withoutVersion(req.body));
  assertNextAction(enquiry);
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
   * So it reopens deliberately or not at all: only to an open stage, and only with a note
   * saying why. The note is the part that matters — it lands in the history beside the close
   * it undoes, so the record explains itself to whoever reads it next.
   */
  const reopening = CLOSED_STATUSES.includes(enquiry.status);
  if (reopening) {
    if (CLOSED_STATUSES.includes(status)) {
      throw ApiError.badRequest(`A ${enquiry.status} enquiry cannot be closed again`);
    }
    if (!note?.trim()) {
      throw ApiError.badRequest('Say why this is being reopened — it goes into the history');
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

  publish(EVENTS.ENQUIRY_STATUS_CHANGED, { enquiry, from, to: status, by: user });
  const specific = statusEvent(status);
  if (specific) publish(specific, { enquiry, from, by: user });

  return enquiry;
}

export const setEnquiryStatus = asyncHandler(async (req, res) => {
  const enquiry = await Enquiry.findById(req.params.id);
  if (!enquiry) throw ApiError.notFound('Enquiry not found');
  if (!ownsRecord(req.user, enquiry)) throw ApiError.notFound('Enquiry not found');

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
 * Promotes a new development into the product master once it has been developed and
 * approved, and links the enquiry to it. Keeps speculative models out of the catalogue.
 */
export const promoteToProduct = asyncHandler(async (req, res) => {
  const enquiry = await Enquiry.findById(req.params.id);
  if (!enquiry) throw ApiError.notFound('Enquiry not found');
  if (!ownsRecord(req.user, enquiry)) throw ApiError.notFound('Enquiry not found');
  if (enquiry.product) throw ApiError.badRequest('This enquiry already points at a model');
  if (!enquiry.isNewDevelopment) {
    throw ApiError.badRequest('Only a new development can be promoted into the catalogue');
  }

  if (await Product.findOne({ modelCode: req.body.modelCode.toUpperCase() })) {
    throw ApiError.conflict(`Model code ${req.body.modelCode} is already in use`);
  }

  const product = await Product.create({
    ...req.body,
    category: req.body.category || enquiry.requirement.category,
    sizeMm: req.body.sizeMm ?? enquiry.requirement.sizeMm,
    material: req.body.material || enquiry.requirement.material,
    developedFromEnquiry: enquiry._id,
  });

  enquiry.product = product._id;
  enquiry.isNewDevelopment = false;
  await enquiry.save();

  res.status(201).json({ success: true, data: { product, enquiry } });
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
