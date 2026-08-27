/**
 * Samples nobody is working on.
 *
 * A different question from the overdue escalation, and the more useful one: that asks
 * whether a date has passed, this asks whether anyone has touched it. Most of what follows is
 * about the two definitions that decide whether the list is worth reading — what counts as
 * being worked on, and what counts as a day.
 *
 *   node --test tests/anomaly.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'anomaly-test-secret-value';
// A fixed weekly off, so the arithmetic below does not depend on the machine's configuration.
process.env.ANOMALY_WEEKLY_OFF = '0';

let mongo;
let server;
let baseUrl;
let admin;
let meera;
let customerId;
let productId;
let anomaly;
let Sample;
let SampleLog;
let Todo;

const DAY = 24 * 60 * 60 * 1000;

const api = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

const signIn = async (email, password) => {
  const { json } = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  return json.data?.token;
};

let sequence = 0;
/** A sample whose whole history is a single moment, so the clock is the only variable. */
async function sampleLastTouched(at, overrides = {}) {
  sequence += 1;
  const created = await api('/api/samples', {
    method: 'POST',
    token: meera,
    body: {
      customer: customerId,
      modelNumber: `Shape ${sequence}`,
      quantity: 5,
      standaloneReason: 'Counter enquiry',
      ...overrides.body,
    },
  });
  assert.equal(created.status, 201, created.json.message);

  await Sample.updateOne(
    { _id: created.json.data._id },
    {
      $set: {
        requestedAt: at,
        statusHistory: [{ to: 'request_received', at }],
        ...overrides.set,
      },
    }
  );

  return created.json.data;
}

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  anomaly = await import('../src/services/anomaly.service.js');
  ({ default: Sample } = await import('../src/models/Sample.js'));
  ({ default: SampleLog } = await import('../src/models/SampleLog.js'));
  ({ default: Todo } = await import('../src/models/Todo.js'));

  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' },
  });
  admin = await signIn('admin@np.com', 'Admin@12345');

  await api('/api/users', {
    method: 'POST',
    token: admin,
    body: { name: 'Meera B', email: 'meera@np.com', password: 'Passw0rd@123', department: 'sampling' },
  });
  meera = await signIn('meera@np.com', 'Passw0rd@123');

  productId = (await api('/api/products', {
    method: 'POST',
    token: admin,
    body: { modelCode: 'NPT-400S', name: 'Shirt Hanger 400mm', category: 'shirt', sizeMm: 400, material: 'plastic' },
  })).json.data._id;

  customerId = (await api('/api/customers', {
    method: 'POST',
    token: admin,
    body: { name: 'Trendline Apparels', mobile: '9840011221' },
  })).json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test.beforeEach(async () => {
  await Sample.deleteMany({});
  await SampleLog.deleteMany({});
  await Todo.deleteMany({});
});

/* ------------------------------ What is a day ------------------------------ */

test('a weekend does not make everything an anomaly on Monday', () => {
  /*
   * The detail the whole feature rests on. Measured in calendar days against a one-day
   * threshold, every open sample on the bench is stalled every Monday morning because nobody
   * worked Sunday — and a list that flags everything is a list nobody reads.
   */
  const fridayEvening = new Date('2026-08-21T18:00:00Z'); // a Friday
  const mondayMorning = new Date('2026-08-24T09:00:00Z');

  // Two and a half calendar days, but the plant only worked Saturday — so one working day,
  // which is under the threshold and raises nothing.
  const elapsed = (mondayMorning - fridayEvening) / DAY;
  assert.ok(elapsed > 2, `${elapsed.toFixed(1)} calendar days would flag it`);
  assert.equal(anomaly.workingDaysBetween(fridayEvening, mondayMorning, 0), 1, 'one working day');

  // A sample last touched on Saturday evening has had no working day pass at all by Monday.
  const saturdayEvening = new Date('2026-08-22T18:00:00Z');
  assert.equal(anomaly.workingDaysBetween(saturdayEvening, mondayMorning, 0), 0);

  // And the off day is what makes the difference: with none, the same span is two days.
  assert.equal(anomaly.workingDaysBetween(fridayEvening, mondayMorning, -1), 2);
});

test('part of a day is not a day', () => {
  // A sample touched at nine this morning is not "a day" untouched at eleven tonight.
  const morning = new Date('2026-08-25T09:00:00Z');
  const night = new Date('2026-08-25T23:00:00Z');
  assert.equal(anomaly.workingDaysBetween(morning, night, 0), 0);
});

/* -------------------------- What counts as worked on -------------------------- */

test('a note on the log counts as working on it', async () => {
  const now = Date.now();
  const sample = await sampleLastTouched(new Date(now - 4 * DAY));

  const before = await anomaly.stalledSamples({ now });
  assert.equal(before.length, 1, 'untouched for four days');

  // Somebody photographed the first shot yesterday. That is work, and the clock restarts.
  await SampleLog.create({
    sample: sample._id,
    author: (await mongoose.connection.collection('users').findOne({ email: 'meera@np.com' }))._id,
    kind: 'note',
    body: 'First shot pulled, shoulder needs easing',
    createdAt: new Date(now - 2 * 60 * 60 * 1000),
  });

  const after = await anomaly.stalledSamples({ now });
  assert.equal(after.length, 0, 'a log entry is work, and the clock restarts from it');
});

test('the escalation sweep touching a record does not reset the clock', async () => {
  /*
   * The trap this design exists to avoid. The escalation sweep writes `escalationLevel` to
   * the sample, so a stall clock built on `updatedAt` would be reset by the very automation
   * flagging it — and the samples in the most trouble would be the only ones that never
   * looked stalled.
   */
  const now = Date.now();
  const sample = await sampleLastTouched(new Date(now - 5 * DAY));

  await Sample.updateOne({ _id: sample._id }, { $set: { escalationLevel: 2 } });
  const touched = await Sample.findById(sample._id);
  assert.ok(touched.updatedAt.getTime() > now - DAY, 'updatedAt has just moved');

  const stalled = await anomaly.stalledSamples({ now });
  assert.equal(stalled.length, 1, 'and the sample is still, correctly, stalled');
  assert.ok(stalled[0].idleDays >= 4, `got ${stalled[0].idleDays} idle days`);
});

test('a sample raised an hour ago is not stale', async () => {
  // Dating from nothing would make every new request instantly an anomaly.
  const now = Date.now();
  await sampleLastTouched(new Date(now - 60 * 60 * 1000));
  assert.deepEqual(await anomaly.stalledSamples({ now }), []);
});

/* ------------------------------- What stalls ------------------------------- */

test('a sample well inside its date still stalls, which is the point', async () => {
  /*
   * The overdue check would say nothing about this one for another ten days. By then it is a
   * problem; today it is a question.
   */
  const now = Date.now();
  await sampleLastTouched(new Date(now - 3 * DAY), {
    set: { requiredDate: new Date(now + 10 * DAY) },
  });

  const [stalled] = await anomaly.stalledSamples({ now });
  assert.ok(stalled, 'not overdue, and stalled');
  assert.ok(new Date(stalled.requiredDate) > new Date(now), 'its date has not passed');
  assert.match(stalled.reason, /picked it up|no progress/i);
});

test('a sample sitting with the customer is not the bench stalling', async () => {
  // The delay is real and it is somebody else's to chase. Pointing the alarm at the bench
  // would be an alarm at the wrong people.
  const now = Date.now();
  await sampleLastTouched(new Date(now - 6 * DAY), { set: { status: 'dispatched' } });
  assert.deepEqual(await anomaly.stalledSamples({ now }), []);
});

test('a finished sample cannot stall', async () => {
  const now = Date.now();
  await sampleLastTouched(new Date(now - 9 * DAY), { set: { status: 'approved' } });
  assert.deepEqual(await anomaly.stalledSamples({ now }), []);
});

test('the reason says what to do, not only that something is wrong', async () => {
  const now = Date.now();
  const meeraUser = await mongoose.connection.collection('users').findOne({ email: 'meera@np.com' });

  await sampleLastTouched(new Date(now - 3 * DAY));
  await sampleLastTouched(new Date(now - 3 * DAY), { set: { assignedTo: meeraUser._id } });

  const rows = await anomaly.stalledSamples({ now });
  const unassigned = rows.find((row) => !row.assignedTo);
  const held = rows.find((row) => row.assignedTo);

  assert.match(unassigned.reason, /nobody has picked it up/i, unassigned.reason);
  assert.match(held.reason, /no progress/i, held.reason);
});

test('the quietest is first, because that is the one somebody acts on', async () => {
  const now = Date.now();
  await sampleLastTouched(new Date(now - 2 * DAY));
  await sampleLastTouched(new Date(now - 8 * DAY));
  await sampleLastTouched(new Date(now - 4 * DAY));

  const rows = await anomaly.stalledSamples({ now });
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => row.idleDays),
    [...rows.map((row) => row.idleDays)].sort((a, b) => b - a)
  );
});

/* --------------------------- Telling management --------------------------- */

test('management is told, and not told the same thing twice', async () => {
  const now = Date.now();
  await sampleLastTouched(new Date(now - 3 * DAY));

  const first = await anomaly.runStallSweep({ now });
  assert.equal(first.length, 1, 'raised');

  // Raising a sample queues the bench, so this counts the stall tasks rather than all of them.
  const raised = await Todo.find({ completed: false, originKey: /:stalled:/ });
  assert.equal(raised.length, 1, 'to management');
  assert.match(raised[0].title, /has not moved in \d+ working day/i, raised[0].title);
  assert.match(raised[0].notes, /Trendline Apparels/);
  assert.equal(raised[0].priority, 'high');

  // Run it again on the same clock: the sweep must be safe to run as often as you like.
  await anomaly.runStallSweep({ now });
  assert.equal(
    await Todo.countDocuments({ completed: false, originKey: /:stalled:/ }),
    1,
    'not raised twice'
  );
});

test('a sample still stalled tomorrow says so again', async () => {
  /*
   * Keyed on the sample and the day count. Keyed on the sample alone it would be raised once
   * and go quiet while the sample sat for another week — which is the failure the sweep is
   * there to prevent, reintroduced by the de-duplication meant to make it bearable.
   */
  const now = Date.now();
  await sampleLastTouched(new Date(now - 3 * DAY));

  await anomaly.runStallSweep({ now });
  await anomaly.runStallSweep({ now: now + DAY });

  const tasks = await Todo.find({ completed: false, originKey: /:stalled:/ }).sort('createdAt');
  assert.equal(tasks.length, 2, 'a longer silence is news again');
  assert.notEqual(tasks[0].title, tasks[1].title, 'and the day count in the title says so');
});

test('nobody but management is told', async () => {
  // The bench sees it on their own dashboard; a task in everybody's list is a list nobody reads.
  const now = Date.now();
  await sampleLastTouched(new Date(now - 3 * DAY));
  await anomaly.runStallSweep({ now });

  const meeraUser = await mongoose.connection.collection('users').findOne({ email: 'meera@np.com' });
  assert.equal(
    await Todo.countDocuments({ user: meeraUser._id, originKey: /:stalled:/ }),
    0,
    'the bench sees it on their dashboard; a task in everybody’s list is one nobody reads'
  );
});

/* --------------------------------- On screen --------------------------------- */

test('the anomalies route answers, and says what a day means', async () => {
  const now = Date.now();
  await sampleLastTouched(new Date(now - 3 * DAY));

  const { status, json } = await api('/api/samples/anomalies', { token: admin });
  assert.equal(status, 200);
  assert.equal(json.data.length, 1);
  assert.ok(json.data[0].idleDays >= 1);
  assert.ok(json.data[0].link.startsWith('/samples/'), 'with the record behind it');
  // The reader cannot judge "2 days idle" without knowing what the threshold was.
  assert.equal(json.meta.stallAfterDays, 1);
});

test('the sampling dashboard carries the count and the worst of them', async () => {
  const now = Date.now();
  await sampleLastTouched(new Date(now - 5 * DAY));

  const { json } = await api('/api/samples/dashboard', { token: admin });
  assert.equal(json.data.tiles.stalled, 1);
  assert.equal(json.data.stalled.length, 1);
  assert.match(json.data.stalled[0].reason, /picked it up|no progress/i);
});

test('Jarvis answers "what is stuck", and it is not the overdue answer', async () => {
  const now = Date.now();
  await sampleLastTouched(new Date(now - 4 * DAY), {
    set: { requiredDate: new Date(now + 10 * DAY) },
  });

  const { json } = await api('/api/jarvis/ask', {
    method: 'POST',
    token: admin,
    body: { message: 'what samples are stuck' },
  });

  assert.equal(json.data.understood.aspect, 'stalled', JSON.stringify(json.data.understood));
  assert.match(json.data.answer, /no work for more than/i, json.data.answer);
  assert.ok(json.data.rows.length, 'with the records behind it');

  // And the neighbouring question still gets the neighbouring answer.
  const late = await api('/api/jarvis/ask', {
    method: 'POST',
    token: admin,
    body: { message: 'what is overdue on the bench' },
  });
  assert.equal(late.json.data.understood.aspect, 'overdue');
  assert.match(late.json.data.answer, /nothing is overdue/i, late.json.data.answer);
});

test('asking what is stuck about something that records no progress says so', async () => {
  // Answering "none" would read as an assurance that nothing anywhere is stuck.
  const { json } = await api('/api/jarvis/ask', {
    method: 'POST',
    token: admin,
    body: { message: 'which enquiries are stuck' },
  });
  assert.match(json.data.answer, /cannot tell you what has gone quiet/i, json.data.answer);
});
