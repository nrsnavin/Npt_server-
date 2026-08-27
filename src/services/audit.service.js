import AuditLog from '../models/AuditLog.js';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import Enquiry from '../models/Enquiry.js';
import Lead from '../models/Lead.js';
import Product from '../models/Product.js';

/**
 * Diffing a record before and after a save, and writing down what moved.
 *
 * Three decisions shape what ends up in the log.
 *
 * **Only what changed.** A row per save listing the fields that actually moved, not a copy
 * of the record. Snapshots are easier to write and answer the wrong question: the reader
 * wants "who shortened the delivery date", and finding that between two copies is work they
 * should not have to do.
 *
 * **Noise is excluded by name.** `updatedAt` moves on every save by definition, and the
 * status histories are already the process's own record — logging them here would bury the
 * one line somebody is looking for under the lines they already have elsewhere.
 *
 * **A failure here never fails the write.** Losing a log row is bad; refusing somebody's
 * edit because the audit collection had a bad moment is worse, and turns a log nobody reads
 * into an outage everybody notices.
 */

/**
 * Fields that would fill the log without telling anybody anything.
 *
 * `statusHistory` and `activities` are their own record of the same events, and both are
 * arrays that change shape rather than value — a diff of them reads as noise. `escalationLevel`
 * is written by the sweep, not by a person.
 */
const IGNORED = new Set([
  '_id', '__v', 'createdAt', 'updatedAt',
  'statusHistory', 'activities', 'contacts', 'readBy',
  'escalationLevel',
]);

/** How deep to walk into a sub-document before treating it as one value. */
const MAX_DEPTH = 2;

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);

/**
 * A comparable form of a value.
 *
 * ObjectIds, dates and populated references all need flattening or `'6a8f…' !== '6a8f…'` for
 * reasons that have nothing to do with the field changing.
 */
function comparable(value) {
  /*
   * Absent, null and empty are all "nothing", and reading them as three different values is
   * what filled every history with lines saying "Notes: nothing → nothing". A form posts an
   * empty string for every optional box the user left alone, and against a field that was
   * never set that is a change from undefined to '' — true of the JSON, and not a thing that
   * happened. Clearing a field that did hold something still reads as a change, because the
   * other side is not nothing.
   */
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(comparable);
  if (isPlainObject(value)) {
    // A populated reference is the record it points at; the id is what changed or did not.
    if (value._id !== undefined) return String(value._id);
    return value;
  }
  if (typeof value === 'object') return String(value);
  return value;
}

/** Every field that differs, as dot paths a person would recognise from the form. */
export function diff(before = {}, after = {}, prefix = '', depth = 0) {
  const changes = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);

  for (const key of keys) {
    if (!prefix && IGNORED.has(key)) continue;

    const path = prefix ? `${prefix}.${key}` : key;
    const from = before?.[key];
    const to = after?.[key];

    /*
     * Walk into a sub-document when *either* side is one. Requiring both meant that setting
     * a group of fields that had never been set — turning notifications on for a customer
     * who had none recorded — fell through to the scalar branch and logged the whole object
     * as JSON: `Notifications: nothing → {"whatsapp":true,"email":true}`. The reader wants
     * "Notifications › WhatsApp: nothing → yes", which is what the recursion gives.
     */
    const nested =
      (isPlainObject(from) && from._id === undefined) || (isPlainObject(to) && to._id === undefined);

    if (depth < MAX_DEPTH && nested) {
      changes.push(...diff(isPlainObject(from) ? from : {}, isPlainObject(to) ? to : {}, path, depth + 1));
      continue;
    }

    const a = comparable(from);
    const b = comparable(to);
    if (JSON.stringify(a) === JSON.stringify(b)) continue;

    changes.push({ field: path, from: a, to: b });
  }

  return changes;
}

/** A plain object of the record as it stands, safe to hold across a mutation. */
export const snapshot = (doc) => (doc?.toObject ? doc.toObject({ depopulate: true }) : { ...doc });

/**
 * Writes what changed between two snapshots.
 *
 * Returns the changes it recorded so a caller can assert on them; returns an empty list when
 * nothing moved, and writes nothing — a save that changed no field is not history.
 */
export async function recordChange({ model, doc, before, by, action = 'updated', note, label }) {
  try {
    const after = snapshot(doc);

    /*
     * No `before` means "there is nothing to diff" — the change is the note, not a field.
     * Passing `{}` for it used to mean the same thing by accident, and read as a record that
     * had just come into existence: attaching a single document wrote twenty lines saying
     * every field on the customer had changed from nothing, burying the one line that was
     * true. The two cases are told apart explicitly now.
     */
    const changes = action === 'updated' && before ? diff(before, after) : [];

    // A save that moved no field and says nothing is not history.
    if (action === 'updated' && !changes.length && !note) return [];

    await AuditLog.create({
      model,
      recordId: doc._id,
      label: label ?? after.number ?? after.name ?? after.code ?? after.modelCode ?? undefined,
      action,
      changes,
      by: by?._id || by || undefined,
      note,
    });

    return changes;
  } catch (error) {
    // Never fail the write this describes.
    console.error(`[audit] could not record a ${action} on ${model}:`, error.message);
    return [];
  }
}

/**
 * Fields whose value is a reference, and how to say which record it points at.
 *
 * Keyed on the last segment of the dot path, so `requirement.product` resolves the same way
 * `product` does. A field that is not here keeps its raw value — an unrecognised id is at
 * least honest, where a guess would not be.
 */
const REFERENCED = {
  assignedTo: { model: User, label: (row) => row.name },
  requestedBy: { model: User, label: (row) => row.name },
  createdBy: { model: User, label: (row) => row.name },
  uploadedBy: { model: User, label: (row) => row.name },
  customer: { model: Customer, label: (row) => (row.code ? `${row.name} (${row.code})` : row.name) },
  enquiry: { model: Enquiry, label: (row) => row.number },
  lead: { model: Lead, label: (row) => row.company },
  product: { model: Product, label: (row) => row.modelCode },
};

const OBJECT_ID = /^[0-9a-f]{24}$/i;

/**
 * Names, in place of the ids a diff records.
 *
 * A change of owner is stored as one 24-character id replacing another, which is accurate
 * and unreadable — the reader wants "Priya → Arun". The resolution happens on the way out
 * rather than on the way in, deliberately: the log keeps the id, because names change, and a
 * trail that had recorded the name at the time would disagree with itself after a marriage.
 *
 * An id that no longer resolves is left as it is. Somebody deleted the record it named, and
 * saying so plainly beats blanking the field and pretending the change never mentioned one.
 */
async function withNames(rows) {
  const wanted = new Map(); // model -> Set of ids

  const fieldOf = (path) => REFERENCED[path.split('.').pop()];

  for (const row of rows) {
    for (const change of row.changes || []) {
      const reference = fieldOf(change.field);
      if (!reference) continue;
      for (const value of [change.from, change.to]) {
        if (typeof value !== 'string' || !OBJECT_ID.test(value)) continue;
        if (!wanted.has(reference.model)) wanted.set(reference.model, new Set());
        wanted.get(reference.model).add(value);
      }
    }
  }

  if (!wanted.size) return rows;

  const names = new Map();
  await Promise.all(
    [...wanted].map(async ([model, ids]) => {
      const found = await model.find({ _id: { $in: [...ids] } }).lean();
      // Every field pointing at one model labels it the same way, so the first entry serves.
      const { label } = Object.values(REFERENCED).find((entry) => entry.model === model);
      for (const record of found) names.set(String(record._id), label(record) || undefined);
    })
  );

  /*
   * Plain objects from here on. These are read-only rows on their way to a screen, and
   * rewriting a field on a hydrated document would have Mongoose cast the name back through
   * the Mixed path for no reason.
   */
  return rows.map((row) => {
    const plain = row.toObject ? row.toObject() : row;
    plain.changes = (plain.changes || []).map((change) => {
      if (!fieldOf(change.field)) return change;
      const named = (value) =>
        typeof value === 'string' && names.has(value) ? names.get(value) : value;
      return { ...change, from: named(change.from), to: named(change.to) };
    });
    return plain;
  });
}

/** One record's history, newest first, with references read as names rather than ids. */
export async function historyFor(model, recordId, { limit = 50 } = {}) {
  const rows = await AuditLog.find({ model, recordId })
    .populate('by', 'name')
    .sort({ at: -1 })
    .limit(limit);

  return withNames(rows);
}
