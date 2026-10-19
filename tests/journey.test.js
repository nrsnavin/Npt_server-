/**
 * The order's journey, linked [services/journey.service.js]: a sample or a quotation ends there;
 * from Production the chain runs Printing / Assembly → QC → Dispatch on its own, waiting for the
 * last finishing team; a team task with no enquiry follows the same chain. And the floor's mould
 * runs show on the enquiry, its Production task, the production queue and the machines.
 *
 *   node --test tests/journey.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'journey-test-secret';

let mongo;
let server;
let baseUrl;
let Todo;
let Enquiry;
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
const send = (enquiry, kind, extra = {}) => api(`/api/enquiries/${enquiry}/handoffs`, { method: 'POST', body: { kind, note: `${kind} please`, ...extra } });
const move = (task, as, status, note = 'Moving it on') => api(`/api/workspace/todos/${task}/status`, { method: 'POST', as, body: { status, note } });
const open = (enquiry, kind) => Todo.findOne({ enquiry, kind, completed: false });

async function freshEnquiry() {
  const made = await api('/api/enquiries', {
    method: 'POST',
    body: { customer: customerId, requirement: { modelNumber: 'NH-400', colour: 'Black' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  });
  assert.equal(made.status, 201, made.json.message);
  return made.json.data._id;
}

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  ({ default: Enquiry } = await import('../src/models/Enquiry.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['siva', 'Sivakumar', 'production'], ['pandi', 'Pandi Print', 'printing'], ['kavitha', 'Kavitha QC', 'quality'], ['anita', 'Anita Despatch', 'despatch'], ['selvi', 'Selvi Sampling', 'sampling']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const me = (await api('/api/auth/me')).json.data.id;
  customerId = (await api('/api/customers', { method: 'POST', body: { name: 'Journey Knits', mobile: '9840099001', assignedTo: me } })).json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('a sample request ends at the sample — nothing further is raised', async () => {
  const enquiry = await freshEnquiry();
  const sample = await send(enquiry, 'sample_request', { brief: { items: [{ model: 'NH-400', quantity: '3' }] } });
  assert.equal(sample.status, 201, sample.json.message);
  const journey = (await api(`/api/enquiries/${enquiry}/handoffs`)).json.journey;
  assert.deepEqual([journey.kind, journey.steps.map((step) => step.key)], ['sample', ['sample']]);
  assert.equal(await Todo.countDocuments({ enquiry, kind: { $in: ['ask_edd', 'quality_check', 'invoice_dispatch'] } }), 0);
});

test('Production done → QC is asked; QC done → Dispatch is asked; the journey shows each step', async () => {
  const enquiry = await freshEnquiry();
  const production = (await send(enquiry, 'ask_edd')).json.data.task;
  const closed = await move(production._id, 'siva', 'closed', 'All 10,000 made');
  assert.equal(closed.status, 200, closed.json.message);
  const quality = await open(enquiry, 'quality_check');
  assert.ok(quality, 'Quality has its task');
  assert.equal(quality.department, 'quality');
  assert.equal(await open(enquiry, 'invoice_dispatch'), null, 'Dispatch waits for Quality');

  const checked = await move(quality._id, 'kavitha', 'closed', 'Passed — 80 checked, none rejected');
  assert.equal(checked.status, 200, checked.json.message);
  const dispatch = await open(enquiry, 'invoice_dispatch');
  assert.ok(dispatch, 'Dispatch has its task');
  assert.match(dispatch.notes || dispatch.updates?.[0]?.note || '', /Quality checked/);
  assert.equal((await Enquiry.findById(enquiry)).stage, 'invoice_dispatch');

  const { journey } = (await api(`/api/enquiries/${enquiry}/handoffs`)).json;
  assert.equal(journey.kind, 'production');
  assert.deepEqual(journey.steps.map((step) => [step.key, step.state]), [
    ['production', 'done'], ['quality', 'done'], ['dispatch', 'open'], ['lr', 'todo'],
  ]);
});

test('with Printing asked, Quality waits until Printing has its share ready too', async () => {
  const enquiry = await freshEnquiry();
  const production = (await send(enquiry, 'ask_edd')).json.data.task;
  const printing = (await send(enquiry, 'ask_printing', { brief: { model: 'NH-400' } })).json.data.task;
  assert.equal((await move(production._id, 'siva', 'ready_dispatch', 'Moulded, with Printing')).status, 200);
  assert.equal(await open(enquiry, 'quality_check'), null, 'Printing is still at it');
  assert.equal((await move(printing._id, 'pandi', 'ready_dispatch', 'Printed')).status, 200);
  assert.ok(await open(enquiry, 'quality_check'), 'the last finishing team ready: Quality is asked');
  /* Closing Production afterwards does not ask Quality twice. */
  await move(production._id, 'siva', 'closed', 'Done');
  assert.equal(await Todo.countDocuments({ enquiry, kind: 'quality_check' }), 1);
});

test('a mould running for an enquiry shows on its Production task, the enquiry, the production queue and the machine', async () => {
  const enquiry = await freshEnquiry();
  const production = (await send(enquiry, 'ask_edd')).json.data.task;
  const mould = (await api('/api/moulds', { method: 'POST', as: 'siva', body: { mouldCode: 'M-J1', name: '400mm shirt hanger', cavities: 4, partWeightGrams: 30, runnerWeightGrams: 12, cycleTimeSeconds: 30 } })).json.data;
  const machine = (await api('/api/machines', { method: 'POST', as: 'siva', body: { code: 'IM-J1', name: 'Toshiba 150T', tonnage: 150 } })).json.data;
  const started = await api('/api/mould-runs', { method: 'POST', as: 'siva', body: { mould: mould._id, machine: machine._id, enquiry, plannedQuantity: 4000 } });
  assert.equal(started.status, 201, started.json.message);

  const task = await Todo.findById(production._id);
  assert.equal(task.status, 'started', 'Production Started, from the floor');
  assert.match(task.updates.at(-1).note, /moulding on IM-J1 — mould M-J1 · 4,000 pcs to make/);

  const { floor, journey } = (await api(`/api/enquiries/${enquiry}/handoffs`)).json;
  assert.equal(floor.running[0].machine.code, 'IM-J1');
  assert.equal(journey.steps.find((step) => step.key === 'production').live, 'IM-J1 · M-J1 running');

  const queue = (await api('/api/production/queue', { as: 'siva' })).json;
  const row = queue.data.find((entry) => entry.enquiry._id === enquiry);
  assert.equal(row.floor.running[0].machine, 'IM-J1');
  assert.ok(queue.meta.teams.moulding >= 1);

  const machines = (await api('/api/machines', { as: 'siva' })).json.data;
  const press = machines.find((entry) => entry.code === 'IM-J1');
  assert.equal(press.running.enquiry._id, enquiry, 'the press says whose job it is');

  const finished = await api(`/api/mould-runs/${started.json.data._id}/finish`, { method: 'POST', as: 'siva', body: { counterEnd: 1000, goodPieces: 3900, rejectedPieces: 100 } });
  assert.equal(finished.status, 200, finished.json.message);
  assert.match((await Todo.findById(production._id)).updates.at(-1).note, /finished — 3,900 good, 100 rejected/);
  const after = (await api(`/api/enquiries/${enquiry}/handoffs`)).json.floor;
  assert.deepEqual([after.running.length, after.made.good], [0, 3900]);
});

test('a team task with no enquiry follows the same chain for the same buyer', async () => {
  const team = await api('/api/workspace/team-tasks', { method: 'POST', body: { kind: 'ask_edd', note: 'Walk-in buyer, 2,000 pcs', customer: customerId, brief: { model: 'NH-400', quantity: '2000' } } });
  assert.equal(team.status, 201, team.json.message);
  const closedTeam = await move(team.json.data.task._id, 'siva', 'closed', 'Made');
  assert.equal(closedTeam.status, 200, closedTeam.json.message);
  const quality = await Todo.findOne({ previousTask: team.json.data.task._id, kind: 'quality_check' });
  assert.ok(quality, 'Quality has the next team task');
  assert.equal(quality.brief.quantity, '2000');
  assert.equal(String(quality.customer), customerId);
  assert.equal((await move(quality._id, 'kavitha', 'closed', 'Passed')).status, 200);
  assert.ok(await Todo.findOne({ previousTask: quality._id, kind: 'invoice_dispatch' }), 'then Dispatch');
});
