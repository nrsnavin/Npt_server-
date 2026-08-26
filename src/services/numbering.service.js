import Counter from '../models/Counter.js';

/**
 * Returns the next document number for a prefix, e.g. nextNumber('ENQ') -> "ENQ-2026-0007".
 * Counters run per calendar year and increment atomically, so two people creating a record
 * at the same moment cannot collide.
 */
export async function nextNumber(prefix, date = new Date()) {
  const year = date.getFullYear();
  const counter = await Counter.findOneAndUpdate(
    { key: `${prefix}-${year}` },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return `${prefix}-${year}-${String(counter.seq).padStart(4, '0')}`;
}
