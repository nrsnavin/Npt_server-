import Customer from '../models/Customer.js';
import { nextNumber } from './numbering.service.js';

/**
 * The plant's customer list — names only, one a line — onto the register
 * [scripts/import-customers.js]. Each becomes a customer with a code, under one owner, with
 * everything else left for the marketing person to fill in as they work the account.
 *
 * Matched on the name with its case, spaces and punctuation set aside: "KRD" and "K R D" are
 * the same company written twice, and "Ruby Fashions DA" is not "Ruby Fashions".
 */

export const nameKey = (name) => {
  const plain = String(name || '').toLowerCase();
  /* Letters in any script count: a name written in Tamil is its own name, not a blank that matches every other. */
  return plain.normalize('NFKC').replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
};

/** The list's names as `{ line, name }`, blanks left out. */
export function readNames(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((raw, index) => ({ line: index + 1, name: raw.replace(/\s+/g, ' ').trim() }))
    .filter((entry) => entry.name);
}

/** Each name: create, or already there (by its code), or a second spelling of one above. */
export async function planCustomers(entries) {
  const existing = await Customer.find({}).select('name code');
  const byKey = new Map(existing.map((customer) => [nameKey(customer.name), customer]));
  const seen = new Map();
  return entries.map((entry) => {
    const key = nameKey(entry.name);
    if (seen.has(key)) return { ...entry, action: 'skip', reason: `the same name as line ${seen.get(key)} ("${seen.get(`${key}:name`)}")` };
    seen.set(key, entry.line);
    seen.set(`${key}:name`, entry.name);
    const found = byKey.get(key);
    if (found) return { ...entry, action: 'exists', code: found.code, as: found.name };
    return { ...entry, action: 'create' };
  });
}

/** Writes a plan: a customer each, coded in turn, owned by `owner`. */
export async function applyCustomers(plan, { owner }) {
  let created = 0;
  for (const entry of plan) {
    if (entry.action !== 'create') continue;
    await Customer.create({
      code: await nextNumber('CUST'),
      name: entry.name,
      assignedTo: owner,
      source: 'manual',
      notes: 'From the customer list — details to fill in.',
    });
    created += 1;
  }
  return { created };
}
