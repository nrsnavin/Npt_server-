/**
 * The team task audit's findings, each the way it went wrong [teamJobs.service, teamProduction.service,
 * journey.service, handoff.service]: a reminder listed as a job, "where it is now" naming a team
 * the goods had not reached, the dispatch left open after Reception's LR, the job never Done, start
 * from where the goods are run twice or over the pieces, a linked job lost to its asker, a second
 * ask raised silently, a team sample with no sample, a job with no buyer sent to Dispatch.
 *
 *   node --test tests/team-audit-fixes.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'team-audit-fixes-test-secret';

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
const today = () => new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
const teamTask = async (as, body) => {
  const sent = await api('/api/workspace/team-tasks', { method: 'POST', as, body });
  assert.equal(sent.status, 201, sent.json.message);
  return sent.json.data.task;
};
const jobRow = async (id, as = 'nandhini', state = 'all') => (await api(`/api/workspace/team-jobs?state=${state}`, { as })).json.data.find((row) => String(row._id) === String(id));
const job = async (id, as = 'nandhini') => (await api(`/api/workspace/team-jobs/${id}`, { as })).json.data;
/* A load sent from the dispatch form, with no paper. */
const loadLines = async (taskId, lines, mode = 'transporter') => {
  const form = new FormData();
  form.append('status', 'part_dispatched');
  form.append('mode', mode);
  form.append('lines', JSON.stringify(lines));
  const response = await fetch(`${baseUrl}/api/workspace/todos/${taskId}/dispatch`, { method: 'POST', headers: { Authorization: `Bearer ${token.ravi}` }, body: form });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
/* A Production job for the buyer (or none), its model filled, made and Ready for Dispatch. */
async function madeJob({ customer = customerId, model, pieces = 5000, as = 'nandhini' }) {
  const production = await teamTask(as, { kind: 'ask_edd', note: `Make ${model}`, ...(customer ? { customer } : {}), edd: new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10) });
  assert.equal((await api(`/api/workspace/todos/${production._id}/brief`, { method: 'POST', as: 'siva', body: { brief: { model, quantity: String(pieces) } } })).status, 200);
  const started = await api(`/api/workspace/todos/${production._id}/start-from`, { method: 'POST', as: 'siva', body: { models: [{ model, at: 'ready_dispatch' }] } });
  assert.equal(started.status, 200, started.json.message);
  await settle();
  return production;
}

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
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['siva', 'Sivakumar', 'production'], ['pandi', 'Pandi Print', 'printing'], ['anand', 'Anand Assembly', 'assembling'], ['ravi', 'Ravi Despatch', 'despatch'], ['rekha', 'Rekha Reception', 'reception'], ['sam', 'Sam Sampling', 'sampling']]) {
    const made = await raw('/api/users', { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: department === 'production' }, token.admin);
    assert.ok(made.data, made.message);
    token[key] = (await raw('/api/auth/login', { email: `${key}@np.com`, password: 'Pass@123456' })).data.token;
  }
  const me = (await api('/api/auth/me')).json.data.id;
  customerId = (await api('/api/customers', { method: 'POST', body: { name: 'Audit Fix Garments', mobile: '9840099301', email: 'buyer@example.com', assignedTo: me } })).json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('A4: a personal payment reminder is not a team job', async () => {
  const reminder = await teamTask('nandhini', { kind: 'my_payment_followup', note: 'Call their accounts', customer: customerId, brief: { status: 'Asked us to call back', commitment: 'Next Week' } });
  assert.equal(await jobRow(reminder._id), undefined, 'not on Team jobs');
  assert.equal((await api(`/api/workspace/team-jobs/${reminder._id}`)).status, 404);
});

test('B5: where it is now is the team that has the goods — Printing at work, not Assembly raised beside it', async () => {
  const production = await teamTask('nandhini', { kind: 'ask_edd', note: 'Make, print and assemble AF-5', customer: customerId });
  assert.equal((await api(`/api/workspace/todos/${production._id}/brief`, { method: 'POST', as: 'siva', body: { brief: { model: 'AF-5', quantity: '3000' } } })).status, 200);
  assert.equal((await api(`/api/workspace/todos/${production._id}/routing`, { method: 'POST', as: 'siva', body: { models: [{ model: 'AF-5', printing: true, assembly: true }] } })).status, 200);
  await settle();
  const printing = await Todo.findOne({ chain: production._id, kind: 'ask_printing' }).lean();
  const assembly = await Todo.findOne({ chain: production._id, kind: 'ask_assembling_edd' }).lean();
  assert.ok(printing && assembly, 'Printing and Assembly are both asked at once');
  /* Nobody after Production has taken it up: Production has it. */
  assert.match((await jobRow(production._id)).now.words, /^Production: /);
  assert.equal((await move(production._id, 'siva', 'handed_printing', { date: today() })).status, 200);
  assert.equal((await move(printing._id, 'pandi', 'started')).status, 200);
  const row = await jobRow(production._id);
  assert.match(row.now.words, /^Printing: Started/, `with Printing, not Assembly — read "${row.now.words}"`);
  assert.match((await job(production._id)).now.words, /^Printing: Started/);
});

test('B18 + K2: Reception’s LR from its LR task closes the dispatch, and the job reads Done once the LR is with the buyer', async () => {
  const production = await madeJob({ model: 'AF-18', pieces: 4000 });
  const request = await Todo.findOne({ chain: production._id, kind: 'invoice_dispatch', completed: false }).lean();
  assert.ok(request, 'Dispatch has the request');
  /* Everything goes by transporter, with no LR copy yet. */
  assert.equal((await loadLines(request._id, [{ model: 'AF-18', quantity: 4000 }])).status, 200);
  await settle();
  const gone = await Todo.findById(request._id).lean();
  assert.equal(gone.status, 'fully_dispatched');
  assert.equal(gone.completed, false, 'open: the LR is still to come');
  const lr = await Todo.findOne({ chain: production._id, kind: 'lr_copy', completed: false }).lean();
  assert.ok(lr, 'Reception has the LR task');
  /* Reception uploads the LR on its own task. */
  const form = new FormData();
  form.append('file', new Blob(['%PDF-1.4 lr'], { type: 'application/pdf' }), 'lr.pdf');
  const uploaded = await fetch(`${baseUrl}/api/workspace/todos/${lr._id}/result`, { method: 'POST', headers: { Authorization: `Bearer ${token.rekha}` }, body: form });
  assert.equal(uploaded.status, 200, (await uploaded.clone().json()).message);
  await settle();
  const closed = await Todo.findById(request._id).lean();
  assert.equal(closed.completed, true, 'everything gone, every load papered: the request closed itself');
  assert.equal(closed.status, 'fully_dispatched');
  const lrNow = await Todo.findById(lr._id).lean();
  assert.equal(lrNow.status, 'sent', 'the LR went to the buyer on upload');
  /* The LR is with the buyer: the job is Done, though Reception keeps its task to track the lorry. */
  assert.equal(lrNow.completed, false);
  const row = await jobRow(production._id);
  assert.equal(row.now.done, true, `done — read "${row.now.words}"`);
  assert.match(row.now.words, /^Done — Reception: LR Copy Sent to Customer/);
  assert.equal((await jobRow(production._id, 'nandhini', 'done'))?.now.done, true, 'on the Done list');
  assert.equal((await job(production._id)).now.done, true);
  /* Another shipment's LR awaited would open it again — here, Reception marking it delivered keeps it Done. */
  assert.equal((await move(lr._id, 'rekha', 'delivered', { note: 'Reached the buyer' })).status, 200);
  assert.match((await jobRow(production._id)).now.words, /^Done — Reception: Delivered/);
});

test('E3 + E4: start from where the goods are — never more dispatched than the model’s pieces, and only once', async () => {
  const production = await teamTask('nandhini', { kind: 'ask_edd', note: 'Status of AF-3?', customer: customerId });
  assert.equal((await api(`/api/workspace/todos/${production._id}/brief`, { method: 'POST', as: 'siva', body: { brief: { model: 'AF-3', quantity: '10000' } } })).status, 200);
  const over = await api(`/api/workspace/todos/${production._id}/start-from`, { method: 'POST', as: 'siva', body: { models: [{ model: 'AF-3', at: 'dispatched', date: today(), pieces: 15000 }] } });
  assert.equal(over.status, 400);
  assert.match(over.json.message, /AF-3: 15,000 pcs is more than its 10,000 pcs/);
  assert.equal(await Todo.exists({ chain: production._id, kind: 'invoice_dispatch' }), null, 'nothing recorded');

  const first = await api(`/api/workspace/todos/${production._id}/start-from`, { method: 'POST', as: 'siva', body: { models: [{ model: 'AF-3', at: 'started' }] } });
  assert.equal(first.status, 200, first.json.message);
  const again = await api(`/api/workspace/todos/${production._id}/start-from`, { method: 'POST', as: 'siva', body: { models: [{ model: 'AF-3', at: 'not_started' }] } });
  assert.equal(again.status, 409);
  assert.match(again.json.message, /already started from where the goods are/);
  const task = await Todo.findById(production._id).lean();
  assert.equal(task.status, 'started', 'left where it was');
  assert.equal(task.updates.filter((line) => /Started from where the goods are/.test(line.text || '')).length, 1, 'said once');

  /* A task already under way by hand is not started over either. */
  const byHand = await teamTask('nandhini', { kind: 'ask_edd', note: 'Make AF-4', customer: customerId, brief: { model: 'AF-4', quantity: '2000' } });
  assert.equal((await move(byHand._id, 'siva', 'started')).status, 200);
  const late = await api(`/api/workspace/todos/${byHand._id}/start-from`, { method: 'POST', as: 'siva', body: { models: [{ model: 'AF-4', at: 'ready_dispatch' }] } });
  assert.equal(late.status, 409);
  assert.match(late.json.message, /already under way/);
});

test('J7: a job linked to the buyer’s enquiry stays on its asker’s Team jobs, saying which enquiry it joined', async () => {
  const enquiry = (await api('/api/enquiries', { method: 'POST', body: { customer: customerId, items: [{ modelNumber: 'AF-7' }], nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 864e5).toISOString() } })).json.data;
  const production = await teamTask('nandhini', { kind: 'ask_edd', note: 'Status of AF-7?', customer: customerId });
  const linked = await api(`/api/workspace/todos/${production._id}/link-enquiry`, { method: 'POST', as: 'siva', body: { enquiry: enquiry._id } });
  assert.equal(linked.status, 200, linked.json.message);
  const row = await jobRow(production._id);
  assert.ok(row, 'still on her Team jobs');
  assert.equal(row.now.done, false);
  assert.match(row.now.words, new RegExp(`^Joined ${enquiry.number} — Production: `));
  assert.equal(String(row.now.linked._id), String(enquiry._id));
  const page = await job(production._id);
  assert.equal(page.linked.number, enquiry.number);
  assert.deepEqual(page.steps.map((step) => step.team), ['Production']);
  assert.ok(page.timeline.some((line) => /Linked to /.test(line.text)), 'the link is on its timeline');
});

test('J8: the same ask open for the buyer and model is said before a second is raised — and raised only when asked to', async () => {
  const first = await teamTask('nandhini', { kind: 'ask_edd', note: 'Make AF-8', customer: customerId, brief: { model: 'AF-8', quantity: '1000' } });
  const second = await api('/api/workspace/team-tasks', { method: 'POST', body: { kind: 'ask_edd', note: 'Make AF-8 again', customer: customerId, brief: { model: 'af-8', quantity: '500' } } });
  assert.equal(second.status, 409);
  assert.equal(second.json.details.code, 'DUPLICATE_JOB');
  assert.equal(String(second.json.details.job._id), String(first._id));
  assert.match(second.json.message, /is already open for Audit Fix Garments — AF-8, with Ask EDD/);
  /* Another model is another job. */
  await teamTask('nandhini', { kind: 'ask_edd', note: 'Make AF-9', customer: customerId, brief: { model: 'AF-9' } });
  /* Raised anyway, when the asker says so. */
  const anyway = await api('/api/workspace/team-tasks', { method: 'POST', body: { kind: 'ask_edd', note: 'A second lot of AF-8', customer: customerId, brief: { model: 'AF-8' }, allowDuplicate: true } });
  assert.equal(anyway.status, 201, anyway.json.message);
});

test('K1: a team Sample Request raises the sample for the bench, on the job; sending it closes the task', async () => {
  const task = await teamTask('nandhini', { kind: 'sample_request', note: 'Two colours for the buyer', customer: customerId, brief: { items: [{ model: 'AF-11 · Shirt hanger', quantity: '2', colour: 'Black' }, { model: 'AF-12', quantity: '3' }] } });
  const { default: Sample } = await import('../src/models/Sample.js');
  const sample = await Sample.findOne({ job: task._id });
  assert.ok(sample, 'the sample is raised');
  assert.equal(String(sample.customer), String(customerId));
  assert.equal(sample.enquiry, undefined);
  assert.deepEqual(sample.items.map((row) => [row.modelNumber, row.quantity]), [['AF-11', 2], ['AF-12', 3]]);
  const fresh = await Todo.findById(task._id).lean();
  assert.equal(fresh.link, `/samples/${sample._id}`, 'the task opens the sample');
  assert.ok(fresh.updates.some((line) => new RegExp(`Sample ${sample.number} raised`).test(line.text)));
  /* Any other sample with no enquiry or job is still refused [belongsToEnquiry]. */
  await assert.rejects(Sample.create({ number: 'SMP-X', requestedBy: sample.requestedBy, customer: customerId }), /belongs to an enquiry/);

  /* The sample goes out: the job's Sample Request is done, with the courier details. */
  sample.set({ status: 'dispatched', courier: 'DTDC', awbNumber: 'AWB123', dispatchedQuantity: 5, dispatchedAt: new Date() });
  await sample.save();
  const { publish, EVENTS } = await import('../src/services/events.service.js');
  await publish(EVENTS.SAMPLE_DISPATCHED, { sample, from: 'sample_ready', by: { _id: sample.requestedBy } });
  await settle();
  const done = await Todo.findById(task._id).lean();
  assert.equal(done.completed, true);
  assert.match(done.outcome?.note || '', /DTDC · AWB AWB123/);
});

test('J9: a job with no buyer waits at Dispatch for its asker to name one — or to say it goes with none', async () => {
  const production = await madeJob({ customer: null, model: 'AF-90', pieces: 2000 });
  assert.equal(await Todo.exists({ chain: production._id, kind: 'invoice_dispatch' }), null, 'Dispatch is not asked with nobody to deliver to');
  const root = await Todo.findById(production._id).lean();
  assert.ok(root.buyerWantedAt);
  const row = await jobRow(production._id);
  assert.equal(row.now.needsBuyer, true);
  assert.match(row.now.words, /name the buyer/);
  const asked = await Todo.findOne({ originKey: `job-buyer:${production._id}`, completed: false }).lean();
  assert.ok(asked, 'whoever gave it is asked');
  assert.equal(asked.link, `/team-jobs/${production._id}`);
  assert.equal((await job(production._id)).mayNameBuyer, true);
  /* Production cannot name it; a buyer off the register is refused. */
  assert.equal((await api(`/api/workspace/team-jobs/${production._id}/buyer`, { method: 'POST', as: 'siva', body: { customer: customerId } })).status, 404);
  assert.equal((await api(`/api/workspace/team-jobs/${production._id}/buyer`, { method: 'POST', body: { customer: '64b000000000000000000000' } })).status, 400);

  const named = await api(`/api/workspace/team-jobs/${production._id}/buyer`, { method: 'POST', body: { customer: customerId } });
  assert.equal(named.status, 200, named.json.message);
  assert.equal(named.json.data.customer.name, 'Audit Fix Garments');
  await settle();
  const request = await Todo.findOne({ chain: production._id, kind: 'invoice_dispatch' }).lean();
  assert.ok(request, 'Dispatch is asked now');
  assert.equal(String(request.customer), String(customerId));
  assert.match((await Todo.findById(production._id).lean()).title, /Audit Fix Garments$/);
  assert.equal(await Todo.exists({ originKey: `job-buyer:${production._id}`, completed: false }), null, 'the ask is closed');
  assert.equal((await api(`/api/workspace/team-jobs/${production._id}/buyer`, { method: 'POST', body: { customer: customerId } })).status, 409, 'once');

  /* Stock for a fair: no buyer, said so — Dispatch is asked as it is. */
  const stock = await madeJob({ customer: null, model: 'AF-91', pieces: 1000 });
  assert.equal(await Todo.exists({ chain: stock._id, kind: 'invoice_dispatch' }), null);
  const waived = await api(`/api/workspace/team-jobs/${stock._id}/buyer`, { method: 'POST', body: { noBuyer: true } });
  assert.equal(waived.status, 200, waived.json.message);
  await settle();
  const sent = await Todo.findOne({ chain: stock._id, kind: 'invoice_dispatch' }).lean();
  assert.ok(sent, 'Dispatch is asked with no buyer');
  assert.equal(sent.customer, undefined);
  assert.ok(waived.json.data.timeline.some((line) => /No buyer — sent as it is/.test(line.text)));
});
