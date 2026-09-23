import mongoose from 'mongoose';

/**
 * How far one person has read one thread.
 *
 * One row per reader per thread — a cursor, not a flag per message — so "unread" is a comparison
 * of timestamps and the cost is O(readers) rather than O(readers × messages). It is how chat
 * products at any scale do it.
 *
 * **Why this is its own collection and not a field on the query.** The query document runs with
 * optimistic concurrency (`protectWrites`): every update advances its version, and a reply is
 * saved against the version it was loaded at. A cursor stored on the query would mean *opening a
 * thread* advances its version — so somebody else's reply, loaded a moment earlier, fails with
 * "someone else changed this record". Reading would break writing. Read state is also per-person
 * and changes constantly, which is exactly the data that should not share a document with the
 * shared record. Here it has neither problem, and it never touches the query's `updatedAt` —
 * so opening a thread does not push it to the top of everybody else's list.
 *
 * Deliberately not `protectWrites`: a cursor is last-writer-wins by nature, and two tabs moving
 * the same person's cursor is not a conflict anybody needs told about.
 */
const queryReadSchema = new mongoose.Schema(
  {
    query: { type: mongoose.Schema.Types.ObjectId, ref: 'Query', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, required: true },
  },
  { versionKey: false }
);

/* The two reads: my cursors for a page of threads, and everybody's cursor on one thread. */
queryReadSchema.index({ query: 1, user: 1 }, { unique: true });
queryReadSchema.index({ user: 1, query: 1 });

/**
 * Moves one person's cursor forward — never back.
 *
 * `$max` rather than `$set`, so a slow request from a tab opened an hour ago cannot land after a
 * newer one and mark the thread unread again. Upserted in one round trip.
 */
queryReadSchema.statics.advance = function advance(queryId, userId, at = new Date()) {
  return this.updateOne(
    { query: queryId, user: userId },
    { $max: { at } },
    { upsert: true }
  );
};

export default mongoose.model('QueryRead', queryReadSchema);
