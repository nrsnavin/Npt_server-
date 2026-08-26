import mongoose from 'mongoose';

export const NOTE_COLOURS = ['amber', 'lime', 'sky', 'rose', 'violet'];

/** A personal note pinned to the dock. */
const stickyNoteSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    content: { type: String, required: true, trim: true, maxlength: 2000 },
    colour: { type: String, enum: NOTE_COLOURS, default: 'amber' },
    pinned: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export default mongoose.model('StickyNote', stickyNoteSchema);
