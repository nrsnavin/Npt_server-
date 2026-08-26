import mongoose from 'mongoose';

export const LOG_KINDS = ['note', 'photo'];

const commentSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, required: true, trim: true, maxlength: 2000 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

/**
 * The working record of a sample: what was tried, what it looked like, and what people said
 * about it [BLUEPRINT §41.6 by analogy — photos and artwork stay on the record rather than
 * in someone's personal chat].
 *
 * An entry is a note or a photo, and either can be commented on. That is the point: the
 * bench posts a photo of the first shot, marketing says the shoulder looks wrong, the bench
 * replies with another photo — and the whole exchange sits on the sample instead of in a
 * WhatsApp thread nobody else can see.
 *
 * Separate from `statusHistory`, which records what the process did. This records what the
 * people did, and the two answer different questions.
 */
const sampleLogSchema = new mongoose.Schema(
  {
    sample: { type: mongoose.Schema.Types.ObjectId, ref: 'Sample', required: true, index: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    kind: { type: String, enum: LOG_KINDS, default: 'note' },
    /** The note, or the caption on a photo. A photo may carry none. */
    body: { type: String, trim: true, maxlength: 4000 },
    attachment: { type: mongoose.Schema.Types.ObjectId, ref: 'Attachment' },

    comments: [commentSchema],
  },
  { timestamps: true }
);

sampleLogSchema.index({ sample: 1, createdAt: -1 });

export default mongoose.model('SampleLog', sampleLogSchema);
