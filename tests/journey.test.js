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
import { dispatchLoad } from './support/dispatchLoad.mjs';
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
/* A load goes through the dispatch form, with its LR copy [support/dispatchLoad.mjs]. */
const move = (task, as, status, note = 'Moving it on') => (['part_dispatched', 'fully_dispatched', 'dispatched'].includes(status)
  ? dispatchLoad({ baseUrl, token: token[as], taskId: task, status, note })
  : api(`/api/workspace/todos/${task}/status`, { method: 'POST', as, body: { status, note } }));
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
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: department === 'production' } });
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

test('QC compulsory: Production done → QC is asked; QC done → Dispatch is asked; the journey shows each step', async () => {
  const enquiry = await freshEnquiry();
  const production = (await send(enquiry, 'ask_edd', { brief: { qcRequired: true } })).json.data.task;
  assert.equal((await Enquiry.findById(enquiry)).qcRequired, true, 'the tick is kept on the enquiry');
  const closed = await move(production._id, 'siva', 'closed', 'All 10,000 made');
  assert.equal(closed.status, 200, closed.json.message);
  const quality = await open(enquiry, 'quality_check');
  assert.ok(quality, 'Quality has its task');
  assert.equal(quality.department, 'quality');
  assert.equal(await open(enquiry, 'invoice_dispatch'), null, 'Dispatch waits for Quality');

  const checked = await move(quality._id, 'kavitha', 'passed', 'Passed — 80 checked, none rejected');
  assert.equal(checked.status, 200, checked.json.message);
  const dispatch = await open(enquiry, 'invoice_dispatch');
  assert.ok(dispatch, 'Dispatch has its task');
  assert.match(dispatch.notes || dispatch.updates?.[0]?.note || '', /Quality passed/);
  assert.equal((await Enquiry.findById(enquiry)).stage, 'invoice_dispatch');

  const { journey } = (await api(`/api/enquiries/${enquiry}/handoffs`)).json;
  assert.equal(journey.kind, 'production');
  assert.deepEqual(journey.steps.map((step) => [step.key, step.state]), [
    ['production', 'done'], ['quality', 'done'], ['dispatch', 'open'], ['lr', 'todo'],
  ]);
});

test('with Printing asked, Quality waits until Printing has its share ready too', async () => {
  const enquiry = await freshEnquiry();
  const production = (await send(enquiry, 'ask_edd', { brief: { qcRequired: true } })).json.data.task;
  const printing = (await send(enquiry, 'ask_printing', { brief: { model: 'NH-400' } })).json.data.task;
  assert.equal((await move(production._id, 'siva', 'ready_dispatch', 'Moulded, with Printing')).status, 200);
  assert.equal(await open(enquiry, 'quality_check'), null, 'Printing is still at it');
  assert.equal((await move(printing._id, 'pandi', 'ready_dispatch', 'Printed')).status, 200);
  assert.ok(await open(enquiry, 'quality_check'), 'the last finishing team ready: Quality is asked');
  /* Closing Production afterwards does not ask Quality twice. */
  await move(production._id, 'siva', 'closed', 'Done');
  assert.equal(await Todo.countDocuments({ enquiry, kind: 'quality_check' }), 1);
});

test('a run for an enquiry makes one of its models, and plans at most 10% over the pieces ordered', async () => {
  const mine = (await api('/api/moulds', { method: 'POST', as: 'siva', body: { mouldCode: 'M-Q1', name: 'Quota hanger', cavities: 4, partWeightGrams: 30, runnerWeightGrams: 12, cycleTimeSeconds: 30 } })).json.data;
  const other = (await api('/api/moulds', { method: 'POST', as: 'siva', body: { mouldCode: 'M-Q2', name: 'Other hanger', cavities: 4, partWeightGrams: 30, runnerWeightGrams: 12, cycleTimeSeconds: 30 } })).json.data;
  const machine = (await api('/api/machines', { method: 'POST', as: 'siva', body: { code: 'IM-Q1', name: 'Toshiba 150T', tonnage: 150 } })).json.data;
  const made = await api('/api/enquiries', {
    method: 'POST',
    body: { customer: customerId, items: [{ mould: mine._id, modelNumber: 'M-Q1', colour: 'Black' }], nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  });
  assert.equal(made.status, 201, made.json.message);
  const enquiry = made.json.data._id;
  /* The pieces ordered, as an SO request's rows would give them (the enquiry form takes none). */
  await mongoose.connection.collection('enquiries').updateOne({ _id: new mongoose.Types.ObjectId(enquiry) }, { $set: { 'items.0.quantity': 1000 } });
  /* The form's list: only the enquiry's models, with the most a run may plan. */
  const models = (await api(`/api/mould-runs/models?enquiry=${enquiry}`, { as: 'siva' })).json.data;
  assert.deepEqual(models.map((row) => [row.mould?.mouldCode, row.quantity, row.most]), [['M-Q1', 1000, 1100]]);
  const wrong = await api('/api/mould-runs', { method: 'POST', as: 'siva', body: { mould: other._id, machine: machine._id, enquiry, plannedQuantity: 500 } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.message, /M-Q2 is not one of this enquiry’s models — pick M-Q1/);
  const over = await api('/api/mould-runs', { method: 'POST', as: 'siva', body: { mould: mine._id, machine: machine._id, enquiry, plannedQuantity: 1101 } });
  assert.equal(over.status, 400);
  assert.match(over.json.message, /more than 10% over the 1,000 ordered of M-Q1 — plan 1,100 at most/);
  const fits = await api('/api/mould-runs', { method: 'POST', as: 'siva', body: { mould: mine._id, machine: machine._id, enquiry, plannedQuantity: 1100 } });
  assert.equal(fits.status, 201, fits.json.message);
  await api(`/api/mould-runs/${fits.json.data._id}/finish`, { method: 'POST', as: 'siva', body: { counterEnd: 300, goodPieces: 1100, rejectedPieces: 0 } });
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

test('a team task with no enquiry follows the same chain for the same buyer — Quality first only when QC was ticked', async () => {
  const team = await api('/api/workspace/team-tasks', { method: 'POST', body: { kind: 'ask_edd', note: 'Walk-in buyer, 2,000 pcs', customer: customerId, brief: { model: 'NH-400', quantity: '2000', qcRequired: true } } });
  assert.equal(team.status, 201, team.json.message);
  const closedTeam = await move(team.json.data.task._id, 'siva', 'closed', 'Made');
  assert.equal(closedTeam.status, 200, closedTeam.json.message);
  const quality = await Todo.findOne({ previousTask: team.json.data.task._id, kind: 'quality_check' });
  assert.ok(quality, 'Quality has the next team task');
  assert.equal(quality.brief.quantity, '2000');
  assert.equal(String(quality.customer), customerId);
  assert.equal(await Todo.findOne({ previousTask: team.json.data.task._id, kind: 'invoice_dispatch' }), null, 'Dispatch waits for Quality’s pass');
  assert.equal((await move(quality._id, 'kavitha', 'passed', 'Passed')).status, 200);
  assert.equal(await Todo.countDocuments({ chain: team.json.data.task._id, kind: 'invoice_dispatch' }), 1, 'Quality passing asks Dispatch, once');

  /* Not ticked: the goods go straight to Dispatch; Quality is not asked. */
  const plain = await api('/api/workspace/team-tasks', { method: 'POST', body: { kind: 'ask_edd', note: 'Repeat, 1,000 pcs', customer: customerId, brief: { model: 'NH-400', quantity: '1000' } } });
  assert.equal((await move(plain.json.data.task._id, 'siva', 'closed', 'Made')).status, 200);
  assert.ok(await Todo.findOne({ previousTask: plain.json.data.task._id, kind: 'invoice_dispatch' }), 'Dispatch asked straight away');
  assert.equal(await Todo.findOne({ previousTask: plain.json.data.task._id, kind: 'quality_check' }), null, 'no QC asked');
});

test('QC not ticked: Production done → Dispatch is asked straight away, no Quality step', async () => {
  const enquiry = await freshEnquiry();
  const production = (await send(enquiry, 'ask_edd')).json.data.task;
  assert.equal((await Enquiry.findById(enquiry)).qcRequired, false);
  assert.equal((await move(production._id, 'siva', 'closed', 'All made')).status, 200);
  assert.equal(await open(enquiry, 'quality_check'), null, 'Quality is not asked');
  const dispatch = await open(enquiry, 'invoice_dispatch');
  assert.ok(dispatch, 'Dispatch has its task');
  const { journey } = (await api(`/api/enquiries/${enquiry}/handoffs`)).json;
  assert.deepEqual(journey.steps.map((step) => [step.key, step.state]).filter(([key]) => key !== 'quality'), [
    ['production', 'done'], ['dispatch', 'open'], ['lr', 'todo'],
  ]);
});

test('QC compulsory with Dispatch asked early: the request waits at Received, Dispatched is refused, Quality’s pass frees it', async () => {
  const enquiry = await freshEnquiry();
  const production = (await send(enquiry, 'ask_edd', { brief: { qcRequired: true } })).json.data.task;
  /* Marketing asks Dispatch before the goods are made, as it often does. */
  const early = await send(enquiry, 'invoice_dispatch', { brief: { quantity: '2000' } });
  assert.equal(early.status, 201, early.json.message);
  const request = early.json.data.task;
  assert.equal((await move(production._id, 'siva', 'ready_dispatch', 'Moulded and packed')).status, 200);
  const held = await Todo.findById(request._id);
  assert.notEqual(held.status, 'waiting_vehicle', 'not Goods Ready while QC is compulsory and not passed');
  assert.match(held.updates.at(-1).note, /QC compulsory: waits for Quality/);
  const refused = await move(request._id, 'anita', 'dispatched', 'Vehicle loaded');
  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /QC is compulsory on this order/);
  const readyRefused = await move(request._id, 'anita', 'waiting_vehicle', 'Packed');
  assert.equal(readyRefused.status, 400);
  const quality = await open(enquiry, 'quality_check');
  assert.ok(quality, 'Quality was asked');
  assert.equal((await move(quality._id, 'kavitha', 'passed', 'Passed — 80 checked')).status, 200);
  const freed = await Todo.findById(request._id);
  assert.equal(freed.status, 'waiting_vehicle', 'Quality’s pass reads Goods Ready on the request');
  const went = await move(request._id, 'anita', 'dispatched', 'Vehicle loaded');
  assert.equal(went.status, 200, went.json.message);
});

test('a Production task raised from the customer, with no enquiry, runs Printing → Assembly → Dispatch → LR copy', async () => {
  const raised = await api('/api/workspace/team-tasks', { method: 'POST', body: { kind: 'ask_edd', note: 'Status of the 5,000 NH-410 for Sunrise', customer: customerId, brief: { model: 'NH-410', quantity: '5000' } } });
  assert.equal(raised.status, 201, raised.json.message);
  const production = raised.json.data.task._id;
  const chainOf = async (kind) => Todo.findOne({ chain: production, kind });

  /* Production plans it: printed, then assembled. Giving a date before deciding is refused, as on an enquiry. */
  const early = await api(`/api/workspace/todos/${production}/edd`, { method: 'POST', as: 'siva', body: { date: new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10) } });
  assert.equal(early.status, 400);
  assert.match(early.json.message, /Decide first/);
  const models = (await api(`/api/workspace/todos/${production}/routing`, { as: 'siva' })).json.data.models;
  assert.deepEqual(models.map((row) => row.model), ['NH-410'], 'the model the task names');
  const added = await api(`/api/workspace/todos/${production}/production-queue`, {
    method: 'POST', as: 'siva', body: { models: [{ model: 'NH-410', printing: true, assembly: true }], date: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10), note: 'Press 2 tomorrow' },
  });
  assert.equal(added.status, 200, added.json.message);
  const printing = await chainOf('ask_printing');
  const assembly = await chainOf('ask_assembling_edd');
  /* It stands in the production queue as its own job while Production has it. */
  const queue = (await api('/api/production/queue', { as: 'siva' })).json;
  const row = queue.data.find((entry) => String(entry.task._id) === String(production));
  assert.ok(row, 'the team task is on the production queue');
  assert.equal(row.enquiry.team, true);
  assert.equal(row.enquiry.customer._id, customerId);
  assert.equal(row.production.taken, true, 'added to the queue');
  assert.ok(printing && assembly, 'Printing and Assembly are tasked on the same job');
  assert.equal(String(printing.customer), customerId);
  assert.equal(printing.enquiry, undefined);
  assert.ok(printing.routing.incoming.production, 'Printing knows when Production hands over');
  assert.deepEqual(printing.routing.handsTo, ['assembling']);

  /* The goods move team to team; nothing goes to Dispatch until the last team is ready. */
  assert.equal((await move(production, 'siva', 'started', 'On press 2')).status, 200);
  const doneAsks = () => Todo.countDocuments({ title: /^Done: / });
  const asksBefore = await doneAsks();
  assert.equal((await move(production, 'siva', 'handed_printing', 'Moulded — to the print line')).status, 200);
  const handed = await Todo.findById(production);
  assert.equal(handed.completed, true, 'Production’s task ends when the goods go to Printing');
  assert.equal(handed.status, 'handed_printing', 'and reads Handed to Printing, not Task Closed');
  assert.equal(await doneAsks(), asksBefore, 'no "next step?" to marketing — the job goes on with Printing');
  assert.ok((await Todo.findById(printing._id)).routing.received.production, 'Printing hears the goods came');
  assert.equal(await chainOf('invoice_dispatch'), null, 'not yet: Printing and Assembly are still at it');
  assert.equal((await move(printing._id, 'pandi', 'started', 'Printing')).status, 200);
  assert.equal((await move(printing._id, 'pandi', 'handed_assembly', 'Printed — to assembly')).status, 200);
  assert.equal((await Todo.findById(printing._id)).completed, true, 'Printing’s task ends when the goods go to Assembly');
  assert.ok((await Todo.findById(assembly._id)).routing.received.printing, 'Assembly hears the goods came from Printing');
  assert.equal(await chainOf('invoice_dispatch'), null);
  const assemblyEdd = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);
  const given = await api(`/api/workspace/todos/${assembly._id}/edd`, { method: 'POST', as: 'admin', body: { date: assemblyEdd, note: 'Packed by then' } });
  assert.equal(given.status, 200, given.json.message);
  assert.equal((await move(assembly._id, 'admin', 'ready_dispatch', 'Assembled and packed')).status, 200);

  const dispatch = await chainOf('invoice_dispatch');
  assert.ok(dispatch, 'the last team ready: Dispatch is asked');
  assert.equal(await chainOf('quality_check'), null, 'QC was not ticked on the job: Quality is not asked');
  assert.equal(String(dispatch.customer), customerId);
  assert.equal(dispatch.brief.quantity, '5000');
  assert.equal((await move(dispatch._id, 'anita', 'dispatched', 'Left on TN 39 AB 4471')).status, 200);
  const lr = await chainOf('lr_copy');
  assert.ok(lr, 'Dispatched gives Reception the LR copy');
  assert.equal(lr.brief.quantity, '5000');

  /* Handed on, Production's task left the queue; its workflow page still shows the chain's teams. */
  const after = (await api('/api/production/queue', { as: 'siva' })).json;
  assert.equal(after.data.some((entry) => String(entry.task._id) === String(production)), false, 'off the queue once handed on');
  const flow = await api(`/api/production/workflow/${production}`, { as: 'siva' });
  assert.equal(flow.status, 200, flow.json.message);
  assert.equal(flow.json.data.enquiry.team, true);
  assert.deepEqual(Object.keys(flow.json.data.teams).sort(), ['assembling', 'despatch', 'printing'], 'QC not ticked: no Quality step on the chain');
  assert.deepEqual(flow.json.data.specs, []);
  /* The model table says each team's date: Production's hand-over to Printing, Assembly's EDD — the job's EDD. */
  const [line] = flow.json.data.models;
  assert.equal(line.production.label, 'Handed to Printing', 'closed at the hand-over, and says so');
  assert.equal(line.production.given.label, 'Hand-over');
  assert.equal(line.production.given.date, new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10));
  assert.deepEqual(line.assemblyStatus.given, { date: assemblyEdd, label: 'EDD' });
  assert.equal(line.edd, assemblyEdd);
});

test('a Production, Printing or Assembly task raised from the customer names its model', async () => {
  const bare = await api('/api/workspace/team-tasks', { method: 'POST', body: { kind: 'ask_edd', note: 'Status of the order', customer: customerId, brief: { quantity: '5000' } } });
  assert.equal(bare.status, 400);
  assert.match(bare.json.message, /Name the model/);
});

test('Assembly asked alone goes Assembly → Dispatch; Printing asked alone goes Printing → Dispatch', async () => {
  for (const [kind, who] of [['ask_assembling_edd', 'admin'], ['ask_printing', 'pandi']]) {
    const raised = await api('/api/workspace/team-tasks', { method: 'POST', body: { kind, note: 'Buyer sent their own hangers', customer: customerId, brief: { model: 'NH-400', quantity: '1200' } } });
    assert.equal(raised.status, 201, raised.json.message);
    const task = raised.json.data.task._id;
    assert.equal((await move(task, who, 'started', 'On it')).status, 200);
    assert.equal(await Todo.findOne({ chain: task, kind: 'invoice_dispatch' }), null);
    assert.equal((await move(task, who, 'ready_dispatch', 'Packed and ready')).status, 200);
    const dispatch = await Todo.findOne({ chain: task, kind: 'invoice_dispatch' });
    assert.ok(dispatch, `${kind}: Dispatch is asked once it is ready`);
    assert.equal(dispatch.brief.model, 'NH-400');
  }
});
