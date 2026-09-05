/**
 * Modules, departments and the access model.
 *
 * The catalogue follows the Navin Plastic Tech CRM blueprint (docs/BLUEPRINT.md), which
 * describes a Customer Order Lifecycle CRM rather than a sales CRM: one master record
 * carries an order from the first WhatsApp message through sampling, pricing, quotation,
 * PO, production, quality, dispatch and payment, and completing a stage hands the next
 * department its task automatically.
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
 *
 * `available` marks what is actually built. The unbuilt entries exist so access is defined
 * ahead of the feature, and so the blueprint's module map has one home in the code.
 */

/** Ordered weakest to strongest; `write` implies `read`. */
export const ACCESS_LEVELS = ['read', 'write'];

const LEVEL_RANK = { read: 1, write: 2 };

/**
 * `stage` places a module on the order lifecycle, in the order work actually moves.
 * Masters, communication, workspace tools and administration sit outside that chain and
 * carry null. `blueprint` names the section of docs/BLUEPRINT.md that specifies the module.
 * `deferred` marks a module deliberately held back, with the reason.
 *
 * The blueprint opens the lifecycle with WhatsApp, but that integration is wired up last.
 * Manual entry is the primary way data gets in, and stays that way permanently — walk-ins,
 * phone calls, trade shows and email are never going to arrive over WhatsApp. When the
 * integration lands it adds a source; it does not become the only one, so nothing on the
 * chain may assume a conversation exists. See BLUEPRINT §8.
 */
export const MODULES = [
  {
    key: 'enquiries',
    label: 'Leads & enquiries',
    description: 'The first customer requirement: product, quantity, target price and required date, with a next action always set.',
    group: 'Pipeline',
    stage: 1,
    ownerDepartment: 'marketing',
    blueprint: '3',
    available: true,
  },
  {
    key: 'samples',
    label: 'Sampling',
    description: 'Sample requests raised from an enquiry, through preparation, dispatch and customer approval.',
    group: 'Pipeline',
    stage: 2,
    ownerDepartment: 'sampling',
    blueprint: '4-6',
    available: true,
  },
  {
    key: 'pricing',
    label: 'Pricing & costing',
    description: 'Cost build-up, calculated and approved selling price, and the approval route below the minimum price.',
    group: 'Pipeline',
    stage: 3,
    ownerDepartment: 'management',
    blueprint: '7-9',
    available: true,
  },
  {
    key: 'quotations',
    label: 'Quotations',
    description: 'Quotations with full revision history, and the negotiation that follows them.',
    group: 'Pipeline',
    stage: 4,
    ownerDepartment: 'marketing',
    blueprint: '10-11',
    available: true,
  },
  {
    key: 'orders',
    label: 'Sales orders',
    description:
      'Customer PO capture, the eight-check verification gate, and release to production once every one of them is ticked.',
    group: 'Pipeline',
    stage: 5,
    ownerDepartment: 'order_confirmation',
    blueprint: '12-13',
    available: true,
  },
  {
    key: 'production',
    label: 'Production status',
    description:
      'Customer-facing visibility per order line: planned, made, packed and still to make, with the date the plant agreed.',
    group: 'Pipeline',
    stage: 6,
    ownerDepartment: 'production',
    blueprint: '14-17',
    available: true,
  },
  {
    key: 'quality',
    label: 'Quality',
    description: 'In-process and final inspection, passed quantity and quality holds against a production order.',
    group: 'Pipeline',
    stage: 7,
    ownerDepartment: 'quality',
    blueprint: '15',
    available: false,
  },
  {
    key: 'dispatch',
    label: 'Dispatch',
    description:
      'Consignments raised against packed stock, through packing, loading, invoice, LR and delivery — with what is reserved and what is still free to send.',
    group: 'Pipeline',
    stage: 8,
    ownerDepartment: 'despatch',
    blueprint: '18-19',
    available: true,
  },
  {
    key: 'payments',
    label: 'Payments',
    description: 'Invoice value, due date, amount received, balance and follow-up, visible to accounts and marketing.',
    group: 'Pipeline',
    stage: 9,
    ownerDepartment: 'accounts',
    blueprint: '20',
    available: false,
  },

  {
    key: 'customers',
    label: 'Customers',
    description: 'One master record per customer, with the full timeline of enquiries, samples, orders, dispatch and payments.',
    group: 'Masters',
    stage: null,
    ownerDepartment: 'marketing',
    blueprint: '2',
    available: true,
  },
  {
    key: 'materials',
    label: 'Material & parts registers',
    description:
      'What a piece is made of and what goes on it: resins by the kilo with their grammage uplift, and hooks, clips and printing by the piece.',
    group: 'Masters',
    /*
     * Production's, alongside the mould register. The rate is a purchase fact and the grammage
     * factor is a shop-floor one, and the people who know both are the people who buy and run
     * the material. Costing reads it; nobody else needs to.
     */
    ownerDepartment: 'production',
    stage: null,
    blueprint: '7',
    available: true,
  },
  {
    key: 'moulds',
    label: 'Mould & model register',
    description:
      'Every tool on the floor, and therefore every model: code, category, size, hook and minimum order, alongside cavities, part and runner weight, cycle time and machine, with resin consumption and output per hour derived from them.',
    group: 'Masters',
    /*
     * Production's, not sampling's. A mould is a machine asset — the people who know what a
     * cavity is doing today are the people standing next to the press, and the weights and
     * cycle times on it are measured on the shop floor rather than agreed with a customer.
     * Everyone downstream reads it; only the plant writes it.
     *
     * This register absorbed the product master, which used to be a second Masters entry on
     * sampling's grant. Two registers describing one steel tool disagreed the first week —
     * the catalogue carried a hand-ticked `mouldAvailable` beside the register that already
     * knew the answer — and every screen had to decide which of them to believe. The tool is
     * the thing that exists, so the tool is the record.
     */
    ownerDepartment: 'production',
    stage: null,
    blueprint: '28',
    available: true,
  },

  {
    key: 'whatsapp',
    label: 'WhatsApp inbox',
    description: 'The front door: incoming messages matched to customers, de-duplicated, assigned and converted to enquiries.',
    group: 'Communication',
    stage: null,
    ownerDepartment: 'marketing',
    blueprint: '41',
    available: false,
    /**
     * Held back until every other module is built. It feeds the enquiry module rather than
     * replacing it: manual entry is the primary path and remains fully supported after this
     * lands, because most enquiries will never arrive over WhatsApp.
     */
    deferred: 'Automated last. Data is entered manually until then, and manual entry stays.',
  },
  {
    key: 'customer_comms',
    label: 'Send to customer',
    description: 'Outbound updates over WhatsApp or email, with preview, edit and a full audit trail.',
    group: 'Communication',
    stage: null,
    ownerDepartment: 'marketing',
    blueprint: '42',
    available: true,
  },
  {
    key: 'announcements',
    label: 'Announcements',
    description: 'Internal notices published to the whole plant or to chosen teams.',
    group: 'Workspace',
    stage: null,
    ownerDepartment: 'management',
    blueprint: '26',
    available: true,
  },
  {
    key: 'tasks',
    label: 'Tasks & follow-ups',
    description: 'Departmental tasks created automatically as stages complete, plus the next-action discipline on every open record.',
    group: 'Workspace',
    stage: null,
    ownerDepartment: 'marketing',
    blueprint: '35',
    available: false,
  },
  {
    key: 'reports',
    label: 'Reports & dashboards',
    description: 'Marketing, department and MD exception dashboards, conversion rates and the weekly review.',
    group: 'Workspace',
    stage: null,
    ownerDepartment: 'management',
    blueprint: '21-24, 37-38',
    available: false,
  },

  {
    key: 'users',
    label: 'User administration',
    description: 'Create accounts, allocate departments and grant module access.',
    group: 'Administration',
    stage: null,
    ownerDepartment: 'management',
    blueprint: '29',
    available: true,
  },
];

export const MODULE_KEYS = MODULES.map((module) => module.key);

/**
 * Defaults follow the blueprint's permission section: write on what a department owns,
 * read on what it must see to do its job without telephoning another department.
 *
 * The blueprint names a separate costing function and a communications function; this
 * organisation has neither as its own team. The `pricing`, `whatsapp` and `customer_comms`
 * modules still exist — costing and announcements sit with management, and the WhatsApp
 * front door and customer messages sit with marketing, who own the customer anyway.
 *
 * Two limits are worth knowing. Pricing is granted to marketing as read, but the
 * blueprint also restricts *which fields* they see — marketing gets quoted price, MOQ,
 * validity and terms, never the cost build-up or margin. And `customer_comms` write is
 * deliberately narrow: operational departments update internal status only, and outbound
 * customer messages stay with marketing and management. Neither is expressible as a
 * module level, so both must be enforced inside those modules when they are built.
 */
export const DEPARTMENTS = [
  {
    key: 'marketing',
    label: 'Marketing',
    defaultAccess: {
      enquiries: 'write',
      quotations: 'write',
      customers: 'write',
      customer_comms: 'write',
      whatsapp: 'write',
      tasks: 'write',
      samples: 'read',
      pricing: 'read',
      orders: 'read',
      production: 'read',
      quality: 'read',
      dispatch: 'read',
      payments: 'read',
      /*
       * The model master, read-only. Marketing picks a model off it on every enquiry, sample
       * and quotation, and needs to see whether a tool exists and who paid for it before
       * anything is offered — but what a cavity weighs is not marketing's to change.
       */
      moulds: 'read',
      materials: 'read',
      reports: 'read',
      announcements: 'read',
    },
  },
  {
    key: 'sampling',
    label: 'Sample team',
    defaultAccess: {
      samples: 'write',
      /* New models are developed here, and a new model is a new tool before it is anything. */
      moulds: 'write',
      materials: 'read',
      tasks: 'write',
      enquiries: 'read',
      customers: 'read',
      announcements: 'read',
    },
  },
  {
    key: 'order_confirmation',
    label: 'Order confirmation team',
    defaultAccess: {
      orders: 'write',
      customers: 'write',
      tasks: 'write',
      enquiries: 'read',
      quotations: 'read',
      samples: 'read',
      pricing: 'read',
      production: 'read',
      dispatch: 'read',
      moulds: 'read',
      materials: 'read',
      announcements: 'read',
    },
  },
  {
    key: 'production',
    label: 'Production department',
    defaultAccess: {
      production: 'write',
      /* The register's home: cavities, cycles and weights are measured at the press. */
      moulds: 'write',
      materials: 'write',
      tasks: 'write',
      orders: 'read',
      quality: 'read',
      samples: 'read',
      announcements: 'read',
    },
  },
  {
    key: 'quality',
    label: 'Quality team',
    defaultAccess: {
      quality: 'write',
      tasks: 'write',
      production: 'read',
      orders: 'read',
      samples: 'read',
      moulds: 'read',
      materials: 'read',
      announcements: 'read',
    },
  },
  {
    key: 'despatch',
    label: 'Despatch team',
    defaultAccess: {
      dispatch: 'write',
      tasks: 'write',
      orders: 'read',
      production: 'read',
      quality: 'read',
      customers: 'read',
      announcements: 'read',
    },
  },
  {
    key: 'accounts',
    label: 'Accounts department',
    defaultAccess: {
      payments: 'write',
      tasks: 'write',
      orders: 'read',
      customers: 'read',
      dispatch: 'read',
      announcements: 'read',
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

/** The order lifecycle, in sequence — the spine the blueprint is built around. */
export const lifecycle = () =>
  MODULES.filter((module) => module.stage !== null).sort((a, b) => a.stage - b.stage);

/** Modules deliberately held back, and why. */
export const deferredModules = () => MODULES.filter((module) => module.deferred);

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
