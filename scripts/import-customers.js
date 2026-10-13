/**
 * Reads the plant's customer list — names only — onto the register
 * [services/customerList.service.js]: one customer each, with a code, under one owner.
 *
 * Usage:
 *   npm run import:customers                               # dry run of data/customers.txt
 *   npm run import:customers -- --confirm                  # write it
 *   npm run import:customers -- --owner=someone@x.com --confirm
 *   npm run import:customers -- path/to/list.txt --confirm
 *
 * The owner is the marketing person (or Admin) the customers are put under — every customer
 * has one [models/Customer.js]; without --owner, the first Admin account. A name already on
 * the register (same letters, any case, spacing or punctuation) is left as it is; a name on the
 * list twice is added once. Safe to run again. Reads MONGO_URI from .env.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import User from '../src/models/User.js';
import { applyCustomers, planCustomers, readNames } from '../src/services/customerList.service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith('--')) || path.join(here, '..', 'data', 'customers.txt');
const confirm = args.includes('--confirm');
const ownerEmail = (args.find((arg) => arg.startsWith('--owner=')) || '').slice('--owner='.length).trim().toLowerCase();

async function main() {
  const entries = readNames(readFileSync(file, 'utf8'));
  await connectDatabase();
  console.log(`Database: ${mongoose.connection.name}`);
  console.log(`Customer list: ${path.basename(file)} — ${entries.length} names\n`);

  const owner = ownerEmail
    ? await User.findOne({ email: ownerEmail })
    : await User.findOne({ role: 'admin' }).sort({ createdAt: 1 });
  if (!owner) throw new Error(ownerEmail ? `No account with the email ${ownerEmail}` : 'No Admin account to own the customers — give --owner=email');
  console.log(`Owner: ${owner.name} <${owner.email}>\n`);

  const plan = await planCustomers(entries);
  for (const entry of plan) {
    if (entry.action === 'create') console.log(`  add     ${entry.name}`);
    else if (entry.action === 'exists') console.log(`  there   ${entry.name} · ${entry.code}${entry.as !== entry.name ? ` (as "${entry.as}")` : ''}`);
    else console.log(`  skip    line ${entry.line} ${entry.name}: ${entry.reason}`);
  }
  const count = (action) => plan.filter((entry) => entry.action === action).length;
  console.log(`\n${count('create')} to add, ${count('exists')} already there, ${count('skip')} repeated on the list.`);

  if (!confirm) {
    console.log('Dry run — nothing written. Run again with --confirm to import.');
    return;
  }
  const result = await applyCustomers(plan, { owner: owner._id });
  console.log(`\n${result.created} added under ${owner.name}.`);
}

main()
  .catch((error) => {
    console.error(`\nStopped: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase().catch(() => {}));
