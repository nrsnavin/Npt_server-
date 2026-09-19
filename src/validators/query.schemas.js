import { z } from 'zod';
import { DEPARTMENT_KEYS } from '../config/modules.js';
import { objectId } from './schemas.js';

/**
 * What a query will accept at the door [queries].
 *
 * The interesting shape is the participant, which is a department *or* a person in one — and
 * expressing that as two optional fields would accept `{}`, an entry standing for nobody, which
 * the controller would then have to refuse in words the schema could have refused in structure.
 * So it is a union: one branch names a person, the other names a department, and there is no
 * third way to spell it.
 *
 * The department is still carried on the person branch, and ignored — the controller reads the
 * department off the user record instead, because two fields that can disagree about where
 * somebody works is a filter that stops finding them. Accepted rather than refused so a form
 * that sends both (which is the natural thing for a dropdown-of-dropdowns to do) is not bounced
 * for being helpful.
 */
const participant = z.union([
  z.object({
    user: objectId,
    department: z.enum(DEPARTMENT_KEYS).optional(),
  }),
  z.object({
    department: z.enum(DEPARTMENT_KEYS),
    user: z.undefined().optional(),
  }),
]);

export const querySchema = z.object({
  customer: objectId,
  /* Short, because it is what a list shows and what somebody scans forty of. */
  subject: z.string().trim().min(3).max(200),
  question: z.string().trim().min(3).max(4000),
  /*
   * At least one, enforced here as well as in the controller. A query addressed to nobody is a
   * note to self, and the to-do list already exists for those.
   */
  participants: z.array(participant).min(1).max(20),
});

export const participantSchema = participant;

/**
 * Something said in the thread.
 *
 * `kind` decides whether it answers. A reply moves an open query to `answered`; a note is an
 * observation that does not. Defaulted to `reply` because that is what somebody typing into the
 * box usually means, and a note is the deliberate choice.
 */
export const messageSchema = z.object({
  kind: z.enum(['reply', 'note']).default('reply'),
  body: z.string().trim().min(1).max(4000),
});
