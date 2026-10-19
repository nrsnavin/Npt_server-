/**
 * A customer's own follow-up, from the customer list [controllers/customerFollowUp.controller.js]:
 * set with a date and a note, a call logged against it (moving it to the next date), closed —
 * every step kept as history — and the Today's actions card beside the list
 * [services/overview.service `followUpsFor`], with the enquiries due by tonight beside them.
 *
 *   node --test tests/customer-follow-up.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'customer-follow-up-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
const ids = {};
const DAY = 86400000;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name] of [['nandhini', 'Nandhini S'], ['arun', 'Arun K']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department: 'marketing' } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
    ids[key] = (await api('/api/auth/me', { as: key })).json.data.id;
  }
  const buyer = async (owner, name, mobile) => (await api('/api/customers', { method: 'POST', as: owner, body: { name, mobile, assignedTo: ids[owner] } })).json.data._id;
  ids.galaxy = await buyer('nandhini', 'Galaxy Apparels', '9840080001');
  ids.opera = await buyer('nandhini', 'Opera Clothing', '9840080002');
  ids.scm = await buyer('arun', 'SCM Garments', '9840080003');
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

const followUp = (as, id, body) => api(`/api/customers/${id}/follow-up`, { method: 'POST', as, body });

test('set, log with a next date, and close — each kept in the history', async () => {
  const soon = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const set = await followUp('nandhini', ids.galaxy, { action: 'set', due: soon, note: 'Send product photos', priority: 'high' });
  assert.equal(set.status, 200, set.json.message);
  assert.equal(set.json.data.followUp.note, 'Send product photos');
  assert.equal(set.json.data.followUp.priority, 'high');

  const next = new Date(Date.now() + 3 * DAY).toISOString();
  const logged = await followUp('nandhini', ids.galaxy, { action: 'log', note: 'Spoke to Ravi, wants photos of the 400mm', next });
  assert.equal(logged.status, 200, logged.json.message);
  assert.equal(new Date(logged.json.data.followUp.due).toISOString(), next, 'moved to the next call');
  assert.equal(logged.json.data.followUp.note, 'Send product photos', 'still the same follow-up');

  const closed = await followUp('nandhini', ids.galaxy, { action: 'close', note: 'Photos sent' });
  assert.equal(closed.status, 200, closed.json.message);
  assert.equal(closed.json.data.followUp, null);
  assert.deepEqual(closed.json.data.log.map((line) => line.kind), ['close', 'log', 'set'], 'newest first');
  assert.equal(closed.json.data.log[1].by.name, 'Nandhini S');

  const again = await followUp('nandhini', ids.galaxy, { action: 'close' });
  assert.equal(again.status, 400, 'nothing open to close');
});

test('refuses a past date, an empty log, and somebody else\'s customer', async () => {
  const past = await followUp('nandhini', ids.opera, { action: 'set', due: new Date(Date.now() - 2 * DAY).toISOString() });
  assert.equal(past.status, 400);
  assert.match(past.json.message, /cannot be in the past/);
  const empty = await followUp('nandhini', ids.opera, { action: 'log', note: '' });
  assert.equal(empty.status, 400);
  const others = await followUp('nandhini', ids.scm, { action: 'set', due: new Date(Date.now() + DAY).toISOString() });
  assert.equal(others.status, 404);
  const history = await api(`/api/customers/${ids.scm}/follow-up`, { as: 'nandhini' });
  assert.equal(history.status, 404);
});

test('Today\'s actions: customer follow-ups and enquiries due by tonight, soonest first, only the signed-in person\'s customers — Admin too', async () => {
  const inAnHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await followUp('nandhini', ids.opera, { action: 'set', due: inAnHour, note: 'Quotation required' });
  await followUp('nandhini', ids.galaxy, { action: 'set', due: new Date(Date.now() + 5 * DAY).toISOString(), note: 'Season visit' });
  await followUp('arun', ids.scm, { action: 'set', due: inAnHour, note: 'Sample approval follow-up' });
  const enquiry = await api('/api/enquiries', {
    method: 'POST',
    as: 'nandhini',
    body: { prospect: { name: 'DSP International', mobile: '9840080009' }, requirement: { modelNumber: 'NH-400' }, nextAction: 'Payment follow-up', nextActionType: 'call', nextFollowUpDate: new Date().toISOString() },
  });
  assert.equal(enquiry.status, 201, enquiry.json.message);

  const { status, json } = await api('/api/dashboard/follow-ups', { as: 'nandhini' });
  assert.equal(status, 200, json.message);
  const titles = json.data.items.map((item) => item.title);
  assert.ok(titles.includes('Quotation required'));
  assert.ok(titles.includes('Payment follow-up'), 'the enquiry due today, on a prospect');
  assert.ok(titles.includes('Season visit'), 'upcoming ones listed after');
  assert.ok(!titles.includes('Sample approval follow-up'), 'not another person\'s customer');
  assert.equal(json.data.pending, 2, 'due by tonight');
  assert.equal(json.data.items.at(-1).title, 'Season visit');
  assert.equal(json.data.items.find((item) => item.title === 'Payment follow-up').prospect, 'DSP International');

  const parties = await api('/api/dashboard/parties?filter=due_today', { as: 'nandhini' });
  assert.ok(parties.json.data.rows.some((row) => row.name === 'Opera Clothing' && row.customerFollowUp?.note === 'Quotation required'), 'counted as due on the list');

  /* Only one's own customers' — Admin too: the card is what I have to chase today. */
  const admins = await api('/api/dashboard/follow-ups', { as: 'admin' });
  assert.ok(!admins.json.data.items.some((item) => item.title === 'Sample approval follow-up'), 'not Arun\'s customer');
  assert.ok(!admins.json.data.items.some((item) => item.title === 'Quotation required'), 'not Nandhini\'s either');
  const aruns = await api('/api/dashboard/follow-ups', { as: 'arun' });
  assert.deepEqual(aruns.json.data.items.map((item) => item.title), ['Sample approval follow-up'], 'Arun sees his own only');
});
