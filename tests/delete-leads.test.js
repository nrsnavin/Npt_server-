/**
 * The one-off clean-up after leads were removed: a dry run changes nothing, a confirmed run
 * removes every lead and every pointer to one, and a second run finds nothing to do.
 *
 *   node --test tests/delete-leads.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

const { deleteLeads } = await import('../scripts/delete-leads.js');

let mongo;
let db;
const quiet = () => {};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  db = mongoose.connection.db;

  const lead = new mongoose.Types.ObjectId();
  const other = new mongoose.Types.ObjectId();
  const customer = new mongoose.Types.ObjectId();
  await db.collection('leads').insertMany([{ _id: lead, company: 'Old Lead' }, { _id: other, company: 'Other' }]);
  await db.collection('customers').insertMany([
    { _id: customer, name: 'Converted', convertedFromLead: lead },
    { name: 'Untouched' },
  ]);
  await db.collection('enquiries').insertOne({ number: 'ENQ-1', customer, lead });
  await db.collection('samples').insertMany([
    { number: 'SMP-1', customer, lead },
    { number: 'SMP-2', lead: other },
    { number: 'SMP-3', customer },
  ]);
  await db.collection('samples').createIndex({ lead: 1 });
  await db.collection('whatsappthreads').insertMany([
    { number: '+911', lead: other, matchedBy: 'lead' },
    { number: '+912', customer, matchedBy: 'customer' },
  ]);
  await db.collection('whatsappthreads').createIndex({ lead: 1 });
  await db.collection('leadcards').insertMany([
    { status: 'confirmed', lead },
    { status: 'ready', matchedLead: other },
    { status: 'ready' },
  ]);
  await db.collection('todos').insertMany([
    { title: 'Call Old Lead', originKey: `lead:${lead}:followup`, link: `/leads/${lead}` },
    { title: 'Gone quiet', originKey: `lead:${other}:stale:2` },
    { title: 'Ring the buyer', originKey: `enquiry:${customer}:followup`, link: '/enquiries/x' },
  ]);
  await db.collection('savedviews').insertMany([{ page: 'leads', name: 'Mine' }, { page: 'enquiries', name: 'Mine' }]);
  await db.collection('auditlogs').insertMany([{ model: 'Lead', recordId: lead }, { model: 'Customer', recordId: customer }]);
  await db.collection('outboxes').insertMany([{ event: 'lead.converted', status: 'pending' }, { event: 'enquiry.created' }]);
  await db.collection('counters').insertMany([{ key: 'LEAD-2026', seq: 9 }, { key: 'ENQ-2026', seq: 4 }]);
});

test.after(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

test('a dry run reports and changes nothing', async () => {
  const report = await deleteLeads(db, { write: false, log: quiet });

  assert.equal(report.leads, 2);
  assert.equal(report['customers: convertedFromLead'], 1);
  assert.equal(report['samples: lead'], 2);
  assert.equal(report.samplesLeftWithoutBuyer, 1, 'the sample for a lead that never became a customer is called out');
  assert.equal(report['todos: lead reminders'], 2);

  assert.equal(await db.collection('leads').countDocuments(), 2);
  assert.equal(await db.collection('customers').countDocuments({ convertedFromLead: { $exists: true } }), 1);
  assert.equal(await db.collection('todos').countDocuments(), 3);
  assert.ok((await db.collection('samples').indexes()).some((index) => index.name === 'lead_1'));
});

test('a confirmed run removes every lead and every pointer to one, and nothing else', async () => {
  await deleteLeads(db, { write: true, log: quiet });

  const names = (await db.listCollections().toArray()).map((row) => row.name);
  assert.ok(!names.includes('leads'));

  assert.equal(await db.collection('customers').countDocuments(), 2, 'customers are kept');
  assert.equal(await db.collection('customers').countDocuments({ convertedFromLead: { $exists: true } }), 0);
  assert.equal(await db.collection('enquiries').countDocuments({ lead: { $exists: true } }), 0);
  assert.equal(await db.collection('samples').countDocuments(), 3, 'samples are kept');
  assert.equal(await db.collection('samples').countDocuments({ lead: { $exists: true } }), 0);
  assert.ok(!(await db.collection('samples').indexes()).some((index) => index.name === 'lead_1'));
  assert.ok(!(await db.collection('whatsappthreads').indexes()).some((index) => index.name === 'lead_1'));
  assert.equal(await db.collection('whatsappthreads').countDocuments({ matchedBy: 'lead' }), 0);
  assert.equal(await db.collection('whatsappthreads').countDocuments({ matchedBy: 'unknown' }), 1);
  assert.equal(await db.collection('leadcards').countDocuments(), 3, 'the card drafts are kept');
  assert.equal(await db.collection('leadcards').countDocuments({ $or: [{ lead: { $exists: true } }, { matchedLead: { $exists: true } }] }), 0);
  assert.deepEqual((await db.collection('todos').find().toArray()).map((row) => row.title), ['Ring the buyer']);
  assert.deepEqual((await db.collection('savedviews').find().toArray()).map((row) => row.page), ['enquiries']);
  assert.deepEqual((await db.collection('auditlogs').find().toArray()).map((row) => row.model), ['Customer']);
  assert.deepEqual((await db.collection('outboxes').find().toArray()).map((row) => row.event), ['enquiry.created']);
  assert.deepEqual((await db.collection('counters').find().toArray()).map((row) => row.key), ['ENQ-2026']);
});

test('a second run finds nothing to do', async () => {
  const report = await deleteLeads(db, { write: true, log: quiet });
  const total = Object.entries(report)
    .filter(([key]) => key !== 'samplesLeftWithoutBuyer')
    .reduce((sum, [, n]) => sum + n, 0);
  assert.equal(total, 0);
});
