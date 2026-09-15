/**
 * Modules, departments and the access model.
 *
 * The catalogue follows the Navin Plastic Tech CRM blueprint (docs/BLUEPRINT.md), which
 * describes a Customer Order Lifecycle CRM rather than a sales CRM: one master record
 * carries an order from the first WhatsApp message through sampling, pricing, quotation,
 * PO, production, quality, dispatch and payment, and completing a stage hands the next
 * department its task automatically.
 *
 * Access is granted per user, per module, at one of the levels that module offers. A user may
 * use a module only if they hold a grant for it; the level decides whether they may change
 * anything. Most modules offer read and write; pricing offers a third in between, because it
 * holds two jobs — quoting and costing — that §8 says the same person may not always do.
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

/**
 * Ordered weakest to strongest; each level implies the ones below it.
 *
 * `quote` exists for exactly one module and is the reason pricing and quotations could become
 * one. §8 splits a costing sheet down the middle — marketing may see the price the plant will
 * sell at, and never the cost, the margin or the floor underneath it — and while quoting lived
 * in its own module that split was expressible as two grants. Merged, it is not: write on the
 * merged module would hand the person raising the quote the whole cost base, which is the one
 * thing §8 exists to stop.
 *
 * So the level sits between the two. Someone holding `quote` may do everything quoting needs —
 * read the sheet, set the selling price, raise, revise and send the document — and still sees
 * a sheet with the cost half redacted, exactly as they did before the merge.
 *
 * Most modules have no use for it, so most do not offer it: see `levelsFor`.
 */
export const ACCESS_LEVELS = ['read', 'quote', 'write'];

const LEVEL_RANK = { read: 1, quote: 2, write: 3 };

/** What a module without its own opinion offers. */
const DEFAULT_LEVELS = ['read', 'write'];

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
  /*
   * Costing and quoting, in one module.
   *
   * They were two, and the seam between them was in the wrong place. A costing exists to
   * produce a quotation and a quotation exists to carry a costing's price to a buyer; splitting
   * them meant two screens, two grants and two lists for one question — what are we charging
   * this customer for this model, and what did they say.
   *
   * What the split was really carrying was §8, and §8 is about *fields*, not about modules. It
   * is now carried by the `quote` level, which is where it belonged: one module, and inside it
   * the same wall between the price and the cost behind it.
   */
  {
    key: 'pricing',
    label: 'Pricing & quotations',
    description:
      'Cost build-up, the approved selling price and the approval route below the minimum, ' +
      'and the quotations raised off it with their full revision history.',
    group: 'Pipeline',
    stage: 3,
    ownerDepartment: 'management',
    blueprint: '7-11',
    available: true,
    /*
     * The middle level is marketing's. They quote, and they must not see the cost — see the
     * note on ACCESS_LEVELS. No other module has two different jobs inside one record, so no
     * other module offers it.
     */
    levels: ['read', 'quote', 'write'],
  },
  {
    key: 'orders',
    label: 'Sales orders',
    description:
      'Customer PO capture, the eight-check verification gate, and release to production once every one of them is ticked.',
    group: 'Pipeline',
    stage: 4,
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
    stage: 5,
    ownerDepartment: 'production',
    blueprint: '14-17',
    available: true,
  },
  {
    key: 'quality',
    label: 'Quality',
    description: 'In-process and final inspection, passed quantity and quality holds against a production order.',
    group: 'Pipeline',
    stage: 6,
    ownerDepartment: 'quality',
    blueprint: '15',
    available: true,
  },
  {
    key: 'dispatch',
    label: 'Dispatch',
    description:
      'Consignments raised against packed stock, through packing, loading, invoice, LR and delivery — with what is reserved and what is still free to send.',
    group: 'Pipeline',
    stage: 7,
    ownerDepartment: 'despatch',
    blueprint: '18-19',
    available: true,
  },
  {
    key: 'payments',
    label: 'Payments',
    description: 'Invoice value, due date, amount received, balance and follow-up, visible to accounts and marketing.',
    group: 'Pipeline',
    stage: 8,
    ownerDepartment: 'accounts',
    blueprint: '20',
    available: true,
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
    available: true,
    /*
     * Built last, as planned, and it feeds the enquiry module rather than replacing it. Manual
     * entry is still the primary path and stays fully supported: walk-ins, phone calls, trade
     * shows and email are never going to arrive over WhatsApp, so nothing downstream may assume
     * a conversation exists behind a record.
     */
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
      customers: 'write',
      customer_comms: 'write',
      whatsapp: 'write',
      tasks: 'write',
      samples: 'read',
      /*
       * Quoting, without the cost behind it — the level that exists for this one line. Marketing
       * raises, revises and sends the quotation and sets the price on it; what the piece costs
       * to make, what the margin is and where the floor sits stay redacted [§8].
       */
      pricing: 'quote',
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
      samples: 'read',
      /* Reading the quote the order came off, and the costing under it stays redacted. */
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

/**
 * The levels this module actually offers.
 *
 * Asked rather than assumed, because `quote` is meaningless everywhere except pricing and an
 * access screen that offered it on despatch would be inviting an admin to grant something that
 * does nothing. A level the module does not offer is refused on the way in [`normaliseGrants`],
 * so this is the one list and not merely a hint to the form.
 */
export const levelsFor = (moduleKey) => findModule(moduleKey)?.levels || DEFAULT_LEVELS;

/**
 * Grants that no longer name a module, mapped onto the one that absorbed it.
 *
 * Merging quotations into pricing changes what is stored on every user who held it, and the
 * stored grant is the whole of what access is — so without this, the merge would silently
 * remove marketing's ability to quote at the moment it deployed. The migration rewrites them
 * properly; this is what makes the deployment safe before it runs, and what makes an old
 * export or a restored backup still mean something.
 *
 * `write` on the old quotations module is `quote` on the new one, deliberately: it was never
 * permission to see a cost, and turning it into one would leak the cost base to every marketing
 * person the day this shipped.
 */
export const RETIRED_MODULES = {
  quotations: { module: 'pricing', levels: { read: 'read', write: 'quote' } },
};

/** The grants a department suggests, as a storable array. */
export function defaultAccessFor(departmentKey) {
  const department = findDepartment(departmentKey);
  if (!department) return [];

  return Object.entries(department.defaultAccess)
    .filter(([module]) => MODULE_KEYS.includes(module))
    .map(([module, level]) => ({ module, level }));
}
