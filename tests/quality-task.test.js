/**
 * A Quality task about several models [config/departmentTaskForms.js `qualityAsks`]: one row per
 * model with its material, pieces and the complaint or check on it, the complaint received as a
 * whole (required on a Quality Issue), and the instruction from whoever raised it. The Quality
 * desk lists each task with its models and the complaint [deskSummary.service `modelsOfBrief`].
 *
 *   node --test tests/quality-task.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'quality-task-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
let customerId;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const soon = () => new Date(Date.now() + 3 * 86400000).toISOString();

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
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['kavi', 'Kavitha', 'quality']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  customerId = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Quality Knits', mobile: '9840022011', assignedTo: me } })).json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the Quality forms ask for model rows with pieces and a complaint each, the complaint received, and an instruction', async () => {
  const { buttons } = (await api('/api/handoffs', { as: 'kavi' })).json.data;
  for (const key of ['quality_check', 'quality_issue']) {
    const button = buttons.find((entry) => entry.key === key);
    const rows = button.asks.find((field) => field.key === 'items');
    assert.equal(rows.type, 'items');
    assert.deepEqual(rows.columns.map((column) => column.key), ['model', 'material', 'quantity', 'complaint']);
    assert.equal(rows.columns[0].required, true, 'a row names its model');
    assert.equal(button.form.note.label, 'Additional instruction to Quality');
  }
  assert.equal(buttons.find((entry) => entry.key === 'quality_issue').asks.find((field) => field.key === 'problem').required, true, 'a complaint has to say what was reported');
  assert.ok(!buttons.find((entry) => entry.key === 'quality_check').asks.find((field) => field.key === 'problem').required, 'a routine check may have none');
});

test('a Quality Issue on two models keeps each row, the complaint and the instruction; the desk lists the models and the issue', async () => {
  const enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customerId, items: [{ modelNumber: 'CRF25', quantity: 10000, colour: 'Black' }, { modelNumber: 'CRF30', quantity: 4000 }], nextAction: 'Call', nextFollowUpDate: soon() },
  })).json.data;

  /* The form is filled from the enquiry's models: a row each, with its pieces. */
  const prefill = (await api(`/api/enquiries/${enquiry._id}/handoffs/prefill`, { as: 'nandhini' })).json.data;
  assert.deepEqual(prefill.items.map((row) => row.model), ['CRF25', 'CRF30']);

  const noComplaint = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini',
    body: { kind: 'quality_issue', note: 'Buyer wants an answer by Friday', brief: { items: [{ model: 'CRF25', quantity: 200 }] } },
  });
  assert.equal(noComplaint.status, 400, 'a complaint has to be said');
  assert.match(noComplaint.json.message, /Complaint received/);

  const noModel = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini',
    body: { kind: 'quality_issue', note: 'Buyer wants an answer by Friday', brief: { items: [{ quantity: 200 }], problem: 'Hooks loose' } },
  });
  assert.equal(noModel.status, 400);
  assert.match(noModel.json.message, /Model is needed on every row/);

  const raised = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini',
    body: {
      kind: 'quality_issue', note: 'Buyer wants an answer by Friday — replace what fails',
      brief: {
        items: [
          { model: 'CRF25', material: 'PP Black', quantity: 200, complaint: 'Hooks pulling out under 2 kg' },
          { model: 'CRF30', quantity: 50, complaint: 'Clips cracked' },
        ],
        problem: 'Buyer returned 250 pcs from the last lot',
      },
    },
  });
  assert.equal(raised.status, 201, raised.json.message);
  const task = raised.json.data.task;
  assert.deepEqual(task.brief.items, [
    { model: 'CRF25', material: 'PP Black', quantity: '200', complaint: 'Hooks pulling out under 2 kg' },
    { model: 'CRF30', quantity: '50', complaint: 'Clips cracked' },
  ]);
  assert.equal(task.brief.problem, 'Buyer returned 250 pcs from the last lot');
  assert.equal(task.notes, 'Buyer wants an answer by Friday — replace what fails');

  const desk = await api('/api/departments/quality/dashboard', { as: 'kavi' });
  assert.equal(desk.status, 200, desk.json.message);
  const row = desk.json.data.enquiries.find((entry) => String(entry.task._id) === String(task._id));
  assert.ok(row, 'on the Quality desk');
  assert.deepEqual(row.models, [
    { model: 'CRF25', quantity: 200, complaint: 'Hooks pulling out under 2 kg' },
    { model: 'CRF30', quantity: 50, complaint: 'Clips cracked' },
  ]);
  assert.equal(row.complaint, 'Buyer returned 250 pcs from the last lot');
  assert.match(row.summary, /Complaint Received/);

  /* The workflow is the same Quality one, moved with a remark. */
  const moved = await api(`/api/workspace/todos/${task._id}/status`, { method: 'POST', as: 'kavi', body: { status: 'checking', note: 'Pulling 50 pcs of each' } });
  assert.equal(moved.status, 200, moved.json.message);
  assert.equal(moved.json.data.status, 'checking');
});

test('a Quality Check with no complaint and no rows still goes — a routine check — and an older flat brief still reads', async () => {
  const enquiry = (await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { customer: customerId, requirement: { modelNumber: 'NH-400' }, nextAction: 'Call', nextFollowUpDate: soon() } })).json.data;
  const raised = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'quality_check', note: 'Check the lot before it goes', brief: {} } });
  assert.equal(raised.status, 201, raised.json.message);
  assert.equal(raised.json.data.task.brief?.items, undefined);
  const { modelsOfBrief } = await import('../src/services/deskSummary.service.js');
  assert.deepEqual(modelsOfBrief({ model: 'NH-400', quantity: '5000' }), [{ model: 'NH-400', quantity: 5000, complaint: null }]);
  assert.deepEqual(modelsOfBrief({ models: 'A, B' }), [{ model: 'A', quantity: null, complaint: null }, { model: 'B', quantity: null, complaint: null }]);
  assert.deepEqual(modelsOfBrief({}), []);
});
