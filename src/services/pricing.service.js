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
 * (Those figures are the raw arithmetic of the two conventions. Every price this file hands out
 * is then rounded up to the nearest five paise — see `priceAt`.)
 *
 * Rounded at all, because a per-piece price is quoted to two decimals and carrying fifteen of
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

/**
 * The step a quoted price is rounded to: five paise.
 *
 * A per-piece price that lands on ₹7.6534 is arithmetic, not a quote — nobody writes that on a
 * quotation, so somebody tidies it by hand and the sheet and the quotation stop agreeing. Doing
 * it here settles it once, for the tiers, the approved price and the floor alike.
 *
 * Five paise rather than a rupee because of what this plant sells: a hanger goes out at ₹6-12
 * in lots of a lakh, so rounding ₹7.05 up to ₹8 adds thirteen percent and loses the job — a
 * bigger move than the whole gap between the 10% and 15% tiers. Five paise is the smallest step
 * that reads as a decided number rather than a computed one.
 */
export const PRICE_STEP = 0.05;

/**
 * The step the **quoted** price is rounded to: ten paise, so it carries one decimal.
 *
 * The price a sheet actually puts forward — cost plus whatever margin this job is working to —
 * is the number that gets read down a phone and written on a quotation, and one decimal is what
 * a person says out loud. ₹7.65 is a computed figure; ₹7.70 is a price.
 *
 * Deliberately only the cost-plus price. The three standing tiers and the §9 floor stay on the
 * five-paise step, because they are reference figures the sheet shows *beside* the price rather
 * than the price itself — and moving the floor would change which sheets need MD's signature,
 * which is a different decision from how a quote reads.
 *
 * The visible consequence, which is worth knowing rather than discovering: the price can now
 * sit up to five paise **above** the tier column it corresponds to. A sheet at 20% on a ₹3.59
 * cost shows tiers of 3.95 / 4.15 / 4.35 and a price of ₹4.40. That is the safe direction — the
 * price is never under the tier, and never under the floor — but the two figures no longer
 * always agree to the paisa, and somebody reading the sheet will notice.
 */
export const QUOTED_PRICE_STEP = 0.1;

/**
 * Cost plus a markup, rounded **up** to a step.
 *
 * Up, never to nearest. The floor in `minimumFor` is the 10% tier run through this same
 * function, so rounding down would produce a "minimum" a few paise under the true cost-plus-ten
 * — quietly shaving the floor that §9's below-minimum approval exists to defend. Rounding up
 * can only ever be safe, and it costs at most one step less a paisa.
 *
 * Worked in whole paise (`× 100`, ceil, `/ 100`) because `Math.ceil(x / 0.05) * 0.05` in binary
 * floating point turns an exact ₹7.65 into ₹7.70: 7.65 / 0.05 is 152.99999999999997, and the
 * ceiling of that is 153. Scaling to integers first keeps a price that is already on the step
 * exactly where it is.
 */
export function priceAt(cost, percent, step = PRICE_STEP) {
  if (!cost) return undefined;

  const stepInPaise = Math.round(step * 100);
  const paise = Math.round(cost * (1 + (percent || 0) / 100) * 100);
  return (Math.ceil(paise / stepInPaise) * stepInPaise) / 100;
}

/**
 * The three standing prices for a costing, as `{ 10: 7.65, 15: 8, 20: 8.35 }`.
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
 *
 * This is the one figure on the sheet that rounds to ten paise rather than five — it is the
 * price being put forward, and a price carries one decimal. See `QUOTED_PRICE_STEP`.
 *
 * A price somebody *types* into `approvedSellingPrice` is not touched by any of this. The
 * rounding governs what the system works out; a figure a person entered is one they agreed with
 * a buyer, and moving it by five paise after the fact is how a sheet comes to disagree with a
 * conversation.
 */
export function priceFrom(pricing) {
  const cost = pricing.totalCost;
  if (!cost) return undefined;
  return priceAt(cost, pricing.markupPercent ?? MINIMUM_TIER, QUOTED_PRICE_STEP);
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
