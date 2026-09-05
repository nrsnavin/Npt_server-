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

    /**
     * What it is attached to — exactly one of these. §27 asks for documents on every record
     * that has them, and each new module adds its own field here rather than a generic
     * `{ type, id }` pair: a real reference can be populated, indexed and reasoned about,
     * and the download route needs to know which model to check the caller against.
     */
    sample: { type: mongoose.Schema.Types.ObjectId, ref: 'Sample', index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', index: true },
    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: 'Enquiry', index: true },
    mould: { type: mongoose.Schema.Types.ObjectId, ref: 'Mould', index: true },
    salesOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder', index: true },

    /** What the file is, in the reader's words: "Buyer drawing", "Signed approval". */
    title: { type: String, trim: true },
  },
  { timestamps: true }
);

export default mongoose.model('Attachment', attachmentSchema);
