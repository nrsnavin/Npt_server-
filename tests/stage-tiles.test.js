/**
 * Clicking a department on the enquiry forwards it there [config/handoffs.js TILE_KIND,
 * controllers/handoff.controller.js handoffCatalogue, web: components/DepartmentDesk.jsx].
 *
 *   node --test tests/stage-tiles.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'stage-tiles-test-secret';

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let customerId;
let events;

const api = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const signIn = async (email, password) => (await api('/api/auth/login', { method: 'POST', body: { email, password } })).json.data?.token;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  events = await import('../src/services/events.service.js');
  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  admin = await signIn('admin@np.com', 'Admin@12345');
  const made = await api('/api/users', {
    method: 'POST', token: admin, body: { name: 'Nandhini S', email: 'nandhini@np.com', password: 'Pass@123456', department: 'marketing' },
  });
  assert.equal(made.status, 201, made.json.message);
  nandhini = await signIn('nandhini@np.com', 'Pass@123456');
  const me = (await api('/api/auth/me', { token: nandhini })).json.data.id;
  customerId = (await api('/api/customers', {
    method: 'POST', token: nandhini, body: { name: 'SCM Garments', mobile: '9876512300', assignedTo: me },
  })).json.data._id;
});

test.after(async () => {
  events?.clearListeners();
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('every department tile names a button that sends the enquiry to that department', async () => {
  const { stages, buttons } = (await api('/api/handoffs', { token: nandhini })).json.data;
  for (const stage of stages.filter((item) => item.number)) {
    const button = buttons.find((item) => item.key === stage.kind);
    assert.ok(button, `${stage.label} has a button`);
    assert.ok(!button.hidden, `${stage.label}: its button can be sent`);
    const department = button.department === 'owner' ? 'marketing' : button.department;
    assert.equal(department, stage.department, `${stage.label} goes to ${stage.department}`);
    if (button.moves) assert.equal(button.stage, stage.key, `${stage.label} moves the enquiry to its own stage`);
  }
  assert.equal(stages.find((item) => item.key === 'enquiry').kind, 'back_to_marketing');
  assert.equal(stages.find((item) => item.key === 'quality').kind, 'quality_check');
  assert.equal(stages.find((item) => item.key === 'closed').kind, null);
});

test('clicking a department forwards the enquiry: that department holds it, at its stage', async () => {
  const enquiry = (await api('/api/enquiries', {
    method: 'POST', token: nandhini,
    body: {
      customer: customerId, requirement: { modelNumber: 'NH-400' },
      nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString(),
    },
  })).json.data;
  const { stages } = (await api('/api/handoffs', { token: admin })).json.data;
  const tile = (key) => stages.find((item) => item.key === key);

  for (const key of ['sample', 'mould', 'audit', 'assembling', 'enquiry']) {
    const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
      method: 'POST', token: admin, body: { kind: tile(key).kind, note: `Over to ${tile(key).label}` },
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.json));
    assert.equal(sent.json.data.stage, key);
    const now = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { token: admin })).json;
    assert.equal(now.holder?.department, tile(key).department, `${key}: held by its department`);
  }
});
