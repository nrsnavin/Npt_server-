import mongoose from 'mongoose';

/**
 * A link that sets a password: the welcome invitation, or a forgotten-password reset.
 *
 * Only the SHA-256 of the token is stored. The token itself exists in one place, the email, so a
 * copy of this collection — a backup, a support dump — cannot be replayed as somebody's link.
 * Single use: `usedAt` is set in the same update that finds it, so two presses of one link
 * cannot both set a password. Mongo removes expired rows on its own via the TTL index.
 */
const passwordTokenSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    purpose: { type: String, enum: ['invite', 'reset'], required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date },
    /** Who sent an invitation; empty for a reset the person asked for themselves. */
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

passwordTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('PasswordToken', passwordTokenSchema);
