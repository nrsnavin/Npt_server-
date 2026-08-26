import { z } from 'zod';
import { HANGER_CATEGORIES, MATERIALS, HOOK_TYPES } from '../models/Product.js';
import { CUSTOMER_TYPES, RATINGS, CUSTOMER_SOURCES } from '../models/Customer.js';
import { LEAD_STATUSES, DISQUALIFY_REASONS } from '../models/Lead.js';
import { ENQUIRY_STATUSES, LOST_REASONS } from '../models/Enquiry.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

/* -------------------------------- Products -------------------------------- */

export const productSchema = z.object({
  modelCode: z.string().min(2).max(40),
  name: z.string().min(2).max(120),
  category: z.enum(HANGER_CATEGORIES),
  sizeMm: z.number().positive(),
  material: z.enum(MATERIALS),
  standardWeightGrams: z.number().nonnegative().optional(),
  availableColours: z.array(z.string()).optional(),
  hookType: z.enum(HOOK_TYPES).optional(),
  photoUrl: z.string().optional(),
  mouldAvailable: z.boolean().optional(),
  mouldNumber: z.string().optional(),
  standardPrice: z.number().nonnegative().optional(),
  moq: z.number().nonnegative().optional(),
  packingQty: z.number().nonnegative().optional(),
  isActive: z.boolean().optional(),
  notes: z.string().optional(),
});

export const productUpdateSchema = productSchema.partial().omit({ modelCode: true });

/* -------------------------------- Customers -------------------------------- */

const contactSchema = z.object({
  name: z.string().min(1),
  designation: z.string().optional(),
  mobile: z.string().optional(),
  whatsapp: z.string().optional(),
  email: z.string().email().optional(),
  isPrimary: z.boolean().optional(),
});

export const customerSchema = z.object({
  name: z.string().min(2).max(160),
  customerType: z.enum(CUSTOMER_TYPES).optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  mobile: z.string().optional(),
  whatsapp: z.string().optional(),
  email: z.string().email().optional(),
  gstin: z.string().optional(),
  contacts: z.array(contactSchema).optional(),
  assignedTo: objectId.optional(),
  creditTermsDays: z.number().nonnegative().optional(),
  paymentTerms: z.string().optional(),
  rating: z.enum(RATINGS).optional(),
  source: z.enum(CUSTOMER_SOURCES).optional(),
  status: z.enum(['active', 'on_hold', 'inactive']).optional(),
  notes: z.string().optional(),
});

export const customerUpdateSchema = customerSchema.partial();

/* ---------------------------------- Leads ---------------------------------- */

export const leadSchema = z.object({
  company: z.string().min(2).max(160),
  contactName: z.string().optional(),
  designation: z.string().optional(),
  mobile: z.string().optional(),
  whatsapp: z.string().optional(),
  email: z.string().email().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  source: z.enum(CUSTOMER_SOURCES).optional(),
  productInterest: z.string().optional(),
  estimatedQuantity: z.number().nonnegative().optional(),
  estimatedValue: z.number().nonnegative().optional(),
  assignedTo: objectId.optional(),
  nextAction: z.string().optional(),
  nextFollowUpDate: z.coerce.date().optional(),
  notes: z.string().optional(),
  visitingCardUrl: z.string().optional(),
});

export const leadUpdateSchema = leadSchema.partial().extend({
  status: z.enum(LEAD_STATUSES).optional(),
  disqualifyReason: z.enum(DISQUALIFY_REASONS).optional(),
  disqualifyNote: z.string().optional(),
});

export const leadActivitySchema = z.object({
  type: z.enum(['call', 'email', 'whatsapp', 'meeting', 'visit', 'note']).optional(),
  summary: z.string().min(1).max(1000),
  occurredAt: z.coerce.date().optional(),
});

/* -------------------------------- Enquiries -------------------------------- */

const requirementSchema = z.object({
  modelNumber: z.string().optional(),
  category: z.enum(HANGER_CATEGORIES).optional(),
  sizeMm: z.number().nonnegative().optional(),
  material: z.enum(MATERIALS).optional(),
  colour: z.string().optional(),
  quantity: z.number().positive('Quantity is required'),
  printing: z.string().optional(),
  packing: z.string().optional(),
});

const enquiryCore = {
  product: objectId.optional(),
  isNewDevelopment: z.boolean().optional(),
  requirement: requirementSchema,
  targetPrice: z.number().nonnegative().optional(),
  requiredDeliveryDate: z.coerce.date().optional(),
  referenceImageUrl: z.string().optional(),
  remarks: z.string().optional(),
  nextAction: z.string().optional(),
  nextFollowUpDate: z.coerce.date().optional(),
  estimatedValue: z.number().nonnegative().optional(),
  probability: z.number().min(0).max(100).optional(),
  source: z.enum(CUSTOMER_SOURCES).optional(),
};

export const enquirySchema = z.object({
  customer: objectId,
  assignedTo: objectId.optional(),
  ...enquiryCore,
});

export const enquiryUpdateSchema = z
  .object({ ...enquiryCore, requirement: requirementSchema.optional() })
  .partial();

/** One conversation, several models — each becomes its own enquiry under a group. */
export const enquiryGroupSchema = z.object({
  customer: objectId,
  shared: z
    .object({
      requiredDeliveryDate: z.coerce.date().optional(),
      nextAction: z.string().optional(),
      nextFollowUpDate: z.coerce.date().optional(),
      source: z.enum(CUSTOMER_SOURCES).optional(),
      remarks: z.string().optional(),
    })
    .optional(),
  enquiries: z.array(z.object(enquiryCore)).min(1, 'Add at least one model'),
});

export const enquiryStatusSchema = z.object({
  status: z.enum(ENQUIRY_STATUSES),
  note: z.string().optional(),
  lostReason: z.enum(LOST_REASONS).optional(),
  lostNote: z.string().optional(),
  holdReason: z.string().optional(),
  nextAction: z.string().optional(),
  nextFollowUpDate: z.coerce.date().optional(),
});

export const promoteProductSchema = productSchema.partial().required({ modelCode: true, name: true });

/* -------------------------------- Conversion -------------------------------- */

export const convertLeadSchema = z.object({
  customer: customerSchema.partial().optional(),
  enquiry: z.object(enquiryCore).optional(),
});
