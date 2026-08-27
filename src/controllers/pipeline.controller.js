import Product from '../models/Product.js';
import Customer from '../models/Customer.js';
import Lead from '../models/Lead.js';
import Enquiry, { CLOSED_STATUSES } from '../models/Enquiry.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { nextNumber } from '../services/numbering.service.js';
import { ownershipFilter, ownsRecord } from '../services/ownership.service.js';
import { EVENTS, publish, statusEvent } from '../services/events.service.js';
import { normalisePhone } from '../utils/phone.js';
import { listParams, paginated } from '../utils/query.js';

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
  const product = await Product.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });
  if (!product) throw ApiError.notFound('Product not found');
  res.json({ success: true, data: product });
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
  const [enquiries, total] = await Promise.all([
    Enquiry.find(filter)
      .select('number enquiryDate status requirement.modelNumber requirement.quantity estimatedValue')
      .sort('-enquiryDate')
      .limit(TIMELINE_PAGE),
    Enquiry.countDocuments(filter),
  ]);

  res.json({ success: true, data: { customer, timeline: { enquiries, total } } });
});

export const createCustomer = asyncHandler(async (req, res) => {
  const duplicate = await findDuplicateCustomer(req.body);
  if (duplicate) {
    throw ApiError.conflict(
      `${duplicate.name} (${duplicate.code}) already exists with the same ${duplicate.matchedOn}`
    );
  }

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

  // Reassigning an owner is a management decision, not the owner's own.
  if (req.body.assignedTo && req.user.role !== 'admin') {
    throw ApiError.forbidden('Only an administrator can reassign a customer');
  }

  Object.assign(customer, req.body);
  await customer.save();
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
  const lead = await Lead.create({
    ...req.body,
    number: await nextNumber('LEAD'),
    assignedTo: req.body.assignedTo || req.user._id,
  });
  res.status(201).json({ success: true, data: lead });
});

export const updateLead = asyncHandler(async (req, res) => {
  const lead = await Lead.findById(req.params.id);
  if (!lead) throw ApiError.notFound('Lead not found');
  if (!ownsRecord(req.user, lead)) throw ApiError.notFound('Lead not found');
  if (lead.status === 'converted') {
    throw ApiError.badRequest('This lead has been converted and can no longer be edited');
  }

  // Giving a relationship away is management's call, not the holder's — the same rule
  // customers already carry.
  if (req.body.assignedTo && req.user.role !== 'admin') {
    throw ApiError.forbidden('Only an administrator can reassign a lead');
  }

  const { status, disqualifyReason } = req.body;
  if (status === 'disqualified' && !disqualifyReason && !lead.disqualifyReason) {
    throw ApiError.badRequest('Give a reason when disqualifying a lead');
  }
  if (status === 'converted') {
    throw ApiError.badRequest('Use the convert action rather than setting the status directly');
  }

  Object.assign(lead, req.body);
  await lead.save();
  res.json({ success: true, data: lead });
});

export const addLeadActivity = asyncHandler(async (req, res) => {
  const lead = await Lead.findById(req.params.id);
  if (!lead) throw ApiError.notFound('Lead not found');
  if (!ownsRecord(req.user, lead)) throw ApiError.notFound('Lead not found');

  lead.activities.push({ ...req.body, createdBy: req.user._id });
  // Logging contact is itself progress, so a new lead stops being new.
  if (lead.status === 'new') lead.status = 'contacted';
  await lead.save();

  res.status(201).json({ success: true, data: lead });
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

  Object.assign(enquiry, req.body);
  assertNextAction(enquiry);
  await enquiry.save();

  res.json({ success: true, data: enquiry });
});

/**
 * Moves an enquiry to a new stage.
 *
 * Every transition is recorded, and the stages that hand work to another department
 * publish an event. Nothing subscribes yet — sampling picks up `sample_required` in
 * Phase 2 and pricing picks up `pricing_required` in Phase 3.
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
