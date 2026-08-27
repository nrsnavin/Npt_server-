/**
 * Sample analytics: how long fulfilment takes and what drives the difference.
 *
 * The arithmetic is the easy part. What these check is the part that misleads: that a mean
 * never travels without its tail, that a segment says how many samples it is drawn from, and
 * that a thin segment is marked as thin rather than presented as equal to the rest.
 *
 *   node --test tests/sample-analytics.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'sample-analytics-test-secret';

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let meera;
let Sample;
let percentile;
let summarise;
let productId;

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

/**
 * A fulfilled sample with a chosen turnaround.
 *
 * Written straight to the collection: the point is the shape of the history, and walking
 * each one through the API would make the durations depend on how fast the test runs.
 */
async function fulfilled({ days, readyDaysAgo = 2, ...attributes }) {
  sequence += 1;
  const readyAt = new Date(Date.now() - readyDaysAgo * DAY);
  const requestedAt = new Date(readyAt.getTime() - days * DAY);

  return Sample.create({
    number: `SMP-TEST-${String(sequence).padStart(4, '0')}`,
    requestedBy: attributes.requestedBy,
    modelNumber: 'NPT-400S',
    quantity: 5,
    status: 'sample_ready',
    requestedAt,
    requiredDate: attributes.requiredDate ?? new Date(requestedAt.getTime() + 7 * DAY),
    statusHistory: [
      { to: 'request_received', at: requestedAt },
      { from: 'request_received', to: 'production_required', at: new Date(requestedAt.getTime() + days * DAY * 0.7) },
      { from: 'production_required', to: 'sample_ready', at: readyAt },
    ],
    ...attributes,
  });
}

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  Sample = (await import('../src/models/Sample.js')).default;
  ({ percentile, summarise } = await import('../src/services/sampleAnalytics.service.js'));

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

  const product = await api('/api/products', {
    method: 'POST',
    token: admin,
    body: {
      modelCode: 'NPT-400S',
      name: 'Shirt Hanger 400mm',
      category: 'shirt',
      sizeMm: 400,
      material: 'plastic',
      hookType: 'metal_swivel',
    },
  });
  productId = product.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------ The statistics ------------------------------ */

test('p90 is a duration something actually took', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  assert.equal(percentile(values, 90), 9);
  assert.equal(percentile(values, 50), 5);
  assert.equal(percentile(values, 100), 10);
  // Nearest-rank, so the answer is always a real observation rather than a blend of two.
  assert.ok(values.includes(percentile(values, 90)));
  assert.equal(percentile([], 90), null);
});

test('a mean never travels without its tail', () => {
  // Nine quick samples and one disaster: the same average, very different businesses.
  const steady = summarise(
    [5, 5, 5, 5, 5, 5, 5, 5, 5, 5].map((days) => ({ fulfilmentMs: days * DAY, status: 'approved' }))
  );
  const spiky = summarise(
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 41].map((days) => ({ fulfilmentMs: days * DAY, status: 'approved' }))
  );

  assert.equal(steady.averageDays, 5);
  assert.equal(spiky.averageDays, 5);

  // Nearest-rank p90 over ten values is the ninth, so a one-in-ten disaster sits above it
  // and the percentile alone reports a healthier process than there is.
  assert.equal(spiky.p90Days, 1);

  // Which is why the worst case is reported too. At a dozen samples a month it is the only
  // figure that sees the sample that took six weeks.
  assert.equal(steady.worstDays, 5);
  assert.equal(spiky.worstDays, 41, 'the one worth talking about has to be visible');
});

test('a thin segment is marked thin rather than presented as equal', () => {
  const thin = summarise([{ fulfilmentMs: 3 * DAY }, { fulfilmentMs: 4 * DAY }]);
  const solid = summarise(Array.from({ length: 6 }, () => ({ fulfilmentMs: 3 * DAY })));

  assert.equal(thin.fulfilled, 2);
  assert.equal(thin.reliable, false, 'two samples is not a trend');
  assert.equal(solid.reliable, true);
  // The count travels with every figure, so a reader can judge it themselves.
  assert.ok(Number.isInteger(thin.fulfilled));
});

test('an unfulfilled sample contributes no duration, and is not counted as fast', () => {
  const summary = summarise([
    { fulfilmentMs: 4 * DAY },
    { fulfilmentMs: null },
    { fulfilmentMs: null },
  ]);

  assert.equal(summary.total, 3);
  assert.equal(summary.fulfilled, 1);
  assert.equal(summary.averageDays, 4, 'not 1.33 — the two open ones have no duration yet');
});

/* ------------------------------ The report ------------------------------ */

test('fulfilment is counted in the month it was fulfilled', async () => {
  await fulfilled({ days: 4, readyDaysAgo: 1, requestedBy: (await api('/api/auth/me', { token: meera })).json.data.id });

  const { status, json } = await api('/api/samples/analytics', { token: meera });
  assert.equal(status, 200);

  assert.ok(json.data.headline.fulfilled >= 1);
  assert.ok(json.data.headline.averageDays > 0);
  assert.ok(json.data.period.from);
  // Raised and fulfilled answer different questions and are reported separately.
  assert.ok('raised' in json.data.headline);
  assert.ok('openAtEnd' in json.data.headline);
});

test('turnaround is broken down by the things that drive it', async () => {
  const me = (await api('/api/auth/me', { token: meera })).json.data.id;

  // Printed samples take longer here; the breakdown has to show that rather than average it away.
  for (const days of [8, 9, 10, 8, 9, 10]) {
    await fulfilled({ days, readyDaysAgo: 1, requestedBy: me, printing: 'Buyer logo', hookType: 'clip', material: 'velvet' });
  }
  for (const days of [2, 3, 2, 3, 2, 3]) {
    await fulfilled({ days, readyDaysAgo: 1, requestedBy: me, hookType: 'fixed', material: 'plastic' });
  }

  const { json } = await api('/api/samples/analytics', { token: meera });
  const { byPrinting, byHookType, byMaterial, byPurpose, byQuantity } = json.data;

  const printed = byPrinting.find((row) => row.label === 'printed');
  const plain = byPrinting.find((row) => row.label === 'plain');
  assert.ok(printed && plain);
  assert.ok(printed.averageDays > plain.averageDays, 'printing is visibly slower');
  assert.equal(printed.reliable, true);

  const clip = byHookType.find((row) => row.label === 'clip');
  const fixed = byHookType.find((row) => row.label === 'fixed');
  assert.ok(clip && fixed, 'hook type is populated, which it was not before');
  assert.ok(clip.averageDays > fixed.averageDays);

  assert.ok(byMaterial.some((row) => row.label === 'velvet'));
  assert.ok(byPurpose.length > 0);
  assert.ok(byQuantity.length > 0);

  // Every row carries its own count and tail, not just an average.
  for (const row of [...byPrinting, ...byHookType, ...byMaterial]) {
    assert.ok(Number.isInteger(row.total));
    assert.ok(row.p90Days === null || row.p90Days >= row.medianDays);
  }
});

test('on-time is measured against the date that was promised', async () => {
  const me = (await api('/api/auth/me', { token: meera })).json.data.id;
  const readyAt = new Date(Date.now() - DAY);

  // One beat its date, one missed it. Both took the same time.
  await fulfilled({ days: 3, readyDaysAgo: 1, requestedBy: me, requiredDate: new Date(readyAt.getTime() + DAY) });
  await fulfilled({ days: 3, readyDaysAgo: 1, requestedBy: me, requiredDate: new Date(readyAt.getTime() - DAY) });

  const { json } = await api('/api/samples/analytics', { token: meera });
  const { onTimePercent, onTimeOf } = json.data.headline;

  assert.ok(onTimeOf >= 2);
  assert.ok(onTimePercent !== null && onTimePercent < 100, 'a missed date has to show');
});

test('the report says where the days actually went', async () => {
  const { json } = await api('/api/samples/analytics', { token: meera });
  const { timeInStage } = json.data;

  assert.ok(timeInStage.length > 0);
  assert.ok(timeInStage.every((row) => row.label && row.averageDays >= 0 && row.occurrences > 0));
  // Worst first: total duration says nine days, this says six of them were in one stage.
  const averages = timeInStage.map((row) => row.averageDays);
  assert.deepEqual(averages, [...averages].sort((a, b) => b - a));
});

test('the trend covers the year whatever period was asked for', async () => {
  // Asking for this month is the common case, and a chart one column wide answers nothing.
  // The question is whether this month is better than the ones before it, so they stay on.
  const short = await api('/api/samples/analytics?months=1', { token: meera });
  const long = await api('/api/samples/analytics?months=6', { token: meera });

  assert.equal(short.json.data.trend.length, 12);
  assert.equal(long.json.data.trend.length, 12);
  assert.deepEqual(
    short.json.data.trend.map((row) => row.month),
    long.json.data.trend.map((row) => row.month),
    'the same twelve months, so switching period does not move the chart under the reader'
  );

  const { trend } = short.json.data;
  assert.ok(trend.every((row) => /^\d{4}-\d{2}$/.test(row.month)));
  assert.ok(trend.every((row) => Number.isInteger(row.raised) && Number.isInteger(row.fulfilled)));
});

test('analytics respect who is asking', async () => {
  const mine = await api('/api/samples/analytics', { token: nandhini });
  const bench = await api('/api/samples/analytics', { token: meera });

  assert.equal(mine.status, 200);
  // Everything here was raised by the bench, so marketing's own view is empty rather than
  // showing somebody else's turnaround.
  assert.equal(mine.json.data.headline.fulfilled, 0);
  assert.ok(bench.json.data.headline.fulfilled > 0);
});

/* --------------------- The gap the analytics surfaced --------------------- */

test('a sample takes its hook type from the model it is of', async () => {
  const customer = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'Hook Test Ltd', mobile: '9876533221' },
  });

  const { json } = await api('/api/samples', {
    method: 'POST',
    token: meera,
    body: { customer: customer.json.data._id, product: productId, quantity: 2 },
  });

  // An enquiry's requirement has no hook type — a buyer asks for a model, not for a swivel —
  // so without this every sample was blank and hook analytics had nothing to segment on.
  assert.equal(json.data.hookType, 'metal_swivel');
  assert.equal(json.data.category, 'shirt');
  assert.equal(json.data.material, 'plastic');
});

test('what the request says beats what the catalogue says', async () => {
  const customer = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'Override Ltd', mobile: '9876533222' },
  });

  const { json } = await api('/api/samples', {
    method: 'POST',
    token: meera,
    body: {
      customer: customer.json.data._id,
      product: productId,
      quantity: 2,
      hookType: 'clip',
      material: 'recycled_pp',
    },
  });

  // A sample often exists precisely to try what the catalogue does not do.
  assert.equal(json.data.hookType, 'clip');
  assert.equal(json.data.material, 'recycled_pp');
});

test('a sample dispatched without a ready tick still counts as fulfilled', async () => {
  const me = (await api('/api/auth/me', { token: meera })).json.data.id;

  // The bench hands the parcel over and marks it dispatched, never ticking ready. Nothing
  // stops that — the status route accepts any status — and the sample is plainly fulfilled.
  // If ready is the only thing analytics will read, every such sample silently leaves the
  // average, which is then computed over whoever remembered to tick every box.
  sequence += 1;
  const requestedAt = new Date(Date.now() - 9 * DAY);
  const dispatchedAt = new Date(Date.now() - 3 * DAY);

  await Sample.create({
    number: `SMP-TEST-${String(sequence).padStart(4, '0')}`,
    requestedBy: me,
    modelNumber: 'NPT-SKIP',
    quantity: 5,
    status: 'dispatched',
    purpose: 'fit_test',
    requestedAt,
    dispatchedAt,
    statusHistory: [
      { to: 'request_received', at: requestedAt },
      { from: 'request_received', to: 'dispatched', at: dispatchedAt },
    ],
  });

  const { json } = await api('/api/samples/analytics?months=3', { token: meera });
  const row = json.data.byPurpose.find((entry) => entry.label === 'fit_test');

  assert.ok(row, 'the sample reached the report at all');
  assert.equal(row.fulfilled, 1);
  // Six days, from the request to the first status that proves it was ready.
  assert.equal(row.averageDays, 6);
});
