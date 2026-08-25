/**
 * The app's feature catalogue and who may use each one.
 *
 * This is the single source of truth for access: the profile screen renders it, and any
 * feature added later should register here and reuse `authorize(...roles)` on its routes,
 * so what a user is told they can do always matches what the API actually permits.
 *
 * `available: false` marks a module that is planned but not built yet — access is still
 * defined, so the moment it ships the right people already have it.
 */
export const FEATURES = [
  {
    key: 'profile',
    label: 'My profile',
    description: 'View and update your own details.',
    group: 'Account',
    roles: ['admin', 'sales', 'production', 'inventory', 'accounts', 'viewer'],
    available: true,
  },
  {
    key: 'users',
    label: 'User management',
    description: 'Invite colleagues and set their role and department.',
    group: 'Account',
    roles: ['admin'],
    available: false,
  },
  {
    key: 'leads',
    label: 'Leads',
    description: 'Enquiries from buyers, exporters and retail chains.',
    group: 'Revenue',
    roles: ['admin', 'sales'],
    available: false,
  },
  {
    key: 'customers',
    label: 'Customers',
    description: 'Customer accounts, credit limits and payment terms.',
    group: 'Revenue',
    roles: ['admin', 'sales', 'accounts'],
    available: false,
  },
  {
    key: 'quotations',
    label: 'Quotations',
    description: 'Price offers sent to buyers.',
    group: 'Revenue',
    roles: ['admin', 'sales'],
    available: false,
  },
  {
    key: 'sales_orders',
    label: 'Sales orders',
    description: 'Confirmed orders through production and dispatch.',
    group: 'Revenue',
    roles: ['admin', 'sales', 'inventory'],
    available: false,
  },
  {
    key: 'production',
    label: 'Production',
    description: 'Moulding and assembly orders on the shop floor.',
    group: 'Plant',
    roles: ['admin', 'production'],
    available: false,
  },
  {
    key: 'catalogue',
    label: 'Hanger catalogue',
    description: 'Finished goods, moulding parameters and price list.',
    group: 'Plant',
    roles: ['admin', 'production', 'inventory', 'sales'],
    available: false,
  },
  {
    key: 'materials',
    label: 'Raw materials',
    description: 'Resin, masterbatch, wire, wood and packaging.',
    group: 'Supply chain',
    roles: ['admin', 'production', 'inventory'],
    available: false,
  },
  {
    key: 'inventory',
    label: 'Inventory',
    description: 'Stock balances, movements and adjustments.',
    group: 'Supply chain',
    roles: ['admin', 'inventory', 'production'],
    available: false,
  },
  {
    key: 'purchasing',
    label: 'Purchasing',
    description: 'Suppliers, purchase orders and goods receipt.',
    group: 'Supply chain',
    roles: ['admin', 'inventory', 'accounts'],
    available: false,
  },
  {
    key: 'invoicing',
    label: 'Invoicing',
    description: 'Tax invoices, payments and receivables.',
    group: 'Finance',
    roles: ['admin', 'accounts'],
    available: false,
  },
];

/** Admin passes every check, mirroring the authorize middleware. */
export const roleHasFeature = (role, feature) =>
  role === 'admin' || feature.roles.includes(role);

/** The full catalogue annotated with whether this role may use each entry. */
export const featuresForRole = (role) =>
  FEATURES.map(({ roles, ...feature }) => ({
    ...feature,
    allowed: roleHasFeature(role, { roles }),
  }));
