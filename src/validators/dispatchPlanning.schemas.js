import { z } from 'zod';
import { DELIVERY_MODES } from '../services/dispatchPlanning.service.js';
import { WEEKDAYS } from '../models/DeliveryRoute.js';

const objectId = z.string().regex(/^[0-9a-f]{24}$/i, 'Not a valid id');
const text = (max) => z.string().trim().max(max).optional().or(z.literal(''));
const clearableId = objectId.nullable().optional().or(z.literal(''));

export const transporterSchema = z.object({
  name: z.string().trim().min(2, 'Give the transporter a name').max(120),
  bookingOffice: text(200),
  phone: text(20),
  serves: text(300),
  notes: text(500),
  active: z.boolean().optional(),
  expectedUpdatedAt: z.string().optional(),
});
export const transporterUpdateSchema = transporterSchema.partial();

export const deliveryRouteSchema = z.object({
  name: z.string().trim().min(2, 'Give the route a name').max(120),
  areas: text(500),
  days: z.array(z.enum(WEEKDAYS)).max(7).optional(),
  notes: text(500),
  active: z.boolean().optional(),
  expectedUpdatedAt: z.string().optional(),
});
export const deliveryRouteUpdateSchema = deliveryRouteSchema.partial();

export const scheduleGroupSchema = z.object({
  tasks: z.array(objectId).min(1, 'Pick at least one request').max(100),
  status: z.string().trim().min(1).max(40),
  note: text(2000),
});

export const customerDeliverySchema = z.object({
  customers: z.array(objectId).min(1, 'Pick at least one buyer').max(200),
  deliveryMode: z.enum(DELIVERY_MODES).nullable().optional().or(z.literal('')),
  usualTransporter: clearableId,
  deliveryRoute: clearableId,
  area: text(120),
  landmark: text(160),
  pincode: z.string().trim().regex(/^(\d{6})?$/, 'A PIN code is six digits').optional(),
});
