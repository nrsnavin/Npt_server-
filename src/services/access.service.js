import {
  MODULES,
  MODULE_KEYS,
  DEPARTMENTS,
  levelSatisfies,
  defaultAccessFor,
} from '../config/modules.js';

/**
 * Resolves what a user may do in a module.
 *
 * Admins hold write everywhere by definition, so they never need explicit grants and
 * cannot be locked out of a module by an editing mistake. Everyone else holds exactly
 * what has been granted to them; no grant means no access.
 */
export function accessLevel(user, moduleKey) {
  if (!user || !user.isActive) return null;
  if (user.role === 'admin') return 'write';

  const grant = (user.moduleAccess || []).find((entry) => entry.module === moduleKey);
  return grant?.level || null;
}

export const canRead = (user, moduleKey) =>
  levelSatisfies(accessLevel(user, moduleKey), 'read');

export const canWrite = (user, moduleKey) =>
  levelSatisfies(accessLevel(user, moduleKey), 'write');

/**
 * The whole catalogue annotated for one user — what the profile screen renders and
 * what the client uses to decide which navigation to show.
 */
export function moduleAccessFor(user) {
  return MODULES.map((module) => {
    const level = accessLevel(user, module.key);
    return {
      key: module.key,
      label: module.label,
      description: module.description,
      group: module.group,
      stage: module.stage,
      available: module.available,
      level,
      canRead: levelSatisfies(level, 'read'),
      canWrite: levelSatisfies(level, 'write'),
    };
  });
}

/**
 * Cleans grants coming from a request: drops unknown modules, drops invalid levels,
 * and keeps the strongest grant when a module is listed more than once.
 */
export function normaliseGrants(grants = []) {
  const strongest = new Map();

  for (const grant of grants) {
    const moduleKey = grant?.module;
    const level = grant?.level;
    if (!MODULE_KEYS.includes(moduleKey)) continue;
    if (level !== 'read' && level !== 'write') continue;

    const held = strongest.get(moduleKey);
    if (!held || (held === 'read' && level === 'write')) strongest.set(moduleKey, level);
  }

  // Stored in catalogue order so a stored document is easy to read.
  return MODULE_KEYS.filter((key) => strongest.has(key)).map((key) => ({
    module: key,
    level: strongest.get(key),
  }));
}

/** The catalogue and department templates an admin screen needs to render its form. */
export const accessCatalogue = () => ({
  modules: MODULES.map(({ ownerDepartment, ...module }) => ({ ...module, ownerDepartment })),
  departments: DEPARTMENTS.map((department) => ({
    key: department.key,
    label: department.label,
    defaultAccess: defaultAccessFor(department.key),
  })),
});
