import { protectWrites } from '../utils/concurrency.js';
import mongoose from 'mongoose';
import { DEPARTMENT_KEYS } from '../config/modules.js';

export const PRIORITIES = ['low', 'normal', 'high'];

/**
 * A task, on a department's queue [BLUEPRINT §35].
 *
 * It used to be strictly personal — one owner, nobody else could see it — and that was the
 * wrong shape for what the app actually does with it. §35's rule is that finishing a stage
 * *raises the next person's task*, and "the next person" is almost never a named individual:
 * it is whoever in the plant is doing that job today. So the automation guessed, and where it
 * could not guess it hedged by raising the same task separately for every production writer,
 * every manager and the order's marketing owner. Four private lists, one job, and each of those
 * four people reading three concerns that were not theirs.
 *
 * The unit is therefore the **department**, and `user` is who has picked it up — which may be
 * nobody. A task with no owner is not an error; it is the normal state of work that has been
 * handed to a department and not yet claimed, and it is what makes escalating *to despatch*
 * mean something rather than being a guess at which despatch clerk is in.
 *
 * Personal tasks still exist: typing one into your own list sets `user` to you and `department`
 * to yours, and it behaves exactly as it did.
 */
const todoSchema = new mongoose.Schema(
  {
    /**
     * Who has it. Optional, because an unclaimed department task has nobody — see above.
     *
     * Claiming is not a permission. Anyone in the department may act on the queue; the owner is
     * there so two people do not both start the same job, not to stop the second one helping.
     */
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

    /**
     * Whose queue it is on. The one field that decides where a task appears.
     *
     * Required, and every door sets it: from the owner's own department for a task somebody
     * types, from the department being asked for one the system raises, and from the target
     * when a task is escalated.
     */
    department: { type: String, enum: DEPARTMENT_KEYS, required: true, index: true },

    title: { type: String, required: true, trim: true, maxlength: 200 },
    notes: { type: String, trim: true, maxlength: 2000 },
    dueDate: { type: Date },
    priority: { type: String, enum: PRIORITIES, default: 'normal' },
    completed: { type: Boolean, default: false },
    completedAt: { type: Date },
    /** Who ticked it off — on a shared queue, "done" without a name is half an answer. */
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    /** Who raised it. Absent on a system task, which is what `system` says. */
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    /**
     * What it is about [§29].
     *
     * Carried so marketing can see every task standing between their buyer and a delivery,
     * whichever department is holding it — the question they are asked on the phone and could
     * previously only answer by ringing round. Ownership is read off the customer rather than
     * copied here: an account that changes hands must not leave its tasks behind.
     */
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', index: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder', index: true },

    /**
     * Handed to another department, and why [§25].
     *
     * The task *moves*: `department` becomes the target and the owner is cleared, because two
     * departments both holding the same task is how it gets done twice or not at all. What
     * stays behind is this record — so the person who escalated still sees it in their own
     * list, marked with where it went, and can tell whether anybody picked it up. An escalation
     * you cannot follow up is a phone call with extra steps.
     */
    escalation: {
      from: { type: String, enum: DEPARTMENT_KEYS },
      to: { type: String, enum: DEPARTMENT_KEYS },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      at: Date,
      reason: { type: String, trim: true, maxlength: 500 },
      /** Cleared when the receiving department picks it up, which is what ends the highlight. */
      acknowledgedAt: Date,
      acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      _id: false,
    },

    /**
     * A priority proposed by the model rather than set by a person.
     *
     * The card that leads with "urgent" is only worth reading if its contents can be trusted,
     * and "Kavitha marked this high" and "a model thought this looked urgent" are not the same
     * claim. So where a suggestion supplied the priority, that is recorded and the screen says
     * so — which also means the day somebody stops believing the suggestions, the honest rows
     * are still distinguishable from the guessed ones.
     *
     * Cleared the moment a person sets the priority themselves: at that point it is theirs.
     */
    prioritySuggested: {
      /** `model` or `rules` — a keyword match and a read sentence deserve different trust. */
      by: { type: String, enum: ['model', 'rules'] },
      at: Date,
      /** What it said, so the row can show its reasoning rather than only its conclusion. */
      reason: { type: String, trim: true, maxlength: 400 },
      _id: false,
    },

    /**
     * Raised by automation rather than typed [BLUEPRINT §35]: completing a stage creates the
     * next person's task. `link` points the dock at the record, and `originKey` identifies
     * what raised it so the same handover cannot queue twice.
     */
    system: { type: Boolean, default: false },
    link: { type: String, trim: true },
    originKey: { type: String, trim: true },
    /**
     * What makes an automated task unique while it is open: `u:<user>:<origin>` for a person's
     * task, `d:<department>:<origin>` for one on a department's queue. Set on creation, cleared
     * when the task is completed, and unique — so two processes raising the same handover or the
     * same reminder at the same moment get one task, not two. Kept by the hooks below.
     */
    openKey: { type: String },
  },
  { timestamps: true }
);

/** True while the receiving department has not picked it up — what the dashboard card lists. */
todoSchema.virtual('isEscalated').get(function isEscalated() {
  return Boolean(this.escalation?.at) && !this.completed;
});

/** Nobody has taken it yet. Drawn differently, because it is the row anybody may claim. */
todoSchema.virtual('unclaimed').get(function unclaimed() {
  return !this.user;
});

todoSchema.set('toJSON', { virtuals: true });
todoSchema.set('toObject', { virtuals: true });

/* The dock lists one person's open tasks by due date, so index the query it actually runs. */
todoSchema.index({ user: 1, completed: 1, dueDate: 1 });
/* And the queue lists a department's, which is now the more common of the two. */
todoSchema.index({ department: 1, completed: 1, dueDate: 1 });
/* The dashboard card: what has been escalated to us and not yet picked up. */
todoSchema.index({ department: 1, completed: 1, 'escalation.at': -1 }, { sparse: true });
/*
 * Automated tasks are deduplicated on their origin. Scoped to the *department* rather than the
 * user, because a department task has no user to be unique against — and because the whole
 * point of the queue is that one job is one row however many people could do it.
 */
todoSchema.index({ department: 1, originKey: 1 }, { sparse: true });
todoSchema.index({ openKey: 1 }, { unique: true, partialFilterExpression: { openKey: { $type: 'string' } } });

/** The key an open automated task holds; completed ones hold none, so the job can be raised again. */
export const openKeyFor = ({ user, department, originKey }) =>
  originKey ? (user ? `u:${user._id || user}:${originKey}` : `d:${department}:${originKey}`) : undefined;

todoSchema.pre('save', function keepOpenKey() {
  if (this.isNew) {
    if (this.originKey && !this.completed) this.openKey = openKeyFor(this);
  } else if (this.isModified('completed')) {
    /* Re-opening does not take the key back: another copy may have been raised meanwhile. */
    if (this.completed) this.openKey = undefined;
  }
});

protectWrites(todoSchema);
export default mongoose.model('Todo', todoSchema);
