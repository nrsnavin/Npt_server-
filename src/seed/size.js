/**
 * How much data a seed run lays down.
 *
 * The default is a *working set*: three or four rows per model, which is enough to open every
 * screen, drag a card across every board and see each rule fire, and small enough that the whole
 * database can be read at a glance when something looks wrong. A seed you have to scroll to
 * understand is a seed nobody reads, and an unread fixture is where wrong test results hide.
 *
 * `SEED_FULL=true npm run seed` lays down everything instead — the full catalogue, all nine
 * enquiries, the whole 26-27 quote sheet. That set exists for demonstrating the system rather
 * than testing it, and the difference is worth stating plainly:
 *
 *   The slim set has **four enquiries, so four of the twelve funnel columns carry a card.** The
 *   full set has one enquiry per stage. Neither is more correct; a board with four populated
 *   columns is what a real Tuesday looks like, and a board with all twelve is what a screenshot
 *   looks like.
 *
 * Nothing is deleted to make the slim set — the rows are all still in the seed files, and the
 * flag decides how many are used. A fixture that has to be rewritten to get bigger is one that
 * quietly stops being able to.
 */

/** The full set is opt-in, so an unconfigured `npm run seed` gives the small one. */
export const FULL = process.env.SEED_FULL === 'true';

/** Three or four of a thing. Named for what it means rather than for the number. */
export const PER_MODEL = Number(process.env.SEED_PER_MODEL || 4);

/**
 * The first few of a list, or all of it under `SEED_FULL`.
 *
 * Order matters, and every list this is applied to is ordered so the rows worth keeping come
 * first — the mould with a blocked cavity, the tool the customer paid for, the resin that is
 * heavier than PP. Trimming a list whose interesting row sits eighth produces a seed where
 * everything works and nothing is worth testing.
 */
export const few = (rows, limit = PER_MODEL) => (FULL ? rows : rows.slice(0, limit));

/**
 * Moves the named rows to the front, so a trim keeps them.
 *
 * Stated as a list of what matters rather than by rewriting the arrays themselves. The seed
 * files are ordered the way a person would write them — by size, by model number, by the order
 * the plant thinks about them — and shuffling them so a slice happens to catch the right four
 * would make every one of those files worse to read in exchange for a behaviour nothing in the
 * file explains. Here the reason is visible: these are the rows a small set cannot do without.
 */
export const leading = (rows, field, wanted) => [
  ...wanted.map((value) => rows.find((row) => row[field] === value)).filter(Boolean),
  ...rows.filter((row) => !wanted.includes(row[field])),
];

/**
 * Drops rows whose references did not survive the trim, and says so.
 *
 * A sample whose enquiry was trimmed away, or an enquiry whose customer was, cannot simply be
 * created with a missing link: at best it is a record pointing at nothing, at worst the seed
 * throws halfway through and leaves the database half written. Filtering them is right; doing
 * it silently is not, because "why are there only two samples?" then has no answer anywhere on
 * screen.
 */
export function resolved(rows, isComplete, what) {
  const kept = rows.filter(isComplete);
  const lost = rows.length - kept.length;
  if (lost) {
    console.log(`  ${lost} ${what} left out — what they pointed at is not in this set.`);
  }
  return kept;
}
