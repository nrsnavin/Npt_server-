import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { normalisePhone } from '../utils/phone.js';
import { DEPARTMENT_KEYS, MODULE_KEYS, ACCESS_LEVELS } from '../config/modules.js';

/**
 * Only two roles are needed once access is granted per module: an admin who may do
 * anything and administer others, and a member whose access is exactly their grants.
 */
export const ROLES = ['admin', 'member'];

const moduleAccessSchema = new mongoose.Schema(
  {
    module: { type: String, enum: MODULE_KEYS, required: true },
    level: { type: String, enum: ACCESS_LEVELS, required: true },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    /** Optional: an account may be OTP-only and never set a password. */
    password: { type: String, minlength: 8, select: false },
    role: { type: String, enum: ROLES, default: 'member' },
    department: { type: String, enum: DEPARTMENT_KEYS },
    /**
     * Explicit per-module grants. Absent means no access. Stored on the user rather than
     * derived from the department, so access is auditable and changing someone's
     * department never silently changes what they can already do.
     */
    moduleAccess: { type: [moduleAccessSchema], default: [] },
    /** Stored in E.164 so an OTP request can look it up unambiguously. */
    phone: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
      set: (value) => normalisePhone(value) || undefined,
    },
    emailVerified: { type: Boolean, default: false },
    phoneVerified: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    lastLoginAt: { type: Date },
    lastLoginMethod: { type: String, enum: ['password', 'email_otp', 'sms_otp'] },
  },
  { timestamps: true }
);

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password') || !this.password) return next();
  this.password = await bcrypt.hash(this.password, 10);
  return next();
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  if (!this.password) return false;
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.hasPassword = function hasPassword() {
  return Boolean(this.password);
};

export default mongoose.model('User', userSchema);
