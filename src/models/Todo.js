import mongoose from 'mongoose';

export const PRIORITIES = ['low', 'normal', 'high'];

/** A personal task. Everyone has their own list; nobody sees anyone else's. */
const todoSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    notes: { type: String, trim: true, maxlength: 2000 },
    dueDate: { type: Date },
    priority: { type: String, enum: PRIORITIES, default: 'normal' },
    completed: { type: Boolean, default: false },
    completedAt: { type: Date },

    /**
     * Raised by automation rather than typed [BLUEPRINT §35]: completing a stage creates the
     * next person's task. `link` points the dock at the record, and `originKey` identifies
     * what raised it so the same handover cannot queue twice.
     */
    system: { type: Boolean, default: false },
    link: { type: String, trim: true },
    originKey: { type: String, trim: true },
  },
  { timestamps: true }
);

// The dock lists open tasks by due date, so index the query it actually runs.
todoSchema.index({ user: 1, completed: 1, dueDate: 1 });
// Automated tasks are deduplicated on their origin, which is unique per user.
todoSchema.index({ user: 1, originKey: 1 }, { sparse: true });

export default mongoose.model('Todo', todoSchema);
