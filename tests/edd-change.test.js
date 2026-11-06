/**
 * EDD change requests [services/eddChange.service.js]: Production asks to move the EDD with a
 * date and a reason; Admin or the marketing person agrees (the EDD moves, its history kept),
 * replies, or keeps it; the team answers a reply.
 *
 *   node --test tests/edd-change.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'edd-change-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
const ids = {};
let enquiry;
let soTask;
let Todo;
let EddChange;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const type = response.headers.get('content-type') || '';
  return { status: response.status, type, json: type.includes('json') ? await response.json().catch(() => ({})) : {} };
};
const status = (taskId, as, value, note) => api(`/api/workspace/todos/${taskId}/status`, { method: 'POST', as, body: { status: value, ...(note ? { note } : {}) } });
/* The SO upload books a draft: the SO team verifies it, marketing confirms it [soDraftReview.service]. */
async function readDraft(orderId) {
  const verified = await api(`/api/orders/${orderId}/draft/verify`, { method: 'POST', as: 'priya', body: {} });
  assert.equal(verified.status, 200, verified.json.message);
  const confirmed = await api(`/api/orders/${orderId}/draft/confirm`, { method: 'POST', as: 'nandhini', body: {} });
  assert.equal(confirmed.status, 200, confirmed.json.message);
  return confirmed.json.data;
}
const openTask = (kind) => Todo.findOne({ enquiry: enquiry._id, kind, completed: false }).sort({ createdAt: -1 });


test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  ({ default: EddChange } = await import('../src/models/EddChange.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [
    ['nandhini', 'Nandhini S', 'marketing'], ['kavi', 'Kavi M', 'marketing'], ['priya', 'Priya Orders', 'order_confirmation'], ['siva', 'Sivakumar', 'production'],
  ]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: department === 'production' } });
    assert.equal(made.status, 201, made.json.message);
    ids[key] = made.json.data.id;
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Aruna Knits', mobile: '9840011001', assignedTo: ids.nandhini } })).json.data;
  enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id, items: [{ modelNumber: 'NPT-410V', colour: 'Black' }], nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini',
    body: { kind: 'po_so', note: 'PO in', brief: { contactPerson: 'Sasi', mobile: '9876543210', paymentTerms: 'Credit — nothing before dispatch', productionConfirmed: true, items: [{ model: 'NPT-410V', quantity: '10000', price: '2.4' }] } },
  });
  soTask = sent.json.data.task;
  const form = new FormData();
  form.append('file', new Blob(['%PDF-1.4 so'], { type: 'application/pdf' }), 'SO.pdf');
  await fetch(`${baseUrl}/api/workspace/todos/${soTask._id}/result`, { method: 'POST', headers: { Authorization: `Bearer ${token.priya}` }, body: form });
  const order = await mongoose.connection.collection('salesorders').findOne({ enquiry: new mongoose.Types.ObjectId(enquiry._id) });
  await readDraft(order._id);
  assert.ok(await openTask('ask_edd'), 'Production has its task');
  const edd = await api(`/api/enquiries/${enquiry._id}/edd`, { method: 'POST', as: 'nandhini', body: { date: day(10) } });
  assert.equal(edd.status, 200, edd.json.message);
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

const day = (ahead) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + ahead * 86400000));

test('Production asks to move the EDD with a date and why; Admin and the marketing person hear it', async () => {
  const task = await openTask('ask_edd');
  const bare = await api(`/api/workspace/todos/${task._id}/edd-changes`, { method: 'POST', as: 'siva', body: { date: day(15) } });
  assert.equal(bare.status, 400, 'a reason is asked');
  assert.equal((await api(`/api/workspace/todos/${task._id}/edd-changes`, { method: 'POST', as: 'nandhini', body: { date: day(15), reason: 'Not mine' } })).status, 403, 'the team asks, not marketing');
  const asked = await api(`/api/workspace/todos/${task._id}/edd-changes`, { method: 'POST', as: 'siva', body: { date: day(15), reason: 'Mould repair — the cavity cracked' } });
  assert.equal(asked.status, 201, asked.json.message);
  assert.equal(asked.json.data.currentEdd, day(10));
  assert.equal(asked.json.data.requestedDate, day(15));
  assert.equal(asked.json.data.mayWithdraw, true);
  const again = await api(`/api/workspace/todos/${task._id}/edd-changes`, { method: 'POST', as: 'siva', body: { date: day(16), reason: 'Another ask' } });
  assert.equal(again.status, 400, 'one open ask at a time');

  for (const who of ['admin', 'nandhini']) {
    const attention = (await api('/api/departments/mine/dashboard', { as: who })).json.data.attention;
    assert.ok(attention.eddChanges.some((row) => row._id === asked.json.data._id), `${who} has it under Needs your action`);
  }
  assert.equal((await api('/api/departments/mine/dashboard', { as: 'kavi' })).json.data.attention.eddChanges.length, 0, 'not another marketing person');
  const track = await api(`/api/enquiries/${enquiry._id}/edd-track`, { as: 'nandhini' });
  assert.equal(track.status, 200, track.json.message);
  assert.equal(track.json.data.open.length, 1);
  assert.equal(track.json.data.open[0].mayAgree, true);
});

test('the marketing person replies with another date; Production answers; the reply goes back and forth', async () => {
  const change = await EddChange.findOne({ enquiry: enquiry._id, status: 'open' });
  assert.equal((await api(`/api/edd-changes/${change._id}/agree`, { method: 'POST', as: 'kavi', body: {} })).status, 404);
  const reply = await api(`/api/edd-changes/${change._id}/reply`, { method: 'POST', as: 'nandhini', body: { body: 'The buyer can wait till the 13th at most', date: day(13) } });
  assert.equal(reply.status, 200, reply.json.message);
  assert.equal(reply.json.data.waitingOn, 'team');
  const theirs = (await api('/api/departments/mine/dashboard', { as: 'siva' })).json.data.attention;
  assert.ok(theirs.eddReplies.some((row) => row._id === String(change._id)), 'the reply is at the top for Production');
  const back = await api(`/api/edd-changes/${change._id}/reply`, { method: 'POST', as: 'siva', body: { body: 'We can do the 14th with a second shift', date: day(14) } });
  assert.equal(back.status, 200, back.json.message);
  assert.equal(back.json.data.requestedDate, day(14), 'the team’s new date is its ask now');
  assert.equal(back.json.data.waitingOn, 'office');
});

test('agreed: the EDD moves to the date, the history keeps the first promise', async () => {
  const change = await EddChange.findOne({ enquiry: enquiry._id, status: 'open' });
  const agreed = await api(`/api/edd-changes/${change._id}/agree`, { method: 'POST', as: 'nandhini', body: { note: 'Buyer told' } });
  assert.equal(agreed.status, 200, agreed.json.message);
  assert.equal(agreed.json.data.status, 'agreed');
  assert.equal(agreed.json.data.agreedDate, day(14));
  const saved = await mongoose.connection.collection('enquiries').findOne({ _id: new mongoose.Types.ObjectId(enquiry._id) });
  assert.equal(saved.edd.date, day(14), 'the EDD moved');
  const track = (await api(`/api/enquiries/${enquiry._id}/edd-track`, { as: 'admin' })).json.data;
  assert.equal(track.first, day(10));
  assert.equal(track.current, day(14));
  assert.equal(track.moved, 1);
  const task = await openTask('ask_edd');
  assert.ok(task.updates.some((entry) => /EDD change agreed/.test(entry.note || '')), 'said on the task');
  assert.equal((await api(`/api/edd-changes/${change._id}/reply`, { method: 'POST', as: 'siva', body: { body: 'thanks' } })).status, 400, 'answered — closed');
});

test('kept: the EDD stands with why; a withdrawn ask is gone', async () => {
  const task = await openTask('ask_edd');
  const asked = await api(`/api/workspace/todos/${task._id}/edd-changes`, { method: 'POST', as: 'siva', body: { date: day(20), reason: 'Resin short' } });
  assert.equal((await api(`/api/edd-changes/${asked.json.data._id}/keep`, { method: 'POST', as: 'admin', body: {} })).status, 400, 'says why');
  const kept = await api(`/api/edd-changes/${asked.json.data._id}/keep`, { method: 'POST', as: 'admin', body: { note: 'Buy resin locally — the date holds' } });
  assert.equal(kept.json.data.status, 'kept');
  assert.equal((await mongoose.connection.collection('enquiries').findOne({ _id: new mongoose.Types.ObjectId(enquiry._id) })).edd.date, day(14), 'unchanged');
  const third = await api(`/api/workspace/todos/${task._id}/edd-changes`, { method: 'POST', as: 'siva', body: { date: day(18), reason: 'Press down' } });
  const withdrawn = await api(`/api/edd-changes/${third.json.data._id}/withdraw`, { method: 'POST', as: 'siva' });
  assert.equal(withdrawn.json.data.status, 'withdrawn');
  const list = await api(`/api/workspace/todos/${task._id}/edd-changes`, { as: 'siva' });
  assert.equal(list.json.data.length, 3);
  assert.equal(list.json.mayAsk, true);
});
