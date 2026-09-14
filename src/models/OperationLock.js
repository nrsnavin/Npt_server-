import mongoose from 'mongoose';

// No TTL: expiring a lock while its writer is paused would allow two writers to commit.
// An interrupted operation stays blocked until an operator reconciles it with writers stopped.
const schema = new mongoose.Schema({
  _id: String,
  token: { type: String, required: true },
  acquiredAt: { type: Date, default: Date.now },
  process: String,
}, { versionKey: false });

export default mongoose.model('OperationLock', schema);
