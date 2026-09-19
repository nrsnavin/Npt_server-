import mongoose from 'mongoose';
import { DEPARTMENT_KEYS } from '../config/modules.js';
import { protectWrites } from '../utils/concurrency.js';

/**
 * A question about a customer, and everybody who has been pulled into answering it.
 *
 * **Not the same thing as an `OrderQuery`, and the difference is the shape of the conversation.**
 * An order query is one question put to one department with a clock on it: "when will line 2 be
 * ready", escalating if production does not answer. It is a transaction. This is a *thread* — it
 * names a buyer rather than an order, it accumulates people rather than moving between them, and
 * it has no single department that owes an answer. "The buyer is disputing the September
 * invoice" needs accounts, then despatch for the POD, then marketing to ring them, and none of
 * those is a hand-over: all three stay in it, because the third one's answer depends on the
 * second's.
 *
 * So the unit here is the **participant list**, and the thing that makes it work is that anybody
 * already in the thread can pull somebody else in. The alternative is the thread that dies
 * because the only person who could have answered was never told it existed, which is the
 * WhatsApp group this replaces.
 *
 * Three decisions worth stating, because each had a defensible alternative:
 *
 * **A participant is a department, optionally narrowed to one person.** Addressed to a
 * department, a question survives leave and shift changes — that is the lesson `OrderQuery`
 * already learned. But "ask Ramesh, he was there when the mould was cut" is a real and common
 * need, and a system that cannot express it gets worked around with a phone call that leaves no
 * record. So the entry carries both: a department, and a person within it when somebody means a
 * person.
 *
 * **Replies and notes are different kinds.** A reply moves the thread on — it answers something,
 * and it is what makes a query `answered`. A note is an observation that does not: "rang them,
 * no answer", "the LR is in the file". Collapsing the two means a thread with nine entries and
 * no way to see whether anybody actually answered, which is the state the plant is in now.
 *
 * **Closing is the asker's, never the answerer's.** The same rule `OrderQuery` holds and for the
 * same reason: an answer that did not answer is the common case, and somebody marking their own
 * work is how a queue empties without anything being resolved.
 */

export const QUERY_STATUSES = ['open', 'answered', 'closed'];

/**
 * One person or one department, and who put them in the room.
 *
 * `addedBy` and `addedAt` are not decoration. Being a participant grants sight of the buyer —
 * see `sharedWith` on the customer — so this list *is* an access grant, and an access grant
 * nobody can account for is the kind that gets quietly wide. Every row says who opened the door
 * and when.
 */
const participantSchema = new mongoose.Schema(
  {
    /** Always set. A person is reached through their department, never instead of it. */
    department: { type: String, enum: DEPARTMENT_KEYS, required: true },

    /**
     * One person, when somebody means one person.
     *
     * Absent means the whole department is in it, which is the usual case and the one that
     * survives somebody being on leave. Naming a person *narrows*: it does not also include
     * their colleagues, or "ask Ramesh specifically" would silently be "ask production", and
     * the distinction the field exists for would be lost the moment it was used.
     */
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

/**
 * Something somebody said, and whether it was an answer.
 *
 * One collection rather than `replies` and `notes` side by side: they are read in one column in
 * the order they happened, and two arrays would have to be merged on every read and would
 * disagree about ordering the moment two landed in the same second.
 */
const messageSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['reply', 'note'], default: 'reply' },
    body: { type: String, required: true, trim: true, maxlength: 4000 },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

const querySchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },

    /**
     * The buyer it is about, and the only required link.
     *
     * Required because it is what the thread is *for*: every question this replaces starts
     * "about SCM Garments…", it is how the thread is found again six weeks later, and it is what
     * decides who may see it. A query about nothing in particular is a note to self, and the
     * to-do list already exists for those.
     */
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },

    subject: { type: String, required: true, trim: true, maxlength: 200 },
    question: { type: String, required: true, trim: true, maxlength: 4000 },

    raisedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    participants: { type: [participantSchema], default: () => [] },
    messages: { type: [messageSchema], default: () => [] },

    status: { type: String, enum: QUERY_STATUSES, default: 'open', index: true },

    /** The asker's verdict, which is a different judgement from the answerer's. */
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    closedAt: Date,
  },
  { timestamps: true }
);

/* The two lists that get built: one buyer's thread, newest first, and a department's queue. */
querySchema.index({ customer: 1, createdAt: -1 });
querySchema.index({ 'participants.department': 1, status: 1, updatedAt: -1 });
querySchema.index({ 'participants.user': 1, status: 1, updatedAt: -1 });

/**
 * The text a plain search matches, kept as one index rather than three `$regex` scans.
 *
 * The customer's *name* is deliberately not in here even though people search by it — it lives
 * on another document, and copying it would be a second copy to keep true when a buyer is
 * renamed. The controller resolves a name to customer ids first and searches on those, which is
 * one extra query and always right.
 */
querySchema.index({ subject: 'text', question: 'text', 'messages.body': 'text' });

/** Whether this is still somebody's problem. */
querySchema.virtual('isOpen').get(function isOpen() {
  return this.status !== 'closed';
});

/** Has anybody actually answered, as opposed to remarked? */
querySchema.virtual('replyCount').get(function replyCount() {
  return (this.messages || []).filter((message) => message.kind === 'reply').length;
});

/** How long it has been sitting, for the lists that lead with that. */
querySchema.virtual('waitingHours').get(function waitingHours() {
  if (this.status === 'closed') return null;
  return Math.floor((Date.now() - new Date(this.createdAt).getTime()) / 3600000);
});

querySchema.set('toJSON', { virtuals: true });
querySchema.set('toObject', { virtuals: true });

/**
 * Whether this person is in the room.
 *
 * The raiser always is — they asked. Otherwise: named on a participant row, or in a department
 * whose row names no particular person. A row that *does* name somebody else does not put their
 * colleagues in, which is the narrowing `participant.user` exists for.
 *
 * Admins and management see everything, as they do everywhere else; that is not this function's
 * business and the caller applies it.
 */
export const inTheRoom = (query, user) => {
  if (!query || !user) return false;
  if (String(query.raisedBy?._id ?? query.raisedBy) === String(user._id)) return true;

  return (query.participants || []).some((participant) => {
    if (participant.user) {
      return String(participant.user?._id ?? participant.user) === String(user._id);
    }
    return participant.department === user.department;
  });
};

/** A mongo fragment matching the queries this person is in — the list screen's own filter. */
export const roomFilter = (user) => ({
  $or: [
    { raisedBy: user._id },
    { participants: { $elemMatch: { user: user._id } } },
    { participants: { $elemMatch: { department: user.department, user: { $exists: false } } } },
    { participants: { $elemMatch: { department: user.department, user: null } } },
  ],
});

protectWrites(querySchema);
export default mongoose.model('Query', querySchema);
