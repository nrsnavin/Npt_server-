import ApiError from '../utils/ApiError.js';

/**
 * Who may see what on a costing sheet [BLUEPRINT §8].
 *
 * This is the one rule the module system cannot express. A grant says whether you may open
 * pricing at all; §8 says that *within* a sheet you may open, marketing sees the quoted price,
 * the validity and the terms — and never the raw material rate, the full cost, the gross margin
 * or the minimum approved price. The blueprint is explicit that enforcing it is the module's
 * own job, and it is worth being clear about why: those figures are what a competitor would
 * pay for, and what a departing salesperson could take with them.
 *
 * **Redacted on the way out, in one function.** Not by asking each endpoint to remember which
 * fields to strip — that is a rule with as many copies as there are routes, and the copy
 * somebody forgets is the leak. Every path that returns a costing goes through `visibleTo`.
 *
 * **Deny by default.** `CONFIDENTIAL` lists what to remove rather than `ALLOWED` listing what
 * to keep, which is the weaker of the two shapes — a field added to the model later is visible
 * until somebody remembers. So the test that guards this walks the *model's own paths* and
 * fails on any money-shaped field that is neither listed as confidential nor as public: adding
 * a cost line to the sheet without deciding who may see it breaks the build.
 */

/**
 * The figures §8 keeps to management and costing.
 *
 * `cost` is the whole sub-document: every line in it is a component of the full cost, so
 * naming them individually would be a list to keep in step with the schema.
 */
export const CONFIDENTIAL = [
  'cost',
  'materialCost',
  'totalCost',
  'grossMarginPercent',
  'targetMargin',
  'minimumSellingPrice',
];

/**
 * Money-shaped fields that marketing is *meant* to see, named so the guard test can tell the
 * difference between "decided to be public" and "nobody has thought about it yet".
 */
export const PUBLIC_FIGURES = [
  'approvedSellingPrice',
  'calculatedSellingPrice',
  'targetPrice',
  'quantity',
];

/**
 * True when this person may see the confidential half.
 *
 * Read off the pricing grant rather than the department: §7 notes this organisation has no
 * costing team so `pricing: write` sits with management, and that granting a marketing person
 * pricing rights should put them inside the sheet without anything here changing.
 */
export const seesCosting = (user) =>
  user?.role === 'admin' ||
  (user?.moduleAccess || []).some((grant) => grant.module === 'pricing' && grant.level === 'write');

/**
 * One costing, as this person is allowed to see it.
 *
 * A marketing reader still learns the one thing they need about the floor — whether the price
 * is under it, and therefore whether they may quote yet — without learning where the floor is.
 * That distinction is the whole design: the block has to be explainable, or it reads as the
 * system being broken.
 */
export function visibleTo(pricing, user) {
  const plain = typeof pricing?.toJSON === 'function' ? pricing.toJSON() : { ...pricing };
  if (seesCosting(user)) return plain;

  for (const field of CONFIDENTIAL) delete plain[field];

  /*
   * Kept: facts about what may happen next, not figures. `needsApproval` is the one the screen
   * should show — a sheet MD has signed off is still under the floor and is cleared to quote,
   * and saying "needs approval" beside a badge reading Approved is the screen contradicting
   * itself.
   */
  plain.belowMinimum = Boolean(pricing.belowMinimum);
  plain.needsApproval = Boolean(pricing.needsApproval);
  plain.costingHidden = true;
  return plain;
}

export const allVisibleTo = (rows, user) => rows.map((row) => visibleTo(row, user));

/**
 * Refuses a write that only costing may make.
 *
 * Reading is split by field; writing is not split at all — building the sheet is costing's job
 * end to end. Marketing raising the request and reading the answer is the whole of their part.
 */
export function assertMayCost(user) {
  if (!seesCosting(user)) {
    throw ApiError.forbidden('Only costing or management can build a costing sheet');
  }
}
