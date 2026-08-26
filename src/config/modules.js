/**
 * Modules, departments and the access model.
 *
 * Access is granted per user, per module, at one of two levels. A user may use a module
 * only if they hold a grant for it; the level decides whether they may change anything.
 * Admins bypass grants entirely.
 *
 * Departments are organisational, not permissions — but each carries a default set of
 * grants, so allocating someone to a department proposes a sensible starting point that
 * the admin can then adjust. What is stored on the user is always the explicit grant,
 * never the department, so access stays auditable and a department change never silently
 * alters what somebody can already do.
 */

/** Ordered weakest to strongest; `write` implies `read`. */
export const ACCESS_LEVELS = ['read', 'write'];

const LEVEL_RANK = { read: 1, write: 2 };

/**
 * The business workflow, in the order work moves through the factory.
 * `stage` positions a module on that chain; masters and administration sit outside it.
 */
export const MODULES = [
  {
    key: 'samples',
    label: 'Samples',
    description: 'Sample requests, development and buyer approval.',
    group: 'Pre-sales',
    stage: 1,
    ownerDepartment: 'sampling',
    available: false,
  },
  {
    key: 'orders',
    label: 'Orders',
    description: 'Order confirmation, sales orders and delivery schedules.',
    group: 'Sales',
    stage: 2,
    ownerDepartment: 'order_confirmation',
    available: false,
  },
  {
    key: 'production',
    label: 'Production',
    description: 'Production planning, shop floor issue and output.',
    group: 'Plant',
    stage: 3,
    ownerDepartment: 'production',
    available: false,
  },
  {
    key: 'quality',
    label: 'Quality',
    description: 'In-process checks, final inspection and rejections.',
    group: 'Plant',
    stage: 4,
    ownerDepartment: 'quality',
    available: false,
  },
  {
    key: 'despatch',
    label: 'Despatch',
    description: 'Packing, dispatch documents and delivery tracking.',
    group: 'Fulfilment',
    stage: 5,
    ownerDepartment: 'despatch',
    available: false,
  },
  {
    key: 'accounts',
    label: 'Accounts',
    description: 'Invoices, payments and receivables.',
    group: 'Finance',
    stage: 6,
    ownerDepartment: 'accounts',
    available: false,
  },
  {
    key: 'communications',
    label: 'Communications',
    description: 'Buyer correspondence, notices and follow-ups.',
    group: 'Sales',
    stage: null,
    ownerDepartment: 'communications',
    available: false,
  },
  {
    key: 'customers',
    label: 'Customers',
    description: 'Customer master, contacts and payment terms.',
    group: 'Masters',
    stage: null,
    ownerDepartment: 'order_confirmation',
    available: false,
  },
  {
    key: 'catalogue',
    label: 'Hanger catalogue',
    description: 'Hanger SKUs, specifications and price list.',
    group: 'Masters',
    stage: null,
    ownerDepartment: 'sampling',
    available: false,
  },
  {
    key: 'inventory',
    label: 'Inventory',
    description: 'Raw material and finished goods stock.',
    group: 'Plant',
    stage: null,
    ownerDepartment: 'production',
    available: false,
  },
  {
    key: 'users',
    label: 'User administration',
    description: 'Create accounts, allocate departments and grant module access.',
    group: 'Administration',
    stage: null,
    ownerDepartment: 'management',
    available: true,
  },
];

export const MODULE_KEYS = MODULES.map((module) => module.key);

/**
 * Defaults describe the access a department normally needs: write on what it owns,
 * read on what it must see to do its job.
 */
export const DEPARTMENTS = [
  {
    key: 'sampling',
    label: 'Sample team',
    defaultAccess: { samples: 'write', catalogue: 'write', customers: 'read', orders: 'read' },
  },
  {
    key: 'order_confirmation',
    label: 'Order confirmation team',
    defaultAccess: {
      orders: 'write',
      customers: 'write',
      samples: 'read',
      catalogue: 'read',
      production: 'read',
      despatch: 'read',
    },
  },
  {
    key: 'production',
    label: 'Production department',
    defaultAccess: {
      production: 'write',
      inventory: 'write',
      orders: 'read',
      quality: 'read',
      catalogue: 'read',
      samples: 'read',
    },
  },
  {
    key: 'quality',
    label: 'Quality team',
    defaultAccess: {
      quality: 'write',
      production: 'read',
      orders: 'read',
      despatch: 'read',
      catalogue: 'read',
    },
  },
  {
    key: 'despatch',
    label: 'Despatch team',
    defaultAccess: {
      despatch: 'write',
      inventory: 'read',
      orders: 'read',
      quality: 'read',
      customers: 'read',
    },
  },
  {
    key: 'accounts',
    label: 'Accounts department',
    defaultAccess: { accounts: 'write', orders: 'read', customers: 'read', despatch: 'read' },
  },
  {
    key: 'communications',
    label: 'Communications team',
    defaultAccess: {
      communications: 'write',
      customers: 'write',
      orders: 'read',
      samples: 'read',
      despatch: 'read',
    },
  },
  {
    key: 'management',
    label: 'Management',
    defaultAccess: Object.fromEntries(MODULE_KEYS.map((key) => [key, 'write'])),
  },
];

export const DEPARTMENT_KEYS = DEPARTMENTS.map((department) => department.key);

export const findModule = (key) => MODULES.find((module) => module.key === key);
export const findDepartment = (key) => DEPARTMENTS.find((department) => department.key === key);

/** True when `held` satisfies a requirement for `required`. */
export const levelSatisfies = (held, required) =>
  Boolean(held) && LEVEL_RANK[held] >= LEVEL_RANK[required];

/** The grants a department suggests, as a storable array. */
export function defaultAccessFor(departmentKey) {
  const department = findDepartment(departmentKey);
  if (!department) return [];

  return Object.entries(department.defaultAccess)
    .filter(([module]) => MODULE_KEYS.includes(module))
    .map(([module, level]) => ({ module, level }));
}
