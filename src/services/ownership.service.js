import mongoose from 'mongoose';
import ApiError from '../utils/ApiError.js';
import { findDepartment } from '../config/modules.js';
import { isManagement } from '../utils/departments.js';

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

/**
 * A marketing person: marketing as their main department. Someone whose main work is quoting or
 * sampling for every salesperson, and who sells a little besides, is not narrowed to a book of
 * their own — their department's work spans every book. Admin and management, by role or by
 * any department they sit in, see every book.
 */
export const isOwnershipScoped = (user) =>
  Boolean(user) && !isManagement(user) && OWNED_BY_DEPARTMENT.includes(user.department);

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

/**
 * Customers: a marketing person sees the customers allocated to them, and no others.
 *
 * A query about a buyer, or one of the buyer's enquiries delegated to them, used to open the
 * customer record too [`sharedWith` on the model]. It no longer does for marketing — the
 * customer is one salesperson's, and Admin decides whose [delegation.service `delegateCustomer`].
 * A delegated enquiry is still theirs to work, contact details and all, on the enquiry itself.
 * Every other department sees the customers its module grant allows, as before.
 */
export const customerScope = (user) => ownershipFilter(user);

/** True when this user may open this particular buyer: allocated to them, or not a salesperson. */
export const ownsCustomer = (user, customer) => ownsRecord(user, customer);

/**
 * Narrowing a list to one colleague's records, which may only ever narrow.
 *
 * Ownership has already pinned the owner for a marketing person. A filter that assigned over
 * that would hand anyone their colleague's book by typing a different id into the address bar
 * — the exact rule this file exists to enforce, undone by a control meant for their manager.
 * So where the two disagree, the answer is nothing rather than somebody else's records.
 *
 * Cast rather than left as the string off the query: `find` casts for you and `aggregate` does
 * not, so the same filter object narrowed a list correctly and matched nothing at all in the
 * tally beside it.
 *
 * Lives here rather than in whichever controller wanted it first, because leads and enquiries
 * must not answer this differently — a rule enforced on one list and not the other is a gap
 * with a witness.
 */
export const narrowToOwner = (scope, requested) => {
  if (!requested) return undefined;
  const asked = String(requested);
  if (!mongoose.isValidObjectId(asked)) throw ApiError.badRequest('That is not a colleague');

  return scope.assignedTo && String(scope.assignedTo) !== asked
    ? { $in: [] }
    : mongoose.Types.ObjectId.createFromHexString(asked);
};

/** Explains the rule for a department, for the profile screen and the docs. */
export const ownershipNoteFor = (departmentKey) =>
  OWNED_BY_DEPARTMENT.includes(departmentKey)
    ? `${findDepartment(departmentKey)?.label || departmentKey} sees only its own customers and enquiries.`
    : null;
