import { normalisePhone } from '../utils/phone.js';

/**
 * Ask Jarvis: turning a typed question into something the database can be asked.
 *
 * Deliberately rules rather than a language model, for three reasons that matter more here
 * than fluency does.
 *
 * **The questions are a closed set.** "Where is SMP-2026-0004", "what is overdue on the
 * bench", "any new enquiries this week" — five subjects and five aspects between them. A
 * model is the right tool when the space of questions is open; this one fits on a page, and
 * a parser you can read is a parser you can fix at four o'clock on a Friday.
 *
 * **A wrong answer here is worse than no answer.** Somebody asks how many samples are late
 * and acts on the number. A model that infers a plausible one, or quietly answers about
 * *open* samples instead, produces a confident sentence nobody can tell is wrong. Everything
 * this returns is a query somebody can re-run by hand.
 *
 * **It costs nothing and works with the network down.** No key to buy, no per-question
 * charge, no third party holding the plant's customer names.
 *
 * The parse is two axes rather than a flat list of intents, because that is how the questions
 * actually decompose: a *subject* (samples, enquiries, leads, customers, orders) and an
 * *aspect* (this specific one, what is late, what is new, how many). A flat list needs an
 * entry per combination and grows brittle; a grid degrades gracefully, and an unknown corner
 * of it can say precisely which half it did not understand.
 *
 * Swapping in a model later means replacing this file alone: everything downstream takes
 * `{ subject, aspect, entities }` and never sees the sentence.
 */

/* ------------------------------- Entities ------------------------------- */

/** The document numbers the plant actually says out loud. */
const NUMBER_PATTERNS = [
  { subject: 'samples', pattern: /\bSMP[-\s]?(\d{4})[-\s]?(\d+)\b/i, format: (y, n) => `SMP-${y}-${n}` },
  { subject: 'enquiries', pattern: /\bENQ[-\s]?(\d{4})[-\s]?(\d+)\b/i, format: (y, n) => `ENQ-${y}-${n}` },
  { subject: 'leads', pattern: /\bLEAD[-\s]?(\d{4})[-\s]?(\d+)\b/i, format: (y, n) => `LEAD-${y}-${n}` },
  { subject: 'customers', pattern: /\bCUST[-\s]?(\d{4})[-\s]?(\d+)\b/i, format: (y, n) => `CUST-${y}-${n}` },
];

/**
 * A document number, however it was typed.
 *
 * People say "SMP 2026 4" and "smp-2026-0004" for the same sample, and the sequence is
 * zero-padded in the database. Both are matched, and the padding is restored — a lookup that
 * fails on the way somebody says the number is a lookup nobody uses twice.
 */
export function documentNumber(text) {
  for (const { subject, pattern, format } of NUMBER_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;

    const [, year, sequence] = match;
    return { subject, number: format(year, sequence.padStart(4, '0')), raw: match[0] };
  }
  return null;
}

/**
 * The window a question is about.
 *
 * "New" with no window means the last week, which is what somebody asking on a Monday
 * morning means by it. Stated so the answer can say so out loud rather than leaving the
 * reader to assume a different span than the one they were given.
 */
const WINDOWS = [
  { pattern: /\btoday\b/i, days: 1, label: 'today' },
  { pattern: /\byesterday\b/i, days: 2, label: 'since yesterday' },
  { pattern: /\bthis week\b|\bpast week\b|\blast week\b|\b7 days\b|\bseven days\b/i, days: 7, label: 'in the last 7 days' },
  { pattern: /\bfortnight\b|\b14 days\b|\btwo weeks\b/i, days: 14, label: 'in the last 14 days' },
  { pattern: /\bthis month\b|\b30 days\b|\bmonth\b/i, days: 30, label: 'in the last 30 days' },
  { pattern: /\bquarter\b|\b90 days\b/i, days: 90, label: 'in the last 90 days' },
];

export function timeWindow(text) {
  for (const { pattern, days, label } of WINDOWS) {
    if (pattern.test(text)) return { days, label, stated: true };
  }
  return { days: 7, label: 'in the last 7 days', stated: false };
}

/* -------------------------------- Subject -------------------------------- */

/**
 * What the question is about.
 *
 * `orders`, `quotations` and the rest are listed even though nothing implements them. Leaving
 * them out would drop an order question into the fallback, which says "I did not understand"
 * — and the reader would try rephrasing a question that is perfectly clear. Naming them means
 * the answer can say the module is not built yet, which is the true reason and the one that
 * stops them retyping.
 */
const SUBJECTS = [
  { key: 'samples', terms: [/\bsamples?\b/i, /\bsmp\b/i, /\bbench\b/i, /\bsampling\b/i] },
  { key: 'enquiries', terms: [/\benquir(y|ies)\b/i, /\binquir(y|ies)\b/i, /\benq\b/i, /\brfq\b/i] },
  { key: 'leads', terms: [/\bleads?\b/i, /\bprospects?\b/i] },
  { key: 'customers', terms: [/\bcustomers?\b/i, /\bbuyers?\b/i, /\baccounts?\b/i, /\bparty\b/i, /\bparties\b/i] },
  { key: 'products', terms: [/\bproducts?\b/i, /\bmodels?\b/i, /\bcatalogue\b/i, /\bcatalog\b/i, /\bhangers?\b/i] },
  { key: 'orders', terms: [/\borders?\b/i, /\bpo\b/i, /\bpurchase orders?\b/i] },
  { key: 'quotations', terms: [/\bquotations?\b/i, /\bquotes?\b/i, /\bquoting\b/i] },
  { key: 'dispatch', terms: [/\bdispatch(es|ed)?\b/i, /\bdespatch(es|ed)?\b/i, /\bshipments?\b/i, /\blr\b/i] },
  { key: 'payments', terms: [/\bpayments?\b/i, /\binvoices?\b/i, /\boutstanding\b/i, /\bcollections?\b/i] },
  { key: 'production', terms: [/\bproduction\b/i, /\bmoulding\b/i, /\bplant\b/i] },
];

/* --------------------------------- Aspect -------------------------------- */

/**
 * What is being asked about it.
 *
 * Order matters: `overdue` is checked before `open`, because "which open samples are late"
 * is a question about lateness. The reverse order answers a question nobody asked and looks
 * like it worked.
 */
const ASPECTS = [
  /*
   * Before `overdue`, because "what is stuck" and "what is late" are different questions and
   * the words for the first are more specific. A sample can be stalled without being overdue —
   * that is the whole reason the check exists.
   */
  { key: 'stalled', terms: [/\bstall(ed|ing)?\b/i, /\bstuck\b/i, /\banomal(y|ies|ous)\b/i, /\bnot (been )?(worked|touched|moved)\b/i, /\bgone quiet\b/i, /\bno progress\b/i, /\bidle\b/i, /\bsitting\b/i] },
  { key: 'overdue', terms: [/\boverdue\b/i, /\blate\b/i, /\bdelayed?\b/i, /\bbehind\b/i, /\bslipp(ed|ing)\b/i, /\bbreach/i] },
  { key: 'due', terms: [/\bdue\b/i, /\bfollow[- ]?ups?\b/i, /\bchase\b/i, /\bpending with me\b/i] },
  { key: 'new', terms: [/\bnew\b/i, /\brecent(ly)?\b/i, /\blatest\b/i, /\bcome in\b/i, /\barrived?\b/i, /\bthis week\b/i, /\btoday\b/i] },
  { key: 'open', terms: [/\bopen\b/i, /\bpending\b/i, /\bin progress\b/i, /\bongoing\b/i, /\bactive\b/i, /\boutstanding\b/i, /\bwip\b/i] },
  { key: 'count', terms: [/\bhow many\b/i, /\bcount\b/i, /\bnumber of\b/i, /\btotal\b/i, /\bsummary\b/i, /\bbreakdown\b/i] },
  { key: 'status', terms: [/\bstatus\b/i, /\bwhere is\b/i, /\bwhat.?s happening\b/i, /\bupdate on\b/i, /\bstage\b/i, /\bprogress\b/i] },
];

const matches = (text, terms) => terms.some((term) => term.test(text));

/**
 * A quoted or trailing name, for "what is happening with Trendline Apparels".
 *
 * Quotes first because they are unambiguous. Otherwise the words after "with" or "for",
 * which is how the question is nearly always phrased — and stopping at a question mark or a
 * conjunction, since "for Trendline and their samples" names one customer, not two things.
 */
export function namedParty(text) {
  const quoted = /["'“”‘’]([^"'“”‘’]{2,60})["'“”‘’]/.exec(text);
  if (quoted) return quoted[1].trim();

  const trailing = /\b(?:with|for|of|about|from)\s+([A-Za-z0-9&.\-\s]{2,60}?)(?:\s+(?:and|status|samples?|enquir|order|please)\b|[?.,!]|$)/i.exec(text);
  if (!trailing) return null;

  const name = trailing[1].trim();
  // Words that are grammar rather than a name — "status of the samples" names nobody.
  if (/^(the|a|an|all|any|our|my|us|them|it|this|that|these|those)$/i.test(name)) return null;
  return name.length >= 2 ? name : null;
}

/* --------------------------------- Parse --------------------------------- */

/**
 * A typed question, as something answerable.
 *
 * Returns the subject and aspect it found and — importantly — says when it found neither, so
 * the answer can name which half was missing. "I understood you are asking about samples but
 * not what about them" is a useful reply; "I did not understand" is not.
 */
export function parse(message) {
  const text = String(message || '').trim();
  if (!text) return { subject: null, aspect: null, entities: {}, text };

  const reference = documentNumber(text);
  const phone = normalisePhone(text.replace(/[^\d+]/g, '')) || null;

  const subject = reference?.subject || SUBJECTS.find((entry) => matches(text, entry.terms))?.key || null;
  let aspect = ASPECTS.find((entry) => matches(text, entry.terms))?.key || null;

  /*
   * A document number is a question about that record whatever else was typed. "SMP-2026-0004
   * overdue?" reads as lateness to the aspect matcher, but the reader is holding one sample
   * and wants to know about it — and the record's own answer says whether it is late anyway.
   */
  if (reference) aspect = 'record';

  // A bare name with no aspect — "anything on Trendline Apparels?" — is asking for its status.
  const party = namedParty(text);
  if (!aspect && party) aspect = 'status';

  return {
    subject,
    aspect,
    entities: {
      reference: reference?.number || null,
      party,
      phone: phone && phone.length >= 10 ? phone : null,
      window: timeWindow(text),
    },
    text,
  };
}

/** Every subject the parser knows, for the help reply. Exported so the two cannot drift. */
export const KNOWN_SUBJECTS = SUBJECTS.map((entry) => entry.key);
