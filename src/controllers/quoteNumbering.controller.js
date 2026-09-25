import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import Counter from '../models/Counter.js';
import Quotation from '../models/Quotation.js';
import AuditLog from '../models/AuditLog.js';
import { financialYear, quoteSequence, setNextQuoteNumber } from '../services/numbering.service.js';
import { recordChange, snapshot } from '../services/audit.service.js';

/**
 * Quote numbering: where this year's sequence stands, and — for an administrator — where it
 * carries on from.
 *
 * The plant numbered quotes by hand before the app (NP/26-27/1, /2, …), so the first quote the
 * app raises has to follow the last one sent, not start again at 001. Next year's sequence can be
 * set before 1 April too. The rule that matters is on the server: the next number can never be
 * one already on a quote, so moving it can never hand two buyers the same number.
 */

const yearFor = (which) => {
  const current = financialYear().start;
  return which === 'next' ? current + 1 : current;
};

async function lastChange(start) {
  const row = await AuditLog.findOne({ model: 'QuoteNumbering', label: `NP-FY-${start}` })
    .sort({ at: -1 })
    .populate('by', 'name')
    .lean();
  return row ? { by: row.by?.name || null, at: row.at, note: row.note } : null;
}

async function describe(start) {
  return { ...(await quoteSequence(start, { Quotation })), changed: await lastChange(start) };
}

export const getQuoteNumbering = asyncHandler(async (req, res) => {
  const current = financialYear().start;
  res.json({ success: true, data: { current: await describe(current), next: await describe(current + 1) } });
});

export const setQuoteNumbering = asyncHandler(async (req, res) => {
  const start = yearFor(req.body.year);
  const key = `NP-FY-${start}`;
  const counterBefore = await Counter.findOne({ key });
  const before = counterBefore ? snapshot(counterBefore) : { key, seq: 0 };

  let moved;
  try {
    moved = await setNextQuoteNumber(start, req.body.next, { Quotation });
  } catch (error) {
    if (error.status === 400) throw ApiError.badRequest(error.message);
    if (error.status === 409) throw ApiError.conflict(error.message);
    throw error;
  }

  await recordChange({
    model: 'QuoteNumbering',
    doc: await Counter.findOne({ key }),
    before,
    by: req.user,
    label: key,
    note: `Next quote set to ${moved.after.next} (was ${moved.before.next})`,
  });

  res.json({ success: true, data: await describe(start) });
});
