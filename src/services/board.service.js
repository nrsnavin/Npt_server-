/**
 * The shared machinery behind a kanban board.
 *
 * A board asks a different question from a list. A list asks "what matches, in order, one page
 * at a time"; a board asks "how much is sitting at every stage, and what are the few at the top
 * of each". Those cannot be served from the same query — paging a list to fifty rows and
 * bucketing them in the browser gives you a board whose columns are whatever happened to fall
 * on page one, and whose counts are a lie the moment the second page exists.
 *
 * So a board is one tally over the whole filtered set, plus a short head of cards per column.
 *
 * **The counts and the cards come from the same filter.** Not the same query — the same filter
 * object, passed to both. A column that says 34 and shows 20 is telling the truth about both
 * numbers; a column that says 34 because it counted something else is the bug that makes people
 * stop believing the screen.
 *
 * **One indexed query per column, in parallel, rather than one clever aggregation.** Grouping
 * with `$push` and slicing the result carries every matched document through the group stage,
 * and `$setWindowFields` buys a rank the board does not otherwise need. Thirteen `find`s that
 * each hit the `status` index and stop at twenty rows are simpler to read, cost the database
 * almost nothing, and — the part that actually matters — go through Mongoose's own `populate`,
 * so a card carries the customer's name the same way every other endpoint's rows do. An
 * aggregation would need `$lookup` stages that restate those joins in a second dialect.
 *
 * The board never decides what a column *means*, only what is in it. Which statuses are rungs
 * on the ladder, which are trays off to the side, and which cannot be dropped into at all is
 * presentation, and lives with the screen that draws it.
 */

/** A screenful. Enough to see the shape of a column without loading the book behind it. */
const DEFAULT_PER_COLUMN = 20;

/**
 * Bounded like every other list. A caller asking for 500 a column across thirteen columns is
 * asking for the whole collection by a side door, which is the one thing paging exists to stop.
 */
const MAX_PER_COLUMN = 50;

export function perColumnFrom(query) {
  const asked = Number(query?.perColumn);
  if (!asked) return DEFAULT_PER_COLUMN;
  return Math.min(Math.max(asked, 1), MAX_PER_COLUMN);
}

/**
 * Builds the columns.
 *
 * `filter` must not carry a `status` of its own — the columns *are* the status filter, and a
 * board narrowed to one stage is a list with more scrolling. Every caller therefore builds its
 * filter with the same `withStatus: false` escape hatch the stage tallies already use, which is
 * what keeps a board and the list beside it from disagreeing about anything else.
 *
 * @param {object}   options
 * @param {import('mongoose').Model} options.Model
 * @param {object}   options.filter      everything except the status
 * @param {string[]} options.statuses    the columns to draw, in order
 * @param {string}   options.sort        one sort for every column — see below
 * @param {number}   options.perColumn
 * @param {string}   [options.valueField] what a column's money line adds up, if it has one
 * @param {string}   [options.select]
 * @param {Array}    [options.populate]
 * @param {boolean}  [options.lastActivityOnly] ship the newest activity rather than the log
 */
export async function buildBoard({
  Model,
  filter = {},
  statuses,
  sort,
  perColumn = DEFAULT_PER_COLUMN,
  valueField,
  select,
  populate = [],
  lastActivityOnly = false,
}) {
  /*
   * One sort across every column, and it is the sort the caller will page with.
   *
   * "Show more" on a column goes to the ordinary list endpoint for page two. If that endpoint
   * ordered differently, page two would repeat some cards and silently drop others — the
   * classic paging bug, and an especially nasty one here because the reader has page one still
   * on screen to compare against. The sort travels back in the response for exactly that
   * reason: the client pages with the string the board used rather than a copy of it.
   */
  const [tally, ...heads] = await Promise.all([
    Model.aggregate([
      ...(Object.keys(filter).length ? [{ $match: filter }] : []),
      {
        $group: {
          _id: '$status',
          total: { $sum: 1 },
          ...(valueField ? { value: { $sum: { $ifNull: [`$${valueField}`, 0] } } } : {}),
        },
      },
    ]),
    ...statuses.map((status) => {
      const query = Model.find({ ...filter, status });
      if (select) query.select(select);
      /*
       * Only the last activity, not the log.
       *
       * A lead with two years of calls on it would otherwise ship two years of calls to draw
       * one line of "last heard from". `$slice: -1` is the difference between a card and a
       * record, and on a five-column board it is most of the payload.
       */
      if (lastActivityOnly) query.slice('activities', -1);
      return query.populate(populate).sort(sort).limit(perColumn);
    }),
  ]);

  const counted = Object.fromEntries(
    tally.map((row) => [row._id, { total: row.total, value: row.value || 0 }])
  );

  return statuses.map((status, index) => ({
    status,
    /*
     * The count is the tally's, never `cards.length`. They differ the moment a column has more
     * than a screenful, and reading the head of the list as the size of it is how a board comes
     * to under-report the exact columns that most need attention — the full ones.
     */
    total: counted[status]?.total || 0,
    value: counted[status]?.value || 0,
    cards: heads[index],
  }));
}
