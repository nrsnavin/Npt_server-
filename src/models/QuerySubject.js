import mongoose from 'mongoose';
import { SUBJECT_MAX_LENGTH } from '../config/querySubjects.js';

/**
 * One subject on the queries' drop-down [config/querySubjects.js, services/querySubjects.service.js].
 * Shared: added by anybody, for everybody. Removed by Admin is hidden, not deleted — the queries
 * already filed under it keep their subject.
 */
const querySubjectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: SUBJECT_MAX_LENGTH },
    /* The name as compared [subjectKey] — one row per subject, whatever its case. */
    key: { type: String, required: true, unique: true },
    /* Its place on the list: the starting subjects in their order, added ones after them. */
    order: { type: Number, default: 1000 },
    hidden: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export default mongoose.model('QuerySubject', querySubjectSchema);
