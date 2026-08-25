import Counter from '../models/Counter.js';

/**
 * Returns the next document number for a prefix, e.g. nextNumber('QUO') -> "QUO-2026-0007".
 * Counters reset per financial period key (calendar year here) and are atomic.
 */
export async function nextNumber(prefix, date = new Date()) {
  const year = date.getFullYear();
  const key = `${prefix}-${year}`;
  const counter = await Counter.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return `${prefix}-${year}-${String(counter.seq).padStart(4, '0')}`;
}
