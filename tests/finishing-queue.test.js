/**
 * Printing's and Assembly's queues [controllers/finishingQueue.controller.js]: one row per open
 * task in EDD order — the date the team works to (its own, else the enquiry's), where the goods
 * are model by model (expected from Production or Printing, the day each came), and what is
 * handed on. Read by the plant; by marketing for their own buyers.
 *
 *   node --test tests/finishing-queue.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'finishing-queue-test-secret';

let mongo;
let server;
let baseUrl;
let Todo;
const token = {};
const ids = {};
let enquiry;
let production;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const indiaDay = (offset = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + offset * 86400000));
const queue = async (team, as = 'siva') => {
  const reply = await api(`/api/production/queue/${team}`, { as });
  assert.equal(reply.status, 200, reply.json.message);
  return reply.json;
};
const openTask = (kind) => Todo.findOne({ enquiry: enquiry._id, kind, completed: false });
const move = (task, as, status, models, note = 'Moving it on') => api(`/api/workspace/todos/${task}/status`, { method: 'POST', as, body: { status, note, ...(models ? { models } : {}) } });

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
  for (const [key, name, department] of [
    ['nandhini', 'Nandhini S', 'marketing'], ['kavi', 'Kavi R', 'marketing'], ['siva', 'Sivakumar', 'production'],
    ['pandi', 'Pandi Print', 'printing'], ['anand', 'Anand Assembly', 'assembling'],
  ]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: department === 'production' } });
    assert.equal(made.status, 201, made.json.message);
    ids[key] = made.json.data.id;
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Aruna Knits', mobile: '9840011001', assignedTo: ids.nandhini } })).json.data;
  enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: {
      customer: customer._id,
      items: [{ modelNumber: 'NPT-410V', quantity: 5000 }, { modelNumber: 'NPT-400S', quantity: 3000 }, { modelNumber: 'NPT-300K', quantity: 2000 }],
      nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString(),
    },
  })).json.data;
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Buyer needs the date', brief: { model: 'NPT-410V', quantity: '10000' } },
  });
  assert.equal(sent.status, 201, sent.json.message);
  production = sent.json.data.task;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('empty until Production routes a model there; the team must be Printing or Assembly', async () => {
  assert.equal((await queue('printing')).data.length, 0);
  assert.equal((await queue('assembling')).data.length, 0);
  assert.equal((await api('/api/production/queue/quality', { as: 'siva' })).status, 400);
});

test('routed: Printing queues the printed models, Assembly the assembled ones, each knowing whom the goods come from', async () => {
  /* 410V printed then assembled; 400S assembled straight from Production; 300K neither. */
  const routed = await api(`/api/workspace/todos/${production._id}/routing`, {
    method: 'POST', as: 'siva',
    body: { models: [{ model: 'NPT-410V', printing: true, assembly: true }, { model: 'NPT-400S', assembly: true }, { model: 'NPT-300K' }] },
  });
  assert.equal(routed.status, 200, routed.json.message);
  const handOver = await api(`/api/workspace/todos/${production._id}/status`, { method: 'POST', as: 'siva', body: { status: 'ready_on_date', note: 'Press 4', date: indiaDay(5) } });
  assert.equal(handOver.status, 200, handOver.json.message);

  const printing = await queue('printing');
  assert.equal(printing.data.length, 1);
  const [print] = printing.data;
  assert.equal(print.enquiry.number, enquiry.number);
  assert.deepEqual(print.models.map((row) => row.model), ['NPT-410V']);
  assert.equal(print.models[0].from, 'production');
  assert.equal(print.models[0].expected, indiaDay(5), 'the day Production said it hands over');
  assert.equal(print.models[0].received, null);
  assert.equal(print.models[0].next, 'assembling', 'printed, it goes on to Assembly');
  assert.equal(print.models[0].givenLabel, 'Hand-over');
  assert.equal(print.goods.inHand, false);
  assert.equal(print.goods.expected, indiaDay(5));
  assert.equal(print.handsOn, true);
  assert.equal(print.edd, null, 'no date of its own and none on the enquiry yet');
  assert.equal(print.band, 'none');
  assert.match(print.link, new RegExp(`/production/workflow/${production._id}`));
  assert.match(print.summary, /NPT-410V still with Production, due/);
  assert.equal(printing.meta.goods.waiting, 1);
  assert.equal(printing.meta.label, 'Printing');

  const assembly = await queue('assembling');
  assert.equal(assembly.data.length, 1);
  const [asm] = assembly.data;
  assert.deepEqual(asm.models.map((row) => row.model).sort(), ['NPT-400S', 'NPT-410V']);
  const v410 = asm.models.find((row) => row.model === 'NPT-410V');
  const s400 = asm.models.find((row) => row.model === 'NPT-400S');
  assert.equal(v410.from, 'printing');
  assert.equal(v410.next, null, 'Assembly is last');
  assert.equal(v410.givenLabel, 'EDD');
  assert.equal(s400.from, 'production');
  assert.equal(s400.expected, indiaDay(5));
  assert.deepEqual(asm.goods.from.sort(), ['printing', 'production']);
  assert.equal(asm.handsOn, false);
});

test('the goods come: Production hands over one model, the row says which came and which is still due', async () => {
  const handed = await move(production._id, 'siva', 'handed_assembly', ['NPT-400S'], 'First lot');
  assert.equal(handed.status, 200, handed.json.message);
  const [asm] = (await queue('assembling')).data;
  assert.equal(asm.models.find((row) => row.model === 'NPT-400S').received, indiaDay(0));
  assert.equal(asm.models.find((row) => row.model === 'NPT-410V').received, null);
  assert.equal(asm.goods.received, 1);
  assert.equal(asm.goods.total, 2);
  assert.equal(asm.goods.inHand, true);
  assert.equal(asm.goods.all, false);
  assert.match(asm.summary, /NPT-410V still with Printing/);
  assert.match(asm.summary, /NPT-400S: Asked/);
});

test('the queue is in the order of the date the team works to — its own once given, the enquiry’s until then', async () => {
  /* Printing's hand-over date to Assembly reaches Assembly's row as the day the goods are expected. */
  const printing = await openTask('ask_printing');
  const handOver = await api(`/api/workspace/todos/${printing._id}/edd`, { method: 'POST', as: 'pandi', body: { date: indiaDay(4), note: 'Two colours' } });
  assert.equal(handOver.status, 200, handOver.json.message);
  let [print] = (await queue('printing')).data;
  assert.equal(print.edd.date, indiaDay(4));
  assert.equal(print.edd.source, 'team');
  assert.equal(print.edd.label, 'Hand-over');
  assert.equal(print.band, 'week');
  let [asm] = (await queue('assembling')).data;
  assert.equal(asm.models.find((row) => row.model === 'NPT-410V').expected, indiaDay(4));

  /* Assembly, last in the chain, gives the EDD; the enquiry's EDD follows and the row is banded by it. */
  const assembly = await openTask('ask_assembling_edd');
  const edd = await api(`/api/workspace/todos/${assembly._id}/edd`, { method: 'POST', as: 'anand', body: { date: indiaDay(6), note: 'Clips in' } });
  assert.equal(edd.status, 200, edd.json.message);
  [asm] = (await queue('assembling')).data;
  assert.equal(asm.edd.date, indiaDay(6));
  assert.equal(asm.edd.label, 'EDD');
  assert.equal(asm.band, 'week');
  assert.equal(asm.models.find((row) => row.model === 'NPT-410V').edd, indiaDay(6), 'the enquiry’s EDD for the model — the latest its teams gave');
  const meta = (await queue('assembling')).meta;
  assert.equal(meta.bands.week, 1);
  assert.equal(meta.noDate, 0);

  /* A second job with no date of its own but an enquiry EDD sorts by that, after the sooner one. */
  const other = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: enquiry.customer?._id || enquiry.customer, items: [{ modelNumber: 'NPT-200A', quantity: 1000 }], nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  const sent = await api(`/api/enquiries/${other._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Second', brief: { model: 'NPT-200A' } } });
  assert.equal(sent.status, 201, sent.json.message);
  const second = sent.json.data.task;
  assert.equal((await api(`/api/workspace/todos/${second._id}/routing`, { method: 'POST', as: 'siva', body: { models: [{ model: 'NPT-200A', assembly: true }] } })).status, 200);
  assert.equal((await api(`/api/enquiries/${other._id}/edd/models`, { method: 'POST', as: 'nandhini', body: { models: [{ model: 'NPT-200A', date: indiaDay(1) }], note: 'Buyer wants it' } })).status, 200);
  const rows = (await queue('assembling')).data;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].enquiry.number, other.number, 'the sooner date first');
  assert.equal(rows[0].edd.source, 'enquiry');
  assert.equal(rows[0].edd.date, indiaDay(1));
  assert.equal(rows[1].enquiry.number, enquiry.number);
  print = (await queue('printing')).data[0];
  assert.equal(print.enquiry.number, enquiry.number, 'Printing has only the printed model');
});

test('Printing hands over to Assembly: Printing’s row says so, Assembly’s says the goods came', async () => {
  const printing = await openTask('ask_printing');
  const handed = await move(printing._id, 'pandi', 'handed_assembly', null, 'Printed');
  assert.equal(handed.status, 200, handed.json.message);
  const [asm] = (await queue('assembling')).data.filter((row) => row.enquiry.number === enquiry.number);
  assert.equal(asm.models.find((row) => row.model === 'NPT-410V').received, indiaDay(0));
  assert.equal(asm.goods.all, true);
  const printRows = (await queue('printing')).data;
  if (printRows.length) {
    assert.equal(printRows[0].models[0].handed, true);
    assert.equal(printRows[0].task.statusLabel, 'Handed to Assembly');
  }
});

test('read by the plant and the in charge; a salesperson sees their own buyers only', async () => {
  assert.equal((await queue('assembling', 'anand')).data.length, 2);
  assert.equal((await queue('assembling', 'pandi')).data.length, 2, 'the finishing desk reads both queues');
  assert.equal((await queue('assembling', 'nandhini')).data.length, 2, 'her own buyer');
  assert.equal((await queue('assembling', 'kavi')).data.length, 0, 'not her buyer');
});
