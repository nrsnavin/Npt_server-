import { z } from 'zod';
import { MODULE_KEYS, DEPARTMENT_KEYS, ACCESS_LEVELS } from '../config/modules.js';

export const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

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
