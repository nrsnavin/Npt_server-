import mongoose from 'mongoose';

/**
 * A device somebody allowed to be notified — a phone, a browser. One person, many devices; one
 * device, every account signed in on it [push.controller `subscribePush`].
 */
const pushSubscriptionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /* The same endpoint once per account on the device; looked up by the index below, endpoint first. */
    endpoint: { type: String, required: true, maxlength: 1000 },
    keys: {
      p256dh: { type: String, required: true, maxlength: 200 },
      auth: { type: String, required: true, maxlength: 100 },
    },
    userAgent: { type: String, maxlength: 300 },
  },
  { timestamps: true }
);

pushSubscriptionSchema.index({ endpoint: 1, user: 1 }, { unique: true });

export default mongoose.model('PushSubscription', pushSubscriptionSchema);
