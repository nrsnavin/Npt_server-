/**
 * Registering the plant's team from data/team.json [scripts/register-team.js]: a dry run that
 * writes nothing, then one account per email in its department(s) — Sivakumar on Marketing and
 * Production — each with a set-password link, and a second run that adds nobody twice.
 *
 *   node --test tests/register-team.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

const run = promisify(execFile);
let mongo;
let users;

const script = (...args) => run('node', ['scripts/register-team.js', ...args], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, MONGO_URI: mongo.getUri('team'), NODE_ENV: 'test', JWT_SECRET: 'register-team-test-secret', SMTP_HOST: '' },
});

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri('team'));
  users = mongoose.connection.collection('users');
  await users.insertOne({ name: 'Navin R', email: 'rsnavin1@gmail.com', role: 'admin', department: 'management', isActive: true });
});

test.after(async () => {
  await mongoose.connection.close();
  await mongo?.stop();
});

test('a dry run lists the twelve and writes nothing', async () => {
  const { stdout } = await script();
  assert.match(stdout, /add\s+sivakumar@navinplastic\.com · Marketing \+ Production/);
  assert.match(stdout, /add\s+sales1@navinplastic\.com · Assembly \+ Printing \+ Quality/);
  assert.match(stdout, /Dry run — nothing written/);
  assert.equal(await users.countDocuments(), 1);
});

test('--confirm adds each in their departments, with a set-password link; a second run adds nobody', async () => {
  const { stdout } = await script('--confirm');
  assert.match(stdout, /12 added, 0 updated/);
  assert.equal(await users.countDocuments(), 13);

  const siva = await users.findOne({ email: 'sivakumar@navinplastic.com' });
  assert.equal(siva.department, 'marketing');
  assert.deepEqual(siva.extraDepartments, ['production']);
  assert.ok(siva.moduleAccess.some((grant) => grant.module === 'production'), 'Production’s screens too');
  assert.equal((await users.findOne({ email: 'office@navinplastic.com' })).department, 'despatch');
  assert.equal((await users.findOne({ email: 'prt@navinplastic.com' })).department, 'payment_recovery');
  const admin = await users.findOne({ email: 'admin@navinplastic.com' });
  assert.equal(admin.role, 'admin');
  assert.equal(admin.password, undefined, 'nobody gets a password but the one they choose');
  assert.match(stdout, /reset-password\?token=/, 'mail is not set up here, so the links are printed');

  const again = await script('--confirm');
  assert.match(again.stdout, /0 added, 0 updated/);
  assert.equal(await users.countDocuments(), 13);
});

test('--update corrects an account’s departments to the file', async () => {
  await users.updateOne({ email: 'ganesh@navinplastic.com' }, { $set: { department: 'sampling', extraDepartments: [] } });
  const dry = await script();
  assert.match(dry.stdout, /differs\s+ganesh@navinplastic\.com · Sampling → Marketing/);
  const { stdout } = await script('--confirm', '--update');
  assert.match(stdout, /updated ganesh@navinplastic\.com · Marketing/);
  assert.equal((await users.findOne({ email: 'ganesh@navinplastic.com' })).department, 'marketing');
});
