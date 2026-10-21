/**
 * The departments a person works in [models/User.js `department`, `extraDepartments`].
 *
 * Most people work in one. Some do two jobs — a marketing person who also prepares quotations,
 * an accountant who also books dispatches — and their queues, hand-overs and desks have to
 * follow them into both. The main department comes first; it is the one "My department" opens,
 * the one their own typed tasks go on, and the one that decides whether they are a marketing
 * person who sees only their own buyers [services/ownership.service.js].
 */
import { deskMates } from '../config/modules.js';

export const departmentsOf = (user) => {
  const own = [...new Set([user?.department, ...(user?.extraDepartments || [])].filter(Boolean))];
  /* A desk shared by several departments [config/modules.js DESK_GROUPS] is worked by all of them:
     a Quality login holds Assembly's and Printing's queues too. The main department stays first. */
  return [...new Set(own.flatMap((key) => deskMates(key)))];
};

/** True when this person works in that department, as their main one or an extra one. */
export const inDepartment = (user, key) => Boolean(key) && departmentsOf(user).includes(key);

/** Admin: the admin role, or working in the Admin (management) department. */
export const isManagement = (user) => user?.role === 'admin' || inDepartment(user, 'management');

/**
 * Who plans Production's work [models/User.js `productionInCharge`]: the EDD and hand-over dates,
 * the printing / assembly decision per model, and putting a task on the production queue. The
 * Production in charge — anyone Admin marks, from any department; marking them adds Production
 * to their departments [user.controller] — or Admin. The rest of Production moves the statuses.
 */
export const isProductionInCharge = (user) => isManagement(user) || user?.productionInCharge === true;

/**
 * Every Admin, as a query — the same people `isManagement` says yes to: the admin role, or the
 * Admin (management) department as the main one or an extra. Notices and escalations used two
 * narrower versions, so somebody in Management as an extra department, or by department without
 * the role, saw everything Admin sees and was told about none of it.
 */
export const MANAGEMENT_QUERY = Object.freeze({
  $or: [{ role: 'admin' }, { department: 'management' }, { extraDepartments: 'management' }],
});
