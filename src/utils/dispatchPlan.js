/**
 * How an enquiry's goods go out [Enquiry `dispatchPlan`]: `together` — one consignment, every
 * model waits for the last — or `by_model` — each model on its own way, from its own EDD to its
 * own dispatch, a ready model going to Dispatch while the others are still being made.
 *
 * The enquiry's own choice (marketing's or Admin's) wins. Without one, an enquiry of several
 * models goes model by model and an enquiry of one goes together: the models of one enquiry do
 * not wait for each other unless the buyer wants them in one consignment.
 *
 * Reads `dispatchPlan` and `items` — select both.
 */
export const DISPATCH_PLAN_FIELDS = 'dispatchPlan items.modelNumber items.mould';

export function dispatchModeOf(enquiry) {
  const chosen = enquiry?.dispatchPlan?.mode;
  if (chosen === 'by_model' || chosen === 'together') return chosen;
  const models = (enquiry?.items || []).filter((item) => item && (String(item.modelNumber || '').trim() || item.mould));
  return models.length > 1 ? 'by_model' : 'together';
}

/** The plan as a screen reads it: the mode, whether somebody chose it, and who and when. */
export const dispatchPlanOf = (enquiry) => ({
  ...(enquiry?.dispatchPlan?.mode ? enquiry.dispatchPlan : {}),
  mode: dispatchModeOf(enquiry),
  chosen: Boolean(enquiry?.dispatchPlan?.mode),
});
