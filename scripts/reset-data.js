/**
 * Empties the database of working data, keeping exactly one user account.
 *
 * Usage:
 *   npm run reset-data                              # dry run — shows what it would delete
 *   npm run reset-data -- --confirm                 # actually delete
 *   npm run reset-data -- --keep=someone@x.com --confirm
 *   npm run reset-data -- --keep-registers --confirm
 *   npm run reset-data -- --keep-users --confirm    # every login stays; all the data goes
 *   npm run reset-data -- --keep=a@x.com,b@x.com --keep-customers --keep-masters --confirm
 *   npm run reset:fresh-start -- --confirm          # the same, for rsnavin1@gmail.com and info@navinplastic.com
 *
 * Options:
 *   --keep=<email>[,<email>…]  the accounts to survive (default: rsnavin1@gmail.com); every one
 *                     must exist, or nothing is deleted
 *   --keep-customers  keep the customer register (their contacts, addresses, owners); what
 *                     happened with them — follow-ups, credit status, business totals — is reset,
 *                     and a customer whose owner is deleted goes to the first account kept
 *   --keep-masters    keep every master: the registers below, plus machines, delivery routes,
 *                     transporters and vehicles, and the mould / trading-item photos
 *   --confirm         required to delete anything; without it this is a dry run
 *   --keep-users      keep every user account (with its department and password), not only one —
 *                     for clearing the working data while everybody can still sign in
 *   --keep-registers  leave the model masters alone — moulds, materials, hooks/clips/print, the trading master
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
const REGISTERS = ['Mould', 'Material', 'Component', 'TradedItem'];

/** The registers and the dispatch masters — what `--keep-masters` spares. */
const MASTERS = [...REGISTERS, 'Machine', 'DeliveryRoute', 'Transporter', 'Vehicle'];

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
 * `Quotation` carries the costing too now, and `Counter` is the running
 * numbers behind SO-2026-0001 — a line reading "Counter 14" tells somebody nothing about what
 * they are about to lose. Anything not named here prints its own model name, which is right
 * for `Lead`, `Enquiry` and most of the rest.
 */
const LABELS = {
  Quotation: 'Quotations (with their costings)',
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
  TradedItem: 'Trading master',
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
  const keeps = argument('keep', DEFAULT_KEEP).toLowerCase().split(',').map((email) => email.trim()).filter(Boolean);
  const confirmed = flag('confirm');
  const keepMasters = flag('keep-masters');
  const keepRegisters = keepMasters || flag('keep-registers') || flag('keep-catalogue');
  const keepUsers = flag('keep-users');
  const keepCustomers = flag('keep-customers');

  await connectDatabase();
  const registered = await loadModels();
  const User = mongoose.models.User;

  /*
   * Checked first, and the run stops here if it fails. Deleting every other account before
   * discovering the survivor was misspelled leaves a database nobody can sign in to.
   */
  const found = await User.find({ email: { $in: keeps } });
  const survivors = keeps.map((email) => found.find((user) => user.email === email)).filter(Boolean);
  const survivor = survivors[0];
  const missing = keeps.filter((email) => !found.some((user) => user.email === email));
  if (missing.length) {
    const known = await User.find().select('email').sort('email').lean();
    console.error(`\nNo account with the email ${missing.join(', ')} in ${mongoose.connection.name}.`);
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

  const kept = [
    ...(keepRegisters ? REGISTERS : []),
    ...(keepMasters ? MASTERS : []),
    ...(keepCustomers ? ['Customer'] : []),
  ];
  const targets = registered.filter((name) => !SPARED.includes(name) && !kept.includes(name));
  /*
   * Within two collections, part stays: the photos of the moulds and trading items kept, and the
   * running number behind the customer codes kept — without it the next customer would be
   * CUST-2026-0001 again and collide with the one already there.
   */
  const partly = {
    Attachment: keepMasters ? { mould: { $exists: false }, tradedItem: { $exists: false } } : {},
    Counter: keepCustomers ? { key: { $not: /^CUST-/ } } : {},
  };
  const scope = (name) => partly[name] || {};

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
    counts.push([name, await mongoose.models[name].countDocuments(scope(name))]);
  }
  const otherUsers = keepUsers ? 0 : await User.countDocuments({ _id: { $nin: survivors.map((user) => user._id) } });
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

  if (keepUsers) console.log(`\nKeeping: every user account (${await User.countDocuments()}), so everybody can still sign in`);
  else survivors.forEach((user) => console.log(`\nKeeping: ${user.name} <${user.email}> (${user.role})`));
  if (keepMasters) console.log(`Keeping: the masters — ${MASTERS.map(label).join(', ')} — and their photos.`);
  else if (keepRegisters) console.log(`Keeping: the registers — ${REGISTERS.map(label).join(', ')} — untouched.`);
  if (keepCustomers) {
    console.log(`Keeping: the ${await mongoose.models.Customer.countDocuments()} customers — follow-ups, credit status and business totals reset.`);
  }

  if (!confirmed) {
    console.log('\nThis was a dry run — nothing has changed.');
    console.log('Re-run with --confirm to actually delete it.\n');
    return;
  }

  for (const name of targets) {
    const { deletedCount } = await mongoose.models[name].deleteMany(scope(name));
    if (deletedCount) console.log(`  cleared ${label(name)} (${deletedCount})`);
  }

  if (!keepUsers) {
    const { deletedCount } = await User.deleteMany({ _id: { $nin: survivors.map((user) => user._id) } });
    if (deletedCount) console.log(`  cleared other accounts (${deletedCount})`);
  }

  /*
   * The customers stay as the register they are; what happened with them goes with the rest of
   * the working data, and one whose owner was deleted is handed to the first account kept.
   */
  if (keepCustomers) {
    const Customer = mongoose.models.Customer;
    await Customer.updateMany({}, {
      $unset: { followUp: 1, followUpLog: 1, lastOrderDate: 1 },
      $set: { totalBusinessValue: 0, 'credit.status': 'good' },
    });
    const owners = (await User.find().select('_id').lean()).map((user) => user._id);
    const { modifiedCount } = await Customer.updateMany({ assignedTo: { $nin: owners } }, { $set: { assignedTo: survivor._id } });
    if (modifiedCount) console.log(`  handed ${modifiedCount} customers to ${survivor.email} — their owner was deleted`);
  }

  /*
   * One survivor is made an admin on the way out when none is. They are the only accounts left,
   * so anything less locks the whole system: no one to grant a module, no one to add a colleague.
   */
  if (!keepUsers && !survivors.some((user) => user.role === 'admin')) {
    survivor.role = 'admin';
    await survivor.save();
    console.log(`  promoted ${survivor.email} to admin — no account left was one`);
  }

  const people = keepUsers ? 'its users' : survivors.length === 1 ? 'one user' : `${survivors.length} users`;
  const also = [keepCustomers && 'the customers', keepMasters ? 'the masters' : keepRegisters && 'the registers'].filter(Boolean);
  const left = `${people}${also.length ? `, ${also.join(' and ')},` : ''} and nothing else`;
  console.log(`\nDone. "${mongoose.connection.name}" now holds ${left}.\n`);
}

run()
  .catch((error) => {
    console.error('\nFailed:', error.message);
    process.exitCode = 1;
  })
  .finally(disconnectDatabase);
