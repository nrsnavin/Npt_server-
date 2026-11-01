/**
 * The field-visit marks on a user, as every screen reads them [models/User.js `fieldVisit`]:
 * goes out (`allowed`), plans visits for others (`mayAssign`, and for whom: `assignTo`), plans
 * their own (`maySelfPlan`). Admin holds all of them; an empty `assignTo` on Admin means everyone.
 */
export const fieldVisitOf = (user) => (user?.role === 'admin'
  ? { allowed: true, mayAssign: true, assignTo: [], maySelfPlan: true }
  : {
    allowed: Boolean(user?.fieldVisit?.allowed),
    mayAssign: Boolean(user?.fieldVisit?.mayAssign),
    assignTo: (user?.fieldVisit?.assignTo || []).map((id) => String(id?._id || id)),
    maySelfPlan: Boolean(user?.fieldVisit?.maySelfPlan),
  });

/** Anyone with a mark — the Field visits screens are theirs. */
export const inFieldModule = (user) => {
  const marks = fieldVisitOf(user);
  return marks.allowed || marks.mayAssign;
};
