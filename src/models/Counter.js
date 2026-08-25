import mongoose from 'mongoose';

/** Backing store for human-readable document numbers (QUO-2026-0001 etc.). */
const counterSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  seq: { type: Number, default: 0 },
});

export default mongoose.model('Counter', counterSchema);
