import { cacheDelete } from '../services/cache.service.js';
import { protectWrites } from '../utils/concurrency.js';
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
    /** Sessions issued before this are refused; see the save hook. */
    passwordChangedAt: { type: Date },
  },
  { timestamps: true }
);

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password') || !this.password) return next();
  this.password = await bcrypt.hash(this.password, 10);
  /*
   * Every session issued before this moment ends. People change a password because they think
   * somebody else has it, and a seven-day token taken before the change kept working after it.
   * Whole seconds, because that is what a token's `iat` is — a session issued in the same
   * second as the change, which is the one handed back to the person making it, still passes.
   */
  if (!this.isNew) this.passwordChangedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  return next();
});

/** True for a token issued before the password last changed. */
userSchema.methods.issuedBeforePasswordChange = function issuedBeforePasswordChange(issuedAt) {
  return Boolean(this.passwordChangedAt) && issuedAt * 1000 < this.passwordChangedAt.getTime();
};

userSchema.methods.comparePassword = function comparePassword(candidate) {
  if (!this.password) return false;
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.hasPassword = function hasPassword() {
  return Boolean(this.password);
};

/*
 * The signed-in person's record is cached for a minute (middleware/auth.js). Any change to a user
 * — deactivation, a new password, different module access — drops that copy at once, so the
 * next request reads the change rather than waiting out the minute.
 */
export const userCacheKey = (id) => `auth:user:${id}`;
const forget = (ids) => {
  const keys = [...new Set(ids.filter(Boolean).map(String))].map(userCacheKey);
  if (!keys.length) return;
  cacheDelete(...keys).catch(() => {});
  /*
   * And again a moment later: a request that read the old record just before this change can
   * write that stale copy back after the first delete. The second one clears it.
   */
  setTimeout(() => cacheDelete(...keys).catch(() => {}), 1500).unref();
};
const idsIn = (filter = {}) => {
  const id = filter._id;
  if (!id) return [];
  if (id.$in) return id.$in;
  return typeof id === 'object' && !id._bsontype && !(id instanceof mongoose.Types.ObjectId) ? [] : [id];
};
userSchema.post('save', (doc) => forget([doc._id]));
userSchema.post(['findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace'], function forgetFound(doc) {
  forget([doc?._id, ...idsIn(this.getFilter())]);
});
userSchema.post(['updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'replaceOne'], function forgetFiltered() {
  forget(idsIn(this.getFilter()));
});

protectWrites(userSchema);
export default mongoose.model('User', userSchema);
