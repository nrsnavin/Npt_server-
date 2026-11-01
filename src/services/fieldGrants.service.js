import { departmentsOf } from '../utils/departments.js';
import { LEVEL_RANK } from '../config/modules.js';

/**
 * The field-visit marks each department gets on day one [models/User.js `fieldVisit`;
 * scripts/grant-field-visits.js]. Admin sets them one by one on the Users page; this is the
 * starting point for a plant switching the module on, so nobody is left with the Field visits
 * screen and no mark that lets them use it.
 *
 *   Admin (the role)           everything, by role — nothing to store.
 *   Management                 goes out, plans their own, assigns to everyone who goes out.
 *   Marketing                  goes out (buyers' visits), plans their own, assigns to Sampling,
 *                              Payment Collection and the PRT — the people who deliver their
 *                              samples and collect their buyers' money.
 *   Sampling                   goes out (sample delivery), plans their own.
 *   Payment Collection, PRT    goes out (collection calls), plans their own.
 *   Everyone else              no mark: the office punch alone.
 *
 * Marks are only ever raised. A mark Admin gave stays; a mark Admin took away from somebody who
 * would get it here comes back only on this script's say-so — which is why it dry-runs first.
 */
export const GOES_OUT = ['marketing', 'sampling', 'payment_collection', 'payment_recovery', 'management'];
export const ASSIGNS = Object.freeze({
  management: GOES_OUT,
  marketing: ['sampling', 'payment_collection', 'payment_recovery'],
});

const inAny = (user, keys) => departmentsOf(user).some((key) => keys.includes(key));

/** The marks this person's departments give, with `assignTo` by department (resolved against the users list). */
export function marksForDepartments(user) {
  if (user.role === 'admin') return null;
  const departments = departmentsOf(user);
  const allowed = inAny(user, GOES_OUT);
  const assignDepartments = [...new Set(departments.flatMap((key) => ASSIGNS[key] || []))];
  if (!allowed && !assignDepartments.length) return null;
  return { allowed, maySelfPlan: allowed, mayAssign: assignDepartments.length > 0, assignDepartments };
}

/**
 * What to write on each user, against everyone: marks raised, `assignTo` widened to the people
 * of the departments named who go out (after this run), the module grant added at write.
 * Rows with nothing to change are left out.
 */
export function planFieldGrants(users) {
  const after = new Map(users.map((user) => [String(user._id), Boolean(user.fieldVisit?.allowed) || Boolean(marksForDepartments(user)?.allowed)]));
  const goers = (departments) => users
    .filter((person) => person.isActive !== false && after.get(String(person._id)) && inAny(person, departments))
    .map((person) => String(person._id));
  const plan = [];
  for (const user of users) {
    if (user.isActive === false) continue;
    const marks = marksForDepartments(user);
    if (!marks) continue;
    const current = user.fieldVisit || {};
    const next = {
      allowed: Boolean(current.allowed) || marks.allowed,
      maySelfPlan: Boolean(current.maySelfPlan) || marks.maySelfPlan,
      mayAssign: Boolean(current.mayAssign) || marks.mayAssign,
      assignTo: [...new Set([...(current.assignTo || []).map(String), ...goers(marks.assignDepartments)])].filter((id) => id !== String(user._id)),
    };
    const held = new Map((user.moduleAccess || []).map((grant) => [grant.module, grant.level]));
    const moduleAccess = next.allowed || next.mayAssign
      ? (LEVEL_RANK[held.get('field_visits')] || 0) >= LEVEL_RANK.write ? null : [...(user.moduleAccess || []).filter((grant) => grant.module !== 'field_visits'), { module: 'field_visits', level: 'write' }]
      : null;
    const changed = next.allowed !== Boolean(current.allowed) || next.maySelfPlan !== Boolean(current.maySelfPlan) || next.mayAssign !== Boolean(current.mayAssign)
      || next.assignTo.length !== (current.assignTo || []).length || moduleAccess;
    if (!changed) continue;
    plan.push({ user, before: { allowed: Boolean(current.allowed), maySelfPlan: Boolean(current.maySelfPlan), mayAssign: Boolean(current.mayAssign), assignTo: (current.assignTo || []).map(String) }, after: next, moduleAccess });
  }
  return plan;
}
