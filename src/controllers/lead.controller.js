import Lead from '../models/Lead.js';
import Customer from '../models/Customer.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import crudController from './crud.factory.js';

export const leadCrud = crudController(Lead, {
  searchFields: ['company', 'contactName', 'email', 'phone'],
  populate: [
    { path: 'owner', select: 'name email' },
    { path: 'convertedCustomer', select: 'code name' },
  ],
  beforeCreate: (body, req) => ({ ...body, owner: body.owner || req.user._id }),
});

export const addActivity = asyncHandler(async (req, res) => {
  const lead = await Lead.findById(req.params.id);
  if (!lead) throw ApiError.notFound('Lead not found');

  lead.activities.push({ ...req.body, createdBy: req.user._id });
  await lead.save();

  res.status(201).json({ success: true, data: lead });
});

/** Promotes a qualified lead into a customer record and marks the lead won. */
export const convertToCustomer = asyncHandler(async (req, res) => {
  const lead = await Lead.findById(req.params.id);
  if (!lead) throw ApiError.notFound('Lead not found');
  if (lead.convertedCustomer) throw ApiError.conflict('This lead has already been converted');

  const code = (req.body.code || lead.company.slice(0, 4).toUpperCase().replace(/\s/g, '')).toUpperCase();
  if (await Customer.findOne({ code })) {
    throw ApiError.conflict(`Customer code ${code} is already in use`);
  }

  const customer = await Customer.create({
    code,
    name: req.body.name || lead.company,
    segment: req.body.segment || 'distributor',
    email: lead.email,
    phone: lead.phone,
    gstin: req.body.gstin,
    creditLimit: req.body.creditLimit ?? 0,
    paymentTermsDays: req.body.paymentTermsDays ?? 30,
    owner: lead.owner || req.user._id,
    contacts: lead.contactName ? [{ name: lead.contactName, email: lead.email, phone: lead.phone, isPrimary: true }] : [],
    addresses: req.body.addresses || (lead.city ? [{ label: 'Billing', city: lead.city }] : []),
    notes: lead.notes,
  });

  lead.convertedCustomer = customer._id;
  lead.stage = 'won';
  await lead.save();

  res.status(201).json({ success: true, data: { lead, customer } });
});

/** Lead counts and pipeline value per stage, for the CRM funnel view. */
export const pipeline = asyncHandler(async (_req, res) => {
  const data = await Lead.aggregate([
    {
      $group: {
        _id: '$stage',
        count: { $sum: 1 },
        value: { $sum: '$estimatedValue' },
      },
    },
    { $project: { _id: 0, stage: '$_id', count: 1, value: 1 } },
    { $sort: { stage: 1 } },
  ]);

  res.json({ success: true, data });
});
