/**
 * Trips [services/trip.service.js]: a group from the planner made into a vehicle on a day, then
 * loaded, sent and ticked off. Making it schedules the requests; leaving marks them Dispatched
 * (which raises Reception's LR copy, filled with the vehicle); a request is on one open trip at
 * most, even when two people make trips at the same instant.
 *
 *   node --test tests/trips.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'trips-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
let Todo;
let CustomerMessage;
let ace;
const requests = [];
let trip;

const api = async (path, { method = 'GET', body, as, raw = false } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (raw) return { status: response.status, type: response.headers.get('content-type'), buffer: Buffer.from(await response.arrayBuffer()) };
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const india = (n = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + n * 86400000));

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  ({ default: CustomerMessage } = await import('../src/models/CustomerMessage.js'));
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

  ace = (await api('/api/vehicles', { method: 'POST', as: 'ravi', body: { number: 'tn 39 ab 4521', kind: 'Tata Ace', capacityCartons: 40, driverName: 'Selvam', driverPhone: '9840011111' } })).json.data;
  assert.equal(ace?.number, 'TN 39 AB 4521', 'the plate is kept in capitals');

  for (const [i, name] of ['Lakshmi Apparels', 'Kavin Fashions', 'Velan Knits'].entries()) {
    const buyer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name, mobile: `98400200${10 + i}`, landmark: 'Kumar Nagar bus stop', city: 'Tiruppur', assignedTo: me } })).json.data;
    const enquiry = (await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { customer: buyer._id, requirement: { modelNumber: 'NH-400' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() } })).json.data;
    const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'invoice_dispatch', note: 'Send the lot', brief: { model: 'NH-400', quantity: String(5000 * (i + 1)), booking: 'Local Delivery' } } });
    assert.equal(sent.status, 201, sent.json.message);
    requests.push({ task: sent.json.data.task._id, enquiry: enquiry._id, buyer });
  }
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('a group becomes a trip for tomorrow: each request is scheduled, with the trip in the remark', async () => {
  const refused = await api('/api/trips', { method: 'POST', as: 'nandhini', body: { tasks: [requests[0].task], mode: 'own_vehicle', vehicle: ace._id } });
  assert.equal(refused.status, 403, 'trips are the dispatch desk’s');
  const noVehicle = await api('/api/trips', { method: 'POST', as: 'ravi', body: { tasks: [requests[0].task], mode: 'own_vehicle' } });
  assert.equal(noVehicle.status, 400, 'our vehicle needs a vehicle or a driver');

  const made = await api('/api/trips', {
    method: 'POST', as: 'ravi',
    body: { tasks: [requests[0].task, requests[1].task], mode: 'own_vehicle', vehicle: ace._id, date: india(1), departAt: '2 pm', cartons: { [requests[0].task]: 25, [requests[1].task]: 20 } },
  });
  assert.equal(made.status, 201, made.json.message);
  trip = made.json.data;
  assert.match(trip.number, /^TRP-\d{4}-\d{4}$/);
  assert.equal(trip.stops.length, 2);
  assert.equal(trip.driverName, 'Selvam', 'the driver comes from the vehicle');
  for (const request of requests.slice(0, 2)) {
    const task = await Todo.findById(request.task).lean();
    assert.equal(task.status, 'tomorrow_dispatch');
    assert.match(task.statusHistory.at(-1).note, new RegExp(`On trip ${trip.number}`));
  }
});

test('the planner leaves requests on a trip out of its groups and shows the trip — over capacity, said', async () => {
  const plan = (await api('/api/dispatch-planning/plan', { as: 'ravi' })).json.data;
  const grouped = plan.groups.flatMap((group) => group.stops.map((stop) => String(stop.task)));
  assert.ok(!grouped.includes(String(requests[0].task)) && !grouped.includes(String(requests[1].task)));
  assert.ok(grouped.includes(String(requests[2].task)), 'the third is still to plan');
  const lane = plan.trips.find((row) => row.number === trip.number);
  assert.equal(lane.goesBy, 'TN 39 AB 4521 · Tata Ace');
  assert.equal(lane.cartons, 45);
  assert.equal(lane.over, true, '45 cartons on a 40-carton vehicle');
  assert.equal(plan.vehicles.length, 1);
});

test('a request is on one open trip at most — even when two trips are made at the same instant', async () => {
  const again = await api('/api/trips', { method: 'POST', as: 'ravi', body: { tasks: [requests[0].task], mode: 'own_vehicle', driverName: 'Hired driver' } });
  assert.equal(again.status, 409);
  assert.match(again.json.message, new RegExp(trip.number));

  const race = await Promise.all([1, 2, 3].map(() => api('/api/trips', { method: 'POST', as: 'ravi', body: { tasks: [requests[2].task], mode: 'own_vehicle', driverName: 'Hired driver' } })));
  assert.equal(race.filter((answer) => answer.status === 201).length, 1, race.map((answer) => `${answer.status} ${answer.json.message || ''}`).join(' | '));
  /* Cancelled, the request is free for another trip. */
  const winner = race.find((answer) => answer.status === 201).json.data;
  const cancelled = await api(`/api/trips/${winner._id}/status`, { method: 'POST', as: 'ravi', body: { status: 'cancelled', note: 'Merged into the morning trip' } });
  assert.equal(cancelled.status, 200, cancelled.json.message);
});

test('before it leaves, stops are reordered, cartons changed, a stop added and one taken off — and a stale copy is refused', async () => {
  const [first, second] = trip.stops;
  const changed = await api(`/api/trips/${trip._id}`, {
    method: 'PATCH', as: 'ravi',
    body: { stops: [{ id: second._id, cartons: 15 }, { id: first._id }], addTasks: [requests[2].task], expectedUpdatedAt: trip.updatedAt },
  });
  assert.equal(changed.status, 200, changed.json.message);
  assert.deepEqual(changed.json.data.stops.map((stop) => String(stop.task._id || stop.task)), [requests[1].task, requests[0].task, requests[2].task].map(String));
  assert.equal(changed.json.data.stops[0].cartons, 15);
  const stale = await api(`/api/trips/${trip._id}`, { method: 'PATCH', as: 'ravi', body: { departAt: '3 pm', expectedUpdatedAt: trip.updatedAt } });
  assert.equal(stale.status, 409);
  trip = changed.json.data;
});

test('the buyers are told once — again only on purpose — and the trip sheet is a PDF', async () => {
  const told = await api(`/api/trips/${trip._id}/tell-buyers`, { method: 'POST', as: 'ravi', body: {} });
  assert.equal(told.status, 200, told.json.message);
  assert.equal(told.json.data.kind, 'planned');
  assert.equal(told.json.data.sent, 3);
  const twice = await api(`/api/trips/${trip._id}/tell-buyers`, { method: 'POST', as: 'ravi', body: {} });
  assert.equal(twice.status, 409);
  const forced = await api(`/api/trips/${trip._id}/tell-buyers`, { method: 'POST', as: 'ravi', body: { force: true } });
  assert.equal(forced.status, 200);
  const logged = await CustomerMessage.find({ event: 'trip_planned' }).lean();
  assert.equal(logged.length, 6);
  assert.match(logged[0].body, /planned for dispatch on/);

  const sheet = await api(`/api/trips/${trip._id}/sheet`, { as: 'ravi', raw: true });
  assert.equal(sheet.status, 200);
  assert.equal(sheet.type, 'application/pdf');
  assert.equal(sheet.buffer.subarray(0, 4).toString(), '%PDF');
});

test('leaving marks every request Dispatched and gives Reception its LR copy, filled with the vehicle', async () => {
  const left = await api(`/api/trips/${trip._id}/status`, { method: 'POST', as: 'ravi', body: { status: 'left' } });
  assert.equal(left.status, 200, left.json.message);
  assert.equal(left.json.data.status, 'left');
  for (const request of requests) {
    const task = await Todo.findById(request.task).lean();
    assert.equal(task.status, 'dispatched');
    assert.match(task.statusHistory.at(-1).note, /Left on TRP-.*TN 39 AB 4521.*driver Selvam/);
    const lr = await Todo.findOne({ enquiry: request.enquiry, kind: 'lr_copy', completed: false }).lean();
    assert.ok(lr, 'Reception has the LR copy');
    assert.equal(lr.brief.vehicleNumber, 'TN 39 AB 4521');
    assert.equal(lr.brief.transporter, 'Own vehicle');
  }
  const locked = await api(`/api/trips/${trip._id}`, { method: 'PATCH', as: 'ravi', body: { departAt: '4 pm' } });
  assert.equal(locked.status, 409, 'the load cannot change once it has left');
});

test('stops are ticked off; one not delivered says why on the request; completing delivers the rest', async () => {
  const [first, second] = trip.stops;
  const noReason = await api(`/api/trips/${trip._id}/stops/${first._id}`, { method: 'POST', as: 'ravi', body: { status: 'not_delivered' } });
  assert.equal(noReason.status, 400);
  const missed = await api(`/api/trips/${trip._id}/stops/${first._id}`, { method: 'POST', as: 'ravi', body: { status: 'not_delivered', note: 'Gate closed, buyer away' } });
  assert.equal(missed.status, 200, missed.json.message);
  const task = await Todo.findById(first.task._id || first.task).lean();
  assert.match(task.updates.at(-1).note, /Not delivered on TRP-.*Gate closed/);
  await api(`/api/trips/${trip._id}/stops/${second._id}`, { method: 'POST', as: 'ravi', body: { status: 'delivered' } });

  const done = await api(`/api/trips/${trip._id}/status`, { method: 'POST', as: 'ravi', body: { status: 'completed' } });
  assert.equal(done.status, 200, done.json.message);
  assert.deepEqual(done.json.data.stops.map((stop) => stop.status), ['not_delivered', 'delivered', 'delivered']);
  const back = await api(`/api/trips/${trip._id}/status`, { method: 'POST', as: 'ravi', body: { status: 'left' } });
  assert.equal(back.status, 409, 'a completed trip stays completed');
});

test('the dispatch report: trips a day, stops a trip, delivered and missed with why, on time, vehicle fill', async () => {
  const today = india(0);
  const report = await api(`/api/dispatch-planning/report?from=${india(-2)}&to=${india(3)}`, { as: 'ravi' });
  assert.equal(report.status, 200, report.json.message);
  const data = report.json.data;
  assert.equal(data.trips, 1, 'the cancelled trip is counted apart');
  assert.equal(data.cancelled, 1);
  assert.equal(data.stops, 3);
  assert.equal(data.stopsPerTrip, 3);
  assert.equal(data.delivered, 2);
  assert.equal(data.notDelivered, 1);
  assert.match(data.missed[0].note, /Gate closed/);
  assert.equal(data.onTime.onTime + data.onTime.late + data.onTime.undated, 3);
  const ace = data.vehicles.find((row) => row.vehicle === 'TN 39 AB 4521');
  assert.equal(ace.trips, 1);
  assert.equal(ace.averageCartons, 40, '25 + 15 after the edit, the third stop uncounted');
  assert.equal(ace.fill, 100, '40 cartons on a 40-carton vehicle');
  const tooLong = await api(`/api/dispatch-planning/report?from=2025-01-01&to=${today}`, { as: 'ravi' });
  assert.equal(tooLong.status, 400, 'three months at most');
});
