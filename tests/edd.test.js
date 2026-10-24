/**
 * The expected delivery date — one date on the enquiry, read by every screen that works to it
 * [models/Enquiry.js `edd`; handoff.service `setTaskEdd`, `writeEnquiryEdd`, `tellEddSet`].
 *
 * Marketing sets it on the enquiry; Production gives it from its task — asked for there until it
 * is — or with a ready date on a status move. The latest word wins. It travels on the Production
 * and Dispatch tasks and on marketing's list.
 *
 *   node --test tests/edd.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'edd-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
let enquiry;
let production;
let dispatch;
let Enquiry;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const indiaDay = (offset = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + offset * 86400000));
const eddOf = async () => (await Enquiry.findById(enquiry._id).select('edd').lean()).edd;

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
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['arun', 'Arun K', 'marketing'], ['siva', 'Sivakumar', 'production'], ['ravi', 'Ravi Despatch', 'despatch'], ['kavi', 'Kavitha', 'quality']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: department === 'production' } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'RR Jain Utjrsh', mobile: '9170875200', email: 'accounts@rrjain.in', assignedTo: me } })).json.data;
  enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id, requirement: { modelNumber: 'UTJRSH-0' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  const asked = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Buyer needs the date', brief: { model: 'UTJRSH-0', quantity: '10000' } },
  });
  assert.equal(asked.status, 201, asked.json.message);
  production = asked.json.data.task;
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini', body: { kind: 'invoice_dispatch', note: 'Send when ready', brief: { model: 'UTJRSH-0', quantity: '10000' } },
  });
  assert.equal(sent.status, 201, sent.json.message);
  dispatch = sent.json.data.task;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('an enquiry in Production with no EDD says so on the enquiry, the list and the tasks', async () => {
  assert.equal(await eddOf(), undefined);
  const history = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { as: 'nandhini' })).json;
  assert.equal(history.production.edd, null);
  assert.equal(history.production.asked.department, 'production');
  const row = (await api('/api/enquiries', { as: 'nandhini' })).json.data.find((entry) => entry._id === enquiry._id);
  assert.equal(row.progress.edd, null);
  const queue = (await api('/api/workspace/todos?scope=department', { as: 'siva' })).json.data;
  const mine = queue.find((task) => task._id === production._id);
  assert.ok(mine, 'the Production task is on the queue');
  assert.equal(mine.enquiry.edd?.date, undefined);
});

test('marketing sets the EDD on the enquiry; Production and Dispatch hear it on their open tasks', async () => {
  const day = indiaDay(5);
  const set = await api(`/api/enquiries/${enquiry._id}/edd`, { method: 'POST', as: 'nandhini', body: { date: day, note: 'Store opening' } });
  assert.equal(set.status, 200, set.json.message);
  assert.equal(set.json.data.department, 'marketing');
  assert.equal(set.json.data.by.name, 'Nandhini S');
  assert.equal(set.json.meta.told, 2, 'the Production task and the dispatch request');

  const edd = await eddOf();
  assert.equal(edd.date, day);
  assert.equal(edd.department, 'marketing');
  assert.equal(edd.note, 'Store opening');

  /* Said on each task, in the department's own timeline. */
  for (const [who, task] of [['siva', production], ['ravi', dispatch]]) {
    const seen = (await api('/api/workspace/todos?scope=department', { as: who })).json.data.find((entry) => entry._id === task._id);
    assert.ok(seen, `${who} sees the task`);
    assert.match(seen.updates.at(-1).text, /^EDD \d{2} \w{3} \d{4} set by Nandhini S \(marketing\): Store opening$/);
    assert.equal(seen.enquiry.edd.date, day);
    assert.equal(seen.enquiry.edd.department, 'marketing');
  }
});

test('the list and the enquiry page read the enquiry’s EDD, whoever gave it', async () => {
  const day = indiaDay(5);
  const row = (await api('/api/enquiries', { as: 'nandhini' })).json.data.find((entry) => entry._id === enquiry._id);
  assert.equal(row.progress.edd.date, day);
  assert.equal(row.progress.edd.department, 'marketing');
  assert.equal(row.edd.date, day);
  const history = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { as: 'nandhini' })).json;
  assert.equal(history.production.edd.department, 'marketing');
  assert.equal(history.production.edd.by, 'Nandhini S');
  assert.equal(history.production.edd.note, 'Store opening');
});

test('Production gives its completion date from its task, without a status move; the EDD stays marketing’s', async () => {
  const day = indiaDay(7);
  const marketing = await eddOf();
  /* Nothing follows moulding on this order, so Production's date is the completion date. */
  const early = await api(`/api/workspace/todos/${production._id}/edd`, { method: 'POST', as: 'siva', body: { date: day } });
  assert.equal(early.status, 400);
  assert.match(early.json.message, /Decide first which models need printing or assembly/);
  assert.equal((await api(`/api/workspace/todos/${production._id}/routing`, { method: 'POST', as: 'siva', body: { models: [{ model: 'UTJRSH-0' }] } })).status, 200);
  const refused = await api(`/api/workspace/todos/${production._id}/edd`, { method: 'POST', as: 'siva', body: { date: indiaDay(-1) } });
  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /cannot be in the past/);

  const given = await api(`/api/workspace/todos/${production._id}/edd`, { method: 'POST', as: 'siva', body: { date: day, note: 'Two presses on it' } });
  assert.equal(given.status, 200, given.json.message);
  const last = given.json.data.updates.at(-1);
  assert.equal(last.fields.edd, day);
  assert.equal(last.dateLabel, 'Completion');
  assert.match(last.note, /^Completion date /);
  assert.equal(given.json.data.user.name, 'Sivakumar', 'the first to write on it has taken it');

  /* The EDD is marketing's: Production's date does not touch it. */
  const edd = await eddOf();
  assert.equal(edd.date, marketing.date);
  assert.equal(edd.department, 'marketing');
  /* The completion date shows with the enquiry, model by model, beside the EDD. */
  const history = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { as: 'nandhini' })).json;
  assert.equal(history.production.edd.date ?? history.production.edd.edd, marketing.date);
  const row = history.production.byModel.find((entry) => entry.model === 'UTJRSH-0');
  assert.equal(row.completion, day);
  assert.equal(row.completionBy, 'production');
  assert.deepEqual(row.teams.map((team) => [team.department, team.date, team.kind]), [['production', day, 'completion']]);
  assert.equal(history.production.completion.date, day);

  const notices = (await api('/api/workspace/notices', { as: 'nandhini' })).json.data;
  assert.ok(!notices.some((notice) => notice.statusLabel === 'Completion date given'), 'on the enquiry and the task — not in Needs your action');
});

test('a ready date given with a status move is Production’s completion date too — never the EDD', async () => {
  const day = indiaDay(9);
  const marketing = await eddOf();
  const moved = await api(`/api/workspace/todos/${production._id}/status`, { method: 'POST', as: 'siva', body: { status: 'ready_on_date', date: day, note: 'Material came late' } });
  assert.equal(moved.status, 200, moved.json.message);
  const edd = await eddOf();
  assert.equal(edd.date, marketing.date);
  assert.equal(edd.department, 'marketing');
  const history = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { as: 'nandhini' })).json;
  assert.equal(history.production.byModel.find((entry) => entry.model === 'UTJRSH-0').completion, day);
  const row = (await api('/api/enquiries', { as: 'nandhini' })).json.data.find((entry) => entry._id === enquiry._id);
  assert.equal(row.progress.edd.date, marketing.date);
  assert.equal(row.progress.edd.department, 'marketing');
});

test('only the task’s department gives the EDD from it, and only from a task that carries one', async () => {
  const day = indiaDay(3);
  const quality = await api(`/api/workspace/todos/${production._id}/edd`, { method: 'POST', as: 'kavi', body: { date: day } });
  assert.equal(quality.status, 403);
  const fromDispatch = await api(`/api/workspace/todos/${dispatch._id}/edd`, { method: 'POST', as: 'ravi', body: { date: day } });
  assert.equal(fromDispatch.status, 400);
  assert.match(fromDispatch.json.message, /Production, Assembly or Printing task/);
  /* The enquiry's own EDD is marketing's and Admin's: another marketing person does not see the enquiry. */
  const other = await api(`/api/enquiries/${enquiry._id}/edd`, { method: 'POST', as: 'arun', body: { date: day } });
  assert.equal(other.status, 404);
  const asAdmin = await api(`/api/enquiries/${enquiry._id}/edd`, { method: 'POST', as: 'admin', body: { date: day, note: 'Buyer moved it up' } });
  assert.equal(asAdmin.status, 200, asAdmin.json.message);
  assert.equal((await eddOf()).department, 'marketing');
  const badDay = await api(`/api/enquiries/${enquiry._id}/edd`, { method: 'POST', as: 'nandhini', body: { date: '31/12/2026' } });
  assert.equal(badDay.status, 400);
});
