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
  email: z.string().trim().email(),
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
  email: z.string().trim().email(),
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
  /* What it is about, so marketing can find it on their buyer's behalf later [§29]. Optional:
     most tasks somebody types are about nothing in particular and should stay that way. */
  customer: objectId.optional(),
  order: objectId.optional(),
});

export const todoUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  notes: z.string().max(2000).optional(),
  /** Null clears the date; a value sets it. */
  /*
   * Null first. `z.union` takes the first branch that parses and `z.coerce.date()` parses
   * null into one January 1970 — so with the date first this accepted a clear and stored the
   * epoch, leaving a to-do permanently overdue by fifty-six years.
   */
  dueDate: z.union([z.null(), z.coerce.date()]).optional(),
  priority: z.enum(PRIORITIES).optional(),
  completed: z.boolean().optional(),
  /**
   * Taking a job off the department queue, or putting it back.
   *
   * Deliberately a boolean rather than a user id: claiming is something you do to your own
   * hands, and "assign this to Kavitha" is a different power that nobody has asked for. A
   * three-state field — true, false, absent — because putting a job back is as necessary as
   * taking it, and absent has to keep meaning "leave the owner alone".
   */
  claim: z.boolean().optional(),
});

/** Handing a task to another department, with the sentence they will act on [§25]. */
export const todoEscalateSchema = z.object({
  department: z.enum(DEPARTMENT_KEYS),
  reason: z
    .string()
    .trim()
    .min(10, 'Say why it is going to them — they have not seen the record')
    .max(500),
  /**
   * Marking it urgent on the way over, and saying who decided that.
   *
   * `high` only — a handover can raise the priority and never lower it, so there is nothing for
   * `low` or `normal` to mean here. `suggestedBy` is what lets the receiving department's card
   * distinguish "somebody marked this urgent" from "a model thought it looked urgent", which is
   * the difference between a card people act on and one they learn to discount.
   */
  priority: z.literal('high').optional(),
  suggestedBy: z.enum(['model', 'rules']).optional(),
  suggestedReason: z.string().trim().max(400).optional(),
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
  email: z.string().trim().email(),
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

/**
 * Handing one of the review's findings to a department [§25].
 *
 * Only *which* finding — its kind and the department it belongs to. The headline, the detail and
 * the severity are re-derived on the server from the same queries that produced the brief,
 * because a body that could carry its own headline could put any sentence on any department's
 * queue and have it look like the plant's own finding.
 */
export const raiseFindingSchema = z.object({
  kind: z.string().trim().min(1).max(64),
  department: z.enum(DEPARTMENT_KEYS),
});
