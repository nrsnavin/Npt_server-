import mongoose from 'mongoose';

/**
 * A floor reading sent over WhatsApp by a production colleague — "IM-2 23400 rej 40 flash" —
 * read into a run log and held until they answer YES [floorMessage.service]. Nothing reaches
 * the run before that answer.
 */
export const FLOOR_MESSAGE_STATUSES = ['pending', 'applied', 'cancelled', 'expired', 'failed'];

const floorMessageSchema = new mongoose.Schema(
  {
    from: { type: String, required: true, index: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    providerId: { type: String, sparse: true, unique: true },
    body: { type: String, trim: true, maxlength: 1000 },
    machine: { type: mongoose.Schema.Types.ObjectId, ref: 'Machine' },
    run: { type: mongoose.Schema.Types.ObjectId, ref: 'MouldRun' },
    /* What was read, in the run log's own shape [validators runLogSchema]. */
    log: {
      counter: Number,
      rejects: { pieces: Number, reason: String },
      downtime: { minutes: Number, reason: String },
    },
    summary: { type: String, trim: true, maxlength: 500 },
    status: { type: String, enum: FLOOR_MESSAGE_STATUSES, default: 'pending', index: true },
    error: { type: String, trim: true, maxlength: 300 },
    decidedAt: Date,
  },
  { timestamps: true }
);

floorMessageSchema.index({ sender: 1, status: 1, createdAt: -1 });

export default mongoose.model('FloorMessage', floorMessageSchema);
