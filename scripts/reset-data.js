/**
 * Empties the database of working data, keeping exactly one user account.
 *
 * Usage:
 *   npm run reset-data                              # dry run — shows what it would delete
 *   npm run reset-data -- --confirm                 # actually delete
 *   npm run reset-data -- --keep=someone@x.com --confirm
 *
 * Options:
 *   --keep=<email>   the one account to survive (default: rsnavin02@gmail.com)
 *   --confirm        required to delete anything; without it this is a dry run
 *   --keep-catalogue leave the product master alone (models, MOQs, standard prices)
 *
 * Reads MONGO_URI from .env, like the server does.
 *
 * **This is not reversible.** Two things guard it, and both are deliberate:
 *
 * A dry run is the default. Running it with no flags prints the collection-by-collection
 * count and deletes nothing, so the first thing anybody sees is what they are about to lose.
 *
 * The surviving account is verified before a single document is removed. A typo in the email
 * would otherwise leave a database with no users at all and no way back in — which is the one
 * failure that turns "clear the data" into "restore from backup".
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';

import User from '../src/models/User.js';
import Lead from '../src/models/Lead.js';
import Customer from '../src/models/Customer.js';
import Enquiry from '../src/models/Enquiry.js';
import Sample from '../src/models/Sample.js';
import SampleLog from '../src/models/SampleLog.js';
import Pricing from '../src/models/Pricing.js';
import Quotation from '../src/models/Quotation.js';
import Product from '../src/models/Product.js';
import Attachment from '../src/models/Attachment.js';
import AuditLog from '../src/models/AuditLog.js';
import Announcement from '../src/models/Announcement.js';
import CustomerMessage from '../src/models/CustomerMessage.js';
import StickyNote from '../src/models/StickyNote.js';
import Todo from '../src/models/Todo.js';
import OtpToken from '../src/models/OtpToken.js';
import Counter from '../src/models/Counter.js';

const DEFAULT_KEEP = 'rsnavin02@gmail.com';

const argument = (name, fallback) => {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

/**
 * Everything that gets emptied, in the order a person would explain it.
 *
 * `Counter` is in the list on purpose: it holds the running numbers behind ENQ-2026-0001 and
 * friends. Leaving it would restart a clean database at ENQ-2026-0042, which reads as data
 * having been deleted rather than never existing — and worse, a restored backup would then
 * collide with numbers already issued.
 */
const COLLECTIONS = [
  ['Leads', Lead],
  ['Enquiries', Enquiry],
  ['Customers', Customer],
  ['Samples', Sample],
  ['Sample logs', SampleLog],
  ['Costings', Pricing],
  ['Quotations', Quotation],
  ['Attachments', Attachment],
  ['Customer messages', CustomerMessage],
  ['Audit log', AuditLog],
  ['Announcements', Announcement],
  ['Sticky notes', StickyNote],
  ['To-dos', Todo],
  ['Sign-in codes', OtpToken],
  ['Document numbering', Counter],
];

async function run() {
  const keep = argument('keep', DEFAULT_KEEP).toLowerCase();
  const confirmed = flag('confirm');
  const keepCatalogue = flag('keep-catalogue');

  await connectDatabase();

  /*
   * Checked first, and the run stops here if it fails. Deleting every other account before
   * discovering the survivor was misspelled leaves a database nobody can sign in to.
   */
  const survivor = await User.findOne({ email: keep });
  if (!survivor) {
    const known = await User.find().select('email').sort('email').lean();
    console.error(`\nNo account with the email ${keep}.`);
    console.error('Nothing has been deleted. The accounts that exist are:\n');
    known.forEach((user) => console.error(`  ${user.email}`));
    console.error('\nRe-run with --keep=<one of those>.');
    process.exitCode = 1;
    return;
  }

  const targets = keepCatalogue ? COLLECTIONS : [...COLLECTIONS, ['Product master', Product]];

  const counts = await Promise.all(
    targets.map(async ([label, Model]) => [label, await Model.countDocuments()])
  );
  const otherUsers = await User.countDocuments({ _id: { $ne: survivor._id } });

  const total = counts.reduce((sum, [, count]) => sum + count, 0) + otherUsers;

  console.log(`\n${confirmed ? 'Deleting' : 'Would delete'} from ${mongoose.connection.name}:\n`);
  counts.forEach(([label, count]) => {
    if (count) console.log(`  ${String(count).padStart(6)}  ${label}`);
  });
  if (otherUsers) console.log(`  ${String(otherUsers).padStart(6)}  Other user accounts`);
  console.log(`\n  ${String(total).padStart(6)}  documents in total`);
  console.log(`\nKeeping: ${survivor.name} <${survivor.email}> (${survivor.role})`);
  if (keepCatalogue) console.log('Keeping: the product master, untouched.');

  if (!confirmed) {
    console.log('\nThis was a dry run — nothing has changed.');
    console.log('Re-run with --confirm to actually delete it.\n');
    return;
  }

  for (const [label, Model] of targets) {
    const { deletedCount } = await Model.deleteMany({});
    if (deletedCount) console.log(`  cleared ${label} (${deletedCount})`);
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

  console.log('\nDone. The database now holds one user and nothing else.\n');
}

run()
  .catch((error) => {
    console.error('\nFailed:', error.message);
    process.exitCode = 1;
  })
  .finally(disconnectDatabase);
