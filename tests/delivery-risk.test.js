/**
 * Will the order make marketing's EDD [services/deliveryRisk.service.js]:
 *   - the work still to do, model by model and team by team, against the days left
 *   - an order of several models needs more days and is flagged well before one of one model
 *   - a team's own date past the EDD reads "will miss"; past the EDD reads late
 *   - the stage model learns from finished tasks
 *   - the reading reaches the enquiry page, the enquiry list, the queue and the at-risk list
 *
 *   node --test tests/delivery-risk.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'delivery-risk-test-secret';

const { assess, fitStage, stageDays, statusProgress, DEFAULT_STAGE_DAYS } = await import('../src/services/deliveryRisk.service.js');

const NOW = new Date('2026-10-24T06:00:00Z');
const day = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(NOW.getTime() + n * 86400000));
/** A model with these teams still before it, none started; Dispatch always last. */
const model = (name, teams = ['production'], dates = []) => ({
  model: name, stages: [...teams.map((stage) => ({ stage, progress: 0 })), { stage: 'despatch', progress: 0 }], dates,
});

test('one model moulded only, ten days out: on track — and watched from a day the reading names', () => {
  const reading = assess({ edd: day(10), models: [model('A')], now: NOW });
  assert.equal(reading.level, 'on_track');
  assert.equal(reading.daysLeft, 10);
  /* Production 4 working days + Dispatch 1, in calendar days. */
  assert.equal(reading.daysNeeded, Math.ceil((4 + 1) * 7 / 6));
  assert.ok(reading.watchFrom > day(0) && reading.watchFrom < day(10));
});

test('the same EDD with four models through Printing and Assembly: flagged — more models, more days, earlier warning', () => {
  const one = assess({ edd: day(10), models: [model('A', ['production', 'printing', 'assembling'])], now: NOW });
  const four = assess({ edd: day(10), models: ['A', 'B', 'C', 'D'].map((name) => model(name, ['production', 'printing', 'assembling'])), now: NOW });
  assert.ok(four.daysNeeded > one.daysNeeded, 'each further model adds days at every team');
  assert.ok(four.watchFrom < one.watchFrom, 'and the warning starts earlier');
  assert.equal(four.level, 'at_risk');
  assert.match(four.why, /May miss the EDD — about \d+ days of work for 4 models, 10 days left/);
  assert.ok(four.reasons.some((line) => /^Production: about \d+ days for 4 models$/.test(line)));
  /* A month out, the four-model order (about 24 days of work) is already in its warning window; one model is nowhere near it. */
  assert.equal(assess({ edd: day(30), models: [model('A', ['production', 'printing', 'assembling'])], now: NOW }).level, 'on_track');
  assert.equal(assess({ edd: day(30), models: ['A', 'B', 'C', 'D'].map((name) => model(name, ['production', 'printing', 'assembling'])), now: NOW }).level, 'watch');
});

test('work under way counts for what is left; a team’s own date past the EDD reads will miss; past the EDD is late', () => {
  const fresh = assess({ edd: day(6), models: [model('A'), model('B')], now: NOW });
  const underWay = assess({ edd: day(6), models: [model('A'), model('B')].map((row) => ({ ...row, stages: row.stages.map((stage) => (stage.stage === 'production' ? { ...stage, progress: 0.8 } : stage)) })), now: NOW });
  assert.ok(underWay.daysNeeded < fresh.daysNeeded);

  const missing = assess({ edd: day(12), models: [model('A', ['production', 'assembling'], [{ department: 'assembling', date: day(14), kind: 'completion' }])], now: NOW });
  assert.equal(missing.level, 'will_miss');
  assert.match(missing.why, /Assembly gave .* for A/);

  assert.equal(assess({ edd: day(-2), models: [model('A')], now: NOW }).level, 'late');
  assert.equal(assess({ edd: null, models: [model('A')], now: NOW }).level, 'none', 'no EDD from marketing — nothing to read against');
  const done = [{ model: 'A', stages: [{ stage: 'production', progress: 1 }, { stage: 'despatch', progress: 1 }], dates: [] }];
  assert.equal(assess({ edd: day(1), models: done, now: NOW }).level, 'none', 'everything has gone');
});

test('the stage model learns days per model from finished tasks, and keeps the defaults until it has enough', () => {
  assert.deepEqual(fitStage([{ days: 3, models: 1 }], DEFAULT_STAGE_DAYS.production), { ...DEFAULT_STAGE_DAYS.production, samples: 1, learned: false });
  /* Ten tasks: 3 days for one model, 2 more for each further model. */
  const samples = Array.from({ length: 10 }, (_, at) => ({ models: 1 + (at % 4), days: 3 + 2 * (at % 4) }));
  const fitted = fitStage(samples, DEFAULT_STAGE_DAYS.production);
  assert.deepEqual([fitted.base, fitted.perModel, fitted.learned], [3, 2, true]);
  assert.equal(stageDays('production', 3, { production: fitted }), 7);
  assert.equal(statusProgress('ask_edd', 'handed_printing'), 1, 'handed on: through');
  assert.equal(statusProgress('ask_edd', 'received'), 0);
  assert.ok(statusProgress('ask_edd', 'part1_ready') > 0 && statusProgress('ask_edd', 'part1_ready') <= 0.8);
  assert.equal(statusProgress('ask_edd', 'mould_issue'), 0, 'an issue is no progress');
});

/* ------------------------------ Through the API ------------------------------ */

let mongo;
let server;
let baseUrl;
const token = {};
const ids = {};
const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const indiaDay = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + n * 86400000));

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
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['siva', 'Sivakumar', 'production']]) {
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

test('a four-model order due in eight days is flagged on the enquiry, the list, the queue and the at-risk list; one model due in a fortnight is not', async () => {
  const make = async (name, mobile, items, eddIn) => {
    const buyer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name, mobile, assignedTo: ids.nandhini } })).json.data;
    const enquiry = (await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { customer: buyer._id, items, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() } })).json.data;
    const edd = await api(`/api/enquiries/${enquiry._id}/edd`, { method: 'POST', as: 'nandhini', body: { date: indiaDay(eddIn), note: 'Buyer’s date' } });
    assert.equal(edd.status, 200, edd.json.message);
    const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Make it', brief: { model: items[0].modelNumber } } });
    assert.equal(sent.status, 201, sent.json.message);
    return { enquiry, production: sent.json.data.task };
  };
  const big = await make('Four Model Knits', '9840055001', ['RK-1', 'RK-2', 'RK-3', 'RK-4'].map((modelNumber) => ({ modelNumber, quantity: 2000 })), 8);
  const routed = await api(`/api/workspace/todos/${big.production._id}/routing`, {
    method: 'POST', as: 'siva', body: { models: ['RK-1', 'RK-2', 'RK-3', 'RK-4'].map((name) => ({ model: name, printing: true, assembly: true })) },
  });
  assert.equal(routed.status, 200, routed.json.message);
  const small = await make('One Model Knits', '9840055002', [{ modelNumber: 'RS-1', quantity: 2000 }], 14);
  assert.equal((await api(`/api/workspace/todos/${small.production._id}/routing`, { method: 'POST', as: 'siva', body: { models: [{ model: 'RS-1' }] } })).status, 200);

  const page = (await api(`/api/enquiries/${big.enquiry._id}/handoffs`, { as: 'nandhini' })).json;
  assert.equal(page.risk.level, 'at_risk');
  assert.equal(page.risk.models, 4);
  assert.equal((await api(`/api/enquiries/${small.enquiry._id}/handoffs`, { as: 'nandhini' })).json.risk.level, 'on_track');

  const listed = (await api('/api/enquiries', { as: 'nandhini' })).json.data;
  assert.equal(listed.find((row) => row._id === big.enquiry._id).progress.risk.level, 'at_risk');

  const queue = (await api('/api/production/queue', { as: 'siva' })).json.data;
  assert.equal(queue.find((row) => row.enquiry.number === big.enquiry.number).delivery.level, 'at_risk');

  const atRisk = await api('/api/production/at-risk', { as: 'siva' });
  assert.equal(atRisk.status, 200, atRisk.json.message);
  assert.deepEqual(atRisk.json.data.map((row) => row.enquiry.number), [big.enquiry.number], 'only the one in danger');
  assert.equal(atRisk.json.meta.atRisk, 1);

  /* Assembly's completion date after the EDD: it will miss. */
  const { default: Todo } = await import('../src/models/Todo.js');
  await api(`/api/workspace/todos/${big.production._id}/edd`, { method: 'POST', as: 'siva', body: { date: indiaDay(2) } });
  const assembly = await Todo.findOne({ enquiry: big.enquiry._id, kind: 'ask_assembling_edd', completed: false });
  const late = await api(`/api/workspace/todos/${assembly._id}/edd`, { method: 'POST', as: 'admin', body: { date: indiaDay(10) } });
  assert.equal(late.status, 200, late.json.message);
  const after = (await api(`/api/enquiries/${big.enquiry._id}/handoffs`, { as: 'nandhini' })).json;
  assert.equal(after.risk.level, 'will_miss');
  assert.equal(after.production.edd.edd, indiaDay(8), 'the EDD is still marketing’s');
});
