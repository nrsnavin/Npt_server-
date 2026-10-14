import Mould from '../models/Mould.js';
import TradedItem from '../models/TradedItem.js';

/**
 * The plant's model codes, for matching what a buyer wrote to what we sell — the retrieval half
 * of reading a chat that asks for several hangers [buyerCard.llm.js `matchModels`].
 *
 * A buyer writes "ncp 25", "NCP25 black", "25 no. shirt hanger" or "the velvet 450". The codes
 * are ours — the mould register (made here) and the trading master (bought in) — so the words
 * are matched against them, never the other way round: a match is always a code we have.
 *
 * Lexical rather than by meaning. A model code is a string of letters and digits, and the thing
 * that tells NCP-25 from NCP-27 is the digits, which a similarity of meaning blurs. So each word
 * the buyer wrote is compared with each code: the code exactly (spaces and dashes ignored), the
 * letters and the size, and what the name says (shirt, trouser, velvet, 400mm).
 */

/** "NCP-25 B" → "NCP25B": what is left of a code once spaces, dashes and case are gone. */
export const codeKey = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const words = (value) => String(value || '').toLowerCase().match(/[a-z]+|\d+(?:\.\d+)?/g) || [];

/** The register, both halves, as plain rows. Kept for a few minutes: it changes by the week. */
let kept = null;
const KEEP_MS = 5 * 60 * 1000;

export async function catalogue({ fresh = false } = {}) {
  if (!fresh && kept && Date.now() - kept.at < KEEP_MS) return kept.rows;
  const [moulds, traded] = await Promise.all([
    Mould.find({ isActive: { $ne: false }, status: { $ne: 'retired' } }).select('mouldCode name category sizeMm').lean(),
    TradedItem.find({ isActive: { $ne: false } }).select('modelNumber code description supplier').lean(),
  ]);
  const rows = toRows(moulds, traded);
  kept = { at: Date.now(), rows };
  return rows;
}

/** Register records as rows to match against: the code, its key, and the words that describe it. */
export function toRows(moulds = [], traded = []) {
  return [
    ...moulds.map((mould) => ({
      ref: `m${mould._id}`, kind: 'mould', id: String(mould._id), code: mould.mouldCode,
      name: mould.name, category: mould.category, sizeMm: mould.sizeMm,
    })),
    ...traded.map((item) => ({
      ref: `t${item._id}`, kind: 'traded', id: String(item._id), code: item.modelNumber || item.code,
      name: [item.description, item.code && item.code !== item.modelNumber ? item.code : null].filter(Boolean).join(' · '),
      supplier: item.supplier,
    })),
  ].map((row) => ({
    ...row,
    key: codeKey(row.code),
    altKey: row.kind === 'traded' && row.name ? codeKey(row.name.split(' · ').pop()) : '',
    words: new Set(words(`${row.code} ${row.name || ''} ${row.category || ''} ${row.sizeMm ? `${row.sizeMm}mm ${row.sizeMm}` : ''}`)),
  }));
}

/** Forget the kept register — after an import, so the next read sees the new codes. */
export const forgetCatalogue = () => { kept = null; };

/** Words every hanger has, which say nothing about which one. */
const FILLER = new Set(['hanger', 'hangers', 'mm', 'cm', 'inch', 'the', 'a', 'one', 'pcs', 'pc', 'nos', 'no', 'model', 'type', 'with', 'and', 'for']);

/** How alike two keys are: shared three-letter runs over all of them (0 to 1). */
export function trigramLikeness(a, b) {
  if (!a || !b) return 0;
  const grams = (text) => {
    const padded = `  ${text} `;
    const out = new Set();
    for (let i = 0; i < padded.length - 2; i += 1) out.add(padded.slice(i, i + 3));
    return out;
  };
  const left = grams(a);
  const right = grams(b);
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * The codes a buyer's words could mean, best first, with a score: 100 is the code itself.
 *
 * Every run of one to three words is tried as a code ("ncp 25 black" tries NCP, NCP25,
 * NCP25BLACK, 25, 25BLACK, BLACK), so a code split by a space or followed by a colour is still
 * found. The digits must agree: NCP-27 is never offered for "ncp 25" on the strength of the
 * letters alone.
 */
export function shortlist(asked, rows, { limit = 6 } = {}) {
  const said = words(asked);
  if (!said.length) return [];
  const runs = new Set();
  for (let start = 0; start < said.length; start += 1) {
    for (let length = 1; length <= 3 && start + length <= said.length; length += 1) {
      runs.add(codeKey(said.slice(start, start + length).join('')));
    }
  }
  const saidNumbers = said.filter((word) => /^\d/.test(word));
  const saidWords = new Set(said);

  const scored = rows.map((row) => {
    let score = 0;
    if (runs.has(row.key) || (row.altKey && runs.has(row.altKey))) score = 100;
    else {
      const best = Math.max(0, ...[...runs].map((run) => trigramLikeness(run, row.key)));
      /* Every number the model is known by: its code's, its name's, its size. */
      const rowNumbers = [...row.words].filter((word) => /^\d/.test(word));
      const digitsAgree = saidNumbers.length > 0 && rowNumbers.some((number) => saidNumbers.includes(number));
      const digitsClash = saidNumbers.length > 0 && rowNumbers.length > 0 && !digitsAgree;
      /* Words that describe the piece — shirt, suit, velvet, clips — not ones every row has. */
      const overlap = [...row.words].filter((word) => saidWords.has(word) && !FILLER.has(word) && !/^\d/.test(word)).length;
      score = best * 60 + (digitsAgree ? 20 : 0) + Math.min(overlap, 4) * 9 - (digitsClash ? 40 : 0);
    }
    return { row, score: Math.round(score) };
  });
  return scored
    .filter((entry) => entry.score >= 9)
    .sort((a, b) => b.score - a.score || a.row.code.localeCompare(b.row.code))
    .slice(0, limit);
}

/** The one code a buyer's words name outright — exactly one 100 — or null. */
export function exactly(asked, rows) {
  const hits = shortlist(asked, rows, { limit: 3 }).filter((entry) => entry.score === 100);
  return hits.length === 1 ? hits[0].row : null;
}

/** A matched row as it is kept on a reading: the code, and which register it is on. */
export const asMatch = (row) => (row
  ? { code: row.code, ...(row.kind === 'mould' ? { mould: row.id } : { tradedItem: row.id }), name: row.name || undefined }
  : {});
