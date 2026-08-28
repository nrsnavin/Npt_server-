/**
 * The one piece of arithmetic on a costing sheet, kept where both the model and the controller
 * can reach it.
 *
 * Selling price from cost and margin, and the definition matters. A "20% margin" in this trade
 * means twenty percent *of the selling price*, not twenty percent added to cost — the two
 * differ by more than people expect (₹10 at 20% is ₹12.50, not ₹12), and quoting the second
 * while believing the first is how a job that looked profitable is not.
 *
 * Rounded to paise, because a per-piece price is quoted to two decimals and carrying fifteen
 * of them means the total on the quote and the total anybody recomputes disagree in the last
 * digit.
 */
export function priceFrom(pricing) {
  const cost = pricing.totalCost;
  if (!cost) return undefined;

  const margin = pricing.targetMargin || 0;
  // A 100% margin has no finite price; treat it as "no margin applied" rather than dividing by
  // zero and writing Infinity into the sheet.
  if (margin >= 100) return Math.round(cost * 100) / 100;

  return Math.round((cost / (1 - margin / 100)) * 100) / 100;
}
