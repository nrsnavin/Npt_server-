import mongoose from 'mongoose';

export const OTP_CHANNELS = ['email', 'sms'];
export const OTP_PURPOSES = ['login', 'verify_email', 'verify_phone'];

/**
 * A one-time passcode issued to an email address or phone number.
 * Only the bcrypt hash of the code is stored — a database leak must not hand out
 * working codes. Documents expire automatically via the TTL index on expiresAt.
 */
const otpTokenSchema = new mongoose.Schema(
  {
    /** Email (lowercased) or phone in E.164. */
    identifier: { type: String, required: true, index: true },
    channel: { type: String, enum: OTP_CHANNELS, required: true },
    purpose: { type: String, enum: OTP_PURPOSES, default: 'login' },
    codeHash: { type: String, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    consumedAt: { type: Date },
    requestIp: String,
  },
  { timestamps: true }
);

// Mongo purges expired codes on its own, so verification never sees a stale document.
otpTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
otpTokenSchema.index({ identifier: 1, purpose: 1, consumedAt: 1 });

export default mongoose.model('OtpToken', otpTokenSchema);
