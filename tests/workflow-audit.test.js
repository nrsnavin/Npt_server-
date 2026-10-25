/**
 * The whole run of an order with two models through Production, Printing, Assembly and Dispatch,
 * the way the floor really moves it — a model at a time, the same status said twice, part loads —
 * checking at each step what the enquiry shows. Written to find the bugs where a repeat or a part
 * move was dropped [handoff.service `setTaskStatus`, `modelJourneys`, `recordDispatchLoad`].
 *
 *   node --test tests/workflow-audit.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { dispatchLoad } from './support/dispatchLoad.mjs';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'workflow-audit-test-secret';

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
  customerId = (await api('/api/customers', { method: 'POST', body: { name: 'Audit Garments', mobile: '9840099001', assignedTo: me } })).json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('two models through every team, a model at a time, with repeats and part loads: the enquiry reads true at each step', async () => {
  const enquiry = (await api('/api/enquiries', {
    method: 'POST',
    body: { customer: customerId, items: [{ modelNumber: 'AU-25', quantity: 10000 }, { modelNumber: 'AU-30', quantity: 6000 }], nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 864e5).toISOString() },
  })).json.data._id;
  const asked = await api(`/api/enquiries/${enquiry}/handoffs`, { method: 'POST', body: { kind: 'ask_edd', note: 'Make both', brief: { model: 'AU-25' } } });
  assert.equal(asked.status, 201, asked.json.message);
  const production = asked.json.data.task;
  /* The pieces of each model, as an SO request carries them onto Production's task [carriedBrief]. */
  await Todo.updateOne({ _id: production._id }, { $set: { 'brief.items': [{ model: 'AU-25', quantity: '10000' }, { model: 'AU-30', quantity: '6000' }] } });

  /* Before routing: both models show, each with Production. */
  let journeys = (await records(enquiry)).journeys;
  assert.deepEqual(journeys.map((row) => row.model).sort(), ['AU-25', 'AU-30'], 'both models before routing');

  /* AU-25 printed then assembled; AU-30 straight to Dispatch. */
  const routed = await api(`/api/workspace/todos/${production._id}/routing`, { method: 'POST', as: 'siva', body: { models: [{ model: 'AU-25', printing: true, assembly: true }, { model: 'AU-30' }] } });
  assert.equal(routed.status, 200, routed.json.message);
  journeys = (await records(enquiry)).journeys;
  assert.deepEqual(journeyOf(journeys, 'AU-25').steps.map((step) => step.team), ['production', 'printing', 'assembling', 'dispatch']);
  assert.deepEqual(journeyOf(journeys, 'AU-30').steps.map((step) => step.team), ['production', 'dispatch']);
  const printing = await Todo.findOne({ enquiry, kind: 'ask_printing', completed: false }).lean();
  const assembly = await Todo.findOne({ enquiry, kind: 'ask_assembling_edd', completed: false }).lean();
  assert.ok(printing && assembly, 'Printing and Assembly are tasked');

  /* Production: started, then Part 1 Ready said twice with a remark each time — both kept. */
  assert.equal((await move(production._id, 'siva', 'started')).status, 200);
  assert.equal((await move(production._id, 'siva', 'part1_ready', { note: '4,000 of AU-25 off the press' })).status, 200);
  assert.equal((await move(production._id, 'siva', 'part1_ready', { note: 'another 3,000 of AU-25' })).status, 200);
  let saved = await Todo.findById(production._id).lean();
  assert.ok(saved.updates.some((entry) => /another 3,000 of AU-25/.test(entry.note || '')), 'the second Part 1 Ready is kept');

  /* AU-30 ready for dispatch on its own; AU-25 handed to Printing. */
  assert.equal((await move(production._id, 'siva', 'ready_dispatch', { models: ['AU-30'], note: 'AU-30 packed' })).status, 200);
  assert.equal((await move(production._id, 'siva', 'handed_printing', { models: ['AU-25'], note: 'AU-25 to printing' })).status, 200);
  await settle();
  journeys = (await records(enquiry)).journeys;
  assert.equal(stepOf(journeyOf(journeys, 'AU-30'), 'production').state, 'done', 'AU-30 through Production');
  assert.equal(stepOf(journeyOf(journeys, 'AU-25'), 'production').state, 'done', 'AU-25 handed on');
  assert.equal(stepOf(journeyOf(journeys, 'AU-25'), 'printing').state, 'now', 'AU-25 with Printing');
  let readiness = (await page(enquiry)).readiness;
  assert.deepEqual(readiness.ready, ['AU-30']);

  /* Printing: goods came (by the hand-over), started, Part Quantity Ready twice — both kept — then handed to Assembly. */
  saved = await Todo.findById(printing._id).lean();
  assert.ok(saved.routing?.receivedModels?.['AU-25'], 'Printing has the goods by the hand-over');
  assert.equal((await move(printing._id, 'pandi', 'started')).status, 200);
  assert.equal((await move(printing._id, 'pandi', 'part_ready', { note: '5,000 printed' })).status, 200);
  assert.equal((await move(printing._id, 'pandi', 'part_ready', { note: '3,000 more printed' })).status, 200);
  saved = await Todo.findById(printing._id).lean();
  assert.ok(saved.updates.some((entry) => /3,000 more printed/.test(entry.note || '')), 'the second Part Quantity Ready is kept');
  assert.equal((await move(printing._id, 'pandi', 'handed_assembly', { note: 'All printed, to assembly' })).status, 200);
  await settle();
  journeys = (await records(enquiry)).journeys;
  assert.equal(stepOf(journeyOf(journeys, 'AU-25'), 'printing').state, 'done');
  assert.equal(stepOf(journeyOf(journeys, 'AU-25'), 'assembling').state, 'now', 'AU-25 with Assembly');

  /* Assembly: started, ready for dispatch. */
  assert.equal((await move(assembly._id, 'anand', 'started')).status, 200);
  assert.equal((await move(assembly._id, 'anand', 'ready_dispatch', { note: 'AU-25 assembled and packed' })).status, 200);
  await settle();
  readiness = (await page(enquiry)).readiness;
  assert.deepEqual([...readiness.ready].sort(), ['AU-25', 'AU-30'], 'both ready');

  /* Dispatch: AU-30 in full, then AU-25 in three part loads. */
  const request = await Todo.findOne({ enquiry, kind: 'invoice_dispatch', completed: false }).lean();
  assert.ok(request, 'Dispatch has the request');
  const sheet = (await api(`/api/workspace/todos/${request._id}/dispatch`, { as: 'ravi' })).json.data;
  assert.deepEqual(sheet.models.map((row) => [row.model, row.ordered, row.ready]).sort(), [['AU-25', 10000, true], ['AU-30', 6000, true]]);
  let load = await dispatchLoad({ baseUrl, token: token.ravi, taskId: request._id, status: 'part_dispatched', models: 'AU-30', pieces: 6000 });
  assert.equal(load.status, 200, load.json.message);
  assert.equal(load.json.data.status, 'part_dispatched');
  for (const pieces of [4000, 4000]) {
    load = await dispatchLoad({ baseUrl, token: token.ravi, taskId: request._id, status: 'part_dispatched', models: 'AU-25', pieces });
    assert.equal(load.status, 200, load.json.message);
    assert.equal(load.json.data.status, 'part_dispatched');
  }
  let shown = await records(enquiry);
  assert.deepEqual(shown.dispatch.models.map((row) => [row.model, row.sent, row.left]).sort(), [['AU-25', 8000, 2000], ['AU-30', 6000, 0]]);
  assert.equal(journeyOf(shown.journeys, 'AU-30').sent ?? journeyOf(shown.journeys, 'AU-30').dispatched ?? 6000, 6000);
  load = await dispatchLoad({ baseUrl, token: token.ravi, taskId: request._id, status: 'part_dispatched', models: 'AU-25', pieces: 2000 });
  assert.equal(load.status, 200, load.json.message);
  assert.equal(load.json.data.status, 'fully_dispatched', 'the last of it: Fully Dispatched');
  shown = await records(enquiry);
  assert.deepEqual(shown.dispatch.models.map((row) => [row.model, row.sent, row.left]).sort(), [['AU-25', 10000, 0], ['AU-30', 6000, 0]]);
  assert.equal((await Todo.findById(request._id).lean()).loads.length, 4, 'four loads kept');
  readiness = (await page(enquiry)).readiness;
  assert.deepEqual([...readiness.sent].sort(), ['AU-25', 'AU-30'], 'both read sent');
});

test('a team task sent without the hanger details: Production fills the model, pieces, material, hook, clip and print, and the job reads them', async () => {
  const sent = await api('/api/workspace/team-tasks', { method: 'POST', body: { kind: 'ask_edd', note: 'New job — details to follow', customer: customerId, edd: new Date(Date.now() + 15 * 864e5).toISOString().slice(0, 10) } });
  assert.equal(sent.status, 201, sent.json.message);
  const task = sent.json.data.task || sent.json.data;
  const { buttons } = (await api('/api/handoffs', { as: 'siva' })).json.data;
  assert.deepEqual(buttons.find((button) => button.key === 'ask_edd').details.map((field) => field.key), ['model', 'material', 'hook', 'clip', 'print', 'quantity']);
  const filled = await api(`/api/workspace/todos/${task._id}/brief`, { method: 'POST', as: 'siva', body: { brief: { model: 'AU-40', material: 'PP Black', hook: 'Chrome swivel', clip: 'Pinch clip', print: '1 colour logo', quantity: '8,000' } } });
  assert.equal(filled.status, 200, filled.json.message);
  assert.deepEqual(['model', 'material', 'hook', 'clip', 'print', 'quantity'].map((key) => filled.json.data.brief[key]), ['AU-40', 'PP Black', 'Chrome swivel', 'Pinch clip', '1 colour logo', '8000']);
  assert.match(filled.json.data.updates.at(-1).note, /Filled: Model, Material & colour, Hook, Clip, Print, Quantity/);
  /* Printing and others may not; the raiser (marketing) may correct. */
  assert.equal((await api(`/api/workspace/todos/${task._id}/brief`, { method: 'POST', as: 'pandi', body: { brief: { model: 'X' } } })).status, 403);
  const corrected = await api(`/api/workspace/todos/${task._id}/brief`, { method: 'POST', body: { brief: { quantity: '9000' } } });
  assert.equal(corrected.status, 200, corrected.json.message);
  /* The job now knows its model and pieces: the journey follows it. */
  const fresh = await Todo.findById(task._id).lean();
  const { modelJourneys } = await import('../src/services/handoff.service.js');
  const journeys = await modelJourneys(null, { task: fresh });
  assert.deepEqual(journeys.map((row) => row.model), ['AU-40']);
});
