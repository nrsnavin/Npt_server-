import Inspection, { HOLDING_VERDICTS } from '../models/Inspection.js';
import { env } from '../config/env.js';

/**
 * What a line's or a consignment's inspections amount to [§15].
 *
 * Kept out of the controllers because three screens ask the same question in three different
 * words — the plant's line list wants "is this held", the despatch gate wants "has this been
 * checked", the order wants "what did quality find" — and three implementations of *the latest
 * verdict* would eventually disagree about whether goods are fit to send.
 *
 * The rule throughout is **the latest inspection wins, per stage**. A lot rejected on Monday and
 * re-inspected on Wednesday after the rejects were pulled is a passed lot; a system that
 * remembered only the failure would hold it forever, and one that remembered only the pass would
 * lose that it ever failed. So the history is kept whole and the *state* is the newest one.
 */

/** The one sort every reader wants: newest first, because the newest is the answer. */
const NEWEST = { inspectedAt: -1, createdAt: -1 };

/**
 * The verdict standing against one line, and what was found.
 *
 * `pre_dispatch` checks are excluded deliberately: they are statements about one lorry, not about
 * the line, and letting a failed check on Tuesday's load hold Friday's would stop goods that were
 * never in question.
 */
export async function lineQuality(lineId) {
  const history = await Inspection.find({ line: lineId, stage: { $in: ['in_process', 'final'] } })
    .sort(NEWEST)
    .limit(20);

  const latest = history[0] || null;

  return {
    latest,
    inspections: history.length,
    /* Held on the newest verdict alone. See the note above on re-inspection. */
    held: Boolean(latest && HOLDING_VERDICTS.includes(latest.verdict)),
    /* Everything ever rejected on this line, which is what a costing of scrap reads. */
    rejected: history.reduce((sum, row) => sum + (row.quantityRejected || 0), 0),
    inspected: history.reduce((sum, row) => sum + (row.quantityInspected || 0), 0),
  };
}

/**
 * Whether a consignment has been checked, and what the check said.
 *
 * Two questions, not one, and the difference is the whole point of a soft gate: **never checked**
 * and **checked and failed** are different situations needing different sentences. A gate that
 * said only "not cleared" would tell despatch to go and find out which, every time.
 */
export async function dispatchQuality(dispatchId, { requireCheck } = {}) {
  const latest = await Inspection.findOne({ dispatch: dispatchId, stage: 'pre_dispatch' })
    .sort(NEWEST)
    .populate('inspectedBy', 'name');

  if (!latest) {
    /*
     * Never inspected, which is a *policy* question rather than a fact about the goods — see
     * `env.quality.requirePreDispatchCheck`. Off by default: a warning that fires on every
     * consignment before the plant has adopted pre-dispatch checks fills the overrides report
     * with everything and tells nobody anything, which is the exact failure a soft gate has to
     * avoid. A failed check below always warns, and needs no setting.
     */
    const strict = requireCheck ?? env.quality.requirePreDispatchCheck;
    return {
      checked: false,
      passed: !strict,
      latest: null,
      concern: strict ? 'Nobody has inspected this consignment' : null,
    };
  }

  const failed = HOLDING_VERDICTS.includes(latest.verdict);
  return {
    checked: true,
    passed: !failed,
    latest,
    concern: failed
      ? `${latest.number} rejected this consignment — ${latest.quantityRejected} of ` +
        `${latest.quantityInspected} pieces failed`
      : null,
  };
}

/**
 * The warning a consignment carries into the dispatch dialog, or null when there is none.
 *
 * Named `concern` rather than `error` throughout, because this gate warns and does not refuse —
 * the plant asked for judgement rather than a wall. What makes that safe is not the wording but
 * the two rules the controller enforces around it: the override needs a reason with a name on
 * it, and overrides are counted in their own report. A warning nobody has to answer for is a
 * warning everybody clicks past, and then quality is decorative.
 */
export async function dispatchConcern(dispatchId) {
  const { concern } = await dispatchQuality(dispatchId);
  return concern;
}

/**
 * Line-level quality for a whole order, keyed by line id.
 *
 * One query rather than one per line: an order screen showing eight lines would otherwise make
 * eight round trips to say eight sentences, and the plant's line list would make one per row
 * across every open order.
 */
export async function qualityForLines(lineIds) {
  if (!lineIds?.length) return new Map();

  const rows = await Inspection.find({
    line: { $in: lineIds },
    stage: { $in: ['in_process', 'final'] },
  }).sort(NEWEST);

  const byLine = new Map();
  for (const row of rows) {
    const key = String(row.line);
    const seen = byLine.get(key);

    if (!seen) {
      /* First row for this line is the newest, because the whole set came back sorted. */
      byLine.set(key, {
        latest: row,
        inspections: 1,
        held: HOLDING_VERDICTS.includes(row.verdict),
        rejected: row.quantityRejected || 0,
        inspected: row.quantityInspected || 0,
      });
      continue;
    }

    seen.inspections += 1;
    seen.rejected += row.quantityRejected || 0;
    seen.inspected += row.quantityInspected || 0;
  }

  return byLine;
}
