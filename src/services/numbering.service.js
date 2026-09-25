import Counter from '../models/Counter.js';

/**
 * Human-readable document numbers.
 *
 * Every counter increments atomically, so two people creating a record at the same moment cannot
 * collide. The year is read in India time, not the server's: a server in a UTC region otherwise
 * stamps the first five and a half hours of 1 January with the old year.
 */

const INDIA = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'numeric' });

/** The calendar year and month (1–12) of an instant, as a clock in India reads it. */
export function indiaYearMonth(date = new Date()) {
  const parts = Object.fromEntries(INDIA.formatToParts(date).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month) };
}

/**
 * The Indian financial year an instant falls in — 1 April to 31 March, India time.
 * `{ start: 2026, label: '26-27' }` for anything from 1 April 2026 to 31 March 2027.
 */
export function financialYear(date = new Date()) {
  const { year, month } = indiaYearMonth(date);
  const start = month >= 4 ? year : year - 1;
  const two = (value) => String(value % 100).padStart(2, '0');
  return { start, label: `${two(start)}-${two(start + 1)}` };
}

async function bump(key) {
  const counter = await Counter.findOneAndUpdate({ key }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return counter.seq;
}

/** The next number for a prefix, per calendar year, e.g. nextNumber('ENQ') -> "ENQ-2026-0007". */
export async function nextNumber(prefix, date = new Date()) {
  const { year } = indiaYearMonth(date);
  const seq = await bump(`${prefix}-${year}`);
  return `${prefix}-${year}-${String(seq).padStart(4, '0')}`;
}

/** Where the quote sequence for a financial year is kept. */
export const quoteCounterKey = (date = new Date()) => `NP-FY-${financialYear(date).start}`;

/**
 * The next quotation number, in the plant's own style: `NP/26-27/001`.
 *
 * Runs per financial year and starts again at 001 on 1 April, as the plant's price sheets do.
 * A revision keeps its quote's number — it is the same offer, restated.
 */
export async function nextQuoteNumber(date = new Date()) {
  const seq = await bump(quoteCounterKey(date));
  return `NP/${financialYear(date).label}/${String(seq).padStart(3, '0')}`;
}

/** A document number as a file name: `NP/26-27/001` -> `NP-26-27-001`. */
export const fileSafeNumber = (number) => String(number || 'document').replace(/[^A-Za-z0-9-]+/g, '-');

/** The financial year starting in April of `start`, e.g. 2026 → 26-27. */
export const financialYearOf = (start) => ({ start, label: `${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}` });
export const formatQuoteNumber = (label, seq) => `NP/${label}/${String(seq).padStart(3, '0')}`;

/**
 * Where a year's quote sequence stands: the counter, and the highest number actually on a quote.
 * They differ when the counter has been moved on, or when a quote was deleted.
 */
export async function quoteSequence(start, { Quotation }) {
  const year = financialYearOf(start);
  const counter = (await Counter.findOne({ key: `NP-FY-${start}` }))?.seq ?? 0;
  const issued = await Quotation.find({ number: new RegExp(`^NP/${year.label}/\\d+$`) }).select('number').lean();
  const highestIssued = issued.reduce((max, row) => Math.max(max, Number(row.number.split('/').at(-1)) || 0), 0);
  return {
    financialYear: year.label,
    start,
    counter,
    highestIssued,
    lastIssued: highestIssued ? formatQuoteNumber(year.label, highestIssued) : null,
    next: formatQuoteNumber(year.label, counter + 1),
    nextSeq: counter + 1,
    /** The lowest the next number may be set to: above every number already on a quote. */
    lowestAllowed: highestIssued + 1,
  };
}

/**
 * Sets the number the next quote of a financial year gets.
 *
 * It may move down as well as up — to take back a counter set too high by mistake — but never to
 * a number at or below one already on a quote, which would issue it twice. The counter is moved
 * only if nobody raised a quote in between reading it and moving it.
 */
export async function setNextQuoteNumber(start, next, { Quotation }) {
  const before = await quoteSequence(start, { Quotation });
  if (next <= before.highestIssued) {
    const error = new Error(
      `${formatQuoteNumber(before.financialYear, next)} cannot be next — ${before.lastIssued} is already on a quote. ` +
        `The lowest the next number can be is ${before.lowestAllowed}.`
    );
    error.status = 400;
    throw error;
  }
  const key = `NP-FY-${start}`;
  const moved = await Counter.findOneAndUpdate(
    { key, seq: before.counter },
    { $set: { seq: next - 1 } },
    { new: true, upsert: before.counter === 0 }
  ).catch((error) => (error.code === 11000 ? null : Promise.reject(error)));
  if (!moved) {
    const error = new Error('A quote was raised while you were changing this. Look at the new figures and try again.');
    error.status = 409;
    throw error;
  }
  return { before, after: await quoteSequence(start, { Quotation }) };
}
