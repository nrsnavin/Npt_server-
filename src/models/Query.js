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

/** How many labels one thread may carry, and how long one may be. Past five it is not filing. */
export const MAX_LABELS = 5;
export const LABEL_MAX_LENGTH = 30;

/** One label as it is stored: trimmed, single-spaced, lower case. */
export const normaliseLabel = (label) => String(label || '').replace(/\s+/g, ' ').trim().toLowerCase();

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
/**
 * Where somebody was when they said it — because they chose to say so.
 *
 * Never captured in the background, never on a timer: a location exists only on a message a
 * person decided to send, having seen what would be shared. See docs/QUERIES-CHAT-DESIGN.md §6.
 *
 * It is what the phone reported, and nothing stronger. A browser cannot prove where a device is,
 * so this is a record of a claim — "shared from Nandhini's phone" — and must never be used as
 * proof of a visit or as attendance without a different design.
 *
 * `place` is the nearest of the bundled towns, worked out on the server with no third party
 * involved; absent when nothing bundled is within 50 km, which is the honest answer.
 */
const locationSchema = new mongoose.Schema(
  {
    lat: { type: Number, required: true, min: -90, max: 90 },
    lng: { type: Number, required: true, min: -180, max: 180 },
    accuracyM: { type: Number, min: 0 },
    capturedAt: Date,
    place: {
      name: String,
      state: String,
      distanceKm: Number,
    },
  },
  { _id: false }
);

const messageSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['reply', 'note'], default: 'reply' },
    /* Optional when a location rides with it: "📍" alone is a complete thing to have said. */
    body: {
      type: String,
      trim: true,
      maxlength: 4000,
      required() {
        return (!this.location || this.location.lat == null) && !(this.attachments || []).length;
      },
    },
    location: { type: locationSchema, default: undefined },
    /* Photos and documents posted with this message — a file needs no caption, like a location. */
    attachments: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Attachment' }], default: undefined },
    /* People tagged in this message with @ — each is brought into the thread and told. */
    mentions: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: undefined },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

/**
 * A message as words, for everything that reads a thread as text.
 *
 * The model's summary and draft, the rules gist, the urgency reading and the list preview all
 * used `message.body` directly — and a location shared with no caption has none, so each of them
 * would have printed "Anita replied: " followed by nothing. One function says what such a message
 * *was*, so they all say the same thing.
 */
export const messageText = (message) => {
  const words = String(message?.body || '').trim();
  const where = message?.location?.lat == null
    ? ''
    : `📍 shared a location${message.location.place?.name ? ` near ${message.location.place.name}` : ''}`;

  const files = (message?.attachments || []).length
    ? `📎 ${(message.attachments || []).map((file) => file?.filename || 'a file').join(', ')}`
    : '';

  return [words, where && (words ? `(${where})` : where), files].filter(Boolean).join(' ');
};

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

    /*
     * Flagged urgent by an administrator. Urgent threads sort above everything else on every
     * list, for everybody, and a person tagged on one is sent WhatsApp as well as email.
     * `isUrgent` is kept beside the details so the list can sort on it with an index.
     */
    isUrgent: { type: Boolean, default: false, index: true },
    urgent: {
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      at: Date,
      reason: { type: String, trim: true, maxlength: 200 },
    },

    /*
     * Labels anybody in the room can put on the thread to file it with others like it —
     * "quality", "payment follow-up", "diwali rush". Shared, not per person: a thread filed under
     * "quality" is filed there for everybody who can see it, which is what makes a label a group
     * rather than a private bookmark. Kept normalised (see `normaliseLabel`) so "Quality" and
     * "quality " are one group, not two.
     */
    labels: {
      type: [{ type: String, trim: true, lowercase: true, minlength: 2, maxlength: LABEL_MAX_LENGTH }],
      validate: {
        validator: (labels) => labels.length <= MAX_LABELS,
        message: `A query carries at most ${MAX_LABELS} labels`,
      },
      default: [],
    },
  },
  { timestamps: true }
);

/* The two lists that get built: one buyer's thread, newest first, and a department's queue. */
querySchema.index({ customer: 1, createdAt: -1 });
querySchema.index({ 'participants.department': 1, status: 1, updatedAt: -1 });
querySchema.index({ 'participants.user': 1, status: 1, updatedAt: -1 });
/* "Tagged me" — the threads a person was named in, which is a filter and a count on every inbox. */
querySchema.index({ 'messages.mentions': 1 });
/* A label is a filter on the list and a count on its chip bar. */
querySchema.index({ labels: 1 });

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

/**
 * Who reads every thread regardless of the room.
 *
 * Admins and management, as everywhere else in this app. It lives here rather than in the
 * controller that first needed it because it is now asked in two places — the query screens and
 * the customer map — and an access rule with two copies is one that will answer differently on
 * one of them. It already did: the map showed an admin no queries at all while the list showed
 * them every one.
 */
export const seesEveryQuery = (user) =>
  user?.role === 'admin' || user?.department === 'management';

/**
 * Every way of being a participant, as mongo fragments.
 *
 * Kept as one list because the room and "asked of me" differ by exactly one branch — whether
 * raising counts — and writing them out twice is how the two come to disagree about who a
 * department-wide row reaches.
 */
const askedBranches = (user) => [
  { participants: { $elemMatch: { user: user._id } } },
  { participants: { $elemMatch: { department: user.department, user: { $exists: false } } } },
  { participants: { $elemMatch: { department: user.department, user: null } } },
];

/** A mongo fragment matching the queries this person is in — the list screen's own filter. */
export const roomFilter = (user) => ({
  $or: [{ raisedBy: user._id }, ...askedBranches(user)],
});

/**
 * The queries somebody was *asked*, as opposed to the ones they raised.
 *
 * The difference is the whole of "what needs me today": a thread I raised and nobody has
 * answered is something I am waiting on, and a thread I was asked and nobody has answered is
 * something I owe. Putting both on the same card would make it a list of things that are merely
 * open, which is a list nobody acts on.
 *
 * `$ne` rather than leaving the raiser out of the branches, because somebody can be both — you
 * may raise a question and also be named on it, and being the asker is what decides.
 */
export const askedOfFilter = (user) => ({
  raisedBy: { $ne: user._id },
  $or: askedBranches(user),
});

protectWrites(querySchema);
export default mongoose.model('Query', querySchema);
