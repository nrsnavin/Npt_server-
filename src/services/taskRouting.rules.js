import { DEPARTMENT_KEYS } from '../config/modules.js';

/**
 * Reading a task well enough to say whose it is, without a model [BLUEPRINT §25, §35].
 *
 * This is the fallback under `taskRouting.llm.js`, and it is written to stand on its own —
 * because for most of this plant's life it will be what runs. An `ANTHROPIC_API_KEY` is optional
 * and a Tiruppur factory on a domestic line will meet timeouts; a suggestion that only works
 * when the network is good is a suggestion nobody comes to rely on.
 *
 * The vocabulary is the plant's own, not a general taxonomy. "E-way bill" is despatch's problem
 * and nobody else's; "regrind" and "cycle time" are the press; "GRS" and "lab dip" are the
 * bench. That specificity is what makes a keyword table work here where it would not work in a
 * generic to-do app — there are eight departments and each owns a distinct set of nouns.
 *
 * Deliberately conservative. Two departments matching, or none, returns `null` rather than a
 * coin toss: an empty dropdown is a small cost, and a confident wrong department is a job sent
 * to people who cannot do it, who then have to work out where it should have gone.
 */

/**
 * The words that belong to one department and no other.
 *
 * Kept as whole-word patterns because substrings mislead: "pod" matches "podium" and, worse,
 * "**pod**gy", while `\bPOD\b` is the proof of delivery every time. Order does not matter — the
 * caller counts hits per department rather than taking the first.
 */
const VOCABULARY = {
  despatch: [
    'e-way', 'eway', 'e way bill', '\\bLR\\b', 'lorry receipt', '\\bPOD\\b',
    'proof of delivery', 'consignment', 'transporter', 'lorry', 'vehicle', 'loaded',
    'loading', 'packing list', 'despatch', 'dispatch', 'courier', 'freight',
  ],
  production: [
    'mould', 'mold', 'cavity', 'cavities', 'cycle time', 'regrind', 'runner',
    'shot weight', 'press', 'machine', 'shift', 'resin', 'moulding', 'production run',
    'output', 'pieces short', 'short by', 'downtime',
    /* Its own name. "Ask production whether Monday is realistic" is the plainest statement of
       whose job a thing is, and the table did not match it. */
    'production', 'press floor', 'shop floor',
  ],
  quality: [
    'inspection', 'inspect', 'reject', 'rejects', 'rejection', 'defect', 'flash',
    'short shot', 'warp', 'warpage', 'sink mark', 'quality check', 'pre-dispatch check',
    'lab dip', 'tolerance', '\\bQC\\b',
    'quality', 'quality hold',
  ],
  sampling: [
    'sample', 'sampling', 'counter sample', 'bench', 'trial', 'prototype',
    'colour approval', 'color approval', 'print approval', 'development',
  ],
  accounts: [
    'invoice', 'payment', 'receipt', 'outstanding', 'overdue payment', 'advance',
    'credit note', 'debit note', '\\bTDS\\b', '\\bGST\\b', 'reconcile', 'ledger',
    'cheque', '\\bRTGS\\b', '\\bNEFT\\b', 'disputing the invoice',
    'accounts', 'accounts team',
  ],
  marketing: [
    'buyer', 'customer wants', 'quotation', 'quote', 'enquiry', 'price', 'pricing',
    'negotiat', 'follow up with', 'ring the', 'call the customer', 'target price',
    'relationship', 'marketing',
  ],
  order_confirmation: [
    '\\bPO\\b', 'purchase order', 'order confirmation', 'confirm the order',
    'artwork approval', 'specification', 'spec sheet', 'release the order',
    'order verification', 'checklist',
  ],
  management: [
    'approval', 'approve the', 'sign off', 'signature', 'below the floor',
    'below cost', 'escalate to management', 'policy', 'management', 'managing director',
    '\\bMD\\b',
  ],
};

/** Compiled once. A regex built per call on a keyword table this size is measurable. */
const PATTERNS = Object.fromEntries(
  Object.entries(VOCABULARY).map(([department, words]) => [
    department,
    words.map((word) => new RegExp(word.startsWith('\\b') ? word : `\\b${word}`, 'i')),
  ])
);

/**
 * Words that mean "this cannot wait", as the plant says them.
 *
 * Two kinds, and the distinction matters. The first is somebody stating urgency — "urgent",
 * "asap". The second is *describing a situation that is urgent* whether or not the word appears:
 * a lorry at the gate, a line stopped, a buyer waiting. The second kind is the useful one,
 * because the people who write "urgent" on everything are not the people this is for.
 */
const URGENT = [
  /\burgent/i, /\basap\b/i, /immediately/i, /right away/i, /today\b/i, /\bnow\b/i,
  /at the gate/i, /waiting/i, /stopped/i, /held up/i, /holding up/i, /cannot (run|ship|load)/i,
  /line (is )?down/i, /buyer is (here|asking|waiting)/i, /before (the )?(lorry|shift|cut-?off)/i,
  /missed/i, /past due/i, /overdue/i, /disput/i,
];

/**
 * What matched, per department — the words themselves and not just how many.
 *
 * The count decides; the words are what the reason is written from. "Mentions the e-way bill and
 * the lorry" is something a person can check against the task in front of them, where "mentions
 * 2 words the despatch team owns" asks them to take it on trust and tells them nothing about
 * whether it read the sentence the way they would.
 */
function score(text) {
  const hits = {};
  for (const [department, patterns] of Object.entries(PATTERNS)) {
    const matched = patterns
      .map((pattern) => text.match(pattern)?.[0])
      .filter(Boolean)
      /* As they appear in the task, lower-cased, longest first — the longest match is almost
         always the most specific and therefore the most convincing one to quote. */
      .map((word) => word.toLowerCase())
      .sort((a, b) => b.length - a.length);
    if (matched.length) hits[department] = matched;
  }
  return hits;
}

/**
 * At most three matches, quoted, as a list somebody reads out loud.
 *
 * Overlapping matches are dropped, keeping the longer. The vocabulary contains both "invoice"
 * and "disputing the invoice", so a sentence with the phrase in it matched both and the reason
 * read *Mentions “disputing the invoice” and “invoice”* — which says one thing twice and makes
 * the suggestion look like it is counting rather than reading. Same for "counter sample" and
 * "sample". Longest-first ordering from the caller is what makes the containment check work.
 */
const listed = (words) => {
  const kept = [];
  for (const word of words) {
    if (!kept.some((already) => already.includes(word))) kept.push(word);
    if (kept.length === 3) break;
  }

  const quoted = kept.map((word) => `“${word}”`);
  if (quoted.length === 1) return quoted[0];
  return `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`;
};

/**
 * Everything the model would be shown, as one string.
 *
 * The customer and order numbers are included because they are part of how a person reads a
 * task — "SO-2026-0001" beside "no e-way bill" is what makes it despatch's and not a general
 * question about e-way bills.
 */
export const describeTask = (task) =>
  [
    task?.title,
    task?.notes,
    task?.customer?.name || '',
    task?.order?.number || '',
  ]
    .filter(Boolean)
    .join(' · ');

/**
 * Whose it is, how urgent, and why — from the words alone.
 *
 * Returns `department: null` when the text does not clearly belong to one department, which is
 * most short tasks and all of the vague ones. The caller treats that as "no suggestion" and
 * leaves the person to choose, which is the honest outcome.
 *
 * `from` is on the answer so the screen can say where a suggestion came from. A person deciding
 * whether to trust it is entitled to know whether a model read the sentence or a keyword table
 * matched two words in it.
 */
export function suggestByRules(task, { exclude } = {}) {
  const text = describeTask(task);
  if (!text.trim()) return { department: null, priority: null, reason: null, from: 'rules' };

  const hits = score(text);
  /* Never the queue it is already on: suggesting that is suggesting nothing. */
  if (exclude) delete hits[exclude];

  const ranked = Object.entries(hits).sort((a, b) => b[1].length - a[1].length);
  const [best, second] = ranked;

  /*
   * A clear winner or nothing. `best.length === second.length` is the case this guards: "invoice
   * not cut before the lorry leaves" scores accounts and despatch equally, and picking either is
   * a guess dressed as an answer.
   */
  const clear = best && (!second || best[1].length > second[1].length);
  const department = clear && DEPARTMENT_KEYS.includes(best[0]) ? best[0] : null;

  return {
    department,
    priority: URGENT.some((pattern) => pattern.test(text)) ? 'high' : null,
    /*
     * The reason quotes the task rather than asserting a judgement, because quoting is all the
     * rules honestly know how to do. "Mentions “e-way” and “lorry”" is true and checkable at a
     * glance; "despatch needs to cut the e-way bill" would be a keyword table pretending it had
     * read the sentence.
     */
    reason: department ? `Mentions ${listed(best[1])}` : null,
    from: 'rules',
  };
}

/** Exposed for the model layer's prompt, so the two cannot describe the plant differently. */
export const DEPARTMENT_VOCABULARY = VOCABULARY;
