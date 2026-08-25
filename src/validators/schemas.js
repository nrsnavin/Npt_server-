import { z } from 'zod';

export const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

export const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  role: z.enum(['admin', 'sales', 'production', 'inventory', 'accounts', 'viewer']).optional(),
  phone: z.string().optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const changePasswordSchema = z.object({
  // Optional so an OTP-only account can set its first password.
  currentPassword: z.string().optional(),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
});

/** An email address or a phone number in any common local or international format. */
export const requestOtpSchema = z.object({
  identifier: z.string().min(3, 'Enter an email address or phone number'),
});

export const verifyOtpSchema = z.object({
  identifier: z.string().min(3, 'Enter an email address or phone number'),
  code: z
    .string()
    .regex(/^\d{4,8}$/, 'Enter the numeric code from your email or SMS'),
});

export const requestVerificationSchema = z.object({
  target: z.enum(['email', 'phone']).default('email'),
});

export const confirmVerificationSchema = z.object({
  target: z.enum(['email', 'phone']).default('email'),
  code: z.string().regex(/^\d{4,8}$/, 'Enter the numeric code'),
});

const salesLineSchema = z.object({
  product: objectId,
  description: z.string().optional(),
  quantity: z.number().positive(),
  unitPrice: z.number().nonnegative(),
  discountPercent: z.number().min(0).max(100).optional(),
  taxPercent: z.number().min(0).optional(),
});

export const quotationSchema = z.object({
  customer: objectId,
  lead: objectId.optional(),
  quotationDate: z.coerce.date().optional(),
  validUntil: z.coerce.date().optional(),
  lines: z.array(salesLineSchema).min(1, 'Add at least one line'),
  status: z.enum(['draft', 'sent', 'accepted', 'rejected', 'expired', 'converted']).optional(),
  terms: z.string().optional(),
  notes: z.string().optional(),
});

export const salesOrderSchema = z.object({
  customer: objectId,
  quotation: objectId.optional(),
  customerPoNumber: z.string().optional(),
  orderDate: z.coerce.date().optional(),
  deliveryDate: z.coerce.date().optional(),
  lines: z.array(salesLineSchema).min(1, 'Add at least one line'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  shippingAddress: z.string().optional(),
  notes: z.string().optional(),
});

export const purchaseOrderSchema = z.object({
  supplier: objectId,
  orderDate: z.coerce.date().optional(),
  expectedDate: z.coerce.date().optional(),
  warehouse: objectId.optional(),
  lines: z
    .array(
      z.object({
        material: objectId,
        description: z.string().optional(),
        quantity: z.number().positive(),
        unitPrice: z.number().nonnegative(),
        discountPercent: z.number().min(0).max(100).optional(),
        taxPercent: z.number().min(0).optional(),
      })
    )
    .min(1, 'Add at least one line'),
  status: z.enum(['draft', 'sent', 'partially_received', 'received', 'cancelled']).optional(),
  notes: z.string().optional(),
});

export const productionOrderSchema = z.object({
  product: objectId,
  bom: objectId.optional(),
  salesOrder: objectId.optional(),
  quantityPlanned: z.number().int().positive(),
  machine: z.string().optional(),
  shift: z.enum(['A', 'B', 'C']).optional(),
  plannedStart: z.coerce.date().optional(),
  plannedEnd: z.coerce.date().optional(),
  supervisor: objectId.optional(),
  notes: z.string().optional(),
});

export const stockAdjustmentSchema = z.object({
  itemType: z.enum(['Material', 'Product']),
  item: objectId,
  warehouse: objectId,
  quantity: z.number().refine((value) => value !== 0, 'Quantity cannot be zero'),
  remarks: z.string().optional(),
});

export const bomSchema = z.object({
  product: objectId,
  version: z.number().int().positive().optional(),
  isActive: z.boolean().optional(),
  components: z
    .array(
      z.object({
        material: objectId,
        quantityPerUnit: z.number().positive(),
        uom: z.string().min(1),
        scrapPercent: z.number().min(0).max(100).optional(),
      })
    )
    .min(1, 'A BOM needs at least one component'),
  machine: z.string().optional(),
  labourMinutesPerUnit: z.number().nonnegative().optional(),
  overheadPerUnit: z.number().nonnegative().optional(),
  notes: z.string().optional(),
});
