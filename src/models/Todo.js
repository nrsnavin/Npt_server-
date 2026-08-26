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
  },
  { timestamps: true }
);

// The dock lists open tasks by due date, so index the query it actually runs.
todoSchema.index({ user: 1, completed: 1, dueDate: 1 });

export default mongoose.model('Todo', todoSchema);
