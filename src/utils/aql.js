/**
 * Sampling by AQL — ISO 2859-1 (IS 2500 Part 1), single sampling, normal inspection, general
 * inspection level II: the lot size gives a code letter, the letter a sample size, and the AQL the
 * most rejects the sample may hold and still accept the lot (Ac). One more than that rejects (Re).
 *
 * Where the table points up or down instead of giving a number, the plan is the first one in that
 * direction — and its sample size, not the letter's, is the one to take.
 */

const LETTERS = [
  [8, 'A'], [15, 'B'], [25, 'C'], [50, 'D'], [90, 'E'], [150, 'F'], [280, 'G'], [500, 'H'],
  [1200, 'J'], [3200, 'K'], [10000, 'L'], [35000, 'M'], [150000, 'N'], [500000, 'P'], [Infinity, 'Q'],
];

export const AQL_LEVELS = [0.65, 1, 1.5, 2.5, 4, 6.5];

/* Each row: letter, sample size, then Ac for each AQL above; 'd' = use the plan below, 'u' = above. */
const TABLE = [
  ['A', 2, 'd', 'd', 'd', 'd', 'd', 0],
  ['B', 3, 'd', 'd', 'd', 'd', 0, 'u'],
  ['C', 5, 'd', 'd', 'd', 0, 'u', 'd'],
  ['D', 8, 'd', 'd', 0, 'u', 'd', 1],
  ['E', 13, 'd', 0, 'u', 'd', 1, 2],
  ['F', 20, 0, 'u', 'd', 1, 2, 3],
  ['G', 32, 'u', 'd', 1, 2, 3, 5],
  ['H', 50, 'd', 1, 2, 3, 5, 7],
  ['J', 80, 1, 2, 3, 5, 7, 10],
  ['K', 125, 2, 3, 5, 7, 10, 14],
  ['L', 200, 3, 5, 7, 10, 14, 21],
  ['M', 315, 5, 7, 10, 14, 21, 'u'],
  ['N', 500, 7, 10, 14, 21, 'u', 'u'],
  ['P', 800, 10, 14, 21, 'u', 'u', 'u'],
  ['Q', 1250, 14, 21, 'u', 'u', 'u', 'u'],
  ['R', 2000, 21, 'u', 'u', 'u', 'u', 'u'],
];

/**
 * The plan for a lot: `{ letter, sampleSize, accept, reject }`, or null when there is no lot size
 * or the AQL is not one of the table's. A sample as big as the lot means checking every piece.
 */
export function aqlPlan(lotSize, aql) {
  const lot = Number(lotSize);
  const column = AQL_LEVELS.indexOf(Number(aql));
  if (!(lot >= 2) || column < 0) return null;
  const letter = LETTERS.find(([upTo]) => lot <= upTo)[1];
  let row = TABLE.findIndex((entry) => entry[0] === letter);
  for (let guard = 0; guard < TABLE.length; guard += 1) {
    const cell = TABLE[row][column + 2];
    if (cell === 'd') row += 1;
    else if (cell === 'u') row -= 1;
    else {
      const sampleSize = Math.min(TABLE[row][1], lot);
      return { letter, sampleSize, accept: cell, reject: cell + 1, everyPiece: sampleSize >= lot };
    }
  }
  return null;
}
