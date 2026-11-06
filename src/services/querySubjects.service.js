import QuerySubject from '../models/QuerySubject.js';
import ApiError from '../utils/ApiError.js';
import { DEFAULT_QUERY_SUBJECTS, SUBJECT_MAX_LENGTH, subjectKey } from '../config/querySubjects.js';

/**
 * The queries' subjects [config/querySubjects.js]: the starting list, seeded once, and every
 * subject somebody added. Used by both kinds of query — a buyer's thread and a question on a task.
 */

let seeded = false;
async function seed() {
  if (seeded) return;
  await QuerySubject.bulkWrite(DEFAULT_QUERY_SUBJECTS.map((name, order) => ({
    updateOne: { filter: { key: subjectKey(name) }, update: { $setOnInsert: { name, key: subjectKey(name), order } }, upsert: true },
  })), { ordered: false });
  seeded = true;
}

const clean = (name) => String(name || '').replace(/\s+/g, ' ').trim();

/** The drop-down: shown subjects, the starting ones first. Admin may ask for the hidden ones too. */
export async function listSubjects({ withHidden = false } = {}) {
  await seed();
  return QuerySubject.find(withHidden ? {} : { hidden: false }).sort({ order: 1, name: 1 }).select('name hidden order').lean();
}

/**
 * The subject a query is filed under, on the list for everyone from now on — the same row when
 * it is already there in another case, shown again when Admin had removed it.
 */
export async function ensureSubject(name, user) {
  const said = clean(name);
  if (!said) return null;
  if (said.length < 2) throw ApiError.badRequest('A subject is a word or two at least');
  if (said.length > SUBJECT_MAX_LENGTH) throw ApiError.badRequest(`Keep a subject under ${SUBJECT_MAX_LENGTH} characters`);
  await seed();
  const key = subjectKey(said);
  const found = await QuerySubject.findOne({ key });
  if (found) {
    if (found.hidden) {
      found.hidden = false;
      await found.save();
    }
    return found.name;
  }
  try {
    const made = await QuerySubject.create({ name: said, key, createdBy: user?._id });
    return made.name;
  } catch (error) {
    /* Two people adding the same subject at once: the other one's row stands. */
    if (error?.code === 11000) return (await QuerySubject.findOne({ key }))?.name || said;
    throw error;
  }
}

/** Admin renames a subject; queries already filed keep the words they were filed under. */
export async function renameSubject(id, name) {
  const said = clean(name);
  if (said.length < 2 || said.length > SUBJECT_MAX_LENGTH) throw ApiError.badRequest(`A subject is 2 to ${SUBJECT_MAX_LENGTH} characters`);
  const row = await QuerySubject.findById(id);
  if (!row) throw ApiError.notFound('Subject not found');
  const clash = await QuerySubject.findOne({ key: subjectKey(said), _id: { $ne: row._id } });
  if (clash) throw ApiError.conflict(`“${clash.name}” is already on the list`);
  row.name = said;
  row.key = subjectKey(said);
  await row.save();
  return row;
}

/** Admin takes a subject off the drop-down, or puts it back. */
export async function setSubjectHidden(id, hidden) {
  const row = await QuerySubject.findById(id);
  if (!row) throw ApiError.notFound('Subject not found');
  row.hidden = Boolean(hidden);
  await row.save();
  return row;
}
