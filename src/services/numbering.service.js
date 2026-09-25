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
