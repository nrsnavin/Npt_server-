/**
 * The EDD asked for wherever queue work starts without one [services/eddAsk.service.js]:
 *   - marketing gives it on the form of a Production / Printing / Assembly / Dispatch task, and
 *     it is the enquiry's — marketing's — before the task is raised
 *   - a task raised with none gives the marketing person a "Set the EDD" To-do, once per job,
 *     answered when the EDD is set
 *   - a job raised from the customer keeps its EDD on its tasks: given on the form or set later
 *     by marketing or Admin, carried to the teams after, and read by the production queue
 *
 *   node --test tests/edd-ask.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'edd-ask-test-secret';

let mongo;
let server;
let baseUrl;
let Todo;
let Enquiry;
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
const indiaDay = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + n * 86400000));
const enquiryFor = async (name, mobile, items = [{ modelNumber: 'EA-1', quantity: 1000 }]) => {
  const buyer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name, mobile, assignedTo: ids.nandhini } })).json.data;
  return (await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { customer: buyer._id, items, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() } })).json.data;
};
const asks = (key) => Todo.find({ originKey: key, completed: false }).lean();

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
  ids.admin = (await api('/api/auth/me', { as: 'admin' })).json.data.id;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['siva', 'Sivakumar', 'production'], ['ravi', 'Ravi Despatch', 'despatch']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: department === 'production' } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
    ids[key] = (await api('/api/auth/me', { as: key })).json.data.id;
  }
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('marketing gives the EDD on the Production form: it is the enquiry’s, and nobody is asked again', async () => {
  const enquiry = await enquiryFor('Form EDD Knits', '9840066001');
  const prefill = (await api(`/api/enquiries/${enquiry._id}/handoffs/prefill`, { as: 'nandhini' })).json.data;
  assert.equal(prefill?.edd ?? '', '', 'the form knows there is no EDD yet');
  const past = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Make it', brief: { model: 'EA-1' }, edd: indiaDay(-1) } });
  assert.equal(past.status, 400);
  assert.match(past.json.message, /cannot be in the past/);

  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Make it', brief: { model: 'EA-1' }, edd: indiaDay(12) } });
  assert.equal(sent.status, 201, sent.json.message);
  const saved = await Enquiry.findById(enquiry._id).select('edd').lean();
  assert.deepEqual([saved.edd.date, saved.edd.department], [indiaDay(12), 'marketing']);
  assert.equal((await asks(`edd-needed:e:${enquiry._id}`)).length, 0, 'no To-do — the EDD was given');
  assert.equal((await api(`/api/enquiries/${enquiry._id}/handoffs/prefill`, { as: 'nandhini' })).json.data.edd, indiaDay(12));
});

test('a queue task raised with no EDD asks the marketing person once; setting the EDD answers it', async () => {
  const enquiry = await enquiryFor('No EDD Knits', '9840066002');
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Make it', brief: { model: 'EA-1' } } });
  assert.equal(sent.status, 201, sent.json.message);
  let open = await asks(`edd-needed:e:${enquiry._id}`);
  assert.equal(open.length, 1);
  assert.equal(String(open[0].user), ids.nandhini, 'the enquiry’s marketing person');
  assert.match(open[0].title, /^Set the EDD — ENQ-/);
  assert.equal(open[0].priority, 'high');
  assert.equal(open[0].link, `/enquiries/${enquiry._id}`);

  /* The app raising Printing (Production's routing) does not ask twice. */
  const routed = await api(`/api/workspace/todos/${sent.json.data.task._id}/routing`, { method: 'POST', as: 'siva', body: { models: [{ model: 'EA-1', printing: true }] } });
  assert.equal(routed.status, 200, routed.json.message);
  assert.ok(await Todo.exists({ enquiry: enquiry._id, kind: 'ask_printing' }));
  assert.equal((await asks(`edd-needed:e:${enquiry._id}`)).length, 1, 'once per job');

  /* Production cannot answer it — the EDD is marketing’s. */
  assert.equal((await api(`/api/enquiries/${enquiry._id}/edd`, { method: 'POST', as: 'siva', body: { date: indiaDay(9) } })).status, 403);
  const set = await api(`/api/enquiries/${enquiry._id}/edd`, { method: 'POST', as: 'nandhini', body: { date: indiaDay(9), note: 'Buyer agreed' } });
  assert.equal(set.status, 200, set.json.message);
  open = await asks(`edd-needed:e:${enquiry._id}`);
  assert.equal(open.length, 0, 'answered');
});

test('the Dispatch request raised with none asks too; Admin gives the EDD on the form as marketing does', async () => {
  const enquiry = await enquiryFor('Dispatch EDD Knits', '9840066003');
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'invoice_dispatch', note: 'Send it', brief: { quantity: '1000' } } });
  assert.equal(sent.status, 201, sent.json.message);
  assert.equal((await asks(`edd-needed:e:${enquiry._id}`)).length, 1);
  /* Admin, like marketing, gives it on the form. */
  const other = await enquiryFor('Other Knits', '9840066004');
  await api(`/api/enquiries/${other._id}/handoffs`, { method: 'POST', as: 'admin', body: { kind: 'ask_edd', note: 'Make it', brief: { model: 'EA-1' }, edd: indiaDay(15) } });
  assert.equal((await Enquiry.findById(other._id).select('edd').lean()).edd.date, indiaDay(15), 'Admin sets it');
});

test('a job raised from the customer: its EDD on the form, carried to the teams after, read by the queue', async () => {
  const buyer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Walk-in Garments', mobile: '9840066005', assignedTo: ids.nandhini } })).json.data;
  const raised = await api('/api/workspace/team-tasks', { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Trade fair lot', customer: buyer._id, brief: { model: 'TJ-1', quantity: '500' }, edd: indiaDay(10) } });
  assert.equal(raised.status, 201, raised.json.message);
  const task = await Todo.findById(raised.json.data.task._id).lean();
  assert.equal(task.jobEdd.date, indiaDay(10));
  assert.equal((await asks(`edd-needed:c:${task._id}`)).length, 0);
  /* Production routes it to Printing: Printing's task carries the job's EDD. */
  const routed = await api(`/api/workspace/todos/${task._id}/routing`, { method: 'POST', as: 'siva', body: { models: [{ model: 'TJ-1', printing: true }] } });
  assert.equal(routed.status, 200, routed.json.message);
  const printing = await Todo.findOne({ chain: task._id, kind: 'ask_printing' }).lean();
  assert.equal(printing.jobEdd.date, indiaDay(10));
  const queue = (await api('/api/production/queue', { as: 'siva' })).json.data;
  const row = queue.find((entry) => String(entry.task._id) === String(task._id));
  assert.equal(row.edd.date, indiaDay(10), 'the production queue orders it by the job’s EDD');
  assert.equal(row.edd.department, 'marketing');
});

test('a job raised from the customer with no EDD asks whoever raised it; marketing or Admin set it from any of its tasks', async () => {
  const raised = await api('/api/workspace/team-tasks', { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Samples for the stall', brief: { model: 'TJ-2', quantity: '200' } } });
  assert.equal(raised.status, 201, raised.json.message);
  const id = raised.json.data.task._id;
  const open = await asks(`edd-needed:c:${id}`);
  assert.equal(open.length, 1);
  assert.equal(String(open[0].user), ids.nandhini);

  assert.equal((await api(`/api/workspace/todos/${id}/job-edd`, { method: 'POST', as: 'siva', body: { date: indiaDay(6) } })).status, 403, 'the EDD is marketing’s');
  assert.equal((await api(`/api/workspace/todos/${id}/job-edd`, { method: 'POST', as: 'nandhini', body: { date: indiaDay(-2) } })).status, 400);
  const set = await api(`/api/workspace/todos/${id}/job-edd`, { method: 'POST', as: 'admin', body: { date: indiaDay(6), note: 'Stall opens on the 6th' } });
  assert.equal(set.status, 200, set.json.message);
  assert.equal(set.json.data.jobEdd.date, indiaDay(6));
  assert.match(set.json.data.updates.at(-1).note, /EDD .* set by Navin R \(marketing\): Stall opens on the 6th/);
  assert.equal((await asks(`edd-needed:c:${id}`)).length, 0, 'answered');

  /* On a task of an enquiry, the EDD is set on the enquiry. */
  const enquiry = await enquiryFor('Enquiry Knits', '9840066006');
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Make it', brief: { model: 'EA-1' }, edd: indiaDay(8) } });
  const refused = await api(`/api/workspace/todos/${sent.json.data.task._id}/job-edd`, { method: 'POST', as: 'nandhini', body: { date: indiaDay(9) } });
  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /set the EDD on the enquiry/);
});
