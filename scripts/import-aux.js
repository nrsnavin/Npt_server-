/**
 * Reads the plant's aux price lists — hooks, clips and print — onto their registers
 * [services/auxRates.service.js].
 *
 * Usage:
 *   npm run import:aux                          # dry run of data/aux-rates.tsv
 *   npm run import:aux -- --confirm             # write it
 *   npm run import:aux -- data/print-rates.tsv --confirm   # the print list (1 / 2 / 3 colour)
 *   npm run import:aux -- path/to/aux.tsv --confirm
 *
 * A name with "hook" in it goes on the hook register, a print by its colours on the print
 * register, the rest on the clip register; a part
 * already there (same kind and name, any spacing or case) has its price brought to the list.
 * Safe to run again — and whenever the prices change. Reads MONGO_URI from .env.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { applyAux, planAux, readAux } from '../src/services/auxRates.service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith('--')) || path.join(here, '..', 'data', 'aux-rates.tsv');
const confirm = args.includes('--confirm');

async function main() {
  const entries = readAux(readFileSync(file, 'utf8'));
  await connectDatabase();
  console.log(`Database: ${mongoose.connection.name}`);
  console.log(`Aux list: ${path.basename(file)} — ${entries.length} parts\n`);

  const plan = await planAux(entries);
  for (const entry of plan) {
    const price = entry.rate === undefined ? '₹0 (no price)' : `₹${entry.rate}`;
    const where = entry.kind.padEnd(5);
    if (entry.action === 'create') console.log(`  add     ${where}  ${entry.name} · ${price}${entry.colour ? ` · ${entry.colour}` : ''}`);
    else if (entry.action === 'update') console.log(`  update  ${where}  ${entry.name} · ₹${entry.from} → ${price}`);
    else if (entry.action === 'skip') console.log(`  skip    line ${entry.line} ${entry.name}: ${entry.reason}`);
    for (const warning of entry.warnings || []) console.log(`          ! ${warning}`);
  }
  const count = (action, kind) => plan.filter((entry) => entry.action === action && (!kind || entry.kind === kind)).length;
  const kinds = ['hook', 'clip', 'print'].filter((kind) => plan.some((entry) => entry.kind === kind));
  console.log(`\n${kinds.map((kind) => `${kind[0].toUpperCase()}${kind.slice(1)}s: ${count('create', kind)} to add, ${count('update', kind)} to update`).join(' · ')} · ${count('unchanged')} unchanged.`);

  if (!confirm) {
    console.log('Dry run — nothing written. Run again with --confirm to import.');
    return;
  }
  const result = await applyAux(plan);
  console.log(`\n${result.created} added, ${result.updated} updated.`);
}

main()
  .catch((error) => {
    console.error(`\nStopped: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase().catch(() => {}));
