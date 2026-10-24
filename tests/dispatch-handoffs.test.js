/**
 * The hand-ons into and out of Dispatch:
 *   - Production or Assembly saying Ready for Dispatch reaches the enquiry's Dispatch request —
 *     told on its task, moved to Goods Ready if it was waiting on the goods, its person notified
 *   - a part load raises Reception's LR copy; a further load tells the open LR task, not a twin
 *
 *   node --test tests/dispatch-handoffs.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchLoad } from './support/dispatchLoad.mjs';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'dispatch-handoffs-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
const ids = {};
let Todo;
let TaskNotice;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const enquiryFor = async (name, mobile) => {
  const buyer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name, mobile, assignedTo: ids.nandhini } })).json.data;
  return (await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { customer: buyer._id, requirement: { modelNumber: 'NH-400' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() } })).json.data;
};
const raise = async (enquiry, kind, brief = {}) => {
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind, note: 'Please', brief } });
  assert.equal(sent.status, 201, sent.json.message);
  return sent.json.data.task._id;
};
/* A load (Part Quantity Dispatched, Fully Dispatched, Dispatched) goes through the dispatch form, with its LR copy [support/dispatchLoad.mjs]. */
const move = (as, task, status, note = 'Moved on') => (['part_dispatched', 'fully_dispatched', 'dispatched'].includes(status)
  ? dispatchLoad({ baseUrl, token: token[as], taskId: task, status, note })
  : api(`/api/workspace/todos/${task}/status`, { method: 'POST', as, body: { status, note } }));

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  ({ default: TaskNotice } = await import('../src/models/TaskNotice.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['siva', 'Sivakumar', 'production'], ['anand', 'Anand Assembly', 'assembling'], ['ravi', 'Ravi Despatch', 'despatch'], ['rekha', 'Rekha Reception', 'reception'], ['murali', 'Murali Mould', 'mould'], ['asha', 'Asha Accounts', 'accounts']]) {
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

test('Production’s Ready for Dispatch moves the waiting Dispatch request to Goods Ready, and Dispatch hears it', async () => {
  const enquiry = await enquiryFor('Lakshmi Apparels', '9840030001');
  const dispatch = await raise(enquiry, 'invoice_dispatch', { quantity: '5000' });
  await Todo.updateOne({ _id: dispatch }, { $set: { user: ids.ravi } });
  const production = await raise(enquiry, 'ask_edd');

  const ready = await move('siva', production, 'ready_dispatch', 'All 5,000 packed');
  assert.equal(ready.status, 200, ready.json.message);
  const after = await Todo.findById(dispatch).lean();
  assert.equal(after.status, 'waiting_vehicle');
  assert.match(after.updates.at(-1).note, /Production.*Ready for Dispatch — All 5,000 packed/);
  assert.match(after.statusHistory.at(-1).note, /Ready for Dispatch/);
  const notice = await TaskNotice.findOne({ task: dispatch, recipient: ids.ravi }).lean();
  assert.ok(notice, 'the Dispatch person on the request is told');
  assert.equal(notice.statusLabel, 'Goods Ready — Waiting for Vehicle');
  /* And it is in the planner's ready groups, not the not-ready list. */
  const plan = (await api('/api/dispatch-planning/plan', { as: 'ravi' })).json.data;
  assert.ok(plan.groups.some((group) => group.stops.some((stop) => String(stop.task) === String(dispatch))));
});

test('Dispatch’s Ask Production is a readiness query of its own — Ready Now answers it and the request reads Goods Ready', async () => {
  const enquiry = await enquiryFor('Lakshmi Knits', '9840030011');
  const dispatch = await raise(enquiry, 'invoice_dispatch', { quantity: '5000' });
  const production = await raise(enquiry, 'ask_edd');
  const asked = await api(`/api/workspace/todos/${dispatch}/ask`, { method: 'POST', as: 'ravi', body: { kind: 'production_query', note: 'When will it be ready?' } });
  assert.equal(asked.status, 200, asked.json.message);
  assert.equal((await Todo.findById(dispatch).lean()).status, 'asked_production');
  const query = await Todo.findById(asked.json.raised._id).lean();
  assert.equal(query.kind, 'production_query');
  assert.equal(query.department, 'production');
  assert.equal(query.status, 'received');
  assert.deepEqual(query.askedFrom.map(String), [String(dispatch)]);
  assert.notEqual(String(query._id), String(production), 'beside the order’s Production task, not added onto it');
  assert.equal((await Todo.findById(production).lean()).status, 'received', 'the order’s own task is not moved');

  assert.equal((await move('siva', query._id, 'ready_on_date', 'Monday')).status, 400, 'Will Be Ready On needs its date');
  const on = await api(`/api/workspace/todos/${query._id}/status`, { method: 'POST', as: 'siva', body: { status: 'ready_on_date', note: 'On the press Monday', date: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10) } });
  assert.equal(on.status, 200, on.json.message);
  let request = await Todo.findById(dispatch).lean();
  assert.equal(request.status, 'asked_production', 'a date answers, but the request still waits for the goods');
  assert.match(request.updates.at(-1).note, /Production: Will Be Ready On \d{4}-\d{2}-\d{2} — On the press Monday/);
  assert.ok(await TaskNotice.exists({ task: query._id, recipient: ids.ravi, status: 'ready_on_date' }), 'Dispatch, who asked, hears it');
  assert.equal((await api(`/api/enquiries/${enquiry._id}`, { as: 'nandhini' })).json.data.edd ?? null, null, 'the answer is not the enquiry’s EDD');

  const now = await move('siva', query._id, 'ready_now', 'Packed and at the gate');
  assert.equal(now.status, 200, now.json.message);
  const closed = await Todo.findById(query._id).lean();
  assert.equal(closed.completed, true);
  assert.equal(closed.status, 'ready_now');
  request = await Todo.findById(dispatch).lean();
  assert.equal(request.status, 'waiting_vehicle', 'answered: the goods are ready');
  assert.equal(await Todo.countDocuments({ enquiry: enquiry._id, title: /^Done: .*next step\?/ }), 0, 'no "next step?" to-do for a query');
  const free = await move('ravi', dispatch, 'party_collect', 'Buyer collects at 4');
  assert.equal(free.status, 200, free.json.message);
});

test('a request already scheduled is told, not moved back; with no Dispatch person, the whole team hears it', async () => {
  const enquiry = await enquiryFor('Kavin Fashions', '9840030002');
  const dispatch = await raise(enquiry, 'invoice_dispatch');
  await Todo.updateOne({ _id: dispatch }, { $set: { status: 'today_dispatch' }, $unset: { user: 1 } });
  const assembly = await raise(enquiry, 'ask_assembling_edd');
  const ready = await move('anand', assembly, 'ready_dispatch', 'Hooks fitted');
  assert.equal(ready.status, 200, ready.json.message);
  const after = await Todo.findById(dispatch).lean();
  assert.equal(after.status, 'today_dispatch', 'already scheduled — left where it is');
  assert.match(after.updates.at(-1).note, /Assembly.*Ready for Dispatch — Hooks fitted/i);
  assert.ok(await TaskNotice.exists({ task: dispatch, recipient: ids.ravi }), 'the Dispatch team is told');
});

test('a part load raises Reception’s LR copy; the next load tells that LR task instead of raising a twin', async () => {
  const enquiry = await enquiryFor('Velan Knits', '9840030003');
  const dispatch = await raise(enquiry, 'invoice_dispatch', { quantity: '20000' });
  const part = await move('ravi', dispatch, 'part_dispatched', '8,000 on TN 39 AB 4521');
  assert.equal(part.status, 200, part.json.message);
  const lr = await Todo.find({ enquiry: enquiry._id, kind: 'lr_copy', completed: false }).lean();
  assert.equal(lr.length, 1, 'Reception has the LR copy for the part load');

  const rest = await move('ravi', dispatch, 'fully_dispatched', 'Remaining 12,000 by KPN');
  assert.equal(rest.status, 200, rest.json.message);
  const after = await Todo.find({ enquiry: enquiry._id, kind: 'lr_copy', completed: false }).lean();
  assert.equal(after.length, 1, 'still one LR task');
  assert.ok(after[0].updates.some((entry) => /Fully Dispatched by Ravi Despatch.*Remaining 12,000 by KPN/.test(entry.note)), 'told of the further load');
  assert.match(after[0].updates.at(-1).note, /LR copy uploaded by Ravi Despatch \(Dispatch\) with the load/, 'with its LR copy, for Reception to send');
  assert.equal(after[0].status, 'received');
});

test('the department that asked hears every move on the task it asked for', async () => {
  const enquiry = await enquiryFor('Arul Exports', '9840030004');
  const dispatch = await raise(enquiry, 'invoice_dispatch');
  await api(`/api/workspace/todos/${dispatch}/ask`, { method: 'POST', as: 'ravi', body: { kind: 'production_query', note: 'Ready when?' } });
  const production = await Todo.findOne({ enquiry: enquiry._id, kind: 'production_query', completed: false }).lean();
  assert.deepEqual(production.askedFrom.map(String), [String(dispatch)]);
  const moved = await move('siva', production._id, 'planning', 'On the machine Monday');
  assert.equal(moved.status, 200, moved.json.message);
  const notice = await TaskNotice.findOne({ task: production._id, recipient: ids.ravi, status: 'planning' }).lean();
  assert.ok(notice, 'Dispatch, who asked, hears Planning');
});

test('Mould Ready tells the enquiry’s Production task, and Production hears it', async () => {
  const enquiry = await enquiryFor('Sri Murugan Garments', '9840030005');
  const production = await raise(enquiry, 'ask_edd');
  const mould = await raise(enquiry, 'mould_issue', { problem: 'Hook cavity flashing' });
  const ready = await move('murali', mould, 'mould_ready', 'Cavity re-polished');
  assert.equal(ready.status, 200, ready.json.message);
  const task = await Todo.findById(production).lean();
  assert.match(task.updates.at(-1).note, /Mould.*: Mould Ready — Cavity re-polished/);
  assert.equal(task.status, 'received', 'nothing moved — that is Production’s call');
  assert.ok(await TaskNotice.exists({ task: production, recipient: ids.siva }), 'Production is told');
});

test('Payment Confirmed with the order still held for its money gives Accounts a task to record the receipt', async () => {
  const { default: SalesOrder } = await import('../src/models/SalesOrder.js');
  const enquiry = await enquiryFor('Velan Exports', '9840030006');
  const order = new mongoose.Types.ObjectId();
  await SalesOrder.collection.insertOne({ _id: order, number: 'SO-TEST-0001', enquiry: new mongoose.Types.ObjectId(enquiry._id), status: 'approved_for_production', paymentPlan: { advancePercent: 50 }, lines: [{ _id: new mongoose.Types.ObjectId(), modelNumber: 'NH-400', quantity: 10000, unitPrice: 1 }] });
  const clarify = await raise(enquiry, 'ac_clarify');
  const confirmed = await move('asha', clarify, 'confirmed', 'UTR 4455 for 5,000 seen in the bank');
  assert.equal(confirmed.status, 200, confirmed.json.message);
  const ask = await Todo.findOne({ originKey: `record-receipt:${order}`, completed: false }).lean();
  assert.ok(ask, 'Accounts is asked to record the receipt');
  assert.equal(String(ask.user), ids.asha);
  assert.match(ask.title, /Record the receipt for SO-TEST-0001 — Production and Dispatch is waiting on it/);
  assert.match(ask.notes, /₹5,000 short/);
  /* Once only, however many times it is confirmed. */
  await move('asha', clarify, 'statement_required', 'Asked for the statement');
  await move('asha', clarify, 'confirmed', 'Confirmed again');
  assert.equal(await Todo.countDocuments({ originKey: `record-receipt:${order}`, completed: false }), 1);
});

test('Assembly asks Production from its own task: a query of its own, and Assembly keeps working meanwhile', async () => {
  const enquiry = await enquiryFor('Ezhil Garments', '9840030012');
  const assembly = await raise(enquiry, 'ask_assembling_edd');
  const asked = await api(`/api/workspace/todos/${assembly}/ask`, { method: 'POST', as: 'anand', body: { kind: 'production_query', note: 'When do the bodies come?' } });
  assert.equal(asked.status, 200, asked.json.message);
  assert.equal(asked.json.raised.kind, 'production_query');
  assert.equal((await Todo.findById(assembly).lean()).status, 'asked', 'the ask moves nothing on Assembly’s task');
  assert.equal(await Todo.countDocuments({ enquiry: enquiry._id, kind: 'ask_edd' }), 0, 'no Production task of the order raised for it');
  const started = await move('anand', assembly, 'goods_received', 'Spares in');
  assert.equal(started.status, 200, 'Assembly is not held by its own question');

  const answered = await api(`/api/workspace/todos/${asked.json.raised._id}/status`, { method: 'POST', as: 'siva', body: { status: 'planning', note: 'On the press tomorrow' } });
  assert.equal(answered.status, 200, answered.json.message);
  const line = (await Todo.findById(assembly).lean()).updates.at(-1);
  assert.match(line.note, /Production: Planning — On the press tomorrow/);
  assert.ok(await TaskNotice.exists({ task: asked.json.raised._id, recipient: ids.anand, status: 'planning' }), 'Assembly hears it');
});

test('Done on a readiness query reads Ready Now and answers the team that asked', async () => {
  const enquiry = await enquiryFor('Mullai Tex', '9840030013');
  const dispatch = await raise(enquiry, 'invoice_dispatch');
  const asked = await api(`/api/workspace/todos/${dispatch}/ask`, { method: 'POST', as: 'ravi', body: { kind: 'assembling_query', note: 'Clips done?' } });
  assert.equal(asked.status, 200, asked.json.message);
  assert.equal((await Todo.findById(dispatch).lean()).status, 'asked_assembling');
  const done = await api(`/api/workspace/todos/${asked.json.raised._id}/done`, { method: 'POST', as: 'anand', body: { note: 'All clipped' } });
  assert.equal(done.status, 200, done.json.message);
  const query = await Todo.findById(asked.json.raised._id).lean();
  assert.equal(query.status, 'ready_now');
  assert.equal((await Todo.findById(dispatch).lean()).status, 'waiting_vehicle');
});

test('a load is sent from the dispatch form: models and pieces, how it travels, and its LR copy or proof of delivery', async () => {
  const enquiry = await enquiryFor('Form Knits', '9840030091');
  const dispatch = await raise(enquiry, 'invoice_dispatch', { quantity: '5000' });
  /* A bare status is refused: the form is the only way a load is said. */
  const bare = await api(`/api/workspace/todos/${dispatch}/status`, { method: 'POST', as: 'ravi', body: { status: 'dispatched', note: 'Gone' } });
  assert.equal(bare.status, 400);
  assert.match(bare.json.message, /given from the dispatch form/);
  const sheet = (await api(`/api/workspace/todos/${dispatch}/dispatch`, { as: 'ravi' })).json.data;
  assert.deepEqual(sheet.modes.map((mode) => [mode.key, mode.proofLabel]), [['transporter', 'LR copy'], ['own_vehicle', 'Proof of delivery'], ['party_collects', 'Signed receipt / photo']]);
  assert.equal(sheet.plan, 'together');
  assert.deepEqual(sheet.models.map((row) => row.model), ['NH-400']);

  const send = (fields, file = true) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
    if (file) form.append('file', new Blob(['%PDF-1.4 pod'], { type: 'application/pdf' }), 'pod.pdf');
    return fetch(`${baseUrl}/api/workspace/todos/${dispatch}/dispatch`, { method: 'POST', headers: { Authorization: `Bearer ${token.ravi}` }, body: form })
      .then(async (response) => ({ status: response.status, json: await response.json() }));
  };
  assert.equal((await send({ status: 'part_dispatched', mode: 'own_vehicle', lines: [{ model: 'NH-400', quantity: 2000 }] }, false)).status, 400, 'no proof of delivery, no load');
  assert.equal((await send({ status: 'part_dispatched', mode: 'by_air', lines: [{ model: 'NH-400', quantity: 2000 }] })).status, 400, 'a mode the plant uses');
  assert.equal((await send({ status: 'part_dispatched', mode: 'own_vehicle', lines: [] })).status, 400, 'tick the models');
  assert.equal((await send({ status: 'part_dispatched', mode: 'own_vehicle', lines: [{ model: 'NOPE-1', quantity: 10 }] })).status, 400, 'only the order’s models');

  /* Our own vehicle: the proof of delivery is the record — no LR task for Reception. */
  const own = await send({ status: 'part_dispatched', mode: 'own_vehicle', lines: [{ model: 'NH-400', quantity: 2000 }], note: 'TN 39 AB 4521' });
  assert.equal(own.status, 200, own.json.message);
  assert.equal(own.json.data.status, 'part_dispatched');
  assert.equal(own.json.data.loads.length, 1);
  assert.deepEqual([own.json.data.loads[0].mode, own.json.data.loads[0].lines[0].quantity], ['own_vehicle', 2000]);
  assert.equal(await Todo.countDocuments({ enquiry: enquiry._id, kind: 'lr_copy' }), 0, 'no LR to send for our own delivery');
  const papers = (await api(`/api/workspace/todos/${dispatch}/documents`, { as: 'ravi' })).json.data;
  assert.equal(papers[0].docType, 'proof_of_delivery');
  assert.equal((await api(`/api/workspace/todos/${dispatch}/dispatch`, { as: 'ravi' })).json.data.models[0].sent, 2000, 'the sheet counts what has gone');

  /* By transporter: the LR copy goes to Reception's LR Copy task, received, for Reception to send. */
  const rest = await send({ status: 'fully_dispatched', mode: 'transporter', lines: [{ model: 'NH-400', quantity: 3000 }] });
  assert.equal(rest.status, 200, rest.json.message);
  const lr = await Todo.findOne({ enquiry: enquiry._id, kind: 'lr_copy', completed: false });
  assert.ok(lr?.resultFile, 'the LR copy is on Reception’s task');
  assert.equal(lr.status, 'received');
  const sent = await api(`/api/workspace/todos/${lr._id}/result/send`, { method: 'POST', as: 'rekha' });
  assert.equal(sent.status, 200, sent.json.message);
  assert.ok(Array.isArray(sent.json.sent), 'said per channel');
  assert.equal((await api(`/api/workspace/todos/${lr._id}/result/send`, { method: 'POST', as: 'ravi' })).status, 403, 'Reception sends it');
});
