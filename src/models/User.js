import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { normalisePhone } from '../utils/phone.js';

export const ROLES = ['admin', 'sales', 'production', 'inventory', 'accounts', 'viewer'];

export const DEPARTMENTS = [
  'management',
  'sales',
  'production',
  'stores',
  'accounts',
  'quality',
  'maintenance',
  'hr',
  'other',
];

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
    role: { type: String, enum: ROLES, default: 'viewer' },
    department: { type: String, enum: DEPARTMENTS, default: 'other' },
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
