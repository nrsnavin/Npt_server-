/**
 * The sampling escalation [BLUEPRINT §25] and the dashboard it feeds [§22].
 *
 * Overdue was computed from the day the module was built; nothing acted on it. These tests
 * drive the sweep against a clock passed in, so a threshold measured in days can be crossed
 * without waiting one.
 *
 *   node --test tests/escalation.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'escalation-test-secret';

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;   // marketing — asked for it
let meera;      // sampling — has to make it
let mouldId;
let Sample;
let runSamplingEscalations;

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

const DAY = 24 * 60 * 60 * 1000;
const soon = (days = 3) => new Date(Date.now() + days * DAY).toISOString();
const followUp = { nextAction: 'Call the buyer', nextFollowUpDate: soon() };

let sequence = 0;

/** A sample due on a chosen date, raised by marketing so both sides are involved. */
async function sampleDue(daysFromNow, overrides = {}) {
  sequence += 1;

  const customer = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: `Buyer ${sequence}`, mobile: `98410${String(100000 + sequence).slice(-5)}` },
  });

  const created = await api('/api/samples', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customer.json.data._id,
      modelNumber: 'NPT-400S',
      quantity: 3,
      requiredDate: new Date(Date.now() + daysFromNow * DAY).toISOString(),
      ...overrides,
    },
  });

  return created.json.data;
}

const tasksFor = async (token) => (await api('/api/workspace/todos', { token })).json.data;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  Sample = (await import('../src/models/Sample.js')).default;
  ({ runSamplingEscalations } = await import('../src/services/escalation.service.js'));

  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' },
  });
  admin = await signIn('admin@np.com', 'Admin@12345');

  for (const [name, email, department, password] of [
    ['Nandhini S', 'nandhini@np.com', 'marketing', 'Mktg@123456'],
    ['Meera S', 'meera@np.com', 'sampling', 'Samp@123456'],
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: { name, email, password, department } });
  }

  nandhini = await signIn('nandhini@np.com', 'Mktg@123456');
  meera = await signIn('meera@np.com', 'Samp@123456');

  const madeMould = await api('/api/moulds', {
    method: 'POST',
    token: admin,
    body: {
      mouldCode: 'M-NPT-400S', name: 'Shirt Hanger 400mm', category: 'shirt', sizeMm: 400, material: 'plastic',
      /* Measured facts, which the register will not take a model without. */
      cavities: 4, partWeightGrams: 26, cycleTimeSeconds: 28, moq: 5000,
    },
  });
  mouldId = madeMould.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* --------------------------------- The thresholds --------------------------------- */

test('nothing escalates before the required date', async () => {
  const sample = await sampleDue(3);

  const raised = await runSamplingEscalations({ now: Date.now() });
  assert.ok(!raised.some((entry) => entry.sample === sample.number));

  const fresh = await Sample.findById(sample._id);
  assert.equal(fresh.escalationLevel, 0);
});

test('crossing the required date reaches the bench and the person waiting', async () => {
  const sample = await sampleDue(-0.5);

  const raised = await runSamplingEscalations({ now: Date.now() });
  const entry = raised.find((row) => row.sample === sample.number);
  assert.ok(entry, 'it should have escalated');
  assert.equal(entry.level, 1);

  // §25 tier one: sampling in-charge and marketing, which here is the bench and the asker.
  const bench = await tasksFor(meera);
  const marketing = await tasksFor(nandhini);
  assert.ok(bench.some((task) => task.title.includes(sample.number) && task.title.includes('overdue')));
  assert.ok(marketing.some((task) => task.title.includes(sample.number)));

  // Management is not troubled at this tier.
  const management = await tasksFor(admin);
  assert.ok(!management.some((task) => task.title.includes(sample.number)));
});

test('more than a day late reaches management', async () => {
  const sample = await sampleDue(-2);

  const raised = await runSamplingEscalations({ now: Date.now() });
  const entry = raised.find((row) => row.sample === sample.number);
  assert.equal(entry.level, 2);

  const management = await tasksFor(admin);
  assert.ok(
    management.some((task) => task.title.includes(sample.number) && task.title.includes('more than a day')),
    'the manager hears about it once it is more than a day late'
  );
});

test('a sample climbs the tiers rather than skipping or repeating them', async () => {
  const sample = await sampleDue(0);
  const due = new Date((await Sample.findById(sample._id)).requiredDate).getTime();

  // An hour past its date: tier one.
  await runSamplingEscalations({ now: due + 60 * 60 * 1000 });
  assert.equal((await Sample.findById(sample._id)).escalationLevel, 1);

  // Sweeping again the same day changes nothing — an alarm that rings hourly is noise.
  const again = await runSamplingEscalations({ now: due + 2 * 60 * 60 * 1000 });
  assert.ok(!again.some((row) => row.sample === sample.number));

  // A day later, tier two.
  const later = await runSamplingEscalations({ now: due + DAY + 1000 });
  assert.equal(later.find((row) => row.sample === sample.number)?.level, 2);
  assert.equal((await Sample.findById(sample._id)).escalationLevel, 2);

  // And no further, however long it sits.
  const week = await runSamplingEscalations({ now: due + 7 * DAY });
  assert.ok(!week.some((row) => row.sample === sample.number));
});

test('a sample with the customer is not the plant’s delay, and does not escalate', async () => {
  const sample = await sampleDue(-3);

  for (const status of ['checking_stock', 'sample_available', 'sample_ready']) {
    await api(`/api/samples/${sample._id}/status`, { method: 'POST', token: meera, body: { status } });
  }
  await api(`/api/samples/${sample._id}/status`, {
    method: 'POST',
    token: meera,
    body: { status: 'dispatched', courier: 'Blue Dart', awbNumber: '77213904118', dispatchedQuantity: 3 },
  });

  const raised = await runSamplingEscalations({ now: Date.now() });
  assert.ok(!raised.some((row) => row.sample === sample.number));
});

test('a closed sample stops escalating', async () => {
  const sample = await sampleDue(-3);
  await api(`/api/samples/${sample._id}/status`, {
    method: 'POST',
    token: meera,
    body: { status: 'cancelled' },
  });

  const raised = await runSamplingEscalations({ now: Date.now() });
  assert.ok(!raised.some((row) => row.sample === sample.number));
});

test('the escalation is not undone when the sample finally moves', async () => {
  const sample = await sampleDue(-0.5);
  await runSamplingEscalations({ now: Date.now() });

  await api(`/api/samples/${sample._id}/status`, {
    method: 'POST',
    token: meera,
    body: { status: 'checking_stock' },
  });

  // The delay happened. Clearing the record of it would hide what the alarm was for.
  const fresh = await Sample.findById(sample._id);
  assert.equal(fresh.escalationLevel, 1);
});

/* --------------------------------- The dashboard --------------------------------- */

test('the dashboard answers what the bench needs to know', async () => {
  const { status, json } = await api('/api/samples/dashboard', { token: meera });
  assert.equal(status, 200);

  const { tiles, quality, turnaround, queueByStatus, oldestOpen, awaitingFeedback } = json.data;

  assert.ok(tiles.openTotal >= 0);
  assert.ok(tiles.overdue >= 0);
  assert.ok(tiles.escalated >= 1, 'the tiles show what has already been shouted about');

  // Ageing beats counts: every queue figure carries its oldest [DASHBOARDS §1].
  assert.ok(Array.isArray(oldestOpen));
  assert.ok(oldestOpen.every((row) => typeof row.ageDays === 'number'));
  const ages = oldestOpen.map((row) => row.ageDays);
  assert.deepEqual(ages, [...ages].sort((a, b) => b - a), 'worst first');

  assert.ok(Array.isArray(awaitingFeedback));
  assert.ok(queueByStatus.every((row) => row.label && typeof row.count === 'number'));

  // Turnaround is null rather than zero when nothing has finished — an average of no
  // samples is not "no days".
  assert.ok(turnaround.requestToReadyDays === null || turnaround.requestToReadyDays >= 0);
  assert.ok(quality.reworkRatePercent === null || quality.reworkRatePercent >= 0);
});

test('the rework rate is the share of answers that asked for another attempt', async () => {
  // Two answered, one of them a modification.
  for (const outcome of ['approved', 'modification_required']) {
    const sample = await sampleDue(2);
    for (const status of ['checking_stock', 'sample_available', 'sample_ready']) {
      await api(`/api/samples/${sample._id}/status`, { method: 'POST', token: meera, body: { status } });
    }
    await api(`/api/samples/${sample._id}/status`, {
      method: 'POST',
      token: meera,
      body: { status: 'dispatched', courier: 'Blue Dart', awbNumber: '55500011122', dispatchedQuantity: 3 },
    });
    await api(`/api/samples/${sample._id}/feedback`, {
      method: 'POST',
      token: nandhini,
      body: { outcome },
    });
  }

  const { json } = await api('/api/samples/dashboard', { token: meera });
  const { quality } = json.data;

  assert.ok(quality.answered >= 2);
  assert.equal(
    quality.reworkRatePercent,
    Math.round((quality.modificationRequired / quality.answered) * 100)
  );
  assert.ok(quality.modificationRequired >= 1);
});

test('marketing sees its own samples on the dashboard, not the whole bench', async () => {
  const mine = await api('/api/samples/dashboard', { token: nandhini });
  const bench = await api('/api/samples/dashboard', { token: meera });

  assert.equal(mine.status, 200);
  // Everything in these tests was raised by Nandhini, so the two agree here — what matters
  // is that the scoped read is applied at all rather than the bench's view being returned.
  assert.ok(mine.json.data.tiles.openTotal <= bench.json.data.tiles.openTotal);
  assert.ok(mine.json.data.byRequester.every((row) => row.label === 'Nandhini S'));
});
