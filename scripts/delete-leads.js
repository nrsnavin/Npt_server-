/**
 * Deletes every lead, now that the CRM has no leads.
 *
 * The workflow starts at the enquiry (Navin CRM role requirements, 7 Oct 2026): IndiaMART and
 * visiting cards make a customer and an enquiry directly, so the `leads` collection is no longer
 * read by anything. This removes it and everything that pointed at it:
 *
 *   leads                    every document, then the collection
 *   customers                `convertedFromLead` unset
 *   enquiries                `lead` unset
 *   samples                  `lead` unset — the samples themselves stay; one made for a lead that
 *                            never became a customer is left with no buyer, and is counted
 *   whatsappthreads          `lead` unset, `matchedBy: 'lead'` becomes 'unknown'
 *   leadcards                `lead` and `matchedLead` unset (the visiting-card drafts stay)
 *   todos                    follow-up and gone-quiet reminders for leads deleted
 *   savedviews               views of the old Leads list deleted
 *   auditlogs                the leads' change history deleted
 *   outboxes                 undelivered `lead.converted` events deleted
 *   counters                 the LEAD-<year> numbering counters deleted
 *   indexes                  `lead_1` on samples and whatsappthreads dropped
 *
 * **This cannot be undone.** Take a backup first:
 *
 *   mongodump --uri "$MONGO_URI" --out ~/backup-before-deleting-leads
 *
 * **Dry run by default.** Prints what it would delete and changes nothing. Pass `--confirm`.
 *
 *   npm run delete:leads              # show me
 *   npm run delete:leads -- --confirm # do it
 *
 * Safe to run again: a second run finds nothing and says so.
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';

const confirm = process.argv.includes('--confirm');

/*
 * Raw collections throughout. The models no longer have the lead fields, and Mongoose applies
 * the current schema on read and write — an update through a model would not see the field it
 * was asked to remove.
 */
async function exists(db, name) {
  return (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
}

async function dropIndexIfThere(collection, name, write) {
  const indexes = await collection.indexes().catch(() => []);
  if (!indexes.some((index) => index.name === name)) return false;
  if (write) await collection.dropIndex(name);
  return true;
}

export async function deleteLeads(db, { write = confirm, log = console.log } = {}) {
  const c = (name) => db.collection(name);
  const report = {};

  const step = async (label, count, act) => {
    report[label] = count;
    log(`  ${label.padEnd(44)} ${count}`);
    if (write && count) await act();
  };

  const hasLeads = await exists(db, 'leads');
  const leadCount = hasLeads ? await c('leads').countDocuments() : 0;
  await step('leads', leadCount, async () => { await c('leads').drop(); });

  const filterHas = (field) => ({ [field]: { $exists: true } });
  await step('customers: convertedFromLead', await c('customers').countDocuments(filterHas('convertedFromLead')),
    () => c('customers').updateMany(filterHas('convertedFromLead'), { $unset: { convertedFromLead: '' } }));
  await step('enquiries: lead', await c('enquiries').countDocuments(filterHas('lead')),
    () => c('enquiries').updateMany(filterHas('lead'), { $unset: { lead: '' } }));

  const orphans = { lead: { $exists: true }, $or: [{ customer: null }, { customer: { $exists: false } }] };
  report.samplesLeftWithoutBuyer = await c('samples').countDocuments(orphans);
  await step('samples: lead', await c('samples').countDocuments(filterHas('lead')),
    () => c('samples').updateMany(filterHas('lead'), { $unset: { lead: '' } }));
  if (report.samplesLeftWithoutBuyer) {
    log(`    (${report.samplesLeftWithoutBuyer} of them were for a lead that never became a customer — they keep no buyer;`
      + ' link them to a customer from the sample screen if they matter)');
  }

  const threadsWith = { $or: [filterHas('lead'), { matchedBy: 'lead' }] };
  await step('whatsappthreads: lead', await c('whatsappthreads').countDocuments(threadsWith), async () => {
    await c('whatsappthreads').updateMany({ matchedBy: 'lead' }, { $set: { matchedBy: 'unknown' } });
    await c('whatsappthreads').updateMany(filterHas('lead'), { $unset: { lead: '' } });
  });

  const cardsWith = { $or: [filterHas('lead'), filterHas('matchedLead')] };
  await step('leadcards: lead, matchedLead', await c('leadcards').countDocuments(cardsWith),
    () => c('leadcards').updateMany(cardsWith, { $unset: { lead: '', matchedLead: '' } }));

  const leadTodos = { $or: [{ originKey: /^lead:/ }, { link: /^\/leads(\/|$|\?)/ }] };
  await step('todos: lead reminders', await c('todos').countDocuments(leadTodos),
    () => c('todos').deleteMany(leadTodos));

  await step('savedviews: Leads list', await c('savedviews').countDocuments({ page: 'leads' }),
    () => c('savedviews').deleteMany({ page: 'leads' }));
  await step('auditlogs: lead history', await c('auditlogs').countDocuments({ model: 'Lead' }),
    () => c('auditlogs').deleteMany({ model: 'Lead' }));
  await step('outboxes: lead.converted', await c('outboxes').countDocuments({ event: 'lead.converted' }),
    () => c('outboxes').deleteMany({ event: 'lead.converted' }));
  await step('counters: LEAD numbering', await c('counters').countDocuments({ key: /^LEAD-/ }),
    () => c('counters').deleteMany({ key: /^LEAD-/ }));

  for (const name of ['samples', 'whatsappthreads']) {
    const dropped = (await exists(db, name)) && (await dropIndexIfThere(c(name), 'lead_1', write));
    if (dropped) log(`  ${`${name}: index lead_1`.padEnd(44)} ${write ? 'dropped' : 'would drop'}`);
  }

  return report;
}

async function main() {
  await connectDatabase();
  console.log(confirm ? '\nDeleting leads:\n' : '\nDry run — nothing will change. What would be deleted:\n');
  const report = await deleteLeads(mongoose.connection.db);
  const total = Object.entries(report).filter(([key]) => key !== 'samplesLeftWithoutBuyer').reduce((sum, [, n]) => sum + n, 0);
  if (!total) console.log('\nNothing to do: no leads left.');
  else if (!confirm) console.log('\nRun again with --confirm to delete. Take a backup first (mongodump).');
  else console.log('\nDone.');
  await disconnectDatabase();
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  main().catch(async (error) => {
    console.error(error);
    await disconnectDatabase().catch(() => null);
    process.exit(1);
  });
}
