/**
 * Reads the plant's price sheet onto the registers: Manufacture rows onto the mould register,
 * Trade rows onto the trading master, each with its photo fetched from the sheet's link
 * [services/mouldSheet.service.js].
 *
 * Usage:
 *   npm run import:mould-sheet                                        # dry run of the bundled sheet
 *   npm run import:mould-sheet -- --confirm                           # write it
 *   npm run import:mould-sheet -- path/to/sheet.tsv --confirm         # another sheet (tab or comma separated)
 *
 * Options:
 *   --confirm         required to write anything; without it this prints what would happen
 *   --no-photos       records only; the photos can be fetched by running it again without this
 *   --pp-rate=<₹/kg>  the PP rate for a bought-in item's estimated inward price
 *                     (default: the newest PP on the material register)
 *   --by=<email>      who the photos are recorded as uploaded by (default: rsnavin1@gmail.com)
 *
 * No duplicates: the rows of one code are merged into one record (the first row's figures stand,
 * later rows fill its blanks, differences are listed to check), and a code already on a register
 * is updated however it is spelt there ("CRF-25" = "CRF25" = "crf 25"). A row with nothing but
 * its name goes in with prefilled values — weight 0 g, 1 cavity, 30 s cycle, PP — noted on the
 * record as to fill in. "CODE (2)" copies an earlier import made are listed, never deleted.
 *
 * Safe to run again: a photo already fetched from the same link is kept, not fetched again.
 * Reads MONGO_URI from .env.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import User from '../src/models/User.js';
import { applySheet, codeKey, earlierCopies, parseSheet, planSheet, ppRateFor, readSheet } from '../src/services/mouldSheet.service.js';
import { photoFetcher } from '../src/services/recordPhoto.service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SHEET = path.join(here, '..', 'data', 'mould-sheet-ip-14-02-26.tsv');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const file = args.find((arg) => !arg.startsWith('--')) || DEFAULT_SHEET;
const confirm = flag('confirm');

async function main() {
  const read = readSheet(parseSheet(readFileSync(file, 'utf8')));
  if (read.error) throw new Error(read.error);

  await connectDatabase();
  console.log(`Database: ${mongoose.connection.name}`);
  console.log(`Sheet: ${path.basename(file)} — ${read.entries.length} rows`);

  const plan = await planSheet(read.entries);
  const merged = plan.filter((entry) => entry.lines.length > 1);
  console.log(`Records:         ${plan.length} (${read.entries.length - plan.length} repeated rows merged into ${merged.length} records)\n`);
  const count = (register, action) => plan.filter((entry) => entry.register === register && entry.action === action).length;
  console.log(`Mould register:  ${count('mould', 'create')} new, ${count('mould', 'update')} updated`);
  console.log(`Trading master:  ${count('traded', 'create')} new, ${count('traded', 'update')} updated`);
  const skipped = plan.filter((entry) => entry.action === 'skip');
  console.log(`Skipped:         ${skipped.length}`);
  for (const entry of skipped) console.log(`  line ${entry.line} ${entry.code}: ${entry.reason}`);
  const warned = plan.filter((entry) => entry.action !== 'skip' && entry.warnings.length);
  if (warned.length) {
    console.log(`\nTo check (${warned.length}):`);
    for (const entry of warned) console.log(`  line ${entry.line} ${entry.code}: ${entry.warnings.join('; ')}`);
  }

  const copies = (await earlierCopies()).filter((copy) => plan.some((entry) => codeKey(entry.code) === codeKey(copy.of)));
  if (copies.length) {
    console.log(`\nCopies an earlier import made (${copies.length}) — not touched; merge or delete them on the register:`);
    for (const copy of copies) console.log(`  ${copy.code} (${copy.register === 'mould' ? 'mould register' : 'trading master'}) — the sheet's ${copy.of} is updated instead`);
  }

  const pp = await ppRateFor(Number(option('pp-rate')) || 0);
  console.log(`\nPP rate for estimated inward prices: ${pp.rate ? `₹${pp.rate}/kg (${pp.from})` : 'none on the material register — resin left out; pass --pp-rate='}`);

  if (!confirm) {
    console.log('\nDry run — nothing written. Run again with --confirm to import.');
    return;
  }

  const email = option('by') || 'rsnavin1@gmail.com';
  const by = await User.findOne({ email }) || await User.findOne({ role: 'admin' });
  if (!by) throw new Error(`No user ${email} and no admin to record the photos against`);

  const photos = !flag('no-photos');
  console.log(`\nImporting${photos ? ' and fetching photos' : ''}…`);
  const result = await applySheet(plan, {
    by,
    ppRate: pp.rate,
    sheetName: 'the IP-14/2/26 sheet',
    fetchPhoto: photoFetcher(),
    photos,
    log: (line) => console.log(line),
  });
  console.log(`\nMould register:  ${result.moulds.created} created, ${result.moulds.updated} updated`);
  console.log(`Trading master:  ${result.traded.created} created, ${result.traded.updated} updated`);
  if (photos) {
    console.log(`Photos:          ${result.photos.added} added, ${result.photos.kept} already there, ${result.photos.failed.length} not fetched`);
    for (const miss of result.photos.failed) console.log(`  line ${miss.line} ${miss.code}: ${miss.reason}`);
  }
}

main()
  .catch((error) => {
    console.error(`\nStopped: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase().catch(() => {}));
