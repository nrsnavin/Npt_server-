import mongoose from 'mongoose';

/*
 * No TTL index: expiring a lock on the clock alone would hand it to a second writer while the
 * first is still working. Instead the holder renews `renewedAt` every few seconds while it holds
 * the lock [services/operationLock.service.js], and only a lock nobody has renewed for longer than
 * a transaction may live is taken over — its holder is gone (a crash, a deploy, a killed process),
 * and any transaction it had open has already been aborted by the database.
 */
const schema = new mongoose.Schema({
  _id: String,
  token: { type: String, required: true },
  acquiredAt: { type: Date, default: Date.now },
  renewedAt: { type: Date, default: Date.now },
  process: String,
}, { versionKey: false });

export default mongoose.model('OperationLock', schema);
