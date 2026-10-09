/**
 * The departments a person works in [models/User.js `department`, `extraDepartments`].
 *
 * Most people work in one. Some do two jobs — a marketing person who also prepares quotations,
 * an accountant who also books dispatches — and their queues, hand-overs and desks have to
 * follow them into both. The main department comes first; it is the one "My department" opens,
 * the one their own typed tasks go on, and the one that decides whether they are a marketing
 * person who sees only their own buyers [services/ownership.service.js].
 */
export const departmentsOf = (user) =>
  [...new Set([user?.department, ...(user?.extraDepartments || [])].filter(Boolean))];

/** True when this person works in that department, as their main one or an extra one. */
export const inDepartment = (user, key) => Boolean(key) && departmentsOf(user).includes(key);

/** Admin: the admin role, or working in the Admin (management) department. */
export const isManagement = (user) => user?.role === 'admin' || inDepartment(user, 'management');
