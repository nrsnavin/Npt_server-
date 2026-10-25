/**
 * Team jobs [teamJobs.service]: a task Admin or marketing gave with no enquiry is read like an
 * enquiry — numbered, where it is now, each team's step, every move — by whoever gave it, the
 * buyer's marketing person and Admin.
 *
 *   node --test tests/team-jobs.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { dispatchLoad } from './support/dispatchLoad.mjs';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'team-jobs-test-secret';

let mongo;
let server;
let baseUrl;
let Todo;
const token = {};
let customerId;

const api = async (path, { method = 'GET', body, as = 'nandhini' } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token[as]}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const move = (task, as, status, extra = {}) => api(`/api/workspace/todos/${task}/status`, { method: 'POST', as, body: { status, note: extra.note || `${status} said`, ...extra } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
const page = async (enquiry) => (await api(`/api/enquiries/${enquiry}/handoffs`)).json;
const records = async (enquiry) => (await api(`/api/enquiries/${enquiry}/records`)).json.data;
const journeyOf = (rows, model) => rows.find((row) => row.model === model);
const stepOf = (journey, team) => journey?.steps.find((step) => step.team === team);

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const raw = async (path, body, bearer) => (await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) })).json();
  await raw('/api/auth/register', { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' });
  token.admin = (await raw('/api/auth/login', { email: 'admin@np.com', password: 'Admin@12345' })).data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['arun', 'Arun K', 'marketing'], ['vijay', 'Vijay Collections', 'payment_collection'], ['siva', 'Sivakumar', 'production'], ['pandi', 'Pandi Print', 'printing'], ['anand', 'Anand Assembly', 'assembling'], ['ravi', 'Ravi Despatch', 'despatch']]) {
    const made = await raw('/api/users', { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: department === 'production' }, token.admin);
    assert.ok(made.data, made.message);
    token[key] = (await raw('/api/auth/login', { email: `${key}@np.com`, password: 'Pass@123456' })).data.token;
  }
  const me = (await api('/api/auth/me')).json.data.id;
  customerId = (await api('/api/customers', { method: 'POST', body: { name: 'Job Garments', mobile: '9840099081', assignedTo: me } })).json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});



test('a job Admin gives Production: numbered, read whole — the asking, where it is now, each team, every move', async () => {
  const sent = await api('/api/workspace/team-tasks', { method: 'POST', as: 'admin', body: { kind: 'ask_edd', note: 'Status of their CRF25 order?', customer: customerId, edd: new Date(Date.now() + 15 * 864e5).toISOString().slice(0, 10) } });
  assert.equal(sent.status, 201, sent.json.message);
  const task = sent.json.data.task || sent.json.data;
  assert.match((await Todo.findById(task._id).lean()).jobNumber, /^JOB-\d{4}-\d{4}$/);
  /* Production fills it and starts it partway: with Printing since yesterday. */
  assert.equal((await api(`/api/workspace/todos/${task._id}/brief`, { method: 'POST', as: 'siva', body: { brief: { model: 'JB-1', quantity: '5000' } } })).status, 200);
  const yesterday = new Date(Date.now() - 864e5 + 330 * 60 * 1000).toISOString().slice(0, 10);
  assert.equal((await api(`/api/workspace/todos/${task._id}/start-from`, { method: 'POST', as: 'siva', body: { models: [{ model: 'JB-1', printing: true, at: 'handed_printing', date: yesterday }] } })).status, 200);

  const list = (await api('/api/workspace/team-jobs', { as: 'admin' })).json.data;
  const row = list.find((entry) => String(entry._id) === String(task._id));
  assert.ok(row, 'on Admin’s list');
  assert.equal(row.asked.what, 'Ask EDD');
  assert.equal(row.customer.name, 'Job Garments');
  assert.match(row.now.words, /^Printing: /, 'where it is now: with Printing');
  assert.deepEqual(row.teams, ['Production', 'Printing']);

  const job = (await api(`/api/workspace/team-jobs/${task._id}`, { as: 'admin' })).json.data;
  assert.equal(job.number, row.number);
  assert.deepEqual(job.steps.map((step) => [step.team, step.statusLabel]), [['Production', 'Handed to Printing'], ['Printing', job.steps[1].statusLabel]]);
  assert.match(job.asked.note, /Status of their CRF25 order/);
  assert.ok(job.timeline.some((line) => /Already handed to Printing on/.test(line.text)), 'what Production did, in its words');
  assert.ok(new Date(job.timeline[0].at) >= new Date(job.timeline.at(-1).at), 'newest first');
  assert.deepEqual(job.journeys.map((row2) => row2.model), ['JB-1']);
});

test('who reads which job: whoever gave it, the buyer’s marketing person, Admin — not another marketing person', async () => {
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  const mine = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Nandhini Buyer', mobile: '9840099082', assignedTo: me } })).json.data._id;
  const sent = await api('/api/workspace/team-tasks', { method: 'POST', as: 'nandhini', body: { kind: 'team_payment_followup', note: 'Collect the balance', customer: mine } });
  assert.equal(sent.status, 201, sent.json.message);
  const task = sent.json.data.task || sent.json.data;
  /* Payment Collection cannot collect: PRT's case is on the same job. */
  const escalated = await api(`/api/workspace/todos/${task._id}/status`, { method: 'POST', as: 'vijay', body: { status: 'escalate_prt', note: 'Not answering', fields: { prtMode: 'Collect cheque' } } });
  assert.equal(escalated.status, 200, escalated.json.message);
  const job = (await api(`/api/workspace/team-jobs/${task._id}`, { as: 'nandhini' })).json.data;
  assert.deepEqual(job.steps.map((step) => step.team), ['Payment Collection', 'Payment Recovery (PRT)']);
  assert.match(job.now.words, /^Payment Recovery \(PRT\)/);
  assert.equal(job.steps[0].completed, true);
  assert.ok((await api('/api/workspace/team-jobs', { as: 'nandhini' })).json.data.some((row) => String(row._id) === String(task._id)), 'on her list');
  assert.equal((await api('/api/workspace/team-jobs', { as: 'arun' })).json.data.some((row) => String(row._id) === String(task._id)), false, 'not another marketing person’s');
  assert.equal((await api(`/api/workspace/team-jobs/${task._id}`, { as: 'arun' })).status, 404);
  assert.equal((await api(`/api/workspace/team-jobs/${task._id}`, { as: 'admin' })).status, 200);
  /* Search by the buyer, and the open / done split. */
  assert.ok((await api('/api/workspace/team-jobs?search=nandhini%20buyer', { as: 'admin' })).json.data.length >= 1);
  assert.equal((await api('/api/workspace/team-jobs?state=done', { as: 'nandhini' })).json.data.some((row) => String(row._id) === String(task._id)), false);
});

test('a job raised before jobs were numbered gets its number when first read', async () => {
  const _id = new mongoose.Types.ObjectId();
  const { default: User } = await import('../src/models/User.js');
  const admin = await User.findOne({ email: 'admin@np.com' }).lean();
  await Todo.create({ _id, chain: _id, kind: 'ask_edd', department: 'production', title: 'Ask EDD — old job', customer: customerId, createdBy: admin._id });
  const list = (await api('/api/workspace/team-jobs', { as: 'admin' })).json.data;
  assert.match(list.find((row) => String(row._id) === String(_id)).number, /^JOB-/);
});
