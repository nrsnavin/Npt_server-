import Receivable from '../models/Receivable.js';
const cents = value => Math.round((value || 0) * 100);
const id = value => String(value?._id || value);

/** Allocate actual advances once, oldest invoice first, in integer paise. */
export function allocatePayments(rows) {
  const invoices = rows.filter(row => row.kind === 'invoice').sort((a, b) =>
    new Date(a.invoice?.date || a.createdAt) - new Date(b.invoice?.date || b.createdAt) || id(a).localeCompare(id(b)));
  const advances = rows.filter(row => row.kind === 'advance');
  const value = row => cents(row.invoice?.value);
  const received = row => cents(row.received);
  const invoiced = invoices.reduce((sum, row) => sum + value(row), 0);
  const advanceDue = advances.reduce((sum, row) => sum + value(row), 0);
  const totalReceived = rows.reduce((sum, row) => sum + received(row), 0);
  const outstanding = Math.max(0, Math.max(invoiced, advanceDue) - totalReceived);
  let credit = advances.reduce((sum, row) => sum + received(row), 0);
  let invoiceBalance = 0;
  for (const row of invoices) {
    const raw = Math.max(0, value(row) - received(row));
    const applied = Math.min(raw, credit);
    credit -= applied;
    row.$locals.balanceAdjustment = applied / 100;
    row.$locals.advanceApplied = applied / 100;
    row.$locals.receiptable = (raw - applied) / 100;
    invoiceBalance += raw - applied;
  }
  let advanceBalance = Math.max(0, outstanding - invoiceBalance);
  for (const row of advances) {
    const raw = Math.max(0, value(row) - received(row));
    const remaining = Math.min(raw, advanceBalance);
    advanceBalance -= remaining;
    row.$locals.balanceAdjustment = (raw - remaining) / 100;
    row.$locals.advanceApplied = 0;
    row.$locals.receiptable = Math.min(raw, outstanding) / 100;
  }
  return rows;
}

/** Resolve whole orders even when the visible list is filtered or paginated. */
export async function applyPaymentPositions(rows) {
  if (!rows.length) return rows;
  const all = await Receivable.find({ order: { $in: [...new Set(rows.map(row => id(row.order)))] } });
  const byId = new Map(all.map(row => [id(row), row]));
  for (const row of rows) byId.set(id(row), row);
  const groups = new Map();
  for (const row of byId.values()) {
    const key = id(row.order);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const group of groups.values()) allocatePayments(group);
  return rows;
}
