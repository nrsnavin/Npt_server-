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

export const vehicleSchema = z.object({
  number: z.string().trim().min(4, 'The vehicle number, as on the plate').max(20),
  kind: text(60),
  capacityCartons: z.number().int().min(0).max(5000).nullable().optional(),
  driverName: text(80),
  driverPhone: text(20),
  notes: text(500),
  active: z.boolean().optional(),
  expectedUpdatedAt: z.string().optional(),
});
export const vehicleUpdateSchema = vehicleSchema.partial();

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A day as YYYY-MM-DD');
const cartonsByTask = z.record(z.string(), z.number().int().min(0).max(5000).nullable()).optional();

export const tripSchema = z.object({
  tasks: z.array(objectId).min(1, 'Pick at least one request').max(60),
  mode: z.enum(DELIVERY_MODES),
  date: day.optional(),
  departAt: text(20),
  vehicle: objectId.optional().or(z.literal('')).transform((value) => value || undefined),
  transporter: objectId.optional().or(z.literal('')).transform((value) => value || undefined),
  driverName: text(80),
  driverPhone: text(20),
  note: text(500),
  cartons: cartonsByTask,
});

export const tripUpdateSchema = z.object({
  date: day.optional(),
  departAt: text(20),
  mode: z.enum(DELIVERY_MODES).optional(),
  vehicle: objectId.nullable().optional().or(z.literal('')),
  transporter: objectId.nullable().optional().or(z.literal('')),
  driverName: text(80),
  driverPhone: text(20),
  note: text(500),
  stops: z.array(z.object({ id: objectId, cartons: z.number().int().min(0).max(5000).nullable().optional() })).min(1).max(60).optional(),
  addTasks: z.array(objectId).max(60).optional(),
  cartons: cartonsByTask,
  expectedUpdatedAt: z.string().optional(),
});

export const tripStatusSchema = z.object({
  status: z.enum(['planned', 'loading', 'left', 'completed', 'cancelled']),
  note: text(500),
});

export const stopStatusSchema = z.object({
  status: z.enum(['delivered', 'not_delivered']),
  note: text(500),
});

export const tellBuyersSchema = z.object({ force: z.boolean().optional() });
