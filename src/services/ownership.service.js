import { findDepartment } from '../config/modules.js';

/**
 * Record-level ownership, which sits *below* module access.
 *
 * A module grant says whether you may use enquiries at all; ownership says whose enquiries
 * you may see. The blueprint restricts this to marketing [§29]: a marketing person must not
 * see another marketing person's customers, enquiries or prices, because those carry the
 * relationship and the commission.
 *
 * Every other department is not competing for the same customers — sampling needs to see
 * whichever enquiry raised the request, production needs whichever order is running — so
 * they see everything their module grant already allows.
 */
const OWNED_BY_DEPARTMENT = ['marketing'];

export const isOwnershipScoped = (user) =>
  user?.role !== 'admin' && OWNED_BY_DEPARTMENT.includes(user?.department);

/**
 * A mongo filter fragment restricting a query to the caller's own records, or `{}` when
 * they are entitled to see everything.
 */
export const ownershipFilter = (user, field = 'assignedTo') =>
  isOwnershipScoped(user) ? { [field]: user._id } : {};

/**
 * An owner field is an ObjectId on a lean record and a full document once populated, so
 * compare on the id in both cases — `String(populatedDoc)` is a document dump, never the id.
 */
const ownerId = (value) => (value && value._id ? String(value._id) : String(value));

/** True when this user may open this particular record. */
export const ownsRecord = (user, record, field = 'assignedTo') => {
  if (!isOwnershipScoped(user)) return true;
  return ownerId(record?.[field]) === ownerId(user._id);
};

/** Explains the rule for a department, for the profile screen and the docs. */
export const ownershipNoteFor = (departmentKey) =>
  OWNED_BY_DEPARTMENT.includes(departmentKey)
    ? `${findDepartment(departmentKey)?.label || departmentKey} sees only its own customers and enquiries.`
    : null;
