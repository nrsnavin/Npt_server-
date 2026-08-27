import Lead from '../models/Lead.js';
import Customer from '../models/Customer.js';
import asyncHandler from '../utils/asyncHandler.js';
import { STATES, CITIES } from '../data/places.js';

/**
 * Suggesting a state or a town as somebody types one.
 *
 * The problem being solved is one spelling per place. Free text fills the database with
 * Tiruppur, Tirupur and TIRUPPUR, which are one town to the plant and three to every report
 * that groups by city — and the reader who sees "Tiruppur: 3" against eleven real customers
 * concludes the CRM is wrong rather than the spelling.
 *
 * Two sources, merged, and the order matters.
 *
 * **The bundled list is canonical.** Where a town is in it, its spelling wins, even if the
 * database holds a variant — that is the whole point of having one.
 *
 * **The database is the rest of it.** A plant that sells into a town nobody bundled should
 * see it offered the second time somebody types it, and never have to remember how they wrote
 * it the first time. This is also what keeps the list from being a guess made once and left:
 * it grows into the business.
 *
 * Unauthenticated? No. It is behind `authenticate` like everything else — the database half
 * would otherwise say which towns this company sells into, which is not a secret worth
 * keeping badly but is not one to hand out either.
 */

/** A search box takes user input; a stray `(` must not throw. */
const escape = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The key two spellings of the same town share.
 *
 * Lowercased, punctuation dropped, and runs of the same letter collapsed — so Tiruppur,
 * tirupur and TIRUPPUR are one key. The doubled consonant is the spelling variance that
 * actually happens here, and it is the one that quietly splits a city report in two.
 *
 * Deliberately not fuzzy beyond that. Bengaluru and Bangalore are different names for the
 * same place and this will offer both, which is right: guessing that two unlike strings mean
 * one town is how a suggestion list starts hiding real answers.
 */
const key = (value) =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/(.)\1+/g, '$1');

/** Enough to choose from without becoming a page to read. */
const LIMIT = 12;

/**
 * Ranked for a person typing.
 *
 * A prefix match comes first: somebody typing "tir" wants Tiruppur before Bhatinda-with-a-tir
 * in the middle. Within each group, alphabetical — so the list does not reshuffle as they
 * type, which is what makes a suggestion list feel unreliable.
 */
function rank(values, query) {
  if (!query) return [...values].sort((a, b) => a.localeCompare(b)).slice(0, LIMIT);

  const term = query.toLowerCase();
  const starts = [];
  const contains = [];

  for (const value of values) {
    const lower = value.toLowerCase();
    if (lower.startsWith(term)) starts.push(value);
    else if (lower.includes(term)) contains.push(value);
  }

  const byName = (a, b) => a.localeCompare(b);
  return [...starts.sort(byName), ...contains.sort(byName)].slice(0, LIMIT);
}

export const listStates = asyncHandler(async (req, res) => {
  const matches = rank(STATES, String(req.query.q || '').trim());
  res.json({ success: true, data: matches.map((name) => ({ name })) });
});

/**
 * Towns, narrowed to a state when one has been chosen.
 *
 * Narrowing is a filter on the suggestions, never on what may be typed. A buyer whose town
 * the bundled list files under a neighbouring state must still be enterable, and arguing with
 * somebody about which district their own address is in is not what this is for.
 */
export const listCities = asyncHandler(async (req, res) => {
  const query = String(req.query.q || '').trim();
  const state = String(req.query.state || '').trim();

  /*
   * What the plant has actually typed. Distinct over both collections, because a town first
   * entered on a lead should be suggested on the customer it becomes.
   */
  const match = { city: { $nin: [null, ''] } };
  if (state) match.state = new RegExp(`^${escape(state)}$`, 'i');

  /*
   * Grouped rather than `distinct`, because the state a town was typed with is worth keeping:
   * a town nobody bundled still knows which state it is in, and losing that would mean
   * choosing it left the state blank.
   */
  const group = [{ $match: match }, { $group: { _id: '$city', state: { $first: '$state' } } }];
  const [leadCities, customerCities] = await Promise.all([
    Lead.aggregate(group),
    Customer.aggregate(group),
  ]);

  const bundled = Object.entries(CITIES)
    .filter(([, inState]) => !state || inState.toLowerCase() === state.toLowerCase())
    .map(([name]) => name);

  /*
   * Merged case-insensitively, with the bundled spelling winning. A database holding "tirupur"
   * should not perpetuate it: offering the canonical spelling is how the variant stops being
   * typed a fourth time.
   */
  const seen = new Map();
  for (const name of bundled) seen.set(key(name), { name, state: CITIES[name] });
  for (const row of [...leadCities, ...customerCities]) {
    const name = String(row._id || '').trim();
    if (!name) continue;
    const id = key(name);
    if (!seen.has(id)) seen.set(id, { name, state: row.state || state || null });
  }

  const byName = new Map([...seen.values()].map((entry) => [entry.name, entry]));
  const matches = rank([...byName.keys()], query);

  res.json({
    success: true,
    // The state each town sits in, so choosing one can fill the other in.
    data: matches.map((name) => ({ name, state: byName.get(name).state || state || null })),
  });
});
