/**
 * Marketing's own dashboard [BLUEPRINT §21, DASHBOARDS §3].
 *
 * The arithmetic is not what these check. They check that it is *this person's* dashboard
 * rather than the plant's, that the §3 integrity breach it exists to surface is surfaced,
 * and that ageing is reported where there is a clock — a count alone hides the one record
 * that has been sitting three weeks.
 *
 *   node --test tests/marketing-dashboard.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'marketing-dashboard-secret';

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let priya;
let productId;
let Enquiry;

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

const days = (offset) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date;
};

let sequence = 0;
const unique = () => (sequence += 1);

async function makeCustomer(token) {
  const n = unique();
  const { json } = await api('/api/customers', {
    method: 'POST',
    token,
    body: { name: `Buyer ${n}`, mobile: `98765${String(400000 + n).slice(-5)}` },
  });
  return json.data;
}

async function makeEnquiry(token, customerId, extra = {}) {
  const { json } = await api('/api/enquiries', {
    method: 'POST',
    token,
    body: {
      customer: customerId,
      product: productId,
      requirement: { modelNumber: 'NPT-400S', quantity: 5000 },
      nextAction: 'Call the buyer',
      nextFollowUpDate: days(3).toISOString(),
      ...extra,
    },
  });
  return json.data;
}

const board = async (token) => (await api('/api/dashboard/marketing', { token })).json.data;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  Enquiry = (await import('../src/models/Enquiry.js')).default;

  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' },
  });
  admin = await signIn('admin@np.com', 'Admin@12345');

  for (const [name, email] of [['Nandhini S', 'nandhini@np.com'], ['Priya R', 'priya@np.com']]) {
    await api('/api/users', {
      method: 'POST',
      token: admin,
      body: { name, email, password: 'Passw0rd@123', department: 'marketing' },
    });
  }
  nandhini = await signIn('nandhini@np.com', 'Passw0rd@123');
  priya = await signIn('priya@np.com', 'Passw0rd@123');

  const product = await api('/api/products', {
    method: 'POST',
    token: admin,
    body: { modelCode: 'NPT-400S', name: 'Shirt Hanger 400mm', category: 'shirt', sizeMm: 400, material: 'plastic' },
  });
  productId = product.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the follow-up list is today’s call list, worst first', async () => {
  const customer = await makeCustomer(nandhini);

  const late = await makeEnquiry(nandhini, customer._id);
  const later = await makeEnquiry(nandhini, customer._id);
  await makeEnquiry(nandhini, customer._id, { nextFollowUpDate: new Date().toISOString() });

  // Backdated directly: the API refuses to create an enquiry already overdue, which is the
  // rule working — the state still arises by a date simply passing.
  await Enquiry.updateOne({ _id: late._id }, { nextFollowUpDate: days(-9) });
  await Enquiry.updateOne({ _id: later._id }, { nextFollowUpDate: days(-2) });

  const data = await board(nandhini);

  assert.equal(data.today.overdueFollowUps.count, 2);
  assert.equal(data.today.dueToday.count, 1);
  // Ageing beats counts: the one sitting nine days has to be the one at the top.
  assert.equal(data.today.overdueFollowUps.rows[0].number, late.number);
  assert.equal(data.today.overdueFollowUps.rows[0].overdueDays, 9);

  // Counted in calendar days, not elapsed 24-hour periods. A follow-up due at five
  // yesterday afternoon is fourteen hours old at seven this morning, and "0d late" in a row
  // the dashboard has just coloured red reads as a bug rather than as a number.
  const yesterdayEvening = days(-1);
  yesterdayEvening.setHours(17, 0, 0, 0);
  const justMissed = await makeEnquiry(nandhini, customer._id);
  await Enquiry.updateOne({ _id: justMissed._id }, { nextFollowUpDate: yesterdayEvening });

  const after = await board(nandhini);
  const row = after.today.overdueFollowUps.rows.find((entry) => entry.number === justMissed.number);
  assert.equal(row.overdueDays, 1, 'due yesterday is one day late, whatever the clock says');
});

test('an enquiry with no next action is reported, because §3 forbids the state', async () => {
  const customer = await makeCustomer(nandhini);
  const enquiry = await makeEnquiry(nandhini, customer._id);

  // The module refuses to write this; a record predating the rule, or a future import, can
  // still hold it — and a rule with no way of telling you it is broken is one you hear
  // about from the customer.
  await Enquiry.updateOne({ _id: enquiry._id }, { $unset: { nextAction: 1, nextFollowUpDate: 1 } });

  const data = await board(nandhini);
  assert.ok(data.today.noNextAction.count >= 1);
  assert.ok(data.today.noNextAction.rows.some((row) => row.number === enquiry.number));
});

test('it is this person’s dashboard, not the plant’s', async () => {
  const theirs = await makeCustomer(priya);
  await makeEnquiry(priya, theirs._id);

  const mine = await board(nandhini);
  const hers = await board(priya);

  assert.ok(mine.performance.openEnquiries.count >= 1);
  assert.equal(hers.performance.openEnquiries.count, 1, 'only her own');

  // Management is not ownership-scoped and sees the team through the same endpoint.
  const all = await board(admin);
  assert.ok(all.performance.openEnquiries.count > hers.performance.openEnquiries.count);
});

test('won and lost are reported by count and by value, and the reasons broken down', async () => {
  const customer = await makeCustomer(nandhini);
  const winner = await makeEnquiry(nandhini, customer._id, { estimatedValue: 120000 });
  const loser = await makeEnquiry(nandhini, customer._id, { estimatedValue: 80000 });

  await api(`/api/enquiries/${winner._id}/status`, {
    method: 'POST', token: nandhini, body: { status: 'won' },
  });
  await api(`/api/enquiries/${loser._id}/status`, {
    method: 'POST', token: nandhini, body: { status: 'lost', lostReason: 'price' },
  });

  const data = await board(nandhini);

  assert.equal(data.performance.won.count, 1);
  assert.equal(data.performance.won.value, 120000);
  assert.equal(data.performance.lost.value, 80000);
  assert.equal(data.performance.winRatePercent, 50);
  // A high win count on a low win value is a different problem from the reverse.
  assert.ok(data.performance.lostReasons.some((row) => row.label === 'price'));
});

test('every figure carries the records behind it', async () => {
  // A number nobody can open is a number nobody trusts [DASHBOARDS §1].
  const data = await board(nandhini);

  for (const key of ['overdueFollowUps', 'dueToday', 'noNextAction', 'awaitingFeedback', 'samplesOverdue']) {
    assert.ok(Array.isArray(data.today[key].rows), `${key} carries rows`);
    assert.equal(typeof data.today[key].count, 'number');
  }
  assert.ok(data.today.overdueFollowUps.rows.every((row) => row._id), 'each row is openable');
});

test('a customer nobody has enquired for in three months is surfaced', async () => {
  const quiet = await makeCustomer(nandhini);

  const data = await board(nandhini);
  assert.equal(data.dormantCustomers.days, 90);
  assert.ok(
    data.dormantCustomers.rows.some((row) => String(row._id) === String(quiet._id)),
    'a customer with no enquiry at all has been quiet the longest'
  );
});
