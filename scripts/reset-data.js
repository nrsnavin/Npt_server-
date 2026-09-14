/**
 * Empties the database of working data, keeping exactly one user account.
 *
 * Usage:
 *   npm run reset-data                              # dry run — shows what it would delete
 *   npm run reset-data -- --confirm                 # actually delete
 *   npm run reset-data -- --keep=someone@x.com --confirm
 *   npm run reset-data -- --keep-registers --confirm
 *
 * Options:
 *   --keep=<email>    the one account to survive (default: rsnavin1@gmail.com)
 *   --confirm         required to delete anything; without it this is a dry run
 *   --keep-registers  leave the model masters alone — moulds, materials, hooks/clips/print
 *                     [§28]. `--keep-catalogue` is accepted as the old name for this.
 *
 * Reads MONGO_URI from .env, like the server does. Nothing is read from the command line but
 * the flags above — in particular there is no way to point it at a different database, because
 * "wrong database" is the mistake this script must not make easy.
 *
 * **This is not reversible.** Three things guard it, and all three are deliberate:
 *
 * A dry run is the default. Running it with no flags prints the collection-by-collection count
 * and deletes nothing, so the first thing anybody sees is what they are about to lose.
 *
 * The surviving account is verified before a single document is removed. A typo in the email
 * would otherwise leave a database with no users at all and no way back in — which is the one
 * failure that turns "clear the data" into "restore from backup".
 *
 * And the database is named in the output. A person running this against production believing
 * it is staging is the only failure mode left, and the one thing that helps is the name of the
 * thing being emptied, printed where they are already looking.
 *
 * ---
 *
 * **The collection list is discovered, not typed.** That is the whole of the rewrite.
 *
 * This script used to carry a hand-written list of sixteen models. Eleven had been added since
 * it was written — sales orders, consignments, inspections, receivables, escalations, order
 * queries, the material and component registers — and it cleared none of them while printing
 * "the database now holds one user and nothing else". A destructive script that lies in its
 * last line is worse than no script: somebody hands the system over believing it is clean.
 *
 * So every model file is imported and Mongoose is asked what it has. A model added tomorrow is
 * covered without anybody remembering this file exists, and the only way to be missed is to be
 * named in SPARED below, where the omission is deliberate and visible.
 */
import { readdirSync } from 'node:fs';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';

const DEFAULT_KEEP = 'rsnavin1@gmail.com';

/**
 * The model masters [§28] — the things the plant *is*, rather than what happened to it.
 *
 * A mould, a resin, a hook: these are measured facts about tooling and bought-in parts, and
 * re-entering them is days of work with a vernier. Cleared by default all the same, because
 * "delete all the data" means all of it — but named as a group so `--keep-registers` can spare
 * exactly them, which is what somebody clearing a year of transactions before a fresh start
 * actually wants.
 */
const REGISTERS = ['Mould', 'Material', 'Component'];

/**
 * Handled separately, not skipped. Listed here so a reader can see there is no third category.
 */
const SPARED = ['User'];

/**
 * Reads `src/models` and lets each file register itself, so nothing has to be listed twice.
 *
 * Index building is turned off first, and that is not a performance note. Registering
 * twenty-seven models against a live connection sets Mongoose building every index on every one
 * of them, each on its own pooled connection — which a small standalone answers by timing one
 * out, and the script then dies before printing a word. A script whose whole job is to delete
 * documents has no business creating indexes anyway; the server does that when it starts.
 */
async function loadModels() {
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);

  const directory = new URL('../src/models/', import.meta.url);
  for (const entry of readdirSync(directory)) {
    if (entry.endsWith('.js')) await import(new URL(entry, directory));
  }
  return Object.keys(mongoose.models).sort();
}

const argument = (name, fallback) => {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

/**
 * A label a person recognises. Only where the model name is not already one.
 *
 * `Pricing` is the costing sheet everywhere in the application, and `Counter` is the running
 * numbers behind SO-2026-0001 — a line reading "Counter 14" tells somebody nothing about what
 * they are about to lose. Anything not named here prints its own model name, which is right
 * for `Lead`, `Enquiry` and most of the rest.
 */
const LABELS = {
  Pricing: 'Costings',
  SalesOrder: 'Sales orders',
  Dispatch: 'Consignments',
  Inspection: 'Quality inspections',
  OrderQuery: 'Questions between departments',
  OrderEscalation: 'Escalations',
  Receivable: 'Receivables',
  CustomerMessage: 'Customer messages',
  SampleLog: 'Sample logs',
  StickyNote: 'Sticky notes',
  Todo: 'To-dos',
  OtpToken: 'Sign-in codes',
  OperationLock: 'Operation locks',
  SyncState: 'Integration sync state',
  AuditLog: 'Audit log',
  Component: 'Hook / clip / print register',
  Material: 'Material register',
  Mould: 'Mould register',
  /*
   * In the list on purpose. It holds the running numbers behind ENQ-2026-0001 and friends, and
   * leaving it would restart a clean database at ENQ-2026-0042 — which reads as data having
   * been deleted rather than never existing, and worse, a restored backup would then collide
   * with numbers already issued.
   */
  Counter: 'Document numbering',
};

const label = (name) => LABELS[name] || `${name}s`;

async function run() {
  const keep = argument('keep', DEFAULT_KEEP).toLowerCase();
  const confirmed = flag('confirm');
  const keepRegisters = flag('keep-registers') || flag('keep-catalogue');

  await connectDatabase();
  const registered = await loadModels();
  const User = mongoose.models.User;

  /*
   * Checked first, and the run stops here if it fails. Deleting every other account before
   * discovering the survivor was misspelled leaves a database nobody can sign in to.
   */
  const survivor = await User.findOne({ email: keep });
  if (!survivor) {
    const known = await User.find().select('email').sort('email').lean();
    console.error(`\nNo account with the email ${keep} in ${mongoose.connection.name}.`);
    console.error('Nothing has been deleted. The accounts that exist are:\n');
    known.forEach((user) => console.error(`  ${user.email}`));
    console.error(
      known.length
        ? '\nRe-run with --keep=<one of those>.\n'
        : '\nThis database has no users at all — check MONGO_URI points where you think.\n'
    );
    process.exitCode = 1;
    return;
  }

  const targets = registered.filter(
    (name) => !SPARED.includes(name) && !(keepRegisters && REGISTERS.includes(name))
  );

  /*
   * Counted one at a time, not in parallel.
   *
   * There are twenty-six of these and `Promise.all` puts twenty-six connections in flight at
   * once, which a small standalone — a staging box, or the in-memory server the tests run
   * against — answers by timing one of them out. This is a one-shot admin task nobody is
   * waiting on the clock for, and a sequential pass also means the counts print in a stable
   * order rather than whichever came back first.
   */
  const counts = [];
  for (const name of targets) {
    counts.push([name, await mongoose.models[name].countDocuments()]);
  }
  const otherUsers = await User.countDocuments({ _id: { $ne: survivor._id } });
  const total = counts.reduce((sum, [, count]) => sum + count, 0) + otherUsers;

  console.log(`\n${confirmed ? 'Deleting' : 'Would delete'} from "${mongoose.connection.name}":\n`);
  counts
    .filter(([, count]) => count)
    .sort((a, b) => b[1] - a[1])
    .forEach(([name, count]) => console.log(`  ${String(count).padStart(6)}  ${label(name)}`));
  if (otherUsers) console.log(`  ${String(otherUsers).padStart(6)}  Other user accounts`);
  console.log(`\n  ${String(total).padStart(6)}  documents in total`);

  /* Said even at zero: "nothing to delete" is itself worth knowing, and is usually the sign
     that MONGO_URI points at the wrong place. */
  if (!total) console.log('\n  (this database is already empty apart from the account below)');

  console.log(`\nKeeping: ${survivor.name} <${survivor.email}> (${survivor.role})`);
  if (keepRegisters) {
    console.log(`Keeping: the registers — ${REGISTERS.map(label).join(', ')} — untouched.`);
  }

  if (!confirmed) {
    console.log('\nThis was a dry run — nothing has changed.');
    console.log('Re-run with --confirm to actually delete it.\n');
    return;
  }

  for (const name of targets) {
    const { deletedCount } = await mongoose.models[name].deleteMany({});
    if (deletedCount) console.log(`  cleared ${label(name)} (${deletedCount})`);
  }

  const { deletedCount } = await User.deleteMany({ _id: { $ne: survivor._id } });
  if (deletedCount) console.log(`  cleared other accounts (${deletedCount})`);

  /*
   * The survivor is made an admin on the way out. It is the only account left, so anything
   * less locks the whole system: no one to grant a module, no one to add a colleague back.
   */
  if (survivor.role !== 'admin') {
    survivor.role = 'admin';
    await survivor.save();
    console.log(`  promoted ${survivor.email} to admin — it is the only account left`);
  }

  const left = keepRegisters ? 'one user and the registers, and nothing else' : 'one user and nothing else';
  console.log(`\nDone. "${mongoose.connection.name}" now holds ${left}.\n`);
}

run()
  .catch((error) => {
    console.error('\nFailed:', error.message);
    process.exitCode = 1;
  })
  .finally(disconnectDatabase);
