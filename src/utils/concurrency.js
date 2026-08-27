import ApiError from './ApiError.js';

/**
 * Refuses a write built on a version of the record somebody has already replaced.
 *
 * Without this, two people editing the same enquiry is last-write-wins: she changes the
 * follow-up date, he changes the remarks, and whoever saves second silently reverts the
 * other. Nothing errors, so neither of them finds out — they discover it a week later, when
 * the customer was not called. On a shared record with a next-action rule hanging off it,
 * that is a lost commitment rather than a lost keystroke.
 *
 * **The token is `updatedAt`, not `__v`.** Mongoose's version key looks like the obvious
 * choice and is the wrong one: it increments only when an *array* field is modified, so
 * editing a customer's credit terms or an enquiry's remarks leaves it untouched. A guard
 * built on it would compare two identical zeroes and wave every stale write through — worse
 * than no guard, because the screen would promise a protection it does not have. Every model
 * here carries `timestamps: true`, and `updatedAt` moves on every save.
 *
 * **Opt-in per request, deliberately.** A caller that sends no timestamp is not blocked: a
 * script or an integration written before this existed must keep working rather than start
 * failing on every write. That is a real trade — an untaught caller can still clobber — but
 * the alternative breaks working integrations to protect against a rarer problem, and the
 * screens where two people genuinely collide are the ones we can teach.
 */
export function expectVersion(record, body) {
  const seen = body?.expectedUpdatedAt;
  if (seen === undefined || seen === null || seen === '') return;

  const expected = new Date(seen).getTime();
  if (Number.isNaN(expected)) return;

  const current = record.updatedAt ? new Date(record.updatedAt).getTime() : null;
  if (current === null) return;

  /*
   * Exact. A tolerance looks prudent and is not: two people saving within the same second is
   * precisely the collision this exists to catch, so a one-second window would wave through
   * the commonest case. The failure modes are not symmetric either — a false conflict costs
   * a reload, a false accept costs somebody's work — so where the comparison is uncertain it
   * should refuse. ISO timestamps round-trip to the millisecond, so it rarely is.
   */
  if (current !== expected) {
    throw ApiError.conflict(
      'Someone else changed this record while you were editing it. Reload to see their ' +
        'version, then make your change again — saving now would overwrite theirs.'
    );
  }
}

/**
 * Strips the concurrency token from an update payload.
 *
 * `expectedUpdatedAt` is part of the protocol, not part of the record. Letting it through to
 * `Object.assign` would write it onto the document as a stray field.
 */
export const withoutVersion = ({ expectedUpdatedAt, __v, ...rest } = {}) => rest;
