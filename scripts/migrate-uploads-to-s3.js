/**
 * Copies the uploads folder into S3, for a deployment switching to S3 storage.
 *
 *   S3_BUCKET=npt-uploads npm run migrate:uploads-to-s3              copy what is missing
 *   S3_BUCKET=npt-uploads npm run migrate:uploads-to-s3 -- --dry-run  say what it would copy
 *   S3_BUCKET=npt-uploads npm run migrate:uploads-to-s3 -- --remove-local
 *                                   copy, then delete each local file S3 is confirmed to hold
 *
 * Safe to run again and again: a file already in S3 is left alone. Safe to run while the app is
 * up: the app reads S3 first and falls back to the local folder, so nothing is ever missing.
 */
import '../src/config/env.js';
import { readdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { EXTENSIONS, SAFE_KEY, UPLOAD_ROOT } from '../src/services/storage.service.js';
import { objectExists, putObject, s3Configured } from '../src/services/storage.s3.js';

const dryRun = process.argv.includes('--dry-run');
const removeLocal = process.argv.includes('--remove-local');

if (!s3Configured()) {
  console.error('Set S3_BUCKET (and S3_REGION, or AWS_REGION) first.');
  process.exit(1);
}

const mimeOf = Object.fromEntries(Object.entries(EXTENSIONS).map(([mime, extension]) => [extension, mime]));
const files = (await readdir(UPLOAD_ROOT).catch(() => [])).filter((name) => SAFE_KEY.test(name));
console.log(`${files.length} file(s) in ${UPLOAD_ROOT}`);

const tally = { copied: 0, present: 0, removed: 0, failed: 0 };
let next = 0;
async function worker() {
  while (next < files.length) {
    const name = files[next++];
    try {
      if (await objectExists(name)) {
        tally.present += 1;
      } else if (dryRun) {
        tally.copied += 1;
      } else {
        await putObject(name, await readFile(path.join(UPLOAD_ROOT, name)), mimeOf[path.extname(name)]);
        tally.copied += 1;
      }
      if (removeLocal && !dryRun && (await objectExists(name))) {
        await unlink(path.join(UPLOAD_ROOT, name));
        tally.removed += 1;
      }
    } catch (error) {
      tally.failed += 1;
      console.error(`  ${name}: ${error.message}`);
    }
  }
}
await Promise.all(Array.from({ length: 8 }, worker));

console.log(`${dryRun ? 'Would copy' : 'Copied'} ${tally.copied}, already there ${tally.present}` +
  `${removeLocal ? `, removed locally ${tally.removed}` : ''}, failed ${tally.failed}.`);
process.exit(tally.failed ? 1 : 0);
