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
 * Who a lead being created should belong to.
 *
 * A marketing person typing in a lead they just spoke to is its natural owner, and handing it
 * to a colleague on their behalf would be surprising rather than fair — §41.3 is about the
 * lead that arrives with nobody attached to it. So the rotation is for everyone else: an
 * administrator entering leads from a trade show list, and later the WhatsApp front door,
 * where an unknown number genuinely has no owner.
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
