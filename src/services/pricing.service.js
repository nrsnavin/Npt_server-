/**
 * The arithmetic on a costing sheet, kept where both the model and the controller can reach it.
 *
 * **Markup on cost, not margin on price.** The plant's own quotation sheet works in markup: the
 * three standing tiers are `net total × 1.10`, `× 1.15` and `× 1.20`, and the figure it calls
 * the minimum selling price is the first of them. Verified against every row of the 26-27
 * sheet — 25 of 25 match `cost × (1 + pct/100)`, and 1 of 25 matches `cost / (1 - pct/100)`,
 * which is the coincidence you would expect at a small percentage.
 *
 * This file used to do the opposite, with a comment insisting that a "20% margin" means twenty
 * percent of the selling price. That is a real convention and it is not the one this business
 * uses. The difference is small where the percentage is small and not small anywhere else: on a
 * ₹6.95 cost, 10% is ₹7.65 either way to within a paisa, 20% is ₹8.34 against ₹8.69, and 40% is
 * ₹9.73 against ₹11.58. Quoting the second while the sheet says the first is how a price gets
 * argued about in a meeting nobody can settle.
 *
 * Rounded to paise, because a per-piece price is quoted to two decimals and carrying fifteen of
 * them means the total on the quotation and the total anybody recomputes disagree in the last
 * digit.
 */

/** The tiers the sheet always shows side by side, so a price is chosen rather than typed. */
export const STANDARD_TIERS = [10, 15, 20];

/**
 * The lowest tier, which is what the sheet calls the minimum selling price.
 *
 * Named rather than written as `STANDARD_TIERS[0]` at each call site: it is a decision about
 * where the floor sits, not an accident of which tier happens to be listed first.
 */
export const MINIMUM_TIER = STANDARD_TIERS[0];

/** Cost plus a markup, to paise. */
export function priceAt(cost, percent) {
  if (!cost) return undefined;
  return Math.round(cost * (1 + (percent || 0) / 100) * 100) / 100;
}

/**
 * The three standing prices for a costing, as `{ 10: 7.65, 15: 7.99, 20: 8.34 }`.
 *
 * All of them, always, because the sheet puts them side by side and the person quoting picks
 * one. Handing back a single number would make that judgement invisible — and it is the
 * judgement, not the arithmetic, that decides whether a job is worth taking.
 */
export function tiersFor(cost) {
  if (!cost) return {};
  return Object.fromEntries(STANDARD_TIERS.map((percent) => [percent, priceAt(cost, percent)]));
}

/**
 * The calculated selling price: cost at whatever markup this sheet is working to.
 *
 * Defaults to the minimum tier rather than to zero, so a sheet where nobody has said otherwise
 * still produces the price the plant would quote by standing policy.
 */
export function priceFrom(pricing) {
  const cost = pricing.totalCost;
  if (!cost) return undefined;
  return priceAt(cost, pricing.markupPercent ?? MINIMUM_TIER);
}

/**
 * The floor, which is derived rather than typed.
 *
 * On the sheet the minimum selling price *is* the 10% column — it is not a separate judgement
 * somebody enters, it is standing policy applied to this cost. Asking for it again would invite
 * a number that disagrees with the arithmetic beside it.
 *
 * An explicit override is still honoured, because a particular buyer or a particular job
 * sometimes has a floor of its own, and a rule with no exception is one people work around by
 * putting the real number somewhere the system cannot see.
 */
export function minimumFor(pricing) {
  if (pricing.minimumOverride != null) return pricing.minimumOverride;
  return priceAt(pricing.totalCost, MINIMUM_TIER);
}
