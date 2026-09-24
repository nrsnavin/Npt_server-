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
  /*
   * Optional. A chat does not ask for a title before you may speak, and this was the one field
   * people stalled on. Left out, the question's own first line is used — see `subjectFrom`.
   */
  subject: z.string().trim().min(3).max(200).optional(),
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
/**
 * A location, as the phone reported it.
 *
 * Accuracy is capped at 5 km: past that it is a cell-tower guess, not a place, and storing it
 * would let a card say "near Tiruppur" about a phone that could have been anywhere in the
 * district. Freshness depends on the clock at the moment of receipt, so it is checked in the
 * controller rather than here.
 */
export const locationSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
  accuracyM: z
    .number()
    .finite()
    .positive()
    .max(5000, 'Your phone could only place you within several kilometres — turn on GPS or move near a window, then share again'),
  capturedAt: z.coerce.date(),
});

export const messageSchema = z
  .object({
    kind: z.enum(['reply', 'note']).default('reply'),
    body: z.string().trim().max(4000).default(''),
    location: locationSchema.optional(),
    /* People tagged with @ in this message. A handful at most — a tag is a person, not a list. */
    mentions: z.array(objectId).max(10).optional(),
  })
  /* Words, a place, or both — "📍" alone is a complete thing to have said. */
  .refine((message) => message.body.length > 0 || message.location, {
    message: 'Say something, or share where you are',
    path: ['body'],
  });

/**
 * The ids on the reader's screen, for the model to read.
 *
 * Capped, because this is a page of a list rather than a database: a caller asking about five
 * hundred threads is asking for a model call nobody is waiting on the answer to.
 */
export const urgencySchema = z.object({
  ids: z.array(objectId).max(40),
});
