/**
 * `npm run seed:demo` [src/seed/index.js --keep-users]: demo records in every register and on
 * every department's dashboard, keeping every existing login — and refusing to clear somebody's
 * real records unless told to.
 *
 *   node --test tests/seed-demo.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let mongo;
let uri;

const seed = (...flags) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['src/seed/index.js', '--keep-users', ...flags], {
    cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, MONGO_URI: uri },
  });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { out += chunk; });
  child.on('exit', (status) => resolve({ status, out }));
});

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  uri = mongo.getUri('demo');
  await mongoose.connect(uri);
  await mongoose.connection.db.collection('users').insertMany([
    { name: 'Real Admin', email: 'rsnavin1@gmail.com', role: 'admin', department: 'management', password: 'kept-hash', isActive: true, createdAt: new Date() },
    { name: 'Senthil Kumar', email: 'senthil@plant.in', role: 'member', department: 'marketing', password: 'kept-hash-2', isActive: true, createdAt: new Date() },
  ]);
  await mongoose.connection.db.collection('customers').insertOne({ code: 'C-REAL', name: 'A real buyer' });
});

test.after(async () => {
  await mongoose.connection.close();
  await mongo?.stop();
});

test('on a database with real records it changes nothing and says how to clear them', async () => {
  const { status, out } = await seed();
  assert.equal(status, 1);
  assert.match(out, /already has 1 customers/);
  assert.match(out, /npm run reset-data -- --keep-users --confirm/);
  assert.equal(await mongoose.connection.db.collection('customers').countDocuments(), 1);
});

test('with --replace: every login kept, registers filled, every department given work', async () => {
  const { status, out } = await seed('--replace');
  assert.equal(status, 0, out.slice(-2000));
  const db = mongoose.connection.db;
  const kept = await db.collection('users').find({ password: /^kept-hash/ }).toArray();
  assert.deepEqual(kept.map((user) => user.email).sort(), ['rsnavin1@gmail.com', 'senthil@plant.in'], 'passwords untouched');
  assert.equal(await db.collection('customers').countDocuments({ code: 'C-REAL' }), 0, 'the working data was replaced');
  for (const register of ['moulds', 'materials', 'components', 'tradeditems']) {
    assert.ok(await db.collection(register).countDocuments() > 0, `${register} filled`);
  }
  const senthil = kept.find((user) => user.email === 'senthil@plant.in');
  assert.ok(await db.collection('enquiries').countDocuments({ assignedTo: senthil._id }) > 0, 'marketing’s records are the real marketing person’s');
  const departments = await db.collection('todos').distinct('department', { kind: { $exists: true }, holds: { $ne: true } });
  for (const department of ['sampling', 'quotation', 'order_confirmation', 'production', 'mould', 'quality', 'assembling', 'despatch', 'reception', 'accounts', 'payment_collection', 'payment_recovery', 'audit']) {
    assert.ok(departments.includes(department), `${department} has a department task`);
  }
  assert.ok(await db.collection('enquiries').countDocuments({ 'items.hookRef': { $exists: true } }) > 0, 'enquiry rows name a hook');
  const prt = await db.collection('todos').findOne({ kind: 'prt_recovery' });
  assert.equal(prt?.department, 'payment_recovery', 'a PRT case, with the Payment Recovery Team');
  assert.ok(prt?.user && prt?.brief?.visitor, 'assigned to a member by name');
});
