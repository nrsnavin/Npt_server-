/**
 * The one-off clean-up of "Needs your action": a dry run changes nothing, a confirmed run deletes
 * every user's notices and takes the answer-came-back highlight off every task, leaving the tasks
 * themselves; a second run finds nothing to do.
 *
 *   node --test tests/clear-notices.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

const { clearNotices } = await import('../scripts/clear-notices.js');

let mongo;
let db;
const quiet = () => {};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  db = mongoose.connection.db;
  const [admin, marketer] = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  const task = new mongoose.Types.ObjectId();
  await db.collection('tasknotices').insertMany([
    { recipient: admin, task, status: 'planning', statusLabel: 'Planning', at: new Date() },
    { recipient: marketer, task, status: 'planning', statusLabel: 'Planning', at: new Date(), readAt: new Date() },
    { recipient: marketer, task, status: 'started', statusLabel: 'Production Started', at: new Date() },
  ]);
  await db.collection('todos').insertMany([
    { _id: task, kind: 'ask_edd', title: 'Ask EDD', status: 'started', attention: { kind: 'reply', note: 'Clarified' } },
    { kind: 'ask_printing', title: 'Ask Printing', status: 'asked' },
  ]);
});

test.after(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

test('a dry run counts and changes nothing', async () => {
  const report = await clearNotices(db, { write: false, log: quiet });
  assert.deepEqual(report, { notices: 3, unread: 2, people: 2, highlights: 1 });
  assert.equal(await db.collection('tasknotices').countDocuments(), 3);
  assert.equal(await db.collection('todos').countDocuments({ attention: { $exists: true } }), 1);
});

test('a confirmed run clears every user’s notices and the highlights, and keeps the tasks', async () => {
  await clearNotices(db, { write: true, log: quiet });
  assert.equal(await db.collection('tasknotices').countDocuments(), 0);
  assert.equal(await db.collection('todos').countDocuments({ attention: { $exists: true } }), 0);
  assert.equal(await db.collection('todos').countDocuments(), 2, 'the tasks stay');
  assert.equal((await db.collection('todos').findOne({ kind: 'ask_edd' })).status, 'started', 'as they were');
});

test('run again, nothing to do', async () => {
  assert.deepEqual(await clearNotices(db, { write: true, log: quiet }), { notices: 0, unread: 0, people: 0, highlights: 0 });
});
