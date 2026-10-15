import mongoose from 'mongoose';

/**
 * Plant-wide settings that Admin changes from the app, one document per key. The first is
 * `security`: whether everyone must set a device PIN, and how long the app may sit idle before
 * it locks [controllers/settings.controller.js].
 */
const settingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export default mongoose.model('Setting', settingSchema);
