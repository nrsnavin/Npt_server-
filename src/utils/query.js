/**
 * Shared list plumbing: paging, sorting and a safe text search.
 *
 * Every list endpoint answers the same three questions — which page, in what order, matching
 * what — so they answer them identically rather than each inventing its own parameter names.
 */

import ApiError from './ApiError.js';

/** Bounded so a caller cannot ask for the whole collection in one request. */
const MAX_LIMIT = 200;

/**
 * Which orderings a list will accept, and why that is a question about permissions.
 *
 * `?sort=` used to go straight to Mongoose. That was survivable while nothing sent one; it stops
 * being survivable the moment the screens grow sortable columns, because **an ordering is
 * information about the field it orders by.** §8 hides the cost base and the floor from
 * marketing, and `?sort=totalCost` hands back the same records ranked by the number they may
 * not see — cheapest job first is a fact about the cost base, and a few requests with a moving
 * filter narrow a hidden figure a long way. A redaction the sort parameter walks around is not
 * a redaction.
 *
 * So a list may name what it will order by, and the set can depend on who is asking: the
 * pricing register offers the costing columns to somebody holding `pricing: write` and not to
 * anybody else. Lists that pass nothing keep the old behaviour, which is what the internal
 * callers and exports rely on.
 *
 * An unknown key is refused rather than quietly replaced with the default. A screen asking for
 * an ordering it is not allowed is a bug, and a silent fallback is a bug that ships — the table
 * draws an arrow on a column it is not actually sorted by, and nobody can see the difference.
 */
function chooseSort(asked, defaultSort, sortable) {
  if (!asked) return defaultSort;

  const requested = String(asked);
  if (!sortable) return requested;

  /* `-field` is descending, which is Mongoose's own spelling and the one the screens send. */
  const field = requested.replace(/^-/, '');
  if (!sortable.includes(field)) {
    throw ApiError.badRequest(
      `Cannot sort by "${field}". This list sorts by: ${sortable.join(', ')}.`
    );
  }
  return requested;
}

/**
 * `defaultLimit` is per list, because what a reader wants first differs by list. A table of
 * enquiries wants a screenful; a feed of photographs wants far fewer, since every row there
 * costs a file download rather than a line of text.
 */
export function listParams(
  query,
  { searchFields = [], defaultSort = '-createdAt', defaultLimit = 25, sortable = null } = {}
) {
  const page = Math.max(Number(query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(query.limit) || defaultLimit, 1), MAX_LIMIT);
  const sort = chooseSort(query.sort, defaultSort, sortable);

  const filter = {};
  if (query.search && searchFields.length) {
    // Escaped, because a search box is user input and a stray `(` must not throw.
    const escaped = String(query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
    filter.$or = searchFields.map((field) => ({ [field]: regex }));
  }

  return { page, limit, sort, filter };
}

/**
 * `extra` carries anything the screen needs *about the whole result*, not this page of it —
 * a tally per status, say. It belongs in the same reply because it has to be computed from
 * the same filter: a count fetched separately is a count that can disagree with the rows
 * underneath it the moment anything else on the screen changes.
 */
export const paginated = (res, data, { page, limit, total }, extra = undefined) =>
  res.json({
    success: true,
    data,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    ...(extra || {}),
  });
