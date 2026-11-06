import mongoose from 'mongoose';
import { DEPARTMENT_KEYS } from '../config/modules.js';

/**
 * A question asked on a task or an enquiry, put to the person who raised the work — and the
 * answer, where the people who asked can act on it [services/taskQuery.service.js].
 *
 * The SO team cannot make the sales order until somebody says which GSTIN; Production cannot
 * start until somebody says which colour. Whoever raised the task knows, so the question goes to
 * them by name: the task's creator, else the enquiry's marketing person, else Admin. The reply
 * comes back onto the task it was asked on, and the task — held at Needs Clarification while it
 * waited — goes back to where it was.
 *
 * Not a `Query` (a thread about a buyer that pulls departments in) and not a task of its own:
 * the old "SO Clarification" was a second task for marketing to finish, and its answer lived in
 * a task outcome nobody on the SO team could see. A question here is one line on the work it is
 * about, and it is answered there.
 */
export const TASK_QUERY_STATUSES = ['open', 'answered', 'closed'];

const messageSchema = new mongoose.Schema(
  {
    body: { type: String, trim: true, required: true, maxlength: 2000 },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    /* `ask`: the asking side (the question, a follow-up); `answer`: whoever it was put to, or Admin. */
    side: { type: String, enum: ['ask', 'answer'], required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: true },
);

const taskQuerySchema = new mongoose.Schema(
  {
    /* The task it was asked on — absent for a question asked on the enquiry itself. */
    task: { type: mongoose.Schema.Types.ObjectId, ref: 'Todo', index: true },
    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: 'Enquiry', index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder' },

    /* The department that asked — the task's own; absent when somebody asked on the enquiry for themselves. */
    department: { type: String, enum: DEPARTMENT_KEYS },
    askedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    question: { type: String, trim: true, required: true, maxlength: 2000 },

    /* Who it was put to. Absent: nobody named could take it, so it is Admin's. */
    to: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    /*
     * Asked by the workflow (the SO team's Needs Clarification): the status it was asked at and
     * the one the task was at before — where the answer puts it back.
     */
    workflow: {
      status: String,
      from: String,
      _id: false,
    },

    messages: { type: [messageSchema], default: () => [] },
    status: { type: String, enum: TASK_QUERY_STATUSES, default: 'open', index: true },
    answeredAt: Date,
    answeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    /* The asking side read the answer ("Got it"); until then it stays at the top of their screen. */
    seenAt: Date,
    closedAt: Date,
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

taskQuerySchema.index({ to: 1, status: 1, updatedAt: -1 });
taskQuerySchema.index({ department: 1, status: 1, updatedAt: -1 });

/** The latest answer, for every list that shows one line. */
taskQuerySchema.virtual('lastAnswer').get(function lastAnswer() {
  return [...(this.messages || [])].reverse().find((message) => message.side === 'answer') || null;
});

taskQuerySchema.set('toJSON', { virtuals: true });
taskQuerySchema.set('toObject', { virtuals: true });

export default mongoose.model('TaskQuery', taskQuerySchema);
