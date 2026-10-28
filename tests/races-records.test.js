/**
 * Writes that race: the same record touched by several people in the same instant, on a real
 * replica set, so every transaction and lock does what it says [utils/transaction.js,
 * services/operationLock.service.js, utils/concurrency.js].
 *
 *   - a counter nobody has used yet, taken by twelve at once (the first number of a new year)
 *   - the resin store: twenty receipts at once, and two corrections that would both empty it
 *   - a mould run finished by five people at once: one finishes it, the shots count once
 *   - six updates written on one task at once: all kept, none refused
 *
 *   node --test tests/races-records.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'races-records-secret';

let rs;
let server;
let baseUrl;
const token = {};
const ids = {};
let Material;
let Mould;
let MouldRun;
let StockMovement;
let Todo;
let numbering;

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
let seq = 0;
const addMould = async () => {
  const made = await api('/api/moulds', { method: 'POST', as: 'siva', body: { mouldCode: `M-X${++seq}`, name: '400mm shirt hanger', cavities: 4, partWeightGrams: 30, runnerWeightGrams: 12, cycleTimeSeconds: 30 } });
  assert.equal(made.status, 201, made.json.message);
  return made.json.data;
};
const addMachine = async () => {
  const made = await api('/api/machines', { method: 'POST', as: 'siva', body: { code: `IM-X${++seq}`, name: 'Toshiba 150T', tonnage: 150 } });
  assert.equal(made.status, 201, made.json.message);
  return made.json.data;
};
const ok = (status) => status === 200 || status === 201;

test.before(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGO_URI = rs.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Material } = await import('../src/models/Material.js'));
  ({ default: Mould } = await import('../src/models/Mould.js'));
  ({ default: MouldRun } = await import('../src/models/MouldRun.js'));
  ({ default: StockMovement } = await import('../src/models/StockMovement.js'));
  ({ default: Todo } = await import('../src/models/Todo.js'));
  numbering = await import('../src/services/numbering.service.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['siva', 'Sivakumar', 'production'], ['ravi', 'Ravi Press', 'production']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: department === 'production' } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
    ids[key] = (await api('/api/auth/me', { as: key })).json.data.id;
  }
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await rs?.stop();
});

test('this is a replica set: the transactions and locks below are real', async () => {
  const { transactionsSupported } = await import('../src/utils/transaction.js');
  assert.equal(await transactionsSupported(), true);
});

test('a counter nobody has used, taken by twelve at once: twelve numbers in a row, no error', async () => {
  const numbers = await Promise.all(Array.from({ length: 12 }, () => numbering.nextNumber('RACE')));
  const seqs = numbers.map((number) => Number(number.split('-').at(-1))).sort((a, b) => a - b);
  assert.deepEqual(seqs, Array.from({ length: 12 }, (_, i) => i + 1));
});

test('twenty receipts at once: the balance is exact and every book entry carries its own running balance', async () => {
  const material = await Material.create({ name: 'PP H110MA', ratePerKg: 95, stockKg: 0, reorderKg: 10 });
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => api(`/api/materials/${material._id}/stock`, { method: 'POST', as: 'admin', body: { kind: 'receipt', kg: 5, reference: `GRN-${i}` } })));
  assert.ok(results.every((result) => ok(result.status)), results.map((result) => result.json.message).join(' | '));
  assert.equal((await Material.findById(material._id).lean()).stockKg, 100);
  const book = await StockMovement.find({ material: material._id }).lean();
  assert.equal(book.length, 20);
  assert.deepEqual(book.map((entry) => entry.balanceAfter).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => (i + 1) * 5), 'no two entries saw the same balance');
});

test('two corrections at once cannot both take the store below zero', async () => {
  const material = await Material.create({ name: 'HIPS', ratePerKg: 120, stockKg: 10 });
  const results = await Promise.all([1, 2].map(() => api(`/api/materials/${material._id}/stock`, { method: 'POST', as: 'admin', body: { kind: 'adjust', kg: -8, note: 'Count corrected' } })));
  assert.equal(results.filter((result) => ok(result.status)).length, 1, results.map((result) => `${result.status} ${result.json.message || ''}`).join(' | '));
  const refused = results.find((result) => result.status === 400);
  assert.match(refused.json.message, /below zero/);
  assert.equal((await Material.findById(material._id).lean()).stockKg, 2);
  assert.equal(await StockMovement.countDocuments({ material: material._id }), 1, 'no entry for the refused one');
});

test('five people finishing one run at once: one finishes it, the mould takes its shots once', async () => {
  const mould = await addMould();
  const machine = await addMachine();
  const started = await api('/api/mould-runs', { method: 'POST', as: 'siva', body: { mould: mould._id, machine: machine._id, counterStart: 1000 } });
  assert.equal(started.status, 201, started.json.message);
  const run = started.json.data;
  const results = await Promise.all(Array.from({ length: 5 }, () => api(`/api/mould-runs/${run._id}/finish`, { method: 'POST', as: 'siva', body: { counterEnd: 1500, goodPieces: 1900, rejectedPieces: 100 } })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409, 409, 409, 409], results.map((result) => result.json.message).join(' | '));
  assert.equal((await Mould.findById(mould._id).lean()).totalShots, 500);
  assert.equal((await MouldRun.findById(run._id).lean()).shotsCounted, 500);
});

test('six updates written on one task in the same instant: every one kept, none refused', async () => {
  const enquiry = await enquiryFor('Deva Fashions', '9840011004');
  const raised = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'When can it be ready?' } });
  assert.equal(raised.status, 201, raised.json.message);
  const task = raised.json.data.task._id;
  const notes = Array.from({ length: 6 }, (_, i) => `Update ${i + 1} from the press`);
  const results = await Promise.all(notes.map((note, i) => api(`/api/workspace/todos/${task}/update`, { method: 'POST', as: i % 2 ? 'siva' : 'ravi', body: { note } })));
  assert.deepEqual(results.map((result) => result.status), Array(6).fill(200), results.map((result) => result.json.message).join(' | '));
  const saved = await Todo.findById(task).lean();
  /* Beside the system's own line — the details the raise left out [handoff.service `bareDetails`]. */
  assert.deepEqual(saved.updates.filter((update) => update.kind !== 'notice').map((update) => update.note).sort(), [...notes].sort());
});
