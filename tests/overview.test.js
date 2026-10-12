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

test('Admin works any department’s task from the board — an update, a new date — without taking it off the queue', async () => {
  const updated = await api(`/api/workspace/todos/${ids.task}/update`, { method: 'POST', as: 'admin', body: { note: 'Checked with the press — the mould goes on M3 tomorrow' } });
  assert.equal(updated.status, 200, updated.json.message);
  assert.ok(!updated.json.data.user, 'still nobody’s: Admin writing on it does not claim it for Admin');

  const inFiveDays = new Date(Date.now() + 5 * 86400000).toISOString();
  const moved = await api(`/api/workspace/todos/${ids.task}/reschedule`, { method: 'POST', as: 'admin', body: { dueDate: inFiveDays, reason: 'Press is down until Monday' } });
  assert.equal(moved.status, 200, moved.json.message);

  /* The board carries what the panel needs: the update with who wrote it, and the new date. */
  const [row] = (await api('/api/dashboard/tasks?department=production', { as: 'admin' })).json.data.filter((task) => task._id === ids.task);
  assert.equal(row.updates.at(-1).note, 'Checked with the press — the mould goes on M3 tomorrow');
  assert.equal(row.updates.at(-1).by.name, 'Navin R');
  assert.equal(new Date(row.dueDate).toDateString(), new Date(inFiveDays).toDateString());

  /* Production's own first writer does take it. */
  const theirs = await api(`/api/workspace/todos/${ids.task}/update`, { method: 'POST', as: 'siva', body: { note: 'Mould is on M3' } });
  assert.equal(theirs.status, 200, theirs.json.message);
  assert.equal(String(theirs.json.data.user?._id || theirs.json.data.user), ids.siva);

  /* Another marketing person is not Admin and not Production: refused. */
  const other = await api(`/api/workspace/todos/${ids.task}/update`, { method: 'POST', as: 'arun', body: { note: 'Not mine' } });
  assert.ok(other.status >= 400 && other.status < 500, `refused, got ${other.status}`);
});

test('Admin reads any department’s tasks, open or done; nobody widens their own scope', async () => {
  const listed = async (as, query) => api(`/api/dashboard/tasks${query}`, { as });
  const ids_ = (response) => response.json.data.map((task) => task._id);
  assert.ok(ids_(await listed('admin', '?department=production')).includes(ids.task));
  assert.deepEqual(ids_(await listed('admin', '?department=sampling')).filter((id) => id === ids.task), []);
  assert.deepEqual(ids_(await listed('siva', '?department=sampling')), [], 'Production asking for Sampling’s gets nothing');
  assert.ok(ids_(await listed('siva', '?department=production')).includes(ids.task));

  const { default: Todo } = await import('../src/models/Todo.js');
  await Todo.updateOne({ _id: ids.task }, { $set: { completed: true, completedAt: new Date() } });
  assert.equal(ids_(await listed('admin', '?department=production')).includes(ids.task), false, 'open by default');
  const done = await listed('admin', '?department=production&state=done');
  assert.ok(ids_(done).includes(ids.task));
  assert.equal(done.json.data.find((task) => task._id === ids.task).completed, true);
  assert.ok(ids_(await listed('admin', '?state=all')).includes(ids.task));
  assert.ok(ids_(await listed('nandhini', '?state=done')).includes(ids.task), 'marketing sees their own enquiry’s finished task');
  assert.equal(ids_(await listed('arun', '?state=done')).includes(ids.task), false, 'not another marketing person’s');

  assert.equal((await listed('admin', '?state=later')).status, 400);
  assert.equal((await listed('admin', '?department=nowhere')).status, 400);
});

test('each tile counts what the list it opens shows — a won enquiry is not a follow-up', async () => {
  /* Won, still in the plant, follow-up date today: active work, but not one to chase. */
  const won = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: ids.bala, requirement: { modelNumber: 'NPT-410V' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 86400000).toISOString() },
  })).json.data;
  await Enquiry.updateOne({ _id: won._id }, { $set: { status: 'won', nextFollowUpDate: new Date() } });

  const totalOf = (json) => json.pagination?.total ?? json.meta?.total ?? json.data?.length;
  const tonight = new Date(); tonight.setHours(23, 59, 59, 999);
  const { figures } = (await api('/api/dashboard/overview', { as: 'nandhini' })).json.data;
  const dueList = (await api(`/api/enquiries?open=true&dueBy=${encodeURIComponent(tonight.toISOString())}`, { as: 'nandhini' })).json;
  const openList = (await api('/api/enquiries?open=true', { as: 'nandhini' })).json;
  assert.equal(figures.dueToday, totalOf(dueList), 'Due today = the Due now list');
  assert.equal(figures.activeEnquiries, totalOf(openList), 'Active enquiries = the Open list');

  const due = (await api('/api/dashboard/parties?filter=due_today', { as: 'nandhini' })).json.data;
  assert.equal(due.rows.some((row) => row.name === 'Bala Garments'), false, 'the party chip agrees');
});

test('a marketing person follows the tasks on their own enquiries — not a colleague’s on a buyer of theirs', async () => {
  const { default: Todo } = await import('../src/models/Todo.js');
  /* Arun works an enquiry for Nandhini's buyer — delegated to him — and asks Production about it. */
  const theirs = await Enquiry.create({
    number: 'ENQ-T-901', customer: ids.aruna, assignedTo: ids.arun, requirement: { modelNumber: 'NPT-500' },
    nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 86400000),
  });
  const asked = await Todo.create({ department: 'production', kind: 'ask_edd', title: 'Ask EDD', enquiry: theirs._id, customer: ids.aruna, createdBy: ids.arun });
  /* A team task with no enquiry, on Nandhini's buyer, raised by somebody else. */
  const team = await Todo.create({ department: 'production', kind: 'ask_edd', title: 'Ask EDD', customer: ids.bala });

  const seen = async (as) => (await api('/api/dashboard/tasks?state=all', { as })).json.data.map((task) => task._id);
  const nandhini = await seen('nandhini');
  assert.equal(nandhini.includes(String(asked._id)), false, 'Arun’s enquiry, though the buyer is hers');
  assert.equal(nandhini.includes(String(team._id)), true, 'a team task on her own buyer');
  assert.equal(nandhini.includes(ids.task), true, 'her own enquiry’s task');
  const arun = await seen('arun');
  assert.equal(arun.includes(String(asked._id)), true, 'his enquiry');
  assert.equal(arun.includes(String(team._id)), false);
});
