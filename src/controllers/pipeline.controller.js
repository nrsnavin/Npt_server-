import Product from '../models/Product.js';
import Customer from '../models/Customer.js';
import Lead from '../models/Lead.js';
import Enquiry, { CLOSED_STATUSES } from '../models/Enquiry.js';
import Sample from '../models/Sample.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { nextNumber } from '../services/numbering.service.js';
import { ownershipFilter, ownsRecord } from '../services/ownership.service.js';
import { assertAssignable, ownerForNewLead } from '../services/assignment.service.js';
import { EVENTS, publish, statusEvent } from '../services/events.service.js';
import { normalisePhone } from '../utils/phone.js';
import { listParams, paginated } from '../utils/query.js';
import { expectVersion, withoutVersion } from '../utils/concurrency.js';
import { recordChange, snapshot } from '../services/audit.service.js';
import { syncFollowUpReminder } from '../subscribers/leadFollowUp.subscriber.js';
import { suggestNextStep, coachConfigured } from '../services/leadCoach.service.js';
import { analyse, followUpQueue } from '../services/leadLog.service.js';
import { scoreFor, teamScoreboard } from '../services/scoreboard.service.js';
import { sendCsv } from '../utils/csv.js';

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

  Object.assign(filter, ownershipFilter(req.user));
  if (req.query.status) filter.status = req.query.status;
  if (req.query.source) filter.source = req.query.source;
  if (req.query.open === 'true') filter.status = { $nin: ['converted', 'disqualified'] };

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
  const { sort, filter } = listParams(req.query, {
    searchFields: ['number', 'requirement.modelNumber', 'remarks'],
    defaultSort: '-enquiryDate',
  });

  Object.assign(filter, ownershipFilter(req.user));
  if (req.query.customer) filter.customer = req.query.customer;
  if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };
  if (req.query.open === 'true') filter.status = { $nin: CLOSED_STATUSES };
  if (req.query.dueBy) filter.nextFollowUpDate = { $lte: new Date(req.query.dueBy) };

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
  const [enquiries, total, samples, sampleTotal] = await Promise.all([
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
  ]);

  res.json({
    success: true,
    data: {
      customer,
      timeline: { enquiries, total, samples, sampleTotal },
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
  const { page, limit, sort, filter } = listParams(req.query, {
    searchFields: ['company', 'contactName', 'mobile', 'email', 'number'],
  });

  Object.assign(filter, ownershipFilter(req.user));
  if (req.query.status) filter.status = req.query.status;
  if (req.query.source) filter.source = req.query.source;
  if (req.query.open === 'true') filter.status = { $nin: ['converted', 'disqualified'] };

  const [data, total] = await Promise.all([
    Lead.find(filter).populate('assignedTo', 'name').sort(sort).skip((page - 1) * limit).limit(limit),
    Lead.countDocuments(filter),
  ]);

  paginated(res, data, { page, limit, total });
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

  const { customer: customerOverrides = {}, enquiry: enquiryInput } = req.body;

  const merged = {
    name: customerOverrides.name || lead.company,
    gstin: customerOverrides.gstin,
    mobile: customerOverrides.mobile || lead.mobile,
    whatsapp: customerOverrides.whatsapp || lead.whatsapp,
  };

  const duplicate = await findDuplicateCustomer(merged);
  if (duplicate) {
    throw ApiError.conflict(
      `${duplicate.name} (${duplicate.code}) already exists with the same ${duplicate.matchedOn}. ` +
        'Link the enquiry to that customer instead of converting.'
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

  const customer = await Customer.create({
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
        assignedTo: lead.assignedTo,
        source: lead.source,
        conversation: lead.conversation,
        lead: lead._id,
      },
      req.user
    );
  }

  lead.status = 'converted';
  lead.convertedCustomer = customer._id;
  lead.convertedEnquiry = enquiry?._id;
  lead.convertedAt = new Date();
  await lead.save();

  publish(EVENTS.LEAD_CONVERTED, { lead, customer, enquiry });

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

export const listEnquiries = asyncHandler(async (req, res) => {
  const { page, limit, sort, filter } = listParams(req.query, {
    searchFields: ['number', 'requirement.modelNumber', 'remarks'],
    defaultSort: '-enquiryDate',
  });

  Object.assign(filter, ownershipFilter(req.user));
  if (req.query.customer) filter.customer = req.query.customer;
  if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };
  if (req.query.open === 'true') filter.status = { $nin: CLOSED_STATUSES };
  if (req.query.groupRef) filter.groupRef = req.query.groupRef;

  // The follow-up list marketing works from each morning [§37].
  if (req.query.dueBy) {
    filter.nextFollowUpDate = { $lte: new Date(req.query.dueBy) };
    filter.status = filter.status || { $nin: CLOSED_STATUSES };
  }

  const [data, total] = await Promise.all([
    Enquiry.find(filter)
      .populate('customer', 'code name')
      .populate('assignedTo', 'name')
      .populate('product', 'modelCode name')
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit),
    Enquiry.countDocuments(filter),
  ]);

  paginated(res, data, { page, limit, total });
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

  // Every model is judged first: a group that stops half way is worse than one refused.
  const items = req.body.enquiries.map((item) => ({
    ...req.body.shared,
    ...item,
    customer: customer._id,
    assignedTo: customer.assignedTo,
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
export const setEnquiryStatus = asyncHandler(async (req, res) => {
  const enquiry = await Enquiry.findById(req.params.id);
  if (!enquiry) throw ApiError.notFound('Enquiry not found');
  if (!ownsRecord(req.user, enquiry)) throw ApiError.notFound('Enquiry not found');

  const { status, note, lostReason, lostNote, holdReason, nextAction, nextFollowUpDate } = req.body;

  if (status === enquiry.status) throw ApiError.badRequest(`Already at ${status}`);
  if (CLOSED_STATUSES.includes(enquiry.status)) {
    throw ApiError.badRequest(`A ${enquiry.status} enquiry cannot be moved again`);
  }
  if (status === 'lost' && !lostReason) {
    throw ApiError.badRequest('Give a reason when marking an enquiry lost');
  }

  const from = enquiry.status;
  enquiry.status = status;
  enquiry.statusHistory.push({ from, to: status, by: req.user._id, note });

  if (status === 'lost') {
    enquiry.lostReason = lostReason;
    enquiry.lostNote = lostNote;
  }
  if (status === 'hold') enquiry.holdReason = holdReason;

  if (nextAction !== undefined) enquiry.nextAction = nextAction;
  if (nextFollowUpDate !== undefined) enquiry.nextFollowUpDate = nextFollowUpDate;

  // Closing clears the follow-up: there is nothing left to chase.
  if (CLOSED_STATUSES.includes(status)) {
    enquiry.nextAction = undefined;
    enquiry.nextFollowUpDate = undefined;
  }

  assertNextAction(enquiry);
  await enquiry.save();

  publish(EVENTS.ENQUIRY_STATUS_CHANGED, { enquiry, from, to: status, by: req.user });
  const specific = statusEvent(status);
  if (specific) publish(specific, { enquiry, from, by: req.user });

  res.json({ success: true, data: enquiry });
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
