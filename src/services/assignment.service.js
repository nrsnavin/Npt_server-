import Counter from '../models/Counter.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';

/**
 * Who a new lead belongs to [BLUEPRINT §41.3].
 *
 * The blueprint states the rule inside the WhatsApp section, and §8 is explicit that it is
 * not a WhatsApp rule: *existing customers go to the account owner; genuinely new leads go
 * round-robin across the marketing team*. Built here so the enquiry module has it now and the
 * integration reuses it rather than inventing a second answer later.
 *
 * The account-owner half already lives where it belongs — an enquiry raised against a
 * customer takes that customer's owner. This is the other half: the lead nobody owns yet.
 *
 * **Round-robin, not least-loaded.** §41.3 says round-robin, and it is the rule a team can
 * check: everyone can see whose turn it was. Least-loaded sounds fairer and is worse to be
 * on the end of, because closing your leads quickly earns you more of them.
 *
 * The turn is kept in the same atomic counter the document numbers use, so two leads
 * arriving together cannot both take the same person, and a restart does not put the
 * rotation back to whoever happens to sort first.
 */

/**
 * Refuses an owner who cannot hold the work.
 *
 * Every module that assigns anything needs this, and each one that grew its own version grew
 * it late: customers, leads and enquiries went without it until an administrator could hand a
 * record to somebody who had already left, and samples went without it in three more places.
 * A record owned by a name that no longer answers is the worst kind of missing — it is not
 * unassigned, so it is not on the queue waiting to be picked up, and it is not anybody's, so
 * it is on no personal list either. It is simply not on a screen.
 *
 * Lives beside the rotation because both answer the same question: who may hold this.
 */
export async function assertAssignable(assignTo) {
  const successor = await User.findById(assignTo?._id ?? assignTo);
  if (!successor) throw ApiError.badRequest('That colleague does not exist');
  if (successor.isActive === false) {
    throw ApiError.badRequest(`${successor.name} is not active, so the work would go nowhere`);
  }
  return successor;
}

/**
 * The people in the rotation.
 *
 * Marketing by department *and* by grant. Department alone would hand leads to someone who
 * cannot open an enquiry; the grant alone would put management and every admin in the
 * rotation, since they hold everything — and the MD is not the next name on the list.
 */
export async function marketingTeam() {
  return User.find({
    isActive: { $ne: false },
    department: 'marketing',
    moduleAccess: { $elemMatch: { module: 'enquiries', level: 'write' } },
  })
    // Stable order, or the rotation depends on whatever Mongo returns first each time.
    .sort({ createdAt: 1, _id: 1 })
    .select('_id name');
}

/**
 * Whether somebody may hold a buyer — the same question `assertCanOwnBuyer` refuses on, asked
 * without throwing.
 *
 * The roster needs it as a question rather than as a refusal: it is deciding whether to offer
 * the reader their own name, and wrapping an assertion in a try/catch to answer "may I?" is a
 * refusal used as a lookup — which reads as an error path every time somebody opens a form.
 *
 * `team` is passed in where the caller already has the roster, so asking about one person does
 * not fetch it twice.
 */
export async function canOwnBuyer(person, team) {
  if (!person || person.isActive === false) return false;
  if (person.role === 'admin' || person.department === 'management') return true;

  const roster = team ?? (await marketingTeam());
  return roster.some((member) => String(member._id) === String(person._id));
}

/**
 * Refuses an owner who could not chase a buyer.
 *
 * Stricter than `assertAssignable`, and used where a *person is choosing* an owner rather than
 * where the plant is resolving one for itself. A lead or a customer belongs to one marketing
 * person [§29], so a record handed to despatch is owned — and therefore on nobody's queue — by
 * somebody whose screens do not show it.
 *
 * **Admins and management pass as well**, and that is deliberate rather than a loophole. They
 * hold every module already, `ownsRecord` never scopes them, and the seeded administrator owns
 * records today. Excluding them would be a new rule the blueprint does not ask for, and it would
 * leave a plant that has not hired its marketing team yet unable to register a buyer at all.
 *
 * So the picker and this check are deliberately not the same list. The form offers marketing,
 * because choosing which of them will chase the buyer is the decision being asked for; the
 * server refuses the class of answer that would strand a record, which is a wider net. A UI that
 * narrows and a server that guards the class is the normal shape, and the narrower of the two is
 * the one a person sees.
 */
export async function assertCanOwnBuyer(assignTo) {
  const chosen = await assertAssignable(assignTo);
  if (await canOwnBuyer(chosen)) return chosen;

  throw ApiError.badRequest(
    `${chosen.name} could not chase a buyer from ${chosen.department || 'no department'}, so the ` +
      'record would belong to nobody who can work it. Choose somebody in marketing.'
  );
}

/**
 * The next marketing person in the rotation, or null when there is nobody to rotate over.
 *
 * Null rather than a guess: the caller knows what to fall back to, and silently assigning a
 * lead to whoever asked for it would be indistinguishable from the rotation working.
 */
export async function nextInRotation() {
  const team = await marketingTeam();
  if (!team.length) return null;
  if (team.length === 1) return team[0];

  const counter = await Counter.findOneAndUpdate(
    { key: 'rotation-marketing' },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );

  // The counter only ever grows; the team can change size beneath it, which just moves where
  // the rotation resumes rather than breaking it.
  return team[counter.seq % team.length];
}

/**
 * Who a lead being created should belong to, when there is nobody to ask.
 *
 * This is now the *front-door* rule only — the WhatsApp number nobody recognises, the IndiaMART
 * enquiry that arrives at two in the morning. There is no person at the keyboard on either, so
 * something has to choose, and §41.3 says round-robin across marketing.
 *
 * It used to answer for the form as well, and that was the wrong shape for a human: somebody
 * filling in a lead they had just taken a call about would submit it and find it had gone to a
 * colleague by rotation, or — if they were in marketing themselves — silently to them. Neither
 * was a decision anybody made, and a record whose owner nobody chose is one that gets chased by
 * whoever notices. The form asks now; see `createLead`.
 */
export async function ownerForNewLead({ requested, creator }) {
  if (requested) return { user: requested, rotated: false };

  const creatorIsMarketing = creator?.department === 'marketing';
  if (creatorIsMarketing) return { user: creator._id, rotated: false };

  const next = await nextInRotation();
  if (next) return { user: next._id, rotated: true, name: next.name };

  // Nobody to rotate over. The lead still needs an owner, and an unowned lead is the one
  // §3 exists to prevent, so it stays with whoever entered it.
  return { user: creator?._id, rotated: false };
}
