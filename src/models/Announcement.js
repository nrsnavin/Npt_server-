import mongoose from 'mongoose';
import { DEPARTMENT_KEYS } from '../config/modules.js';

export const ANNOUNCEMENT_CATEGORIES = ['general', 'production', 'quality', 'people', 'urgent'];

/**
 * An organisation-wide notice. Written by whoever holds write on the announcements
 * module; read by everyone it is addressed to.
 */
const announcementSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, required: true, trim: true, maxlength: 4000 },
    category: { type: String, enum: ANNOUNCEMENT_CATEGORIES, default: 'general' },
    /** Empty means everybody; otherwise only these departments see it. */
    departments: [{ type: String, enum: DEPARTMENT_KEYS }],
    pinned: { type: Boolean, default: false },
    publishedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    /** Who has opened it, so the dock can show an unread count. */
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

announcementSchema.index({ publishedAt: -1 });

export default mongoose.model('Announcement', announcementSchema);
