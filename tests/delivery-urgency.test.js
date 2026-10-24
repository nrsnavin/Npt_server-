/**
 * Delivery urgency on a Dispatch request, and the delivery queue it orders
 * [config/deliveryUrgency.js, services/deliveryUrgency.service.js].
 *
 * Marketing or Admin says how soon the buyer needs the goods — Top Most Urgent, Today Morning,
 * Today Evening, Today, Tomorrow. A request raised with a Dispatch schedule takes it from there;
 * one without asks the enquiry's marketing person with a To-do, and Dispatch is never held for
 * it. Today Morning is late after noon, the others after 7 PM (Tomorrow's, the next day).
 *
 *   node --test tests/delivery-urgency.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { dueByFor, urgencyFromSchedule, SCHEDULE_CHOICES } from '../src/config/deliveryUrgency.js';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'delivery-urgency-test-secret';

let mongo;
let server;
let baseUrl;
let Todo;
let customerId;
const token = {};

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
/* The ask is raised by a listener after the request is sent: wait for it. */
const eventually = async (check, ms = 4000) => {
  const until = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value || Date.now() > until) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const istHour = (date) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(date));
const istDay = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);

async function dispatchRequest(brief = {}) {
  const enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customerId, requirement: { modelNumber: 'NH-400' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'invoice_dispatch', note: 'Send the lot', brief: { quantity: '2000', ...brief } } });
  assert.equal(sent.status, 201, sent.json.message);
  return { enquiry, task: sent.json.data.task };
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
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['arun', 'Arun K', 'marketing'], ['ravi', 'Ravi Despatch', 'despatch']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  customerId = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Urgent Knits', mobile: '9840022331', assignedTo: me } })).json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the cut-offs: Today Morning by noon, Today and Today Evening by 7 PM, Tomorrow by 7 PM tomorrow — India time', () => {
  const nineAm = new Date('2026-10-21T03:30:00Z'); // 09:00 IST
  assert.equal(istHour(dueByFor('today_morning', nineAm)), 12);
  assert.equal(istDay(dueByFor('today_morning', nineAm)), '2026-10-21');
  assert.equal(istHour(dueByFor('today_evening', nineAm)), 19);
  assert.equal(istHour(dueByFor('today', nineAm)), 19);
  assert.equal(istDay(dueByFor('tomorrow', nineAm)), '2026-10-22');
  assert.equal(istHour(dueByFor('tomorrow', nineAm)), 19);
  assert.equal(dueByFor('top_urgent', nineAm), null, 'Top Most Urgent has no cut-off: it is first whatever the clock');
  const lateNight = new Date('2026-10-21T19:00:00Z'); // 00:30 IST on the 22nd
  assert.equal(istDay(dueByFor('today', lateNight)), '2026-10-22', 'the day is India’s, not the server’s');
  assert.deepEqual(SCHEDULE_CHOICES, ['Top Most Urgent Dispatch', 'Today Morning Dispatch', 'Today Evening Dispatch', 'Today Dispatch', 'Tomorrow Dispatch']);
  assert.equal(urgencyFromSchedule('Tomorrow First Dispatch'), 'tomorrow', 'the old wording still reads');
  assert.equal(urgencyFromSchedule('Today Evening Dispatch'), 'today_evening');
});

test('a request raised with a schedule takes its urgency from it; nobody is asked', async () => {
  const { task } = await dispatchRequest({ schedule: 'Today Morning Dispatch' });
  const saved = await eventually(async () => (await Todo.findById(task._id).lean()).delivery);
  assert.equal(saved.urgency, 'today_morning');
  assert.equal(istHour(new Date(saved.dueBy)), 12);
  assert.equal(await Todo.countDocuments({ originKey: `delivery-urgency:${task._id}` }), 0);
});

test('without one, it starts at Today — the day it reached Dispatch — and the marketing person is asked to confirm; only they or Admin may answer; Dispatch hears it', async () => {
  const { task } = await dispatchRequest();
  const ask = await eventually(() => Todo.findOne({ originKey: `delivery-urgency:${task._id}`, completed: false }).lean());
  assert.ok(ask, 'a To-do for the marketing person');
  assert.match(ask.title, /^Confirm delivery urgency — ENQ-/);
  const fallback = (await Todo.findById(task._id).lean()).delivery;
  assert.equal(fallback.urgency, 'today', 'the default: Today');
  assert.equal(fallback.default, true);
  const arrived = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(task.createdAt));
  assert.equal(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(fallback.dueBy)), arrived, 'due the day it reached Dispatch');
  assert.ok(new Date(fallback.dueBy) > new Date(task.createdAt), 'never late the moment it lands');
  assert.equal(ask.priority, 'high');
  const set = (as, body) => api(`/api/workspace/todos/${task._id}/delivery`, { method: 'POST', as, body });

  assert.equal((await set('ravi', { urgency: 'today' })).status, 403, 'not Dispatch');
  assert.equal((await set('arun', { urgency: 'today' })).status, 403, 'not another marketing person');
  assert.equal((await set('nandhini', { urgency: 'next_week' })).status, 400, 'one of the five');

  /* The default is changed without a reason — it was the app's, not a person's. */
  const given = await set('nandhini', { urgency: 'tomorrow' });
  assert.equal(given.status, 200, given.json.message);
  assert.equal(given.json.data.delivery.urgency, 'tomorrow');
  assert.equal(given.json.data.delivery.default, undefined, 'no longer the default');
  assert.equal((await Todo.findById(ask._id)).completed, true, 'the To-do is done');
  const notices = (await api('/api/workspace/notices', { as: 'ravi' })).json.data;
  assert.ok(notices.some((notice) => notice.statusLabel === 'Delivery urgency set: Today → Tomorrow'), 'Dispatch hears it');

  assert.equal((await set('nandhini', { urgency: 'today_evening' })).status, 400, 'a change says why');
  const changed = await set('admin', { urgency: 'top_urgent', note: 'Buyer’s truck is at the gate' });
  assert.equal(changed.status, 200, changed.json.message);
  const after = await Todo.findById(task._id);
  assert.equal(after.delivery.urgency, 'top_urgent');
  assert.match(after.updates.at(-1).note, /Delivery urgency changed: Tomorrow → Top Most Urgent — Buyer’s truck is at the gate/);
});

test('confirming the default keeps Today and its due time, and answers the To-do', async () => {
  const { task } = await dispatchRequest();
  const ask = await eventually(() => Todo.findOne({ originKey: `delivery-urgency:${task._id}`, completed: false }).lean());
  const before = (await Todo.findById(task._id).lean()).delivery;
  const confirmed = await api(`/api/workspace/todos/${task._id}/delivery`, { method: 'POST', as: 'nandhini', body: { urgency: 'today' } });
  assert.equal(confirmed.status, 200, confirmed.json.message);
  assert.equal(confirmed.json.data.delivery.default, undefined);
  assert.equal(new Date(confirmed.json.data.delivery.dueBy).getTime(), new Date(before.dueBy).getTime(), 'the due time stands');
  assert.match(confirmed.json.data.updates.at(-1).note, /Delivery urgency confirmed: Today/);
  assert.equal((await Todo.findById(ask._id)).completed, true);
});

test('the delivery queue: late first, then Top Most Urgent, then by cut-off; the default sorts by its own cut-off, marked', async () => {
  await Todo.updateMany({ kind: 'invoice_dispatch' }, { $set: { completed: true } });
  const make = async (urgency) => {
    const { task } = await dispatchRequest();
    await eventually(() => Todo.findOne({ originKey: `delivery-urgency:${task._id}` }).lean());
    if (urgency) assert.equal((await api(`/api/workspace/todos/${task._id}/delivery`, { method: 'POST', as: 'nandhini', body: { urgency } })).status, 200);
    return String(task._id);
  };
  const unset = await make(null);
  const tomorrow = await make('tomorrow');
  const evening = await make('today_evening');
  const top = await make('top_urgent');
  const late = await make('today_morning');
  await Todo.updateOne({ _id: late }, { $set: { 'delivery.dueBy': new Date(Date.now() - 3600000) } });
  const morning = await make('today');
  await Todo.updateOne({ _id: morning }, { $set: { 'delivery.urgency': 'today_morning', 'delivery.dueBy': new Date(Date.now() + 3600000) } });
  /* Cut-offs fixed against now, so the order does not depend on the hour the test runs. */
  await Todo.updateOne({ _id: evening }, { $set: { 'delivery.dueBy': new Date(Date.now() + 2 * 3600000) } });
  await Todo.updateOne({ _id: tomorrow }, { $set: { 'delivery.dueBy': new Date(Date.now() + 26 * 3600000) } });
  await Todo.updateOne({ _id: unset }, { $set: { 'delivery.dueBy': new Date(Date.now() + 3 * 3600000) } });

  const reply = await api('/api/dispatch-planning/queue', { as: 'ravi' });
  assert.equal(reply.status, 200, reply.json.message);
  const order = reply.json.data.map((row) => String(row.task._id));
  assert.deepEqual(order, [late, top, morning, evening, unset, tomorrow].filter((id) => order.includes(id)));
  assert.equal(order.length, 6);
  const first = reply.json.data[0];
  assert.equal(first.delivery.late, true);
  assert.equal(first.delivery.label, 'Today Morning');
  assert.equal(first.delivery.by, 'Nandhini S');
  /* The row carries the request whole, so Dispatch moves its status from the queue; only marketing or Admin is offered the urgency. */
  assert.equal(first.task.kind, 'invoice_dispatch');
  assert.ok(Array.isArray(first.task.updates) && first.task.department === 'despatch');
  assert.ok(reply.json.data.every((row) => row.maySetUrgency === false), 'Dispatch reads the urgency, never sets it');
  const asMarketing = (await api('/api/dispatch-planning/queue', { as: 'nandhini' })).json.data;
  assert.ok(asMarketing.every((row) => row.maySetUrgency === true), 'her own buyers');
  const fallback = reply.json.data.find((row) => String(row.task._id) === unset).delivery;
  assert.equal(fallback.label, 'Today');
  assert.equal(fallback.default, true, 'marked as the default');
  assert.equal(fallback.by, null);
});
