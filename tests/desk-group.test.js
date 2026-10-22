/**
 * One desk for Quality, Assembly and Printing [config/modules.js DESK_GROUPS]; every update on a
 * department task told to Admin and the enquiry's marketing person; and "My Payment Follow-up" on
 * the login of whoever raises it.
 *
 *   node --test tests/desk-group.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'desk-group-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
const ids = {};

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

const raise = async (as, kind, extra = {}) => {
  const sent = await api(`/api/enquiries/${ids.enquiry}/handoffs`, { method: 'POST', as, body: { kind, note: `Please do: ${kind}`, ...extra } });
  assert.equal(sent.status, 201, `${kind}: ${sent.json.message}`);
  return sent.json.data.task;
};

const noticesFor = async (as) => (await api('/api/workspace/notices', { as })).json.data || [];

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
  ids.admin = (await api('/api/auth/me', { as: 'admin' })).json.data.id;
  for (const [key, name, department] of [
    ['nandhini', 'Nandhini S', 'marketing'], ['suresh', 'Suresh Q', 'quality'], ['ravi', 'Ravi A', 'assembling'], ['mani', 'Mani P', 'printing'], ['siva', 'Sivakumar', 'production'],
  ]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: department === 'production' } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
    ids[key] = (await api('/api/auth/me', { as: key })).json.data.id;
  }
  ids.customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Deva Fashions', mobile: '9840011004', assignedTo: ids.nandhini } })).json.data._id;
  ids.enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: ids.customer, requirement: { modelNumber: 'NPT-400S' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data._id;
  ids.quality = (await raise('nandhini', 'quality_check'))._id;
  ids.assembling = (await raise('nandhini', 'ask_assembling_edd'))._id;
  ids.printing = (await raise('nandhini', 'ask_printing'))._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('Printing is a department; Quality, Assembly and Printing are one desk, each queue under its own department', async () => {
  const { DEPARTMENT_KEYS, deskOf, deskMates } = await import('../src/config/modules.js');
  assert.ok(DEPARTMENT_KEYS.includes('printing'));
  assert.equal(deskOf('assembling').key, 'finishing');
  assert.deepEqual(deskMates('quality'), ['quality', 'assembling', 'printing']);
  assert.deepEqual(deskMates('production'), ['production']);

  for (const [as, key] of [['suresh', 'quality'], ['ravi', 'assembling'], ['mani', 'printing'], ['suresh', 'mine']]) {
    const { status, json } = await api(`/api/departments/${key}/dashboard`, { as });
    assert.equal(status, 200, `${as} opens /departments/${key}: ${json.message}`);
    assert.equal(json.data.desk.key, 'finishing');
    assert.equal(json.data.figures.label, 'Quality · Assembling · Printing');
    assert.equal(json.data.figures.open, 3);
    assert.deepEqual(json.data.enquiries.map((row) => row.task.department).sort(), ['assembling', 'printing', 'quality']);
  }
  const production = (await api('/api/departments/production/dashboard', { as: 'siva' })).json.data;
  assert.equal(production.desk, undefined, 'a department of its own is unchanged');
  const refused = await api('/api/departments/quality/dashboard', { as: 'siva' });
  assert.equal(refused.status, 403);
});

test('one desk, one queue: a Quality login works Assembly’s and Printing’s tasks; the board offers the desk as one choice', async () => {
  const mine = (await api('/api/workspace/todos?scope=department&status=open', { as: 'suresh' })).json.data;
  assert.deepEqual(mine.map((task) => task.department).sort(), ['assembling', 'printing', 'quality']);
  const moved = await api(`/api/workspace/todos/${ids.printing}/status`, { method: 'POST', as: 'suresh', body: { status: 'started', note: 'Artwork approved, on the pad printer' } });
  assert.equal(moved.status, 200, moved.json.message);
  /* The update is kept in its parts — the step, the person's words — beside the one-line note. */
  const line = moved.json.data.updates.at(-1);
  assert.equal(line.kind, 'status');
  assert.equal(line.statusLabel, 'Started');
  assert.equal(line.text, 'Artwork approved, on the pad printer');
  assert.equal(line.note, 'Started: Artwork approved, on the pad printer');

  const desk = (await api('/api/dashboard/tasks?department=finishing', { as: 'admin' })).json.data;
  assert.deepEqual(desk.map((task) => task.department).sort(), ['assembling', 'printing', 'quality']);
  const one = (await api('/api/dashboard/tasks?department=printing', { as: 'admin' })).json.data;
  assert.deepEqual(one.map((task) => task.department), ['printing']);
  const own = (await api('/api/dashboard/tasks?department=finishing', { as: 'ravi' })).json.data;
  assert.equal(own.length, 3, 'the desk’s own people read the whole desk');
  const other = (await api('/api/dashboard/tasks?department=finishing', { as: 'siva' })).json.data;
  assert.deepEqual(other, [], 'Production asking for the desk gets nothing');
});

test('updates, send-backs and new dates stay on the task — not in Admin’s or marketing’s Needs your action', async () => {
  const before = (await noticesFor('nandhini')).length;
  const adminBefore = (await noticesFor('admin')).length;
  const updated = await api(`/api/workspace/todos/${ids.assembling}/update`, { method: 'POST', as: 'ravi', body: { note: 'Clips fitted on 4,000 pieces' } });
  assert.equal(updated.status, 200, updated.json.message);
  const inFiveDays = new Date(Date.now() + 5 * 86400000).toISOString();
  const dated = await api(`/api/workspace/todos/${ids.assembling}/reschedule`, { method: 'POST', as: 'ravi', body: { dueDate: inFiveDays, reason: 'Clips arrive Monday' } });
  assert.equal(dated.status, 200, dated.json.message);
  const back = await api(`/api/workspace/todos/${ids.quality}/send-back`, { method: 'POST', as: 'suresh', body: { reason: 'No lot to check yet — ask again when packed' } });
  assert.equal(back.status, 200, back.json.message);

  assert.equal((await noticesFor('nandhini')).length, before, 'the marketing person is not told');
  assert.equal((await noticesFor('admin')).length, adminBefore, 'nor Admin');
  assert.equal((await noticesFor('siva')).length, 0, 'nor anybody else');
});

test('My Payment Follow-up lands on the login that raises it, each person their own, and shows on their desk', async () => {
  const brief = { status: 'Promised to pay', owner: 'my_payment_followup', commitment: 'Next Week' };
  const hers = await raise('nandhini', 'my_payment_followup', { brief });
  assert.equal(String(hers.user?._id || hers.user), ids.nandhini);
  assert.equal(hers.department, 'marketing');
  /* Admin following up the same buyer gets their own, not a 409 on hers. */
  const his = await raise('admin', 'my_payment_followup', { brief });
  assert.equal(String(his.user?._id || his.user), ids.admin);
  assert.notEqual(String(his._id), String(hers._id));

  const mine = (await api('/api/workspace/todos?scope=mine&status=open', { as: 'nandhini' })).json.data;
  assert.ok(mine.some((task) => task._id === hers._id), 'on her To-do');
  const desk = (await api('/api/departments/marketing/dashboard', { as: 'nandhini' })).json.data;
  assert.ok(desk.enquiries.some((row) => row.task._id === hers._id), 'on her desk');
  assert.ok(!desk.enquiries.some((row) => row.task._id === his._id), 'not Admin’s');
  const admins = (await api('/api/departments/management/dashboard', { as: 'admin' })).json.data;
  assert.ok(admins.enquiries.some((row) => row.task._id === his._id), 'Admin’s own, on Admin’s desk');
  const board = (await api('/api/dashboard/tasks', { as: 'nandhini' })).json.data;
  assert.ok(board.some((task) => task._id === hers._id), 'and on the board');

  /* A follow-up note on it stays on the task — not in Admin's Needs your action. */
  const noted = await api(`/api/workspace/todos/${hers._id}/update`, { method: 'POST', as: 'nandhini', body: { note: 'Accounts promised Friday' } });
  assert.equal(noted.status, 200, noted.json.message);
  assert.ok(!(await noticesFor('admin')).some((notice) => notice.note === 'Accounts promised Friday'));
});

test('the Quality · Printing · Assembly desk reads as lines: enquiry, buyer, EDD, a 20–30 word state, the Production workflow page', async () => {
  const enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: ids.customer, requirement: { modelNumber: 'NPT-410V' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data._id;
  const send = async (kind) => {
    const sent = await api(`/api/enquiries/${enquiry}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind, note: `Please do: ${kind}` } });
    assert.equal(sent.status, 201, `${kind}: ${sent.json.message}`);
    return sent.json.data.task;
  };
  const production = await send('ask_edd');
  await send('quality_check');
  await send('ask_printing');
  const desk = (await api('/api/departments/quality/dashboard', { as: 'suresh' })).json.data;
  const rows = desk.enquiries.filter((row) => String(row.enquiry?._id) === String(enquiry));
  assert.equal(rows.length, 2, 'Quality’s and Printing’s tasks on the desk');
  for (const row of rows) {
    assert.ok(row.summary && row.summary.split(/\s+/).length <= 30, row.summary);
    assert.equal(row.summaryBy, 'rules', 'no model set up in the tests: the rules write the line');
    assert.equal(row.workflow, `/production/workflow/${production._id}`);
    assert.match(row.summary, /Production: /);
    assert.match(row.summary, /No EDD yet/);
  }
  /* A desk outside the three keeps its rows as they were. */
  const productionDesk = (await api('/api/departments/production/dashboard', { as: 'siva' })).json.data;
  assert.equal(productionDesk.enquiries[0]?.summary, undefined);
});
