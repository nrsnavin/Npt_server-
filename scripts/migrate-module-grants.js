/**
 * Rewrites grants for modules that have been merged into another.
 *
 * Access is whatever is stored on the user — there is no department fallback and no implicit
 * rule — so merging a module changes what every person holding it can do. Quotations folded
 * into pricing, and without this every marketing person would be carrying a grant for a module
 * that no longer exists: `normaliseGrants` drops it the next time their record is saved, and
 * from that moment they cannot raise a quotation and nothing on the screen says why.
 *
 * `accessLevel` already reads a retired grant as the module that absorbed it, so nobody is
 * locked out in the meantime. This makes it permanent, and makes what is stored match what is
 * enforced — which matters because the access screen shows the stored grant. An admin looking
 * at a user who can quote should see that they can quote.
 *
 *   quotations: read   →   pricing: read
 *   quotations: write  →   pricing: quote
 *
 * `write` becomes `quote`, never `write`. The old grant was permission to raise a document,
 * never permission to see a cost — promoting it would hand the plant's cost base, margin and
 * floor price to every marketing person the day this ran, which is the one thing §8 exists to
 * prevent.
 *
 * **Strongest wins.** A user holding both the retired grant and a grant for the module that
 * absorbed it keeps whichever is higher, so a costing clerk who already held `pricing: write`
 * is never demoted to `quote` by their old quotations grant.
 *
 * **Idempotent.** A user with no retired grant is skipped, so running it twice is safe and a
 * half-finished run can simply be run again.
 *
 * **Dry run by default.** Prints what it would do and changes nothing. Pass `--confirm` to write.
 *
 *   node scripts/migrate-module-grants.js            # show me
 *   node scripts/migrate-module-grants.js --confirm  # do it
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { RETIRED_MODULES, levelSatisfies } from '../src/config/modules.js';

const confirm = process.argv.includes('--confirm');
const RETIRED_KEYS = Object.keys(RETIRED_MODULES);

/**
 * One user's grants, with every retired module folded into the one that absorbed it.
 *
 * Returns null when there is nothing to do, so the caller can skip without comparing documents.
 */
function rewrite(grants = []) {
  if (!grants.some((grant) => RETIRED_KEYS.includes(grant.module))) return null;

  const held = new Map(grants.map((grant) => [grant.module, grant.level]));

  for (const key of RETIRED_KEYS) {
    const level = held.get(key);
    if (!level) continue;

    const { module: target, levels } = RETIRED_MODULES[key];
    const mapped = levels[level];
    held.delete(key);
    if (!mapped) continue;

    const existing = held.get(target);
    /* Never a demotion: a costing clerk carrying both grants keeps write. */
    if (!existing || levelSatisfies(mapped, existing)) held.set(target, mapped);
  }

  return [...held].map(([module, level]) => ({ module, level }));
}

async function migrate() {
  await connectDatabase();
  const users = mongoose.connection.collection('users');

  const affected = await users
    .find({ 'moduleAccess.module': { $in: RETIRED_KEYS } })
    .toArray();

  console.log(
    `${affected.length} user(s) hold a grant for a merged module ` +
      `(${RETIRED_KEYS.join(', ')}).\n`
  );

  let written = 0;
  for (const user of affected) {
    const next = rewrite(user.moduleAccess);
    if (!next) continue;

    const was = (user.moduleAccess || [])
      .filter((grant) => RETIRED_KEYS.includes(grant.module))
      .map((grant) => `${grant.module}:${grant.level}`)
      .join(', ');
    const now = next
      .filter((grant) => Object.values(RETIRED_MODULES).some((t) => t.module === grant.module))
      .map((grant) => `${grant.module}:${grant.level}`)
      .join(', ');

    console.log(`  ${user.email || user.name || user._id}   ${was}  →  ${now}`);

    if (confirm) {
      await users.updateOne({ _id: user._id }, { $set: { moduleAccess: next } });
      written += 1;
    }
  }

  console.log('');
  if (confirm) {
    console.log(`Rewrote grants for ${written} user(s).`);
  } else {
    console.log(
      `Dry run — nothing was changed. Re-run with --confirm to rewrite ${affected.length}.`
    );
  }

  await disconnectDatabase();
}

migrate().catch(async (error) => {
  console.error(error);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
