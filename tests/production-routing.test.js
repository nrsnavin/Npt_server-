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

test('Printing hands over to Assembly; Assembly, last in the chain, gives the EDD', async () => {
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
  const written = await eddOf();
  assert.equal(written.date, indiaDay(10));
  assert.equal(written.department, 'assembling');
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

test('with nothing after moulding, Production’s date is the EDD, as before', async () => {
  const rerouted = await route([{ model: 'NPT-410V' }, { model: 'NPT-400S' }, { model: 'NPT-300K' }]);
  assert.equal(rerouted.status, 200, rerouted.json.message);
  assert.deepEqual(rerouted.json.data.routing.handsTo, []);
  const given = await api(`/api/workspace/todos/${production._id}/edd`, { method: 'POST', as: 'siva', body: { date: indiaDay(6) } });
  assert.equal(given.status, 200, given.json.message);
  assert.equal((await eddOf()).date, indiaDay(6));
  assert.equal((await eddOf()).department, 'production');
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

test('a date per model from each team: a model’s EDD is the latest of its teams, the enquiry’s the latest model', async () => {
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
  assert.equal(state.eddByModel.find((row) => row.model === 'CRF40').date, indiaDay(4), 'nothing after moulding: Production’s date is its EDD');
  assert.equal(state.eddByModel.find((row) => row.model === 'CRF25').date, undefined, 'Printing and Assembly still to give theirs');
  assert.equal(state.edd?.date, undefined, 'no enquiry EDD until every model has one');

  const printing = await Todo.findOne({ enquiry: second._id, kind: 'ask_printing', completed: false });
  const assembly = await Todo.findOne({ enquiry: second._id, kind: 'ask_assembling_edd', completed: false });
  /* Printing 1st, Assembly 5th (here: day 6 and day 9): the model's EDD is Assembly's, the later. */
  assert.equal((await edd(printing._id, 'priya', { models: [{ model: 'CRF25', date: indiaDay(6) }] })).status, 200);
  assert.equal((await stateOf()).eddByModel.find((row) => row.model === 'CRF25').date, undefined, 'still waiting on Assembly');
  const fromAssembly = await edd(assembly._id, 'anand', { models: [{ model: 'CRF25', date: indiaDay(9) }, { model: 'CRF30', date: indiaDay(5) }] });
  assert.equal(fromAssembly.status, 200, fromAssembly.json.message);
  state = await stateOf();
  const crf25 = state.eddByModel.find((row) => row.model === 'CRF25');
  assert.deepEqual([crf25.date, crf25.department], [indiaDay(9), 'assembling']);
  assert.deepEqual(crf25.teams.map((row) => [row.department, row.date]).sort(), [['assembling', indiaDay(9)], ['printing', indiaDay(6)], ['production', indiaDay(2)]].sort());
  assert.equal(state.eddByModel.find((row) => row.model === 'CRF30').date, indiaDay(5));
  assert.deepEqual([state.edd.date, state.edd.department], [indiaDay(9), 'assembling'], 'the order goes when its last model is ready');
  assert.match(state.edd.note, /latest of 3 models \(CRF25\)/);

  /* Assembly moves CRF25 earlier than Printing's date: the later of the two still stands. */
  await edd(assembly._id, 'anand', { models: [{ model: 'CRF25', date: indiaDay(5) }] });
  assert.equal((await stateOf()).eddByModel.find((row) => row.model === 'CRF25').date, indiaDay(6), 'Printing’s 6th is later than Assembly’s 5th');
  const production = (await api(`/api/enquiries/${second._id}/handoffs`, { as: 'nandhini' })).json.production;
  assert.equal(production.byModel.length, 3, 'the enquiry screen reads each model’s EDD');
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

test('marketing sets the final EDD per model — by default the latest; every task is told; a team moving its date does not undo it', async () => {
  const { enquiry: third, production: asked } = await routedEnquiry('Final EDD Knits', '9840011888', [{ modelNumber: 'FX-1', quantity: 1000 }, { modelNumber: 'FX-2', quantity: 1000 }], [{ model: 'FX-1' }, { model: 'FX-2', printing: true }]);
  await api(`/api/workspace/todos/${asked._id}/edd`, { method: 'POST', as: 'siva', body: { models: [{ model: 'FX-1', date: indiaDay(3) }, { model: 'FX-2', date: indiaDay(2) }] } });
  const printing = await Todo.findOne({ enquiry: third._id, kind: 'ask_printing', completed: false });
  await api(`/api/workspace/todos/${printing._id}/edd`, { method: 'POST', as: 'priya', body: { date: indiaDay(5) } });
  let state = await Enquiry.findById(third._id).select('edd eddByModel').lean();
  assert.equal(state.edd.date, indiaDay(5), 'by default the latest');

  assert.equal((await api(`/api/enquiries/${third._id}/edd/models`, { method: 'POST', as: 'siva', body: { models: [{ model: 'FX-2', date: indiaDay(8) }] } })).status, 403, 'Production does not set marketing’s date');
  const set = await api(`/api/enquiries/${third._id}/edd/models`, { method: 'POST', as: 'nandhini', body: { models: [{ model: 'FX-2', date: indiaDay(8) }], note: 'Buyer agreed the 8th' } });
  assert.equal(set.status, 200, set.json.message);
  state = await Enquiry.findById(third._id).select('edd eddByModel').lean();
  const fx2 = state.eddByModel.find((row) => row.model === 'FX-2');
  assert.deepEqual([fx2.date, fx2.suggested, fx2.department, fx2.final.date], [indiaDay(8), indiaDay(5), 'marketing', indiaDay(8)]);
  assert.equal(state.edd.date, indiaDay(8));
  assert.match((await Todo.findById(printing._id)).updates.at(-1).note, /Final EDD set by Nandhini S: FX-2/);
  const { default: TaskNotice } = await import('../src/models/TaskNotice.js');
  const priyaId = (await api('/api/auth/me', { as: 'priya' })).json.data.id;
  assert.ok(await TaskNotice.exists({ task: printing._id, recipient: priyaId, statusLabel: 'Final EDD set by marketing' }), 'Printing is told');

  await api(`/api/workspace/todos/${printing._id}/edd`, { method: 'POST', as: 'priya', body: { date: indiaDay(6) } });
  state = await Enquiry.findById(third._id).select('edd eddByModel').lean();
  const after = state.eddByModel.find((row) => row.model === 'FX-2');
  assert.deepEqual([after.date, after.suggested], [indiaDay(8), indiaDay(6)], 'marketing’s word stands; the teams’ new date is seen beside it');
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
  assert.deepEqual(view.readiness, { ready: ['DP-1'], waiting: [{ model: 'DP-2', team: 'printing' }], sent: [], qc: { required: true, passed: [], atQc: ['DP-1'] } }, 'made, and with Quality until it passes');
});
