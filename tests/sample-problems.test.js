/**
 * Problems in the log, and the rack as a stock list [the sampling audit, items 11 and 12], and
 * the approval analytics [item 10].
 *
 *   node --test tests/sample-problems.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'sample-problems-test-secret';

let mongo;
let server;
let baseUrl;
let events;
const token = {};
const id = {};
let customerId;
let Sample;
let Todo;

const DAY = 86400000;
const NO_PHOTO = { noPhoto: true, noPhotoReason: 'No camera on the test bench' };

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
const soon = (days = 3) => new Date(Date.now() + days * DAY).toISOString();
const move = (sampleId, body, as = 'meera') => api(`/api/samples/${sampleId}/status`, { method: 'POST', as, body });

async function requested(requirement = { modelNumber: 'NPT-400S', colour: 'Ivory' }, extra = {}) {
  const raised = await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { customer: customerId, requirement, nextAction: 'Call', nextFollowUpDate: soon(), ...extra } });
  assert.equal(raised.status, 201, raised.json.message);
  const enquiry = raised.json.data;
  await api(`/api/enquiries/${enquiry._id}/status`, { method: 'POST', as: 'nandhini', body: { status: 'sample_required', nextAction: 'Call', nextFollowUpDate: soon() } });
  await settle();
  const sample = (await api(`/api/samples?enquiry=${enquiry._id}`, { as: 'meera' })).json.data[0];
  assert.ok(sample);
  return { enquiry, sample };
}

/** An enquiry with no sample on it yet — for a request raised by hand. */
async function freshEnquiry() {
  const raised = await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { customer: customerId, requirement: { modelNumber: 'NPT-400S', colour: 'Ivory' }, nextAction: 'Call', nextFollowUpDate: soon() } });
  assert.equal(raised.status, 201, raised.json.message);
  return raised.json.data;
}

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  events = await import('../src/services/events.service.js');
  const { default: app } = await import('../src/app.js');
  ({ default: Sample } = await import('../src/models/Sample.js'));
  ({ default: Todo } = await import('../src/models/Todo.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['meera', 'Meera S', 'sampling']]) {
    await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
    id[key] = (await api('/api/auth/me', { as: key })).json.data.id;
  }
  customerId = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'SCM Garments', mobile: '9876500011', assignedTo: id.nandhini } })).json.data._id;
  await api('/api/moulds', { method: 'POST', as: 'admin', body: { mouldCode: 'NPT-400S', name: 'Shirt Hanger 400mm', category: 'shirt', sizeMm: 400, material: 'plastic', cavities: 4, partWeightGrams: 26, cycleTimeSeconds: 28, moq: 5000 } });
});

test.after(async () => {
  events?.clearListeners();
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------ Item 11: problems in the log ------------------------------ */

test('a log entry that reads as a problem flags the sample; the sweep tells whoever asked and the bench once; the next move clears it', async () => {
  const { problemIn, runProblemFlags } = await import('../src/services/sampleProblems.service.js');
  assert.equal(problemIn('Second shot, shoulder corrected'), null);
  assert.equal(problemIn('Mould issue on cavity 3, waiting for the tool room'), 'Mould issue');
  assert.equal(problemIn('HIPS white resin short till Friday'), 'resin short');
  assert.equal(problemIn('Machine down since morning'), 'Machine down');

  const { sample } = await requested();
  assert.equal((await move(sample._id, { status: 'checking_stock' })).status, 200);
  const plain = await api(`/api/samples/${sample._id}/logs`, { method: 'POST', as: 'meera', body: { body: 'First shot taken, looks fine' } });
  assert.equal(plain.status, 201, plain.json.message);
  assert.equal(plain.json.meta.problem, null);
  const posted = await api(`/api/samples/${sample._id}/logs`, { method: 'POST', as: 'meera', body: { body: 'Ivory resin short — nothing in the store till the 30th' } });
  assert.equal(posted.status, 201, posted.json.message);
  assert.equal(posted.json.meta.problem, 'resin short');
  assert.equal(posted.json.data.flag, 'problem');

  const flagged = await api(`/api/samples/${sample._id}`, { as: 'meera' });
  assert.equal(flagged.json.data.problem.words, 'resin short');
  assert.match(flagged.json.data.problem.note, /Ivory resin short/);
  const row = (await api('/api/samples/queue', { as: 'meera' })).json.data.rows.find((entry) => entry._id === sample._id);
  assert.equal(row.problem.words, 'resin short');
  assert.equal(row.highlighted, true);
  const card = (await api('/api/samples/day', { as: 'meera' })).json.data.inWork.find((entry) => entry._id === sample._id);
  assert.equal(card.problem.words, 'resin short');

  const raised = await runProblemFlags();
  assert.deepEqual(raised.map((entry) => [entry.sample, entry.words]), [[sample.number, 'resin short']]);
  const asked = await Todo.findOne({ user: id.nandhini, originKey: `sample:${sample._id}:problem:${posted.json.data._id}`, completed: false });
  assert.ok(asked, 'whoever asked for the sample hears');
  assert.equal(asked.priority, 'high');
  assert.match(asked.title, /the bench flagged a problem — resin short/);
  assert.ok(await Todo.findOne({ department: 'sampling', originKey: `sample:${sample._id}:problem:${posted.json.data._id}` }), 'and the bench’s own queue');
  assert.deepEqual(await runProblemFlags(), [], 'once');

  const moved = await move(sample._id, { status: 'production_required' });
  assert.equal(moved.status, 200, moved.json.message);
  assert.equal(moved.json.data.problem, undefined, 'the next move answers the flag');
});

/* ------------------------------ Item 12: the rack ------------------------------ */

test('the rack is a stock list: counted by the bench, read by marketing, debited by an in-person hand-over, never below zero', async () => {
  const marketingCounts = await api('/api/samples/rack', { method: 'PUT', as: 'nandhini', body: { rows: [{ modelNumber: 'NPT-400S', colour: 'Ivory', pieces: 3 }] } });
  assert.equal(marketingCounts.status, 403, 'the bench keeps the rack');
  const counted = await api('/api/samples/rack', { method: 'PUT', as: 'meera', body: { rows: [{ modelNumber: 'NPT-400S', colour: 'Ivory', pieces: 3, shelf: 'A2' }, { modelNumber: 'NPT-380T', colour: '', pieces: 1 }] } });
  assert.equal(counted.status, 200, counted.json.message);
  assert.equal(counted.json.data[0].mould?.mouldCode, 'NPT-400S', 'linked to the register by its code');
  const listed = await api('/api/samples/rack', { as: 'nandhini' });
  assert.equal(listed.status, 200, 'marketing reads it before a visit');
  assert.deepEqual(listed.json.meta, { lines: 2, pieces: 4, empty: 0 });

  /* Counted again: the same line, not a second one. */
  const again = await api('/api/samples/rack', { method: 'PUT', as: 'meera', body: { rows: [{ modelNumber: 'npt-400s', colour: 'ivory', pieces: 2 }] } });
  assert.equal(again.status, 200);
  assert.equal((await api('/api/samples/rack', { as: 'meera' })).json.meta.lines, 2);

  /* A piece taken from the rack on a visit comes off it. */
  const raised = await api('/api/samples', { method: 'POST', as: 'nandhini', body: { enquiry: (await freshEnquiry())._id, quantity: 1, handover: 'in_person' } });
  assert.equal(raised.status, 201, raised.json.message);
  const taken = raised.json.data;
  assert.equal(taken.status, 'sample_ready', 'on the rack: ready the moment it is raised');
  const handed = await api(`/api/samples/${taken._id}/hand-over`, { method: 'POST', as: 'nandhini', body: { receivedBy: 'Mr Ravi', pieces: 1 } });
  assert.equal(handed.status, 200, handed.json.message);
  assert.match(handed.json.data.statusHistory.find((entry) => /^Rack:/.test(entry.note || ''))?.note, /NPT-400S Ivory: 2 → 1 on the rack/);
  const line = (await api('/api/samples/rack', { as: 'meera' })).json.data.find((entry) => entry.modelNumber === 'NPT-400S');
  assert.equal(line.pieces, 1);
  assert.equal(line.lastTaken.by.name, 'Nandhini S');
  assert.equal(line.lastTaken.sample.number, taken.number);

  const second = await api('/api/samples', { method: 'POST', as: 'nandhini', body: { enquiry: (await freshEnquiry())._id, quantity: 5, handover: 'in_person' } });
  await api(`/api/samples/${second.json.data._id}/hand-over`, { method: 'POST', as: 'nandhini', body: { receivedBy: 'Mr Ravi', pieces: 5 } });
  assert.equal((await api('/api/samples/rack', { as: 'meera' })).json.data.find((entry) => entry.modelNumber === 'NPT-400S').pieces, 0, 'never below zero');
  assert.equal((await api('/api/samples/rack', { as: 'meera' })).json.meta.empty, 1, 'and the bench sees what to top up');

  const gone = await api(`/api/samples/rack/${line._id}`, { method: 'DELETE', as: 'meera' });
  assert.equal(gone.status, 200);
  assert.equal((await api('/api/samples/rack', { as: 'meera' })).json.meta.lines, 1);
});

/* ------------------------------ Item 10: approval analytics ------------------------------ */

test('the analytics say what the buyer said by model, purpose and bench member, and how often a compulsory colour was missed', async () => {
  const outcomes = [
    ['NPT-400S', 'approved', 'Ivory', true, 'Ivory', null],
    ['NPT-400S', 'rejected', 'Ivory', true, 'White', 'Buyer said White is fine'],
    ['NPT-380T', 'approved', 'Black', false, 'Grey', null],
    ['NPT-380T', 'modification_required', 'Black', false, 'Black', null],
  ];
  for (const [model, outcome, colour, colourMandatory, dispatchedColour, override] of outcomes) {
    const { sample } = await requested({ modelNumber: model, colour, colourMandatory });
    await api(`/api/samples/${sample._id}/assign`, { method: 'POST', as: 'meera', body: {} });
    for (const body of [{ status: 'checking_stock' }, { status: 'sample_available' }, { status: 'sample_ready', ...NO_PHOTO }]) assert.equal((await move(sample._id, body)).status, 200);
    const sent = await move(sample._id, { status: 'dispatched', courier: 'DTDC', awbNumber: `D${Math.floor(Math.random() * 1e8)}`, dispatchedQuantity: 1, dispatchedColour, ...(override ? { colourOverride: true, colourOverrideReason: override } : {}) });
    assert.equal(sent.status, 200, sent.json.message);
    await settle();
    const said = await api(`/api/samples/${sample._id}/feedback`, { method: 'POST', as: 'nandhini', body: { outcome, note: 'Said so' } });
    assert.equal(said.status, 200, said.json.message);
  }
  await settle();
  const report = await api('/api/samples/analytics', { as: 'admin' });
  assert.equal(report.status, 200, report.json.message);
  const { approval, colourMisses } = report.json.data;
  assert.equal(approval.answered, 4, JSON.stringify(await Sample.find({ status: { $in: ['approved', 'rejected', 'modification_required'] } }).select('number status feedbackAt modelNumber').lean()));
  assert.equal(approval.byModel.length, 2);
  assert.ok(approval.byModel.every((row) => row.answered === 2 && row.approved === 1 && row.approvedPercent === 50 && row.reliable === false));
  assert.deepEqual(approval.byPurpose.map((row) => [row.label, row.answered, row.approved]), [['existing_model', 4, 2]]);
  assert.deepEqual(approval.byBench.map((row) => [row.label, row.answered, row.approved, row.modified, row.rejected]), [['Meera S', 4, 2, 1, 1]]);
  assert.equal(colourMisses.sent, 6, 'the four here and the two rack hand-overs, each sent in a colour');
  assert.equal(colourMisses.compulsory, 2);
  assert.equal(colourMisses.steppedPast, 1);
  assert.equal(colourMisses.steppedPastPercent, 50);
  assert.equal(colourMisses.substituted, 1, 'a preference sent in another shade');
  assert.deepEqual(colourMisses.rows.map((row) => [row.model, row.asked, row.sent, row.reason]), [['NPT-400S', 'Ivory', 'White', 'Buyer said White is fine'], ['NPT-380T', 'Black', 'Grey', null]]);
});
