/**
 * Distance on the trip planner, from buyers' pinned gates [utils/geo.js]: groups near each other
 * are named on each other, a group's stops are put in the order a vehicle reaches them, and a trip
 * can be re-ordered by distance from the plant.
 *
 *   node --test tests/dispatch-distance.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'dispatch-distance-test-secret';
/* The plant, on Kunnathur Road. */
process.env.PLANT_LAT = '11.1085';
process.env.PLANT_LNG = '77.3411';

let mongo;
let server;
let baseUrl;
const token = {};
const buyers = {};
const tasks = {};
let Customer;
let geo;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const pin = (id, lat, lng) => Customer.updateOne({ _id: id }, { $set: { site: { lat, lng, setBy: new mongoose.Types.ObjectId(), setAt: new Date(), fromQuery: new mongoose.Types.ObjectId(), fromMessage: new mongoose.Types.ObjectId() } } });

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Customer } = await import('../src/models/Customer.js'));
  geo = await import('../src/utils/geo.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['ravi', 'Ravi Despatch', 'despatch']]) {
    await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  /* Three areas: Anupparpalayam and Kumar Nagar about a kilometre apart, Avinashi twenty away. */
  const people = [
    ['far', 'Avinashi Traders', 'Avinashi', 11.1925, 77.2689],
    ['near1', 'Kumar Nagar Knits', 'Kumar Nagar', 11.1180, 77.3290],
    ['near2', 'Anupparpalayam Apparels', 'Anupparpalayam', 11.1250, 77.3330],
  ];
  for (const [i, [key, name, area, lat, lng]] of people.entries()) {
    buyers[key] = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name, area, city: 'Tiruppur', mobile: `98400400${10 + i}`, assignedTo: me } })).json.data;
    await pin(buyers[key]._id, lat, lng);
    const sent = await api('/api/workspace/team-tasks', { method: 'POST', as: 'admin', body: { kind: 'invoice_dispatch', note: 'Lot', customer: buyers[key]._id, brief: { booking: 'Local Delivery' } } });
    assert.equal(sent.status, 201, sent.json.message);
    tasks[key] = sent.json.data.task?._id || sent.json.data._id;
  }
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('kilometres between two gates, and pinned stops in nearest-next order from the plant', () => {
  const plant = geo.plantSite();
  assert.deepEqual(plant, { lat: 11.1085, lng: 77.3411 });
  assert.ok(Math.abs(geo.km({ lat: 11.1180, lng: 77.3290 }, { lat: 11.1250, lng: 77.3330 }) - 0.89) < 0.1);
  const stops = [{ id: 'far', s: { lat: 11.1925, lng: 77.2689 } }, { id: 'none' }, { id: 'near2', s: { lat: 11.1250, lng: 77.3330 } }, { id: 'near1', s: { lat: 11.1180, lng: 77.3290 } }];
  assert.deepEqual(geo.nearestOrder(stops, (stop) => stop.s).map((stop) => stop.id), ['near1', 'near2', 'far', 'none']);
});

test('groups whose buyers are within 3 km name each other on the planner — the far one is not named', async () => {
  const plan = (await api('/api/dispatch-planning/plan', { as: 'ravi' })).json.data;
  const of = (key) => plan.groups.find((group) => group.stops.some((stop) => String(stop.task) === String(tasks[key])));
  assert.equal(of('near1').nearby.length, 1);
  assert.equal(of('near1').nearby[0].label, of('near2').label);
  assert.ok(of('near1').nearby[0].km < 1.5);
  assert.equal(of('far').nearby.length, 0);
  assert.equal(plan.coverage.pinned, 3);
});

test('a trip is re-ordered by distance from the plant before it leaves', async () => {
  const made = await api('/api/trips', { method: 'POST', as: 'ravi', body: { tasks: [tasks.far, tasks.near2, tasks.near1], mode: 'own_vehicle', driverName: 'Selvam' } });
  assert.equal(made.status, 201, made.json.message);
  const sorted = await api(`/api/trips/${made.json.data._id}`, { method: 'PATCH', as: 'ravi', body: { orderByDistance: true } });
  assert.equal(sorted.status, 200, sorted.json.message);
  assert.deepEqual(sorted.json.data.stops.map((stop) => stop.customer.name), ['Kumar Nagar Knits', 'Anupparpalayam Apparels', 'Avinashi Traders']);
});
