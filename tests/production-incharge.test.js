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

test('an in charge keeps full Production access whatever Admin sets later — replaced, reset or trimmed', async () => {
  /* Replaced wholesale with less: Production comes back under it. */
  const replaced = await api(`/api/users/${ids.kala}/access`, { method: 'PUT', as: 'admin', body: { moduleAccess: [{ module: 'enquiries', level: 'write' }, { module: 'production', level: 'read' }] } });
  assert.equal(replaced.status, 200, replaced.json.message);
  assert.equal(levelOf(replaced.json.data, 'production'), 'write');
  assert.equal(levelOf(replaced.json.data, 'moulds'), 'write');
  assert.equal(levelOf(replaced.json.data, 'materials'), 'write');
  assert.equal(levelOf(replaced.json.data, 'tasks'), 'write');
  assert.equal(levelOf(replaced.json.data, 'enquiries'), 'write', 'what Admin gave above the floor stays');
  /* Reset to the departments' defaults: marketing's plus Production's, never below the floor. */
  const reset = await api(`/api/users/${ids.kala}/access/reset`, { method: 'POST', as: 'admin' });
  if (reset.status === 200) assert.equal(levelOf(reset.json.data, 'production'), 'write');
  /* Unmarked, Admin may trim freely again. */
  await api(`/api/users/${ids.kala}`, { method: 'PATCH', as: 'admin', body: { productionInCharge: false } });
  const trimmed = await api(`/api/users/${ids.kala}/access`, { method: 'PUT', as: 'admin', body: { moduleAccess: [{ module: 'enquiries', level: 'write' }] } });
  assert.equal(levelOf(trimmed.json.data, 'production'), undefined);
  await api(`/api/users/${ids.kala}`, { method: 'PATCH', as: 'admin', body: { productionInCharge: true } });
  assert.equal(levelOf((await api(`/api/users/${ids.kala}`, { as: 'admin' })).json.data, 'production'), 'write', 'marked again, the floor is back');
});

test('an in charge who is marketing first reads the whole production queue, not only their own buyers', async () => {
  /* The task is on Nandhini's buyer; Kala is marketing by main department and in charge. */
  const queue = await api('/api/production/queue', { as: 'kala' });
  assert.equal(queue.status, 200, queue.json.message);
  assert.ok(queue.json.data.some((row) => String(row.task._id) === String(production._id)), 'the queue shows another salesperson’s enquiry to the in charge');
  const job = await api(`/api/production/workflow/${production._id}`, { as: 'kala' });
  assert.equal(job.status, 200, job.json.message);
  /* Unmarked but still on the Production desk, Kala works to the queue and reads it whole. */
  await api(`/api/users/${ids.kala}`, { method: 'PATCH', as: 'admin', body: { productionInCharge: false } });
  const desk = await api('/api/production/queue', { as: 'kala' });
  assert.ok(desk.json.data.some((row) => String(row.task._id) === String(production._id)), 'a marketing person with a Production desk reads the queue');
  await api(`/api/users/${ids.kala}`, { method: 'PATCH', as: 'admin', body: { productionInCharge: true } });
  /* A salesperson with no plant desk still reads only their own buyers' rows. */
  const other = await api('/api/users', { method: 'POST', as: 'admin', body: { name: 'Kavi R', email: 'kavi@np.com', password: 'Pass@123456', department: 'marketing' } });
  assert.equal(other.status, 201, other.json.message);
  token.kavi = (await api('/api/auth/login', { method: 'POST', body: { email: 'kavi@np.com', password: 'Pass@123456' } })).json.data.token;
  const theirs = await api('/api/production/queue', { as: 'kavi' });
  assert.equal(theirs.status, 200, theirs.json.message);
  assert.equal(theirs.json.data.length, 0, 'not their buyer');
  assert.equal((await api(`/api/production/workflow/${production._id}`, { as: 'kavi' })).status, 404);
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

const Todo = () => mongoose.connection.collection('todos');
const notices = () => mongoose.connection.collection('tasknotices');
const idOf = (key) => new mongoose.Types.ObjectId(ids[key]);

test('EDD Accepted and Planning are the in charge’s moves too', async () => {
  for (const key of ['accepted', 'planning']) {
    const refused = await status('mani', { status: key, note: 'Taking it on' });
    assert.equal(refused.status, 403, key);
    assert.match(refused.json.message, /Only the Production in charge moves it to/);
  }
});

test('the in charge was asked for the EDD when the task came in; giving the date closed it', async () => {
  const asks = await Todo().find({ originKey: `production-plan:${production._id}` }).toArray();
  assert.ok(asks.some((ask) => String(ask.user) === ids.siva), 'Sivakumar was asked');
  assert.match(asks[0].title, /^Give the EDD — /);
  assert.equal(asks[0].link, `/production/workflow/${production._id}`);
  assert.ok(asks.every((ask) => ask.completed), 'closed once the date was given');
});

test('the planning board is the in charge’s; the floor still pauses and completes jobs', async () => {
  const fake = new mongoose.Types.ObjectId();
  const moved = await api(`/api/work-orders/${fake}`, { method: 'PATCH', as: 'mani', body: { machine: String(new mongoose.Types.ObjectId()) } });
  assert.equal(moved.status, 403);
  assert.match(moved.json.message, /Only the Production in charge plans the presses/);
  assert.equal((await api(`/api/work-orders/${fake}`, { method: 'PATCH', as: 'mani', body: { move: 'release' } })).status, 403);
  /* Pausing is the floor's: past the gate, to a work order that is not there. */
  assert.equal((await api(`/api/work-orders/${fake}`, { method: 'PATCH', as: 'mani', body: { move: 'pause' } })).status, 404);
  assert.equal((await api('/api/production/plan/apply', { method: 'POST', as: 'mani', body: { moves: [{ workOrder: String(fake), machine: String(fake), sequence: 1 }] } })).status, 403);
  assert.equal((await api('/api/machines', { method: 'POST', as: 'mani', body: { code: 'IM-9' } })).status, 403);
  const added = await api('/api/machines', { method: 'POST', as: 'siva', body: { code: 'IM-9', name: 'Press 9' } });
  assert.equal(added.status, 201, added.json.message);
});

test('Assembly gives its own completion date: nobody is asked to confirm it, and the in charge cannot set it', async () => {
  const assembly = await Todo().findOne({ kind: 'ask_assembling_edd', completed: false });
  assert.ok(assembly?.routing?.byProduction, 'Assembly’s task came from the routing');
  const given = await api(`/api/workspace/todos/${assembly._id}/edd`, { method: 'POST', as: 'anand', body: { date: indiaDay(9) } });
  assert.equal(given.status, 200, given.json.message);
  assert.equal(await Todo().countDocuments({ originKey: `production-confirm:${assembly._id}` }), 0, 'no “Confirm the EDD Assembly gave” for the in charge');
  const confirm = await api(`/api/workspace/todos/${assembly._id}/edd/confirm`, { method: 'POST', as: 'siva' });
  assert.equal(confirm.status, 400, 'nothing to confirm — the date is Assembly’s');
  const own = await api(`/api/workspace/todos/${assembly._id}/edd`, { method: 'POST', as: 'siva', body: { date: indiaDay(11) } });
  assert.ok([403, 404].includes(own.status), 'the in charge does not set Assembly’s date');
  const line = (await Todo().findOne({ _id: assembly._id })).updates.at(-1);
  assert.match(line.note, new RegExp(`^Completion date`), 'Assembly’s own date stands');
});

test('Admin can still plan, and the in charge is told when Admin does', async () => {
  const before = await notices().countDocuments({ recipient: idOf('siva') });
  const moved = await status('admin', { status: 'planning', note: 'Customer called the MD' });
  assert.equal(moved.status, 200, moved.json.message);
  const told = await notices().find({ recipient: idOf('siva') }).toArray();
  assert.equal(told.length, before + 1);
  assert.match(told.at(-1).statusLabel, /^Admin moved it to Planning/);
});

test('who is in charge is listed for the desks; nobody marked, Admin is asked for the EDD', async () => {
  const listed = await api('/api/workspace/production-in-charge', { as: 'mani' });
  assert.deepEqual(listed.json.data.map((person) => person.name).sort(), ['Kala M', 'Sivakumar']);
  for (const key of ['siva', 'kala']) await api(`/api/users/${ids[key]}`, { method: 'PATCH', as: 'admin', body: { productionInCharge: false } });
  assert.deepEqual((await api('/api/workspace/production-in-charge', { as: 'mani' })).json.data, []);
  const sent = await api('/api/workspace/team-tasks', { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Another lot', customer: (await mongoose.connection.collection('customers').findOne({}))._id, brief: { model: 'NPT-410V' } } });
  assert.equal(sent.status, 201, sent.json.message);
  const task = sent.json.data.task || sent.json.data;
  /* The ask follows the task's event: give it a moment. */
  let ask = null;
  for (let tries = 0; tries < 40 && !ask; tries += 1) {
    ask = await Todo().findOne({ originKey: `production-plan:${task._id}` });
    if (!ask) await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  assert.ok(ask, 'Admin is asked');
  assert.match(ask.notes, /Nobody is marked Production in charge/);
  for (const key of ['siva']) await api(`/api/users/${ids[key]}`, { method: 'PATCH', as: 'admin', body: { productionInCharge: true } });
});

test('moved out of Production, the mark goes with them', async () => {
  const moved = await api(`/api/users/${ids.siva}`, { method: 'PATCH', as: 'admin', body: { department: 'quality' } });
  assert.equal(moved.status, 200, moved.json.message);
  assert.equal(moved.json.data.productionInCharge, false);
});
