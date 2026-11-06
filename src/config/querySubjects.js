/**
 * The subjects a query starts with, offered as a drop-down [services/querySubjects.service.js].
 * Anybody may add another — it joins the list for everyone; Admin renames or removes them.
 * These are the first list only: once seeded, the list lives in the database.
 */
export const DEFAULT_QUERY_SUBJECTS = [
  'Accounts issue',
  'Payment / outstanding',
  'Invoice / GST',
  'Credit limit',
  'Sample',
  'PP sample',
  'Pricing / quotation',
  'Sales order / PO details',
  'Production status',
  'Delivery date (EDD)',
  'Dispatch',
  'Transport / LR',
  'Quality / rejection',
  'Material / colour',
  'Mould / model',
  'Printing / artwork',
  'Hook / clip',
  'Packing / cartons',
  'Customer complaint',
  'Returns / replacement',
  'Documents / certificates',
  'Other',
];

/** One subject as it is compared: trimmed, single-spaced, lower case — "Dispatch" and "dispatch " are one. */
export const subjectKey = (name) => String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();

export const SUBJECT_MAX_LENGTH = 60;
