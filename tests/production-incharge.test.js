/**
 * The Production in charge [models/User.js `productionInCharge`, utils/departments.js
 * `isProductionInCharge`]: Admin marks anyone — from Production, Marketing or any department —
 * and Production joins their departments with its full access. Only they (or Admin) give
 * Production's EDD and hand-over dates (from the EDD box, a dated status, or the Expected date on
 * Update / Done), decide printing and assembly per model, and put the task on the production
 * queue. Everyone else in Production sees all of it and moves the statuses — Mould Issue, Part 1
 * Ready, Handed to Assembly — but a status that sets a date is refused.
 *
 *   node --test tests/production-incharge.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'incharge-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
const ids = {};
let production;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const indiaDay = (offset = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + offset * 86400000));
const on = (path) => `/api/workspace/todos/${production._id}/${path}`;
const status = (as, body) => api(on('status'), { method: 'POST', as, body });

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
  for (const [key, name, department, productionInCharge] of [
    ['nandhini', 'Nandhini S', 'marketing', false], ['siva', 'Sivakumar', 'production', true],
    ['mani', 'Mani Floor', 'production', false], ['anand', 'Anand Assembly', 'assembling', false],
  ]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge } });
    assert.equal(made.status, 201, made.json.message);
    ids[key] = made.json.data.id;
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Aruna Knits', mobile: '9840011001', assignedTo: ids.nandhini } })).json.data;
  const enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: {
      customer: customer._id, items: [{ modelNumber: 'NPT-410V', quantity: 5000 }, { modelNumber: 'NPT-400S', quantity: 3000 }],
      nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString(),
    },
  })).json.data;
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Buyer needs the date', brief: { model: 'NPT-410V' } } });
  assert.equal(sent.status, 201, sent.json.message);
  production = sent.json.data.task;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

const levelOf = (user, module) => (user.moduleAccess || []).find((grant) => grant.module === module)?.level;

test('Admin marks the Production in charge from any department; Production and its full access come with it', async () => {
  assert.equal((await api('/api/auth/me', { as: 'siva' })).json.data.productionInCharge, true);
  assert.equal((await api('/api/auth/me', { as: 'mani' })).json.data.productionInCharge, false);
  /* A marketing person made in charge when added: still marketing first, Production beside it. */
  const kala = await api('/api/users', { method: 'POST', as: 'admin', body: { name: 'Kala M', email: 'kala@np.com', password: 'Pass@123456', department: 'marketing', productionInCharge: true } });
  assert.equal(kala.status, 201, kala.json.message);
  assert.equal(kala.json.data.department, 'marketing');
  assert.deepEqual(kala.json.data.extraDepartments, ['production']);
  for (const module of ['production', 'moulds', 'materials', 'tasks']) assert.equal(levelOf(kala.json.data, module), 'write', module);
  ids.kala = kala.json.data.id;
  token.kala = (await api('/api/auth/login', { method: 'POST', body: { email: 'kala@np.com', password: 'Pass@123456' } })).json.data.token;
  /* Marked later: Assembly's Anand gets Production too, access raised and nothing taken away. */
  const anand = await api(`/api/users/${ids.anand}`, { method: 'PATCH', as: 'admin', body: { productionInCharge: true } });
  assert.equal(anand.status, 200, anand.json.message);
  assert.ok(anand.json.data.departments.includes('production') && anand.json.data.departments.includes('assembling'));
  assert.equal(levelOf(anand.json.data, 'production'), 'write');
  /* Unmarked, they keep Production until Admin takes it away. */
  const off = await api(`/api/users/${ids.anand}`, { method: 'PATCH', as: 'admin', body: { productionInCharge: false } });
  assert.equal(off.json.data.productionInCharge, false);
  assert.ok(off.json.data.departments.includes('production'));
});

test('a Production member sees the routing but cannot decide it, give the EDD or queue the task', async () => {
  const form = await api(on('routing'), { as: 'mani' });
  assert.equal(form.status, 200, form.json.message);
  assert.equal(form.json.data.mayDecide, false);
  assert.equal((await api(on('routing'), { as: 'siva' })).json.data.mayDecide, true);

  const routed = await api(on('routing'), { method: 'POST', as: 'mani', body: { models: [{ model: 'NPT-410V', printing: false }] } });
  assert.equal(routed.status, 403);
  assert.match(routed.json.message, /Only the Production in charge decides printing and assembly/);
  const queued = await api(on('production-queue'), { method: 'POST', as: 'mani', body: { date: indiaDay(5) } });
  assert.equal(queued.status, 403);
});

test('the Production in charge decides and gives the EDD; the member is refused the date', async () => {
  /* The marketing person who is in charge works the Production task like anyone in Production. */
  assert.equal((await api(on('routing'), { as: 'kala' })).json.data.mayDecide, true);
  const routed = await api(on('routing'), { method: 'POST', as: 'kala', body: { models: [{ model: 'NPT-410V' }, { model: 'NPT-400S', assembly: true }] } });
  assert.equal(routed.status, 200, routed.json.message);
  const refused = await api(on('edd'), { method: 'POST', as: 'mani', body: { date: indiaDay(6) } });
  assert.equal(refused.status, 403);
  assert.match(refused.json.message, /Only the Production in charge gives the EDD/);
  const given = await api(on('edd'), { method: 'POST', as: 'siva', body: { date: indiaDay(6), note: 'Press 3 from Monday' } });
  assert.equal(given.status, 200, given.json.message);
});

test('the Expected date on Update or Done is the EDD too: refused to the member, the update itself goes through', async () => {
  const dated = await api(on('update'), { method: 'POST', as: 'mani', body: { note: 'Half done', fields: { edd: indiaDay(4), pending: '2000' } } });
  assert.equal(dated.status, 403);
  assert.match(dated.json.message, /Only the Production in charge gives the EDD/);
  const plain = await api(on('update'), { method: 'POST', as: 'mani', body: { note: 'Half done', fields: { pending: '2000' } } });
  assert.equal(plain.status, 200, plain.json.message);
  const done = await api(on('done'), { method: 'POST', as: 'mani', body: { note: 'All moulded', fields: { edd: indiaDay(4) } } });
  assert.equal(done.status, 403);
});

test('a Production member moves the statuses, but not one that sets a date', async () => {
  for (const [key, note] of [['started', 'Press 3 running'], ['mould_issue', 'Ejector pin broke'], ['part1_ready', 'First 2,000 off the press']]) {
    const moved = await status('mani', { status: key, note });
    assert.equal(moved.status, 200, `${key}: ${moved.json.message}`);
  }
  for (const body of [
    { status: 'ready_tomorrow', note: 'All but packing' },
    { status: 'ready_on_date', note: 'Machine free Friday', date: indiaDay(3) },
    { status: 'part2_ready', note: 'Rest done', date: indiaDay(2) },
  ]) {
    const refused = await status('mani', body);
    assert.equal(refused.status, 403, body.status);
    assert.match(refused.json.message, /Only the Production in charge gives the date/);
  }
  const handed = await status('mani', { status: 'handed_assembly', note: 'NPT-400S to Anand', models: ['NPT-400S'] });
  assert.equal(handed.status, 200, handed.json.message);
  /* The in charge's own dated move goes through. */
  const dated = await status('siva', { status: 'ready_on_date', note: 'Last lot Friday', date: indiaDay(3), models: ['NPT-410V'] });
  assert.equal(dated.status, 200, dated.json.message);
});

test('moved out of Production, the mark goes with them', async () => {
  const moved = await api(`/api/users/${ids.siva}`, { method: 'PATCH', as: 'admin', body: { department: 'quality' } });
  assert.equal(moved.status, 200, moved.json.message);
  assert.equal(moved.json.data.productionInCharge, false);
});
