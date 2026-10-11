/**
 * The overview dashboard [services/overview.service.js]: the figures, the new enquiries to
 * verify, the department tasks to follow and the customer / party master — each through the
 * same ownership rules as the lists it summarises.
 *
 *   node --test tests/overview.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'overview-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
const ids = {};
let Enquiry;

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
  ({ default: Enquiry } = await import('../src/models/Enquiry.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['arun', 'Arun K', 'marketing'], ['siva', 'Sivakumar', 'production']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
    ids[key] = (await api('/api/auth/me', { as: key })).json.data.id;
  }
  const customer = async (as, name, mobile) => (await api('/api/customers', { method: 'POST', as, body: { name, mobile, assignedTo: ids[as] } })).json.data;
  ids.aruna = (await customer('nandhini', 'Aruna Knits', '9840011001'))._id;
  ids.bala = (await customer('nandhini', 'Bala Garments', '9840011002'))._id;
  ids.chitra = (await customer('arun', 'Chitra Exports', '9840011003'))._id;
  ids.deva = (await customer('nandhini', 'Deva Fashions', '9840011004'))._id;
  const enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: ids.aruna, requirement: { modelNumber: 'NPT-400S' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  ids.enquiry = enquiry._id;
  /* Due today. */
  await Enquiry.updateOne({ _id: enquiry._id }, { $set: { nextFollowUpDate: new Date() } });
  /* A second enquiry, with Production — its marketing status follows to Production. */
  const working = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: ids.deva, requirement: { modelNumber: 'M-102' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  const sent = await api(`/api/enquiries/${working._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'When can it be ready?' } });
  assert.equal(sent.status, 201, sent.json.message);
  ids.task = sent.json.data.task._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the figures are the reader’s own book — Admin’s the company’s', async () => {
  const mine = (await api('/api/dashboard/overview', { as: 'nandhini' })).json.data;
  assert.deepEqual(mine.figures, { customers: 3, dueToday: 1, activeEnquiries: 2, quotations: 0 });
  assert.equal(mine.newEnquiries.total, 1);
  assert.equal(mine.newEnquiries.rows[0].customer.name, 'Aruna Knits');
  assert.equal(mine.newEnquiries.rows[0].assignedTo.name, 'Nandhini S');

  const theirs = (await api('/api/dashboard/overview', { as: 'arun' })).json.data;
  assert.deepEqual(theirs.figures, { customers: 1, dueToday: 0, activeEnquiries: 0, quotations: 0 });
  const all = (await api('/api/dashboard/overview', { as: 'admin' })).json.data;
  assert.equal(all.figures.customers, 4);
  assert.equal(all.figures.activeEnquiries, 2);
});

test('department tasks to follow: marketing their own enquiries’, the department its queue, Admin all', async () => {
  const has = async (as) => (await api('/api/dashboard/tasks', { as })).json.data.some((task) => task._id === ids.task);
  assert.equal(await has('nandhini'), true);
  assert.equal(await has('arun'), false, 'not another marketing person’s');
  assert.equal(await has('siva'), true, 'Production’s queue');
  assert.equal(await has('admin'), true);
  const [task] = (await api('/api/dashboard/tasks', { as: 'nandhini' })).json.data;
  assert.equal(task.label, 'Ask EDD');
  assert.equal(task.team, 'Production Team');
  assert.equal(task.customer.name, 'Deva Fashions');
  assert.equal(task.createdBy.name, 'Nandhini S');
});

test('the party master: every customer with where it stands, by chip', async () => {
  const { json } = await api('/api/dashboard/parties', { as: 'nandhini' });
  const rows = Object.fromEntries(json.data.rows.map((row) => [row.name, row]));
  assert.deepEqual(Object.keys(rows).sort(), ['Aruna Knits', 'Bala Garments', 'Deva Fashions'], 'only their own');
  assert.equal(rows['Deva Fashions'].status, 'Production', 'where the plant has it');
  assert.equal(rows['Aruna Knits'].status, 'Enquiry received');
  assert.equal(rows['Aruna Knits'].isNew, true);
  assert.equal(rows['Bala Garments'].status, 'Follow-up pending');
  assert.equal(rows['Bala Garments'].line, 'Contact customer and update status');
  assert.equal(json.data.counts.all, 3);
  assert.equal(json.data.counts.production, 1);
  assert.equal(json.data.counts.new_enquiry, 1);
  assert.equal(json.data.counts.due_today, 1);

  const fresh = (await api('/api/dashboard/parties?filter=new_enquiry', { as: 'nandhini' })).json.data;
  assert.deepEqual(fresh.rows.map((row) => row.name), ['Aruna Knits']);
  const found = (await api('/api/dashboard/parties?search=bala', { as: 'nandhini' })).json.data;
  assert.deepEqual(found.rows.map((row) => row.name), ['Bala Garments']);
  assert.equal((await api('/api/dashboard/parties', { as: 'admin' })).json.data.total, 4);
  assert.equal((await api('/api/dashboard/parties', { as: 'siva' })).status, 403, 'Production has no customer grant');
});

test('a party is due today, or new, when any live enquiry of theirs is — not just the newest', async () => {
  /* A newer enquiry for Aruna, followed up in a week — the older one is still due today. */
  const newer = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: ids.aruna, requirement: { modelNumber: 'NPT-500' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 7 * 86400000).toISOString() },
  })).json.data;
  await Enquiry.updateOne({ _id: newer._id }, { $set: { marketingStatus: 'quotation_preparing', updatedAt: new Date(Date.now() + 60000) } }, { timestamps: false });
  const { json } = await api('/api/dashboard/parties?filter=due_today', { as: 'nandhini' });
  assert.deepEqual(json.data.rows.map((row) => row.name), ['Aruna Knits'], 'the figures said one due today; so does the chip');
  assert.equal(json.data.counts.due_today, (await api('/api/dashboard/overview', { as: 'nandhini' })).json.data.figures.dueToday);
  assert.equal(json.data.rows[0].status, 'Quotation preparing', 'where it stands is the newest enquiry');
  assert.equal(json.data.rows[0].isNew, true, 'the older one is still waiting to be verified');
  assert.equal(json.data.counts.new_enquiry, 1);
});
