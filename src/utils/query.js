/**
 * Shared list plumbing: paging, sorting and a safe text search.
 *
 * Every list endpoint answers the same three questions — which page, in what order, matching
 * what — so they answer them identically rather than each inventing its own parameter names.
 */

/** Bounded so a caller cannot ask for the whole collection in one request. */
const MAX_LIMIT = 200;

/**
 * `defaultLimit` is per list, because what a reader wants first differs by list. A table of
 * enquiries wants a screenful; a feed of photographs wants far fewer, since every row there
 * costs a file download rather than a line of text.
 */
export function listParams(
  query,
  { searchFields = [], defaultSort = '-createdAt', defaultLimit = 25 } = {}
) {
  const page = Math.max(Number(query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(query.limit) || defaultLimit, 1), MAX_LIMIT);
  const sort = query.sort || defaultSort;

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
