/**
 * Dispatch planning [services/dispatchPlanning.service.js]: the open dispatch requests in groups
 * that can go together — by transporter, delivery route, landmark (however it is spelt), area or
 * PIN — with the not-ready and the unpaid kept apart, a whole group scheduled in one press, and
 * delivery details set on several buyers at once.
 *
 *   node --test tests/dispatch-planning.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'dispatch-planning-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
let Todo;
let landmarkKey;
let kpn;
let route2;
const buyers = {};
const tasks = {};

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const plan = async () => {
  const answer = await api('/api/dispatch-planning/plan', { as: 'ravi' });
  assert.equal(answer.status, 200, answer.json.message);
  return answer.json.data;
};
const groupOf = (data, taskId) => data.groups.find((group) => group.stops.some((stop) => String(stop.task) === String(taskId)));

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  ({ landmarkKey } = await import('../src/services/dispatchPlanning.service.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['ravi', 'Ravi Despatch', 'despatch']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;

  kpn = (await api('/api/transporters', { method: 'POST', as: 'ravi', body: { name: 'KPN Parcel', bookingOffice: 'Tiruppur office' } })).json.data;
  route2 = (await api('/api/delivery-routes', { method: 'POST', as: 'ravi', body: { name: 'Route 2 · Avinashi Road', areas: 'Anupparpalayam, Kumar Nagar', days: ['mon', 'thu'] } })).json.data;
  assert.ok(kpn?._id && route2?._id, 'the lists take entries');

  const people = [
    ['lakshmi', { name: 'Lakshmi Apparels', landmark: 'Kumar Nagar Bus Stand', city: 'Tiruppur' }],
    ['kavin', { name: 'Kavin Fashions', landmark: 'near kumarnagar bus-stop.', city: 'Tiruppur' }],
    ['velan', { name: 'Velan Knits', city: 'Tiruppur', area: 'Veerapandi' }],
    ['arul', { name: 'Arul Exports', city: 'Bangalore' }],
    ['murugan', { name: 'Sri Murugan Garments', city: 'Bangalore' }],
    ['sr', { name: 'SR Textiles', city: 'Tiruppur', area: 'Mangalam' }],
    ['gate', { name: 'Gate Pickup Traders', city: 'Erode' }],
    ['blank', { name: 'No Address Ltd' }],
  ];
  let n = 0;
  for (const [key, fields] of people) {
    const made = await api('/api/customers', { method: 'POST', as: 'nandhini', body: { ...fields, mobile: `98400${String(10000 + n++)}`, assignedTo: me } });
    assert.equal(made.status, 201, made.json.message);
    buyers[key] = made.json.data;
  }
  /* Arul and Murugan go by KPN; SR Textiles is on Route 2 — set from the planner, as the desk would. */
  const transport = await api('/api/dispatch-planning/customer-delivery', { method: 'POST', as: 'ravi', body: { customers: [buyers.arul._id, buyers.murugan._id], usualTransporter: kpn._id, deliveryMode: 'transport' } });
  assert.equal(transport.status, 200, transport.json.message);
  assert.equal(transport.json.data.updated, 2);
  const onRoute = await api('/api/dispatch-planning/customer-delivery', { method: 'POST', as: 'ravi', body: { customers: [buyers.sr._id], deliveryRoute: route2._id } });
  assert.equal(onRoute.status, 200, onRoute.json.message);

  const raise = async (key, brief) => {
    const sent = await api('/api/workspace/team-tasks', { method: 'POST', as: 'admin', body: { kind: 'invoice_dispatch', note: `Lot for ${buyers[key].name}`, customer: buyers[key]._id, brief } });
    assert.equal(sent.status, 201, sent.json.message);
    tasks[key] = sent.json.data.task?._id || sent.json.data._id;
  };
  await raise('lakshmi', { schedule: 'Tomorrow Dispatch', quantity: '12000' });
  await raise('kavin', { schedule: 'Top Most Urgent Dispatch', quantity: '6500' });
  await raise('velan', { schedule: 'Today Dispatch' });
  await raise('arul', { booking: 'Normal Booking', quantity: '9000' });
  await raise('murugan', { quantity: '4000' });
  await raise('sr', { booking: 'Local Delivery' });
  await raise('gate', { booking: 'Party Will Collect' });
  await raise('blank', {});
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('one spelling for a landmark, however it is typed', () => {
  assert.equal(landmarkKey('Kumar Nagar Bus Stand'), landmarkKey('near kumarnagar bus-stop.'));
  assert.equal(landmarkKey('Opp. Ramaraj Mill'), landmarkKey('ramaraj mill'));
  assert.notEqual(landmarkKey('Kumar Nagar Bus Stand'), landmarkKey('Ramaraj Mill'));
});

test('buyers at the same landmark, spelt two ways, are one group for one vehicle — with the reason', async () => {
  const data = await plan();
  const group = groupOf(data, tasks.lakshmi);
  assert.ok(group, 'Lakshmi is planned');
  assert.equal(group, groupOf(data, tasks.kavin), 'Kavin is in the same group');
  assert.equal(group.mode, 'own_vehicle');
  assert.equal(group.by, 'landmark');
  assert.match(group.reason, /^Same landmark: /);
  assert.match(group.label, /^Near .*Tiruppur$/);
  /* The most urgent buyer leads the group, and the group carries its urgency. */
  assert.equal(String(group.stops[0].task), String(tasks.kavin));
  assert.equal(group.totals.quantity, 18500);
});

test('transport bookings go by transporter — the request’s booking or the buyer’s usual way', async () => {
  const data = await plan();
  const group = groupOf(data, tasks.arul);
  assert.equal(group, groupOf(data, tasks.murugan), 'Murugan, with no booking on the request, goes by his usual transporter');
  assert.equal(group.mode, 'transport');
  assert.equal(group.by, 'transporter');
  assert.equal(group.reason, 'Same transporter: KPN Parcel · Tiruppur office');
});

test('a route beats an area; the party collecting needs no vehicle; no address is asked for, last', async () => {
  const data = await plan();
  assert.equal(groupOf(data, tasks.sr).by, 'route');
  assert.equal(groupOf(data, tasks.sr).reason, 'Same delivery route: Route 2 · Avinashi Road');
  assert.equal(groupOf(data, tasks.velan).by, 'area');
  assert.equal(groupOf(data, tasks.gate).mode, 'party_collects');
  const blank = groupOf(data, tasks.blank);
  assert.equal(blank.needsDetails, true);
  assert.equal(data.groups.at(-1), blank, 'the group that needs details comes last');
  assert.equal(data.counts.needsDetails, 1);
  assert.equal(data.coverage.customers, 8);
  /* Most urgent group first. */
  assert.equal(data.groups[0], groupOf(data, tasks.kavin));
});

test('goods not ready are kept out of the groups, with why', async () => {
  const moved = await api(`/api/workspace/todos/${tasks.velan}/status`, { method: 'POST', as: 'ravi', body: { status: 'not_ready', note: 'Packing not finished' } });
  assert.equal(moved.status, 200, moved.json.message);
  const data = await plan();
  assert.equal(groupOf(data, tasks.velan), undefined);
  const waiting = data.notReady.find((row) => String(row.task) === String(tasks.velan));
  assert.match(waiting.why, /Goods Not Yet Ready/);
  assert.equal(data.counts.notReady, 1);
});

test('a whole group is scheduled in one press, each request through its own status, with the remark', async () => {
  const group = groupOf(await plan(), tasks.arul);
  const refused = await api('/api/dispatch-planning/schedule', { method: 'POST', as: 'nandhini', body: { tasks: group.stops.map((stop) => stop.task), status: 'tomorrow_dispatch' } });
  assert.equal(refused.status, 403, 'planning is the dispatch desk’s');
  const wrong = await api('/api/dispatch-planning/schedule', { method: 'POST', as: 'ravi', body: { tasks: group.stops.map((stop) => stop.task), status: 'dispatched' } });
  assert.equal(wrong.status, 400, 'only a schedule — Dispatched has its own door');

  const done = await api('/api/dispatch-planning/schedule', { method: 'POST', as: 'ravi', body: { tasks: group.stops.map((stop) => stop.task), status: 'tomorrow_dispatch', note: 'KPN drop, 4 pm' } });
  assert.equal(done.status, 200, done.json.message);
  assert.equal(done.json.data.moved, 2);
  for (const key of ['arul', 'murugan']) {
    const task = await Todo.findById(tasks[key]).lean();
    assert.equal(task.status, 'tomorrow_dispatch');
    assert.equal(task.statusHistory.at(-1).note, 'KPN drop, 4 pm');
  }
});

test('a buyer’s delivery details are set from the planner, and the lists refuse what is not on them', async () => {
  const unknown = await api('/api/dispatch-planning/customer-delivery', { method: 'POST', as: 'ravi', body: { customers: [buyers.blank._id], usualTransporter: new mongoose.Types.ObjectId().toString() } });
  assert.equal(unknown.status, 400);
  const marketing = await api('/api/dispatch-planning/customer-delivery', { method: 'POST', as: 'nandhini', body: { customers: [buyers.blank._id], area: 'Kumar Nagar' } });
  assert.equal(marketing.status, 403);
  const fixed = await api('/api/dispatch-planning/customer-delivery', { method: 'POST', as: 'ravi', body: { customers: [buyers.blank._id], deliveryRoute: route2._id } });
  assert.equal(fixed.status, 200, fixed.json.message);
  const data = await plan();
  assert.equal(groupOf(data, tasks.blank), groupOf(data, tasks.sr), 'now on Route 2 with SR Textiles');
  assert.equal(data.counts.needsDetails, 0);
});

test('the lists keep one spelling, and an edit made on an old copy is refused', async () => {
  const twin = await api('/api/transporters', { method: 'POST', as: 'ravi', body: { name: 'kpn parcel', bookingOffice: 'TIRUPPUR OFFICE' } });
  assert.equal(twin.status, 409);
  const fresh = await api(`/api/transporters/${kpn._id}`, { method: 'PATCH', as: 'ravi', body: { phone: '9840011111', expectedUpdatedAt: kpn.updatedAt } });
  assert.equal(fresh.status, 200, fresh.json.message);
  const stale = await api(`/api/transporters/${kpn._id}`, { method: 'PATCH', as: 'ravi', body: { phone: '9840022222', expectedUpdatedAt: kpn.updatedAt } });
  assert.equal(stale.status, 409);
  const off = await api(`/api/delivery-routes/${route2._id}`, { method: 'PATCH', as: 'ravi', body: { active: false } });
  assert.equal(off.status, 200);
  const offered = await api('/api/delivery-routes?active=true', { as: 'ravi' });
  assert.equal(offered.json.data.length, 0, 'a route switched off is not offered');
});
