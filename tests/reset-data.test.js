/**
 * The script that empties the database, and the guard that stops it going stale.
 *
 * `reset-data` carried a hand-written list of sixteen models. Eleven had been added since it
 * was written — sales orders, consignments, inspections, receivables, escalations, order
 * queries, the material and component registers — and it cleared none of them while printing
 * "the database now holds one user and nothing else". A destructive script that lies in its
 * last line is the worst kind: somebody hands a system over believing it is clean, and finds
 * out when a customer's old order turns up on a fresh install.
 *
 * It discovers models now rather than listing them, so the drift cannot recur. These tests are
 * the proof of that and of the two things a person running it is relying on: that nothing is
 * left behind, and that the one account they named is still there afterwards.
 *
 *   node --test tests/reset-data.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'reset-data-test-secret-value';

let mongo;

/**
 * Every model the application registers, loaded the way the script itself loads them.
 *
 * Index building off, for the reason the script turns it off: twenty-seven models registering
 * against a live connection sets Mongoose building every index on each of them, and the small
 * standalone this test runs against then has nothing left for the child process the test is
 * actually about.
 */
const loadModels = async () => {
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);

  const directory = new URL('../src/models/', import.meta.url);
  for (const entry of readdirSync(directory)) {
    if (entry.endsWith('.js')) await import(new URL(entry, directory));
  }
  return Object.keys(mongoose.models).sort();
};

/** Runs the real script against this test's database, and hands back what it printed. */
const reset = (args = []) =>
  execFileSync('node', ['scripts/reset-data.js', ...args], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, MONGO_URI: process.env.MONGO_URI },
    encoding: 'utf8',
  });

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri('reset_test');
  /* A small pool on purpose: the script runs as a separate process against the same server,
     and a parent holding a hundred connections is a parent starving the thing under test. */
  await mongoose.connect(process.env.MONGO_URI, { maxPoolSize: 5 });
  await loadModels();
});

test.after(async () => {
  await mongoose.connection.close();
  await mongo?.stop();
});

/**
 * One document in every collection, so "did it clear everything" has something to be wrong about.
 *
 * Written straight through the driver rather than through the models: a Sales Order that will
 * not save without a customer and a line is a fixture problem, not the thing under test, and
 * this script deletes by collection regardless of what is in it.
 */
const seedEverything = async (names) => {
  for (const name of names) {
    /* Cleared first: a test that leaves documents behind — the dry run, the misspelled
       survivor — would otherwise collide with the next seeding on a unique index. */
    await mongoose.connection
      .collection(mongoose.models[name].collection.collectionName)
      .deleteMany({});
    await mongoose.connection
      .collection(mongoose.models[name].collection.collectionName)
      .insertOne({ _probe: name });
  }
};

const countsByModel = async (names) => {
  const entries = await Promise.all(
    names.map(async (name) => [
      name,
      await mongoose.connection
        .collection(mongoose.models[name].collection.collectionName)
        .countDocuments(),
    ])
  );
  return Object.fromEntries(entries);
};

const makeUsers = async () => {
  const User = mongoose.models.User;
  await User.collection.deleteMany({});
  await User.create({
    name: 'Navin R', email: 'rsnavin1@gmail.com', password: 'Admin@12345',
    role: 'admin', department: 'management',
  });
  await User.create({
    name: 'Nandhini S', email: 'nandhini@np.com', password: 'Passw0rd@123',
    department: 'marketing',
  });
};

test('a dry run is the default, and it changes nothing', async () => {
  const names = Object.keys(mongoose.models).sort();
  await makeUsers();
  await seedEverything(names.filter((name) => name !== 'User'));

  const output = reset();

  assert.match(output, /Would delete/, 'it says it would, not that it did');
  assert.match(output, /dry run — nothing has changed/);
  /* The database it is about to empty, named where the person is already reading. */
  assert.match(output, /reset_test/);

  const after = await countsByModel(names.filter((name) => name !== 'User'));
  for (const [name, count] of Object.entries(after)) {
    assert.equal(count, 1, `${name} must still be there after a dry run`);
  }
  assert.equal(await mongoose.models.User.countDocuments(), 2);
});

/**
 * The test the rewrite exists for.
 *
 * Asserted over *every* registered model rather than a list written here — a list in the test
 * would go stale in exactly the way the list in the script did, and then two files would agree
 * with each other and disagree with the application.
 */
test('--confirm empties every collection the application registers', async () => {
  const names = Object.keys(mongoose.models).sort();
  const others = names.filter((name) => name !== 'User');
  await makeUsers();
  await seedEverything(others);

  assert.ok(others.length > 20, `expected the whole model set, saw ${others.length}`);

  const output = reset(['--confirm']);
  assert.match(output, /now holds one user/);

  const after = await countsByModel(others);
  const left = Object.entries(after).filter(([, count]) => count > 0).map(([name]) => name);
  assert.deepEqual(left, [], `these survived a full reset:\n  ${left.join('\n  ')}`);
});

test('the named account survives, alone, and is an admin', async () => {
  await makeUsers();
  /* Deliberately not an admin to begin with: the survivor is the only way back in, and an
     account that cannot grant a module locks the whole system. */
  await mongoose.models.User.updateOne({ email: 'rsnavin1@gmail.com' }, { role: 'user' });

  reset(['--confirm']);

  const users = await mongoose.models.User.find().lean();
  assert.equal(users.length, 1);
  assert.equal(users[0].email, 'rsnavin1@gmail.com');
  assert.equal(users[0].role, 'admin', 'promoted on the way out');
});

test('a misspelled survivor deletes nothing and says which accounts exist', async () => {
  const names = Object.keys(mongoose.models).sort();
  const others = names.filter((name) => name !== 'User');
  await makeUsers();
  await seedEverything(others);

  let failed = false;
  let output = '';
  try {
    reset(['--keep=rsnavin02@gmail.com', '--confirm']);
  } catch (error) {
    /* A non-zero exit is the point: a scripted deploy step must stop here, not carry on. */
    failed = true;
    output = `${error.stdout || ''}${error.stderr || ''}`;
  }

  assert.ok(failed, 'a typo in the survivor must fail loudly');
  assert.match(output, /Nothing has been deleted/);
  assert.match(output, /rsnavin1@gmail\.com/, 'and names the accounts that do exist');

  const after = await countsByModel(others);
  assert.ok(
    Object.values(after).every((count) => count === 1),
    'nothing may be deleted before the survivor is confirmed'
  );
  assert.equal(await mongoose.models.User.countDocuments(), 2);
});

test('--keep-registers spares the model masters and nothing else', async () => {
  const names = Object.keys(mongoose.models).sort();
  const others = names.filter((name) => name !== 'User');
  await makeUsers();
  await seedEverything(others);

  reset(['--keep-registers', '--confirm']);

  const after = await countsByModel(others);
  /* §28's masters: measured facts about tooling and bought-in parts, which are days of work
     with a vernier to re-enter. */
  for (const register of ['Mould', 'Material', 'Component']) {
    assert.equal(after[register], 1, `${register} should have been spared`);
  }
  const workingData = others.filter((name) => !['Mould', 'Material', 'Component'].includes(name));
  const left = workingData.filter((name) => after[name] > 0);
  assert.deepEqual(left, [], `these are not registers and should have gone:\n  ${left.join('\n  ')}`);
});
