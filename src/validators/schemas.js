import { z } from 'zod';
import { MODULE_KEYS, DEPARTMENT_KEYS, ACCESS_LEVELS } from '../config/modules.js';

const idPattern = /^[0-9a-fA-F]{24}$/;

/**
 * A reference to another record, accepted either as an id or as the populated record itself.
 *
 * The API populates references on the way out so a screen can show a name rather than an id:
 * `assignedTo` leaves as `{ _id, name, email }`. An edit form is seeded from that same
 * record and sends it back untouched, so it arrives as an object — and refusing it means
 * every save from a detail screen fails with a validation error about a field the user never
 * touched. That is exactly what was happening to customers.
 *
 * The alternative is asking every client to un-populate by hand before every write, which
 * they will forget, one form at a time. An API should accept what it emits.
 */
export const objectId = z.preprocess(
  (value) =>
    value && typeof value === 'object' && !Array.isArray(value) && value._id !== undefined
      ? String(value._id)
      : value,
  z.string().regex(idPattern, 'Must be a valid id')
);

export const ROLE_VALUES = ['admin', 'member'];

const moduleGrant = z.object({
  module: z.enum(MODULE_KEYS),
  level: z.enum(ACCESS_LEVELS),
});

export const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  department: z.enum(DEPARTMENT_KEYS).optional(),
  phone: z.string().optional(),
});

/** A user may change their own name and phone; department and access are an admin's call. */
export const updateProfileSchema = z.object({
  name: z.string().min(2).optional(),
  phone: z.string().optional(),
});

export const createUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  role: z.enum(ROLE_VALUES).optional(),
  department: z.enum(DEPARTMENT_KEYS),
  phone: z.string().optional(),
  /** Omit to accept the department's defaults. */
  moduleAccess: z.array(moduleGrant).optional(),
});

export const updateUserSchema = z.object({
  name: z.string().min(2).optional(),
  role: z.enum(ROLE_VALUES).optional(),
  department: z.enum(DEPARTMENT_KEYS).optional(),
  phone: z.string().optional(),
  isActive: z.boolean().optional(),
});

export const setAccessSchema = z.object({
  moduleAccess: z.array(moduleGrant),
});

/* ----------------------------- Workspace ----------------------------- */

const PRIORITIES = ['low', 'normal', 'high'];
const NOTE_COLOURS = ['amber', 'lime', 'sky', 'rose', 'violet'];
const ANNOUNCEMENT_CATEGORIES = ['general', 'production', 'quality', 'people', 'urgent'];

export const todoSchema = z.object({
  title: z.string().min(1, 'Give the task a title').max(200),
  notes: z.string().max(2000).optional(),
  dueDate: z.coerce.date().optional(),
  priority: z.enum(PRIORITIES).optional(),
});

export const todoUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  notes: z.string().max(2000).optional(),
  /** Null clears the date; a value sets it. */
  dueDate: z.union([z.coerce.date(), z.null()]).optional(),
  priority: z.enum(PRIORITIES).optional(),
  completed: z.boolean().optional(),
});

export const noteSchema = z.object({
  content: z.string().min(1, 'Write something first').max(2000),
  colour: z.enum(NOTE_COLOURS).optional(),
  pinned: z.boolean().optional(),
});

export const noteUpdateSchema = z.object({
  content: z.string().min(1).max(2000).optional(),
  colour: z.enum(NOTE_COLOURS).optional(),
  pinned: z.boolean().optional(),
});

export const announcementSchema = z.object({
  title: z.string().min(1, 'Give the announcement a title').max(200),
  body: z.string().min(1, 'Write the announcement').max(4000),
  category: z.enum(ANNOUNCEMENT_CATEGORIES).optional(),
  /** Empty means everyone sees it. */
  departments: z.array(z.enum(DEPARTMENT_KEYS)).optional(),
  pinned: z.boolean().optional(),
  expiresAt: z.coerce.date().optional(),
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
