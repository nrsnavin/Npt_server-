/**
 * Reads the plant's resin rate list onto the material register [services/materialRates.service.js]:
 * each material by the name the store uses, with its rate per kg — HIPS at +18.8% grammage over
 * PP, every other resin at PP's.
 *
 * Usage:
 *   npm run import:materials                          # dry run of data/material-rates.tsv
 *   npm run import:materials -- --confirm             # write it
 *   npm run import:materials -- path/to/rates.tsv --confirm
 *
 * A material already on the register (same name, any spacing or case) has its rate, resin and
 * grammage brought to the list; one not on the list is left alone. Safe to run again — and to
 * run whenever the rates change. Reads MONGO_URI from .env.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { applyRates, planRates, readRates } from '../src/services/materialRates.service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith('--')) || path.join(here, '..', 'data', 'material-rates.tsv');
const confirm = args.includes('--confirm');

async function main() {
  const entries = readRates(readFileSync(file, 'utf8'));
  await connectDatabase();
  console.log(`Database: ${mongoose.connection.name}`);
  console.log(`Rate list: ${path.basename(file)} — ${entries.length} materials\n`);

  const plan = await planRates(entries);
  for (const entry of plan) {
    const rate = entry.rate === undefined ? '₹0 (no rate)' : `₹${entry.rate}/kg`;
    const grammage = entry.grammage ? ` · grammage +${entry.grammage}%` : '';
    if (entry.action === 'create') console.log(`  add        ${entry.name} · ${rate}${grammage}`);
    else if (entry.action === 'update') {
      const moves = Object.entries(entry.changes).map(([field, { from, to }]) => `${field} ${from} → ${to}`).join(', ');
      console.log(`  update     ${entry.name} · ${moves}`);
    } else if (entry.action === 'skip') console.log(`  skip       line ${entry.line} ${entry.name}: ${entry.reason}`);
    for (const warning of entry.warnings || []) console.log(`             ! ${warning}`);
  }
  const count = (action) => plan.filter((entry) => entry.action === action).length;
  console.log(`\n${count('create')} to add, ${count('update')} to update, ${count('unchanged')} unchanged.`);

  if (!confirm) {
    console.log('Dry run — nothing written. Run again with --confirm to import.');
    return;
  }
  const result = await applyRates(plan);
  console.log(`\n${result.created} added, ${result.updated} updated.`);
}

main()
  .catch((error) => {
    console.error(`\nStopped: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase().catch(() => {}));
