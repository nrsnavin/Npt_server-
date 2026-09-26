/**
 * The fixes from the scale audit that hold on any deployment — one box or many.
 *
 *   - Two processes raising the same reminder or handover at the same moment get one task.
 *   - Every request carries an id, back in the response and in the error a person reads.
 *
 *   node --test tests/scale-fixes.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'scale-fixes-test-secret';

let mongo;
let server;
let baseUrl;
let Todo;
let tasks;
let User;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  ({ default: User } = await import('../src/models/User.js'));
  tasks = await import('../src/services/task.service.js');
  await Todo.init();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

let seq = 0;
const person = () => User.create({ name: `Staff ${++seq}`, email: `staff${seq}@np.com`, password: 'Pass@123456', department: 'despatch' });

/* ------------------------------ One task per handover ------------------------------ */

test('the same reminder raised by several processes at once is one task', async () => {
  const kavitha = await person();
  const raise = () => tasks.raiseTask({ user: kavitha._id, title: 'SMP-0042 is overdue', originKey: 'sample:42:escalation:1' });
  const results = await Promise.all(Array.from({ length: 8 }, raise));
  assert.equal(await Todo.countDocuments({ user: kavitha._id, originKey: 'sample:42:escalation:1' }), 1);
  assert.equal(new Set(results.map((row) => String(row._id))).size, 1, 'every caller is handed the one task');
});

test('the same job on a department queue, raised at once, is one row', async () => {
  const raise = () => tasks.raiseDepartmentTask({ department: 'despatch', title: 'Load SO-0007', originKey: 'order:7:ready' });
  await Promise.all(Array.from({ length: 8 }, raise));
  assert.equal(await Todo.countDocuments({ department: 'despatch', originKey: 'order:7:ready', user: { $exists: false } }), 1);
});

test('once done, the same job can be raised again', async () => {
  const anita = await person();
  const first = await tasks.raiseTask({ user: anita._id, title: 'Chase payment', originKey: 'receivable:9:chase' });
  first.completed = true;
  await first.save();
  assert.equal(first.openKey, undefined, 'completing frees the key');
  const again = await tasks.raiseTask({ user: anita._id, title: 'Chase payment', originKey: 'receivable:9:chase' });
  assert.notEqual(String(again._id), String(first._id));

  /* Closing through resolveTasks frees it the same way. */
  assert.equal(await tasks.resolveTasks('receivable:9:chase'), 1);
  const third = await tasks.raiseTask({ user: anita._id, title: 'Chase payment', originKey: 'receivable:9:chase' });
  assert.ok(third && !third.completed);
  assert.equal(await Todo.countDocuments({ originKey: 'receivable:9:chase', completed: false }), 1);
});

test('different people each get their own copy of a shared reminder', async () => {
  const [a, b] = [await person(), await person()];
  await Promise.all([a, b].map((user) => tasks.raiseTask({ user: user._id, title: 'SMP-0050 is overdue', originKey: 'sample:50:escalation:2' })));
  assert.equal(await Todo.countDocuments({ originKey: 'sample:50:escalation:2' }), 2);
});

/* ----------------------------------- Request ids ----------------------------------- */

test('every response carries a request id, kept from the load balancer when it sent one', async () => {
  const made = await fetch(`${baseUrl}/api/nowhere`);
  assert.match(made.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  const kept = await fetch(`${baseUrl}/api/nowhere`, { headers: { 'X-Request-Id': 'alb-7f3a-01' } });
  assert.equal(kept.headers.get('x-request-id'), 'alb-7f3a-01');
  const junk = await fetch(`${baseUrl}/api/nowhere`, { headers: { 'X-Request-Id': 'bad id with spaces <script>' } });
  assert.match(junk.headers.get('x-request-id'), /^[0-9a-f-]{36}$/, 'a malformed id is replaced, not echoed');
});

/* ------------------------------ Events are awaited ------------------------------ */

test('every publish is awaited, so its outbox row is written inside the transaction', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  await walk(new URL('../src', import.meta.url).pathname);
  const offenders = [];
  for (const file of files) {
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      if (/(?<![\w.])publish\(/.test(line) && !/await publish\(|function publish\(/.test(line)) {
        offenders.push(`${file.split('/src/')[1]}:${index + 1}`);
      }
    });
  }
  assert.deepEqual(offenders, [], 'publish() without await');
});
