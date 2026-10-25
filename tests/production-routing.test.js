/**
 * Production decides, model by model, what follows moulding — printing, assembly, both (printing
 * first) or neither — before it gives any date. Printing's and Assembly's tasks are raised from
 * that decision. A team that hands on gives the next team a hand-over date; the last team in the
 * chain gives the enquiry's EDD [handoff.service `decideRouting`, `passHandover`].
 *
 *   node --test tests/production-routing.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'routing-test-secret';

let mongo;
let server;
let baseUrl;
let Todo;
let Enquiry;
const token = {};
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
const route = (models, as = 'siva') => api(`/api/workspace/todos/${production._id}/routing`, { method: 'POST', as, body: { models } });
const openTask = (kind) => Todo.findOne({ enquiry: enquiry._id, kind, completed: false });
const eddOf = async () => (await Enquiry.findById(enquiry._id).select('edd').lean()).edd;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  ({ default: Enquiry } = await import('../src/models/Enquiry.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [
    ['nandhini', 'Nandhini S', 'marketing'], ['siva', 'Sivakumar', 'production'],
    ['priya', 'Priya Print', 'printing'], ['anand', 'Anand Assembly', 'assembling'],
  ]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: department === 'production' } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Aruna Knits', mobile: '9840011001', assignedTo: me } })).json.data;
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

test('Production must decide printing and assembly before it gives any date', async () => {
  const early = await api(`/api/workspace/todos/${production._id}/edd`, { method: 'POST', as: 'siva', body: { date: indiaDay(4) } });
  assert.equal(early.status, 400);
  assert.match(early.json.message, /Decide first/);
  const moved = await api(`/api/workspace/todos/${production._id}/status`, { method: 'POST', as: 'siva', body: { status: 'ready_on_date', note: 'Machine 4 free', date: indiaDay(4) } });
  assert.equal(moved.status, 400);
  /* A move without a date is fine — the press keeps running while Production decides. */
  const accepted = await api(`/api/workspace/todos/${production._id}/status`, { method: 'POST', as: 'siva', body: { status: 'accepted', note: 'Mould on the shelf' } });
  assert.equal(accepted.status, 200, accepted.json.message);
});

test('the routing form lists every model on the enquiry; only Production decides', async () => {
  const form = await api(`/api/workspace/todos/${production._id}/routing`, { as: 'siva' });
  assert.equal(form.status, 200, form.json.message);
  assert.deepEqual(form.json.data.models.map((row) => row.model).sort(), ['NPT-300K', 'NPT-400S', 'NPT-410V']);
  assert.equal(form.json.data.routing, null);
  assert.equal((await route([{ model: 'NPT-410V', printing: true }], 'nandhini')).status, 403, 'marketing does not route Production’s task');
  assert.equal((await route([])).status, 400);
});

test('per model: printed models go to Printing, assembled ones to Assembly; printed + assembled goes through both', async () => {
  const routed = await route([
    { model: 'NPT-410V', printing: true, assembly: true },
    { model: 'NPT-400S', assembly: true },
    { model: 'NPT-300K' },
  ]);
  assert.equal(routed.status, 200, routed.json.message);
  assert.deepEqual(routed.json.data.routing.handsTo, ['printing', 'assembling'], 'Production hands to the first team after it for each model');
  assert.equal(routed.json.raised.printing.department, 'printing');
  assert.equal(routed.json.raised.assembling.department, 'assembling');

  const printing = await openTask('ask_printing');
  assert.equal(printing.brief.models, 'NPT-410V', 'Printing has only the printed model');
  assert.deepEqual(printing.routing.handsTo, ['assembling'], 'and hands it on to Assembly');
  assert.deepEqual(printing.routing.goesOn, ['NPT-410V'], 'which models go on — their Printing workflow ends at Handed to Assembly');
  assert.ok(printing.askedFrom.some((id) => String(id) === String(production._id)), 'told back to Production');

  const assembly = await openTask('ask_assembling_edd');
  assert.equal(assembly.brief.models, 'NPT-410V, NPT-400S');
  assert.deepEqual(assembly.routing.from, ['production', 'printing']);
  assert.deepEqual(assembly.routing.handsTo, [], 'Assembly is last — it gives the EDD');
});

test('Production’s date is the hand-over date to the next teams, not the EDD', async () => {
  const day = indiaDay(4);
  const given = await api(`/api/workspace/todos/${production._id}/edd`, { method: 'POST', as: 'siva', body: { date: day, note: 'Moulding done by then' } });
  assert.equal(given.status, 200, given.json.message);
  assert.equal(given.json.data.updates.at(-1).fields.handover, day);
  assert.equal(given.json.data.routing.handOverDate, day);
  assert.equal((await eddOf())?.date, undefined, 'the enquiry has no EDD from a hand-over date');

  const printing = await openTask('ask_printing');
  assert.equal(printing.routing.incoming.production, day, 'Printing knows when the goods come');
  assert.match(printing.updates.at(-1).note, /Production hands over on/);
  const assembly = await openTask('ask_assembling_edd');
  assert.equal(assembly.routing.incoming.production, day, 'so does Assembly, for the model that skips printing');

  /* The same with a status move that carries a date. */
  const later = indiaDay(5);
  const moved = await api(`/api/workspace/todos/${production._id}/status`, { method: 'POST', as: 'siva', body: { status: 'ready_on_date', note: 'Shifted by a day', date: later } });
  assert.equal(moved.status, 200, moved.json.message);
  assert.equal((await openTask('ask_printing')).routing.incoming.production, later);
  assert.equal((await eddOf())?.date, undefined);
});

test('Printing hands over to Assembly; Assembly, last in the chain, gives the completion date', async () => {
  const printing = await openTask('ask_printing');
  const handed = await api(`/api/workspace/todos/${printing._id}/edd`, { method: 'POST', as: 'priya', body: { date: indiaDay(7) } });
  assert.equal(handed.status, 200, handed.json.message);
  assert.equal(handed.json.data.updates.at(-1).fields.handover, indiaDay(7));
  assert.equal((await openTask('ask_assembling_edd')).routing.incoming.printing, indiaDay(7));
  assert.equal((await eddOf())?.date, undefined);

  const assembly = await openTask('ask_assembling_edd');
  const edd = await api(`/api/workspace/todos/${assembly._id}/edd`, { method: 'POST', as: 'anand', body: { date: indiaDay(10), note: 'Clips arrive Monday' } });
  assert.equal(edd.status, 200, edd.json.message);
  assert.equal(edd.json.data.updates.at(-1).fields.edd, indiaDay(10));
  /* Assembly's is the completion date; the EDD stays marketing's to give. */
  assert.equal((await eddOf())?.date, undefined);
  const state = await Enquiry.findById(enquiry._id).select('eddByModel').lean();
  const row = state.eddByModel.find((entry) => entry.model === 'NPT-410V');
  assert.deepEqual([row.completion, row.completionBy], [indiaDay(10), 'assembling']);
  assert.deepEqual(row.teams.map((team) => [team.department, team.kind]).sort(), [['assembling', 'completion'], ['printing', 'handover'], ['production', 'handover']].sort());
});

test('changing the routing closes an untouched task that is no longer needed', async () => {
  const printing = await openTask('ask_printing');
  const rerouted = await route([
    { model: 'NPT-410V', assembly: true },
    { model: 'NPT-400S', assembly: true },
    { model: 'NPT-300K' },
  ]);
  assert.equal(rerouted.status, 200, rerouted.json.message);
  assert.deepEqual(rerouted.json.data.routing.handsTo, ['assembling']);
  const closed = await Todo.findById(printing._id);
  assert.equal(closed.completed, true, 'Printing had not started, so its task closes');
  assert.match(closed.outcome.note, /no printing is needed/);
  const assembly = await openTask('ask_assembling_edd');
  assert.deepEqual(assembly.routing.from, ['production']);
  assert.equal(assembly.brief.models, 'NPT-410V, NPT-400S');
});

test('with nothing after moulding, Production’s date is the completion date — the EDD stays marketing’s', async () => {
  const rerouted = await route([{ model: 'NPT-410V' }, { model: 'NPT-400S' }, { model: 'NPT-300K' }]);
  assert.equal(rerouted.status, 200, rerouted.json.message);
  assert.deepEqual(rerouted.json.data.routing.handsTo, []);
  const given = await api(`/api/workspace/todos/${production._id}/edd`, { method: 'POST', as: 'siva', body: { date: indiaDay(6) } });
  assert.equal(given.status, 200, given.json.message);
  assert.equal((await eddOf())?.date, undefined);
  const state = await Enquiry.findById(enquiry._id).select('eddByModel').lean();
  assert.ok(state.eddByModel.every((row) => row.completion === indiaDay(6) && row.completionBy === 'production'));
});

test('the plant calendar is Production’s to set, and the queue estimates press days from the mould', async () => {
  const read = await api('/api/settings/plant', { as: 'nandhini' });
  assert.equal(read.status, 200);
  assert.equal(read.json.data.hoursPerDay, 22, 'two shifts less changeovers by default');
  assert.equal((await api('/api/settings/plant', { method: 'PUT', as: 'nandhini', body: { hoursPerDay: 20 } })).status, 403, 'marketing does not set plant hours');
  const set = await api('/api/settings/plant', { method: 'PUT', as: 'siva', body: { hoursPerDay: 20, weeklyOff: 0 } });
  assert.equal(set.status, 200, set.json.message);
  assert.equal(set.json.data.hoursPerDay, 20);

  const { default: Mould } = await import('../src/models/Mould.js');
  await Mould.create({ mouldCode: 'NPT-410V', name: 'Velvet 410', cavities: 4, activeCavities: 4, partWeightGrams: 20, cycleTimeSeconds: 20, efficiencyPercent: 90 });
  const queue = await api('/api/production/queue', { as: 'siva' });
  assert.equal(queue.status, 200, queue.json.message);
  const row = queue.json.data.find((entry) => entry.enquiry.number === enquiry.number);
  assert.equal(row.capacity.basis, 'mould');
  assert.equal(row.capacity.mould, 'NPT-410V');
  assert.equal(row.capacity.perDay, 12960, '648 an hour × 20 press hours');
  assert.equal(row.capacity.days, 1, '10,000 pieces in one press day');
});

test('a date per model from each team: hand-over dates where a model goes on, the last team’s completion date — never the EDD', async () => {
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Per Model Knits', mobile: '9840011999', assignedTo: me } })).json.data;
  const second = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id, items: [{ modelNumber: 'CRF25', quantity: 10000 }, { modelNumber: 'CRF30', quantity: 4000 }, { modelNumber: 'CRF40', quantity: 2000 }], nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  const asked = (await api(`/api/enquiries/${second._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Dates please', brief: { model: 'CRF25' } } })).json.data.task;
  const routed = await api(`/api/workspace/todos/${asked._id}/routing`, {
    method: 'POST', as: 'siva', body: { models: [{ model: 'CRF25', printing: true, assembly: true }, { model: 'CRF30', assembly: true }, { model: 'CRF40' }] },
  });
  assert.equal(routed.status, 200, routed.json.message);
  const edd = (id, as, body) => api(`/api/workspace/todos/${id}/edd`, { method: 'POST', as, body });
  const stateOf = async () => Enquiry.findById(second._id).select('edd eddByModel').lean();

  /* Production, model by model — a model it does not have is refused. */
  assert.equal((await edd(asked._id, 'siva', { models: [{ model: 'NOPE-1', date: indiaDay(2) }] })).status, 400);
  const fromProduction = await edd(asked._id, 'siva', { models: [{ model: 'CRF25', date: indiaDay(2) }, { model: 'CRF30', date: indiaDay(3) }, { model: 'CRF40', date: indiaDay(4) }] });
  assert.equal(fromProduction.status, 200, fromProduction.json.message);
  let state = await stateOf();
  const of = (model) => state.eddByModel.find((row) => row.model === model);
  assert.equal(of('CRF40').completion, indiaDay(4), 'nothing after moulding: Production’s date is its completion date');
  assert.equal(of('CRF25').completion, undefined, 'Printing and Assembly still to give theirs');
  assert.deepEqual(of('CRF25').teams.map((row) => [row.department, row.date, row.kind]), [['production', indiaDay(2), 'handover']], 'Production’s date for it is a hand-over');
  assert.equal(state.edd?.date, undefined, 'the EDD is marketing’s — the plant never writes it');

  const printing = await Todo.findOne({ enquiry: second._id, kind: 'ask_printing', completed: false });
  const assembly = await Todo.findOne({ enquiry: second._id, kind: 'ask_assembling_edd', completed: false });
  assert.equal((await edd(printing._id, 'priya', { models: [{ model: 'CRF25', date: indiaDay(6) }] })).status, 200);
  state = await stateOf();
  assert.equal(of('CRF25').completion, undefined, 'still waiting on Assembly');
  const fromAssembly = await edd(assembly._id, 'anand', { models: [{ model: 'CRF25', date: indiaDay(9) }, { model: 'CRF30', date: indiaDay(5) }] });
  assert.equal(fromAssembly.status, 200, fromAssembly.json.message);
  state = await stateOf();
  assert.deepEqual([of('CRF25').completion, of('CRF25').completionBy], [indiaDay(9), 'assembling']);
  assert.deepEqual(of('CRF25').teams.map((row) => [row.department, row.date, row.kind]).sort(), [['assembling', indiaDay(9), 'completion'], ['printing', indiaDay(6), 'handover'], ['production', indiaDay(2), 'handover']].sort());
  assert.equal(of('CRF30').completion, indiaDay(5));
  assert.equal(state.edd?.date, undefined, 'still marketing’s to give');
  const production = (await api(`/api/enquiries/${second._id}/handoffs`, { as: 'nandhini' })).json.production;
  assert.equal(production.byModel.length, 3, 'the enquiry screen reads each model’s dates');
  assert.deepEqual(production.completion, { date: indiaDay(9), complete: true }, 'the plant’s completion: the latest model’s');
});

async function routedEnquiry(name, phone, items, models) {
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name, mobile: phone, assignedTo: me } })).json.data;
  const made = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id, items, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  const task = (await api(`/api/enquiries/${made._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Dates please', brief: { model: items[0].modelNumber } } })).json.data.task;
  const routed = await api(`/api/workspace/todos/${task._id}/routing`, { method: 'POST', as: 'siva', body: { models } });
  assert.equal(routed.status, 200, routed.json.message);
  return { enquiry: made, production: task };
}

test('marketing sets the EDD per model; every task is told; a team moving its date does not undo it', async () => {
  const { enquiry: third, production: asked } = await routedEnquiry('Final EDD Knits', '9840011888', [{ modelNumber: 'FX-1', quantity: 1000 }, { modelNumber: 'FX-2', quantity: 1000 }], [{ model: 'FX-1' }, { model: 'FX-2', printing: true }]);
  await api(`/api/workspace/todos/${asked._id}/edd`, { method: 'POST', as: 'siva', body: { models: [{ model: 'FX-1', date: indiaDay(3) }, { model: 'FX-2', date: indiaDay(2) }] } });
  const printing = await Todo.findOne({ enquiry: third._id, kind: 'ask_printing', completed: false });
  await api(`/api/workspace/todos/${printing._id}/edd`, { method: 'POST', as: 'priya', body: { date: indiaDay(5) } });
  let state = await Enquiry.findById(third._id).select('edd eddByModel').lean();
  assert.equal(state.edd?.date, undefined, 'the plant’s dates are not the EDD');
  assert.equal(state.eddByModel.find((row) => row.model === 'FX-2').completion, indiaDay(5));

  assert.equal((await api(`/api/enquiries/${third._id}/edd/models`, { method: 'POST', as: 'siva', body: { models: [{ model: 'FX-2', date: indiaDay(8) }] } })).status, 403, 'Production does not set marketing’s date');
  const set = await api(`/api/enquiries/${third._id}/edd/models`, { method: 'POST', as: 'nandhini', body: { models: [{ model: 'FX-2', date: indiaDay(8) }], note: 'Buyer agreed the 8th' } });
  assert.equal(set.status, 200, set.json.message);
  state = await Enquiry.findById(third._id).select('edd eddByModel').lean();
  const fx2 = state.eddByModel.find((row) => row.model === 'FX-2');
  assert.deepEqual([fx2.date, fx2.completion, fx2.department, fx2.final.date], [indiaDay(8), indiaDay(5), 'marketing', indiaDay(8)]);
  assert.equal(state.edd.date, indiaDay(8), 'the enquiry’s EDD follows marketing’s');
  assert.equal(state.edd.department, 'marketing');
  assert.match((await Todo.findById(printing._id)).updates.at(-1).note, /EDD set by Nandhini S \(marketing\): FX-2/);
  const { default: TaskNotice } = await import('../src/models/TaskNotice.js');
  const priyaId = (await api('/api/auth/me', { as: 'priya' })).json.data.id;
  assert.ok(await TaskNotice.exists({ task: printing._id, recipient: priyaId, statusLabel: 'EDD set by marketing' }), 'Printing is told');

  await api(`/api/workspace/todos/${printing._id}/edd`, { method: 'POST', as: 'priya', body: { date: indiaDay(6) } });
  state = await Enquiry.findById(third._id).select('edd eddByModel').lean();
  const after = state.eddByModel.find((row) => row.model === 'FX-2');
  assert.deepEqual([after.date, after.completion], [indiaDay(8), indiaDay(6)], 'marketing’s word stands; the team’s new date is seen beside it');
  assert.equal(state.edd.date, indiaDay(8));
});

test('Production hands the goods to Printing — only where a model was routed there — and Printing hears it', async () => {
  const { enquiry: fourth, production: asked } = await routedEnquiry('Hand On Knits', '9840011777', [{ modelNumber: 'HO-1', quantity: 1000 }], [{ model: 'HO-1', printing: true }]);
  const wrong = await api(`/api/workspace/todos/${asked._id}/status`, { method: 'POST', as: 'siva', body: { status: 'handed_assembly', note: 'To assembly' } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.message, /Nothing on this order goes to Assembly/);
  const handed = await api(`/api/workspace/todos/${asked._id}/status`, { method: 'POST', as: 'siva', body: { status: 'handed_printing', note: 'All 1,000 moulded' } });
  assert.equal(handed.status, 200, handed.json.message);
  const printing = await Todo.findOne({ enquiry: fourth._id, kind: 'ask_printing', completed: false });
  assert.match(printing.updates.at(-1).note, /Production handed the goods over \(HO-1\)/);
  assert.equal(printing.routing.received.production, indiaDay(0));
  assert.equal(await Todo.findOne({ enquiry: fourth._id, kind: 'quality_check' }), null, 'handed on is not ready — Quality waits for Printing');
});

test('dispatch plan: each model as it is ready — a ready model goes to Quality without waiting for the rest; together waits', async () => {
  const items = [{ modelNumber: 'DP-1', quantity: 1000 }, { modelNumber: 'DP-2', quantity: 1000 }];
  const models = [{ model: 'DP-1' }, { model: 'DP-2', printing: true }];
  const together = await routedEnquiry('Together Knits', '9840011666', items, models);
  /* One consignment, chosen by marketing — several models otherwise go each on its own way [utils/dispatchPlan.js]. */
  assert.equal((await api(`/api/enquiries/${together.enquiry._id}/dispatch-plan`, { method: 'POST', as: 'nandhini', body: { mode: 'together' } })).status, 200);
  /* QC compulsory on both, so the ready model goes to Quality rather than straight to Dispatch [qcGate.service]. */
  await Enquiry.updateOne({ _id: together.enquiry._id }, { $set: { qcRequired: true } });
  await api(`/api/workspace/todos/${together.production._id}/status`, { method: 'POST', as: 'siva', body: { status: 'ready_dispatch', note: 'DP-1 ready' } });
  assert.equal(await Todo.findOne({ enquiry: together.enquiry._id, kind: 'quality_check' }), null, 'together: waits for Printing');

  const split = await routedEnquiry('By Model Knits', '9840011555', items, models);
  await Enquiry.updateOne({ _id: split.enquiry._id }, { $set: { qcRequired: true } });
  assert.equal((await api(`/api/enquiries/${split.enquiry._id}/dispatch-plan`, { method: 'POST', as: 'siva', body: { mode: 'by_model' } })).status, 403, 'marketing’s or Admin’s call');
  const plan = await api(`/api/enquiries/${split.enquiry._id}/dispatch-plan`, { method: 'POST', as: 'nandhini', body: { mode: 'by_model', note: 'Buyer wants DP-1 first' } });
  assert.equal(plan.status, 200, plan.json.message);
  await api(`/api/workspace/todos/${split.production._id}/status`, { method: 'POST', as: 'siva', body: { status: 'ready_dispatch', note: 'DP-1 ready' } });
  const quality = await Todo.findOne({ enquiry: split.enquiry._id, kind: 'quality_check' });
  assert.ok(quality, 'a ready model goes on');
  assert.match(quality.notes || '', /Ready: DP-1 · still to come: DP-2/);
  const view = (await api(`/api/enquiries/${split.enquiry._id}/handoffs`, { as: 'nandhini' })).json;
  assert.equal(view.dispatchPlan.mode, 'by_model');
  assert.deepEqual(view.readiness, { ready: ['DP-1'], waiting: [{ model: 'DP-2', team: 'printing' }], sent: [], partSent: [], qc: { required: true, passed: [], atQc: ['DP-1'] } }, 'made, and with Quality until it passes');
});

test('Printing’s date for a model with no assembly after is its completion date — never a hand-over to Assembly', async () => {
  const { enquiry, production: asked } = await routedEnquiry('Print Only Knits', '9840013561',
    [{ modelNumber: 'CRF-SET', quantity: 1000 }, { modelNumber: 'CRF-AS', quantity: 1000 }],
    [{ model: 'CRF-SET', printing: true }, { model: 'CRF-AS', printing: true, assembly: true }]);
  const handed = await api(`/api/workspace/todos/${asked._id}/status`, { method: 'POST', as: 'siva', body: { status: 'handed_printing', note: 'All moulded' } });
  assert.equal(handed.status, 200, handed.json.message);
  const printing = await Todo.findOne({ enquiry: enquiry._id, kind: 'ask_printing', completed: false });
  const assembly = () => Todo.findOne({ enquiry: enquiry._id, kind: 'ask_assembling_edd' }).lean();
  const before = (await assembly())?.routing?.incoming?.printing;
  const move = (status, note, date, models) => api(`/api/workspace/todos/${printing._id}/status`, { method: 'POST', as: 'priya', body: { status, note, ...(date ? { date } : {}), models } });
  for (const status of ['goods_received', 'in_queue', 'started']) {
    const moved = await move(status, `${status} for CRF-SET`, null, ['CRF-SET']);
    assert.equal(moved.status, 200, moved.json.message);
  }
  const ready = await move('ready_dispatch', 'Printed, ready to go', indiaDay(5), ['CRF-SET']);
  assert.equal(ready.status, 200, ready.json.message);
  const line = (await Todo.findById(printing._id).lean()).updates.at(-1);
  assert.equal(line.dateLabel, 'Completion date', 'the date is Printing’s completion date');
  assert.doesNotMatch(line.note, /Hand-over/);
  assert.equal(line.fields.edd, indiaDay(5));
  assert.equal((await assembly())?.routing?.incoming?.printing, before, 'Assembly is told nothing for a model that never comes to it');
  const crf = (await Enquiry.findById(enquiry._id).select('eddByModel').lean()).eddByModel.find((row) => row.model === 'CRF-SET');
  assert.deepEqual([crf.completion, crf.completionBy], [indiaDay(5), 'printing']);

  /* The direct date for the model going on is still the hand-over to Assembly. */
  const onward = await api(`/api/workspace/todos/${printing._id}/edd`, { method: 'POST', as: 'priya', body: { models: [{ model: 'CRF-AS', date: indiaDay(4) }] } });
  assert.equal(onward.status, 200, onward.json.message);
  assert.match((await Todo.findById(printing._id).lean()).updates.at(-1).note, /Hand-over to Assembly/);
  const onlySet = await api(`/api/workspace/todos/${printing._id}/edd`, { method: 'POST', as: 'priya', body: { models: [{ model: 'CRF-SET', date: indiaDay(6) }] } });
  assert.equal(onlySet.status, 200, onlySet.json.message);
  assert.match((await Todo.findById(printing._id).lean()).updates.at(-1).note, /^Completion date/);
  /* Both models at once: Assembly hears the date of the one that goes to it, not the later one that ends here. */
  const mixed = await api(`/api/workspace/todos/${printing._id}/edd`, { method: 'POST', as: 'priya', body: { models: [{ model: 'CRF-SET', date: indiaDay(8) }, { model: 'CRF-AS', date: indiaDay(7) }] } });
  assert.equal(mixed.status, 200, mixed.json.message);
  assert.equal((await assembly())?.routing?.incoming?.printing, indiaDay(7));
});

test('no QC on the order: a ready model goes straight to Dispatch when it goes out model by model; together waits for the rest', async () => {
  const items = [{ modelNumber: 'NQ-1', quantity: 1000 }, { modelNumber: 'NQ-2', quantity: 1000 }];
  const models = [{ model: 'NQ-1' }, { model: 'NQ-2', printing: true }];
  const together = await routedEnquiry('No QC Together', '9840013562', items, models);
  assert.equal((await api(`/api/enquiries/${together.enquiry._id}/dispatch-plan`, { method: 'POST', as: 'nandhini', body: { mode: 'together' } })).status, 200);
  await api(`/api/workspace/todos/${together.production._id}/status`, { method: 'POST', as: 'siva', body: { status: 'ready_dispatch', note: 'NQ-1 ready', models: ['NQ-1'] } });
  assert.equal(await Todo.findOne({ enquiry: together.enquiry._id, kind: 'invoice_dispatch' }), null, 'together: waits for Printing’s model');
  assert.equal(await Todo.findOne({ enquiry: together.enquiry._id, kind: 'quality_check' }), null, 'no QC asked for');

  const split = await routedEnquiry('No QC By Model', '9840013563', items, models);
  const plan = await api(`/api/enquiries/${split.enquiry._id}/dispatch-plan`, { method: 'POST', as: 'nandhini', body: { mode: 'by_model' } });
  assert.equal(plan.status, 200, plan.json.message);
  await api(`/api/workspace/todos/${split.production._id}/status`, { method: 'POST', as: 'siva', body: { status: 'ready_dispatch', note: 'NQ-1 ready', models: ['NQ-1'] } });
  const dispatch = await Todo.findOne({ enquiry: split.enquiry._id, kind: 'invoice_dispatch', completed: false });
  assert.ok(dispatch, 'the ready model is on Dispatch’s desk — and so in its delivery queue');
  assert.equal(dispatch.department, 'despatch');
  assert.equal(await Todo.findOne({ enquiry: split.enquiry._id, kind: 'quality_check' }), null, 'no Quality step without QC');
});

test('several models, no plan chosen: each goes its own way — a ready model reaches Dispatch while the other is still made', async () => {
  const items = [{ modelNumber: 'IN-1', quantity: 1000 }, { modelNumber: 'IN-2', quantity: 1000 }];
  const { enquiry, production } = await routedEnquiry('Own Way Knits', '9840013564', items, [{ model: 'IN-1' }, { model: 'IN-2', printing: true }]);
  const view = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { as: 'nandhini' })).json;
  assert.deepEqual([view.dispatchPlan.mode, view.dispatchPlan.chosen], ['by_model', false], 'model by model by default');
  await api(`/api/workspace/todos/${production._id}/status`, { method: 'POST', as: 'siva', body: { status: 'ready_dispatch', note: 'IN-1 ready', models: ['IN-1'] } });
  assert.ok(await Todo.findOne({ enquiry: enquiry._id, kind: 'invoice_dispatch', completed: false }), 'IN-1 is on Dispatch’s desk');
  const printing = await Todo.findOne({ enquiry: enquiry._id, kind: 'ask_printing', completed: false });
  assert.ok(printing, 'IN-2 is still with Printing');

  const single = await routedEnquiry('One Model Knits', '9840013565', [{ modelNumber: 'ONE-1', quantity: 1000 }], [{ model: 'ONE-1' }]);
  assert.equal((await api(`/api/enquiries/${single.enquiry._id}/handoffs`, { as: 'nandhini' })).json.dispatchPlan.mode, 'together', 'one model: nothing to split');
});

test('only goods ready can be dispatched: no finishing → after Production; printed → after Printing; printed and assembled → after Assembly', async () => {
  const { dispatchLoad } = await import('./support/dispatchLoad.mjs');
  const { enquiry, production } = await routedEnquiry('Ready Rules Knits', '9840013777',
    [{ modelNumber: 'RD-1', quantity: 1000 }, { modelNumber: 'RD-2', quantity: 1000 }, { modelNumber: 'RD-3', quantity: 1000 }],
    [{ model: 'RD-1' }, { model: 'RD-2', printing: true }, { model: 'RD-3', printing: true, assembly: true }]);
  await Todo.updateOne({ _id: production._id }, { $set: { 'brief.items': [{ model: 'RD-1', quantity: 1000 }, { model: 'RD-2', quantity: 1000 }, { model: 'RD-3', quantity: 1000 }] } });
  const status = (id, as, body) => api(`/api/workspace/todos/${id}/status`, { method: 'POST', as, body });
  const sheetOf = async (id) => Object.fromEntries((await api(`/api/workspace/todos/${id}/dispatch`, { as: 'admin' })).json.data.models.map((row) => [row.model, row.ready ? 'ready' : row.waitingOn]));

  /* RD-1 has no printing or assembly: Production's Ready for Dispatch makes it ready. RD-2 and RD-3 go to Printing. */
  assert.equal((await status(production._id, 'siva', { status: 'ready_dispatch', note: 'RD-1 packed', models: ['RD-1'] })).status, 200);
  assert.equal((await status(production._id, 'siva', { status: 'handed_printing', note: 'Moulded', models: ['RD-2', 'RD-3'] })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const dispatch = await Todo.findOne({ enquiry: enquiry._id, kind: 'invoice_dispatch', completed: false }).lean();
  assert.ok(dispatch, 'RD-1 ready: Dispatch is asked');
  assert.deepEqual(await sheetOf(dispatch._id), { 'RD-1': 'ready', 'RD-2': 'printing', 'RD-3': 'assembling' });
  const tooSoon = await dispatchLoad({ baseUrl, token: token.admin, taskId: dispatch._id, status: 'part_dispatched', models: 'RD-1, RD-2', pieces: 2000 });
  assert.equal(tooSoon.status, 400);
  assert.match(tooSoon.json.message, /RD-2 is still with Printing — only models marked Ready for Dispatch by their last team/);

  /* RD-2 printed and ready: it may go. RD-3 printed and handed to Assembly: still not. */
  const printing = await Todo.findOne({ enquiry: enquiry._id, kind: 'ask_printing', completed: false });
  for (const step of ['in_queue', 'started']) assert.equal((await status(printing._id, 'priya', { status: step, note: step, models: ['RD-2', 'RD-3'] })).status, 200);
  assert.equal((await status(printing._id, 'priya', { status: 'ready_dispatch', note: 'RD-2 printed', models: ['RD-2'], date: indiaDay(1) })).status, 200);
  assert.equal((await status(printing._id, 'priya', { status: 'handed_assembly', note: 'RD-3 printed', models: ['RD-3'] })).status, 200);
  assert.deepEqual(await sheetOf(dispatch._id), { 'RD-1': 'ready', 'RD-2': 'ready', 'RD-3': 'assembling' }, 'printed is not enough for an assembled model');
  const assemblyFirst = await dispatchLoad({ baseUrl, token: token.admin, taskId: dispatch._id, status: 'part_dispatched', models: 'RD-3', pieces: 1000 });
  assert.equal(assemblyFirst.status, 400);
  assert.match(assemblyFirst.json.message, /RD-3 is still with Assembly/);
  const firstTwo = await dispatchLoad({ baseUrl, token: token.admin, taskId: dispatch._id, status: 'part_dispatched', models: 'RD-1, RD-2', pieces: 2000 });
  assert.equal(firstTwo.status, 200, firstTwo.json.message);
  assert.equal(firstTwo.json.data.status, 'part_dispatched');

  /* RD-3 assembled and ready: now it goes, and everything ordered has gone. */
  const assembly = await Todo.findOne({ enquiry: enquiry._id, kind: 'ask_assembling_edd', completed: false });
  assert.equal((await status(assembly._id, 'anand', { status: 'ready_dispatch', note: 'RD-3 assembled', date: indiaDay(1) })).status, 200);
  assert.deepEqual(await sheetOf(dispatch._id), { 'RD-1': 'ready', 'RD-2': 'ready', 'RD-3': 'ready' });
  const last = await dispatchLoad({ baseUrl, token: token.admin, taskId: dispatch._id, status: 'part_dispatched', models: 'RD-3', pieces: 1000 });
  assert.equal(last.status, 200, last.json.message);
  assert.equal(last.json.data.status, 'fully_dispatched');
});

test('all together: Dispatch is asked only once every model is ready from its last team — Production handing one to Printing is not its models ready', async () => {
  const { enquiry, production } = await routedEnquiry('Together Ready Knits', '9840013778',
    [{ modelNumber: 'TG-1', quantity: 500 }, { modelNumber: 'TG-2', quantity: 500 }],
    [{ model: 'TG-1' }, { model: 'TG-2', printing: true }]);
  assert.equal((await api(`/api/enquiries/${enquiry._id}/dispatch-plan`, { method: 'POST', as: 'nandhini', body: { mode: 'together' } })).status, 200);
  const status = (id, as, body) => api(`/api/workspace/todos/${id}/status`, { method: 'POST', as, body });
  /* Production hands TG-2 to Printing and Printing finishes it — but TG-1 is still on the press. */
  assert.equal((await status(production._id, 'siva', { status: 'handed_printing', note: 'TG-2 moulded', models: ['TG-2'] })).status, 200);
  const printing = await Todo.findOne({ enquiry: enquiry._id, kind: 'ask_printing', completed: false });
  for (const step of ['in_queue', 'started']) await status(printing._id, 'priya', { status: step, note: step, models: ['TG-2'] });
  assert.equal((await status(printing._id, 'priya', { status: 'ready_dispatch', note: 'TG-2 printed', models: ['TG-2'], date: indiaDay(1) })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await Todo.exists({ enquiry: enquiry._id, kind: 'invoice_dispatch' }), null, 'TG-1 is not ready: nothing goes');
  /* TG-1 ready from Production: now the whole order goes. */
  assert.equal((await status(production._id, 'siva', { status: 'ready_dispatch', note: 'TG-1 packed', models: ['TG-1'] })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(await Todo.exists({ enquiry: enquiry._id, kind: 'invoice_dispatch', completed: false }), 'every model ready: Dispatch is asked');
});
