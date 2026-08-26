import mongoose from 'mongoose';

/**
 * One stored file, and what it belongs to.
 *
 * The record matters as much as the bytes: a photo of a buyer's sample is as confidential as
 * the sample, so the download route resolves the attachment first and checks the caller
 * against whatever it hangs off. A file with no owning record cannot be served at all.
 */
const attachmentSchema = new mongoose.Schema(
  {
    /** The storage key. Random, so the store cannot be walked. */
    key: { type: String, required: true, unique: true },
    filename: { type: String, trim: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },

    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    /** What it is attached to. More of these as later modules gain their own files. */
    sample: { type: mongoose.Schema.Types.ObjectId, ref: 'Sample', index: true },
  },
  { timestamps: true }
);

export default mongoose.model('Attachment', attachmentSchema);
