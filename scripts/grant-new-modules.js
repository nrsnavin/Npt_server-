/**
 * Gives existing people the grants a newly added module would have given them.
 *
 * Access is whatever is stored on the user. `defaultAccess` on a department is consulted **once,
 * when a user is created**, and never again — which is right, because an admin who deliberately
 * takes a module away from somebody should not have it handed back on the next deploy. The cost
 * is that adding a module to this app grants it to nobody who already exists: the queries feature
 * ships, every screen is built, and on the box the whole department gets a 403 with nothing on
 * screen explaining why, because their user records were written before the module had a name.
 *
 * So this is the other half of adding a module, and it is deliberately the narrow half:
 *
 *   **It only ever adds, and only what the department already suggests.** A person is given the
 *   level their own department's `defaultAccess` names — the same thing they would have been
 *   given had they been created today. A department whose default does not include the module
 *   gets nothing, so this cannot be used to hand production the pricing module.
 *
 *   **It never touches a module somebody already holds.** Any grant at all for that module, at
 *   any level, means the question has already been decided by an admin — including the decision
 *   to give somebody less. Silently promoting a `read` to `write` because the default says so is
 *   exactly the overwrite that makes an access screen untrustworthy.
 *
 *   **It cannot take anything away.** There is no removal path here at all. A module going away
 *   is a different job with a different risk, and it is `migrate-module-grants.js`.
 *
 * Idempotent: a second run finds nobody left to grant. Dry run by default.
 *
 *   node scripts/grant-new-modules.js                     # show me, for queries
 *   node scripts/grant-new-modules.js --confirm           # do it
 *   node scripts/grant-new-modules.js tasks --confirm     # some other module
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { MODULE_KEYS, findDepartment } from '../src/config/modules.js';

const confirm = process.argv.includes('--confirm');

/**
 * Which modules to catch people up on.
 *
 * `queries` is the default because it is the one that needs it today; the script is written
 * around a list because this is not a one-off problem — every module added after the first user
 * was created has it, and the next one will too.
 */
const asked = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
const MODULES = asked.length ? asked : ['queries'];

const unknown = MODULES.filter((key) => !MODULE_KEYS.includes(key));
if (unknown.length) {
  console.error(`Not a module in this app: ${unknown.join(', ')}`);
  console.error(`Known modules: ${MODULE_KEYS.join(', ')}`);
  process.exit(1);
}

/**
 * The grants this person is missing, as rows to append.
 *
 * Empty when there is nothing to do, so the caller can skip without comparing documents.
 */
function missing(user) {
  const held = new Set((user.moduleAccess || []).map((grant) => grant.module));
  const defaults = findDepartment(user.department)?.defaultAccess || {};

  return MODULES
    /* Already decided, at whatever level. Not ours to revisit. */
    .filter((key) => !held.has(key))
    /* Only what this department would have been given anyway. */
    .filter((key) => defaults[key])
    .map((key) => ({ module: key, level: defaults[key] }));
}

async function grant() {
  await connectDatabase();
  const users = mongoose.connection.collection('users');

  const everybody = await users.find({}).toArray();
  console.log(`Catching ${everybody.length} user(s) up on: ${MODULES.join(', ')}\n`);

  let written = 0;
  let skipped = 0;

  for (const user of everybody) {
    const rows = missing(user);
    if (!rows.length) {
      skipped += 1;
      continue;
    }

    const added = rows.map((row) => `${row.module}:${row.level}`).join(', ');
    console.log(`  ${user.email || user.name || user._id}  (${user.department})   + ${added}`);

    if (confirm) {
      await users.updateOne({ _id: user._id }, { $push: { moduleAccess: { $each: rows } } });
      written += 1;
    }
  }

  console.log('');
  console.log(`${skipped} user(s) already had it, or their department does not get it.`);

  if (confirm) {
    console.log(`Granted ${written} user(s).`);
  } else {
    console.log(`Dry run — nothing was changed. Re-run with --confirm to grant ${everybody.length - skipped}.`);
  }

  await disconnectDatabase();
}

grant().catch(async (error) => {
  console.error(error);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
