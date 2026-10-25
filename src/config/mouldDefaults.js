/**
 * The values a mould is set up with when floor planning needs one that is not on the register
 * yet [floorPlanning.service `defaultMouldFor`]: a typical two-cavity hanger tool, so the
 * planner can size the job, score the presses and propose one. Every value used is named in the
 * mould's `defaulted` list until somebody measures it and corrects the mould — the planner's
 * dates are only as good as these.
 */
export const MOULD_DEFAULTS = Object.freeze({
  cavities: 2,
  cycleTimeSeconds: 30,
  partWeightGrams: 20,
  runnerWeightGrams: 4,
  tonnage: 120,
  changeoverMinutes: 120,
  efficiencyPercent: 85,
});

/** The mould's fields those values go into, as the `defaulted` list names them. */
export const DEFAULTED_FIELDS = Object.freeze(['cavities', 'cycleTimeSeconds', 'partWeightGrams', 'runnerWeightGrams', 'machine.tonnage', 'changeoverMinutes', 'efficiencyPercent']);

/** What a patch to a mould corrects, of the defaulted fields — those leave the list. */
export const correctedBy = (patch = {}) => DEFAULTED_FIELDS.filter((field) => (field === 'machine.tonnage' ? patch.machine?.tonnage !== undefined : patch[field] !== undefined));
