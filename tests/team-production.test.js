/**
 * A Production task Admin or marketing raised with only the buyer's name [teamProduction.service]:
 * the Production in charge links it to the buyer's enquiry, or starts each model from where the
 * goods are — not started, started, with Printing or Assembly since a date, with Dispatch, or
 * already dispatched — and the job follows from there.
 *
 *   node --test tests/team-production.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { dispatchLoad } from './support/dispatchLoad.mjs';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'team-production-test-secret';

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
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['siva', 'Sivakumar', 'production'], ['pandi', 'Pandi Print', 'printing'], ['anand', 'Anand Assembly', 'assembling'], ['ravi', 'Ravi Despatch', 'despatch']]) {
    const made = await raw('/api/users', { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: department === 'production' }, token.admin);
    assert.ok(made.data, made.message);
    token[key] = (await raw('/api/auth/login', { email: `${key}@np.com`, password: 'Pass@123456' })).data.token;
  }
  const me = (await api('/api/auth/me')).json.data.id;
  customerId = (await api('/api/customers', { method: 'POST', body: { name: 'Status Ask Garments', mobile: '9840099071', assignedTo: me } })).json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});


/* Admin asks Production for the status of the buyer's order — nothing else known. Production fills what the order is. */
async function statusAsk(items) {
  const sent = await api('/api/workspace/team-tasks', { method: 'POST', as: 'admin', body: { kind: 'ask_edd', note: 'What is the status of their order?', customer: customerId, edd: new Date(Date.now() + 15 * 864e5).toISOString().slice(0, 10) } });
  assert.equal(sent.status, 201, sent.json.message);
  const task = sent.json.data.task || sent.json.data;
  assert.equal((await api(`/api/workspace/todos/${task._id}/brief`, { method: 'POST', as: 'siva', body: { brief: { model: items[0][0], material: 'PP Black', quantity: String(items[0][1]) } } })).status, 200);
  return { ...task, items };
}
/* The in charge names every model with its pieces as he reads the order, and says where each is. */
const startFrom = (task, models, as = 'siva') => api(`/api/workspace/todos/${task._id}/start-from`, {
  method: 'POST', as,
  body: { models: (task.items || []).map(([model, quantity]) => ({ model, quantity, ...(models.find((row) => row.model === model) || {}) })) },
});
const yesterday = new Date(Date.now() - 864e5 + 330 * 60 * 1000).toISOString().slice(0, 10);

test('the in charge says where each model is: one with Printing since yesterday, one with Assembly, one already dispatched, one not started', async () => {
  const task = await statusAsk([['TP-1', 5000], ['TP-2', 4000], ['TP-3', 3000], ['TP-4', 2000]]);
  /* Refusals before anything moves. */
  assert.equal((await startFrom(task, [{ model: 'TP-1', at: 'handed_printing' }])).status, 400, 'Printing must be ticked');
  const noDate = await startFrom(task, [{ model: 'TP-1', at: 'handed_printing', printing: true }]);
  assert.match(noDate.json.message, /Give the date TP-1 was handed over/);
  assert.equal((await startFrom(task, [{ model: 'TP-3', at: 'dispatched', date: yesterday }])).status, 400, 'pieces needed');
  assert.equal((await startFrom(task, [{ model: 'TP-1', at: 'handed_printing', printing: true, date: yesterday }], 'pandi')).status, 403, 'the in charge’s call');

  const started = await startFrom(task, [
    { model: 'TP-1', at: 'handed_printing', printing: true, assembly: true, date: yesterday },
    { model: 'TP-2', at: 'handed_assembly', printing: true, assembly: true, date: yesterday },
    { model: 'TP-3', at: 'dispatched', date: yesterday, pieces: 3000 },
    { model: 'TP-4', at: 'not_started' },
  ]);
  assert.equal(started.status, 200, started.json.message);
  const fresh = await Todo.findById(task._id).lean();
  const statusOf = (model) => (fresh.modelStatuses || []).find((row) => row.model === model)?.status;
  assert.deepEqual(['TP-1', 'TP-2', 'TP-3'].map(statusOf), ['handed_printing', 'handed_assembly', 'ready_dispatch']);
  /* Routing: what each model has passed through is done. */
  assert.deepEqual(fresh.routing.models.map((row) => [row.model, row.printing, row.assembly]), [['TP-1', true, true], ['TP-2', false, true], ['TP-3', false, false], ['TP-4', false, false]]);
  /* Printing has TP-1, Assembly has TP-2 (and TP-1 to come). */
  const printing = await Todo.findOne({ chain: task._id, kind: 'ask_printing' }).lean();
  const assembly = await Todo.findOne({ chain: task._id, kind: 'ask_assembling_edd' }).lean();
  assert.deepEqual(printing.routing.models, ['TP-1']);
  assert.deepEqual([...assembly.routing.models].sort(), ['TP-1', 'TP-2']);
  assert.match(JSON.stringify(fresh.updates), /Already handed to Printing on/);
  /* TP-3 is on record as gone — and no Dispatch request is waiting to send it again. */
  const past = await Todo.findOne({ chain: task._id, kind: 'invoice_dispatch', completed: true }).lean();
  assert.deepEqual(past.loads[0].lines, [{ model: 'TP-3', quantity: 3000 }]);
  assert.equal(await Todo.exists({ chain: task._id, kind: 'invoice_dispatch', completed: false }), null, 'nothing to send yet — the rest are not made');
  const { modelJourneys } = await import('../src/services/handoff.service.js');
  const journeys = await modelJourneys(null, { task: fresh });
  const dispatchOf = (model) => journeys.find((row) => row.model === model).steps.find((step) => step.team === 'dispatch');
  assert.equal(dispatchOf('TP-3').state, 'done', 'TP-3 reads sent');
});

test('everything already with Dispatch: the Dispatch request is raised; everything already gone: none is', async () => {
  const ready = await statusAsk([['TR-1', 1000]]);
  const moved = await startFrom(ready, [{ model: 'TR-1', at: 'ready_dispatch' }]);
  assert.equal(moved.status, 200, moved.json.message);
  await settle();
  assert.ok(await Todo.exists({ chain: ready._id, kind: 'invoice_dispatch', completed: false }), 'Dispatch has the request');

  const gone = await statusAsk([['TG-1', 1000]]);
  const said = await startFrom(gone, [{ model: 'TG-1', at: 'dispatched', date: yesterday, pieces: 1000 }]);
  assert.equal(said.status, 200, said.json.message);
  await settle();
  assert.equal(await Todo.exists({ chain: gone._id, kind: 'invoice_dispatch', completed: false }), null, 'nothing to send again');
});

test('linked to the buyer’s enquiry: the task follows that enquiry; an enquiry already in production takes the ask instead', async () => {
  const enquiry = (await api('/api/enquiries', { method: 'POST', body: { customer: customerId, items: [{ modelNumber: 'TL-1' }], nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 864e5).toISOString() } })).json.data;
  const task = await statusAsk([['TL-1', 6000]]);
  const options = (await api(`/api/workspace/todos/${task._id}/link-options`, { as: 'siva' })).json.data;
  assert.ok(options.enquiries.some((row) => row.number === enquiry.number && !row.inProduction));
  assert.deepEqual(options.startPoints.map((row) => row.key), ['not_started', 'started', 'handed_printing', 'handed_assembly', 'ready_dispatch', 'dispatched']);
  const linked = await api(`/api/workspace/todos/${task._id}/link-enquiry`, { method: 'POST', as: 'siva', body: { enquiry: enquiry._id } });
  assert.equal(linked.status, 200, JSON.stringify(linked.json.message));
  assert.equal(String(linked.json.data.enquiry?._id || linked.json.data.enquiry), String(enquiry._id));
  assert.equal(linked.json.mergedInto, null);

  /* A second ask for the same buyer: the enquiry already has Production's task — this one closes onto it. */
  const again = await statusAsk([['TL-1', 6000]]);
  const merged = await api(`/api/workspace/todos/${again._id}/link-enquiry`, { method: 'POST', as: 'siva', body: { enquiry: enquiry._id } });
  assert.equal(merged.status, 200, merged.json.message);
  assert.equal(String(merged.json.mergedInto._id), String(task._id));
  assert.equal((await Todo.findById(again._id).lean()).completed, true);

  /* Another buyer's enquiry is refused. */
  const me = (await api('/api/auth/me')).json.data.id;
  const madeOther = await api('/api/customers', { method: 'POST', body: { name: 'Other Buyer Knits', mobile: '9840099072', assignedTo: me } });
  assert.equal(madeOther.status, 201, madeOther.json.message);
  const other = madeOther.json.data._id;
  const theirs = (await api('/api/enquiries', { method: 'POST', body: { customer: other, items: [{ modelNumber: 'TL-9' }], nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 864e5).toISOString() } })).json.data;
  const third = await statusAsk([['TL-2', 100]]);
  assert.equal((await api(`/api/workspace/todos/${third._id}/link-enquiry`, { method: 'POST', as: 'siva', body: { enquiry: theirs._id } })).status, 400);
});
