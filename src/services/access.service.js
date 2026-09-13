import {
  MODULES,
  MODULE_KEYS,
  DEPARTMENTS,
  RETIRED_MODULES,
  levelSatisfies,
  levelsFor,
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

  const grants = user.moduleAccess || [];
  const grant = grants.find((entry) => entry.module === moduleKey);
  if (grant?.level) return grant.level;

  /*
   * A grant naming a module that no longer exists, read as the module that absorbed it.
   *
   * Access is whatever is stored on the user, so merging quotations into pricing would have
   * taken marketing's ability to quote away the moment it deployed — before anybody could run
   * the migration, and with no error to explain it. Read-time is the only place that can be
   * true on the first request after a deploy. The migration then makes it permanent; until it
   * has run, or if an old export is restored afterwards, this is what keeps the grant meaning
   * what the admin who wrote it meant.
   */
  const retired = Object.entries(RETIRED_MODULES)
    .filter(([, target]) => target.module === moduleKey)
    .map(([key, target]) => target.levels[grants.find((e) => e.module === key)?.level])
    .filter(Boolean);

  /* Strongest wins, the same rule normaliseGrants applies to a duplicate. */
  return retired.sort((a, b) => (levelSatisfies(a, b) ? -1 : 1))[0] || null;
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
      levels: levelsFor(module.key),
      level,
      canRead: levelSatisfies(level, 'read'),
      /* The middle level, for the one module that has one. The client needs it to decide
         whether to offer a Raise a quote button to somebody who may not touch the costing. */
      canQuote: levelSatisfies(level, 'quote'),
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

  for (const raw of grants) {
    /* A grant for a module that has been absorbed is rewritten rather than dropped — the same
       reading `accessLevel` does, made permanent the next time the user is saved. */
    const retired = RETIRED_MODULES[raw?.module];
    const grant = retired
      ? { module: retired.module, level: retired.levels[raw?.level] }
      : raw;

    const moduleKey = grant?.module;
    const level = grant?.level;
    if (!MODULE_KEYS.includes(moduleKey)) continue;
    /* Against what this module offers, not against the global list: `quote` is pricing's and
       granting it on despatch would store a level that satisfies nothing and reads as access. */
    if (!levelsFor(moduleKey).includes(level)) continue;

    const held = strongest.get(moduleKey);
    if (!held || levelSatisfies(level, held)) strongest.set(moduleKey, level);
  }

  // Stored in catalogue order so a stored document is easy to read.
  return MODULE_KEYS.filter((key) => strongest.has(key)).map((key) => ({
    module: key,
    level: strongest.get(key),
  }));
}

/** The catalogue and department templates an admin screen needs to render its form. */
export const accessCatalogue = () => ({
  modules: MODULES.map(({ ownerDepartment, ...module }) => ({
    ...module,
    ownerDepartment,
    /* Named per module so the access form offers what that module actually has, rather than
       three buttons everywhere and two of them meaning the same thing. */
    levels: levelsFor(module.key),
  })),
  departments: DEPARTMENTS.map((department) => ({
    key: department.key,
    label: department.label,
    defaultAccess: defaultAccessFor(department.key),
  })),
});
