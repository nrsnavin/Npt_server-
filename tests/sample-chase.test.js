/**
 * Chase and summarise [the sampling audit, item 5], without the model: the nudge on a sample
 * sitting past the usual time at its status, the bench summary by rule on the sampling home, and
 * the chase draft written onto the sample when the feedback reminder goes — read and sent by a
 * person from the sample's message dialog.
 *
 *   node --test tests/sample-chase.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'sample-chase-test-secret';
delete process.env.ANTHROPIC_API_KEY;

let mongo;
let server;
let baseUrl;
let events;
const token = {};
let customerId;
let Sample;

const DAY = 86400000;
const HOUR = 3600000;
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

async function requested() {
  const enquiry = (await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { customer: customerId, requirement: { modelNumber: 'NPT-400S', colour: 'Ivory' }, nextAction: 'Call', nextFollowUpDate: soon() } })).json.data;
  await api(`/api/enquiries/${enquiry._id}/status`, { method: 'POST', as: 'nandhini', body: { status: 'sample_required', nextAction: 'Call', nextFollowUpDate: soon() } });
  await settle();
  const sample = (await api(`/api/samples?enquiry=${enquiry._id}`, { as: 'meera' })).json.data[0];
  assert.ok(sample);
  return { enquiry, sample };
}

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  events = await import('../src/services/events.service.js');
  const { default: app } = await import('../src/app.js');
  ({ default: Sample } = await import('../src/models/Sample.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['meera', 'Meera S', 'sampling']]) {
    await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  customerId = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'SCM Garments', mobile: '9876500011', whatsapp: '9876500011', assignedTo: me, contacts: [{ name: 'Ramesh', phone: '9876500011', isPrimary: true }] } })).json.data._id;
});

test.after(async () => {
  events?.clearListeners();
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('a nudge: sitting at a status well past the usual time — the usual from the bench’s own history, or the defaults', async () => {
  const { nudgeFor, usualHoursAtStatus, DEFAULT_USUAL_HOURS } = await import('../src/services/samplingNudges.service.js');
  const now = Date.now();
  const at = (hoursAgo) => new Date(now - hoursAgo * HOUR);
  const sample = { status: 'checking_stock', requestedAt: at(60), statusHistory: [{ to: 'request_received', at: at(60) }, { to: 'checking_stock', at: at(50) }] };
  const nudge = nudgeFor(sample, DEFAULT_USUAL_HOURS, now);
  assert.equal(nudge.text, '2 days at checking stock — usual is 4 h');
  assert.equal(nudge.usualHours, 4);
  assert.equal(nudgeFor({ ...sample, statusHistory: [{ to: 'checking_stock', at: at(3) }] }, DEFAULT_USUAL_HOURS, now), null, 'three hours is not a nudge');
  assert.equal(nudgeFor({ ...sample, status: 'approved' }, DEFAULT_USUAL_HOURS, now), null, 'nothing to do, nothing to nudge');
  assert.match(nudgeFor({ ...sample, status: 'dispatched', statusHistory: [{ to: 'dispatched', at: at(7 * 24) }] }, DEFAULT_USUAL_HOURS, now).text, /7 days with the buyer — usual is 3 days/);

  /* The plant's own usual wins once it has been at a status often enough. */
  const usual = await usualHoursAtStatus({ now });
  assert.equal(usual.checking_stock, DEFAULT_USUAL_HOURS.checking_stock, 'no history yet: the default');
  for (let i = 0; i < 6; i += 1) {
    await Sample.create({ number: `SMP-U-${i}`, enquiry: new mongoose.Types.ObjectId(), customer: customerId, requestedBy: new mongoose.Types.ObjectId(), modelNumber: 'X', status: 'sample_ready', statusHistory: [{ to: 'checking_stock', at: at(40) }, { to: 'sample_available', at: at(16) }, { to: 'sample_ready', at: at(2) }] });
  }
  const learned = await usualHoursAtStatus({ now });
  assert.equal(learned.checking_stock, 24, 'a day at checking stock is this bench’s usual');
  assert.equal(nudgeFor(sample, learned, now).text, '2 days at checking stock — usual is 1 day', 'fifty hours against a usual day: just past twice over');
  assert.equal(nudgeFor({ ...sample, statusHistory: [{ to: 'checking_stock', at: at(40) }] }, learned, now), null, 'forty hours against a usual day: not yet');
});

test('the sampling home carries the bench summary — by rule without the model — with nudges and problems in it', async () => {
  const { summaryByRules } = await import('../src/services/samplingSummary.llm.js');
  assert.equal(summaryByRules({}), 'Nothing late, nothing new, nothing stuck — a clear bench.');
  const said = summaryByRules({
    late: [{ number: 'SMP-1', model: 'NPT-400S', daysLate: 2 }, { number: 'SMP-2', daysLate: 1 }],
    fresh: [{ number: 'SMP-3', assignedTo: null }],
    inWork: [{}, {}, {}],
    nudged: [{ number: 'SMP-4', nudge: '2 days at checking stock — usual is 4 h' }],
    problems: [{ number: 'SMP-5', problem: 'resin short' }],
    waitingOnBuyer: [{}],
  });
  assert.match(said, /^2 late — SMP-1 \(NPT-400S\) first, 2 days over\. 1 new, nobody has picked them up\. 3 on the bench\. 1 sitting past the usual time: SMP-4 2 days at checking stock/);
  assert.match(said, /1 flagged a problem: SMP-5 — resin short\. 1 with buyers over three days/);
  assert.ok(said.split(' ').length <= 60, `under sixty words: ${said.split(' ').length}`);

  const { sample } = await requested();
  await Sample.updateOne({ _id: sample._id }, { $set: { 'statusHistory.0.at': new Date(Date.now() - 2 * DAY), requestedAt: new Date(Date.now() - 2 * DAY) } });
  const day = await api('/api/samples/day', { as: 'meera' });
  assert.equal(day.status, 200);
  assert.equal(day.json.meta.summary.byModel, false, 'no key: the rules answer');
  assert.match(day.json.meta.summary.text, /1 new, nobody has picked them up/);
  const card = day.json.data.fresh.find((row) => row._id === sample._id);
  assert.match(card.nudge, /2 days at request received — usual is 4 h/);
  const row = (await api('/api/samples/queue', { as: 'meera' })).json.data.rows.find((entry) => entry._id === sample._id);
  assert.match(row.nudge, /2 days at request received/);
});

test('the feedback reminder writes a chase draft onto the sample; the message dialog offers it, and a person sends it', async () => {
  const { runFeedbackReminders } = await import('../src/services/escalation.service.js');
  const { chaseByRules } = await import('../src/services/samplingSummary.llm.js');
  const { sample } = await requested();
  for (const body of [{ status: 'checking_stock' }, { status: 'sample_available' }, { status: 'sample_ready', ...NO_PHOTO }]) assert.equal((await move(sample._id, body)).status, 200);
  const sent = await move(sample._id, { status: 'dispatched', courier: 'DTDC', awbNumber: 'D7721390', dispatchedQuantity: 3 });
  assert.equal(sent.status, 200, sent.json.message);
  await settle();
  const sentAt = new Date(sent.json.data.dispatchedAt).getTime();
  const raised = await runFeedbackReminders({ now: sentAt + 4 * DAY });
  assert.equal(raised.length, 1);

  const after = await Sample.findById(sample._id).lean();
  assert.ok(after.chaseDraft?.body, 'a draft on the sample');
  assert.equal(after.chaseDraft.byModel, false, 'by rule without the model');
  assert.equal(after.chaseDraft.body, chaseByRules({ sample: { ...sample, deliveryMethod: 'courier', courier: 'DTDC' }, customer: { name: 'SCM Garments', contactPerson: 'Ramesh' }, days: 4 }));
  assert.match(after.chaseDraft.body, /^Hello Ramesh,\n\nYour sample SMP-\d{4}-\d{4} — NPT-400S in Ivory — reached you about 4 days ago\./);

  const preview = await api(`/api/samples/${sample._id}/customer-message/preview?event=sample_feedback_chase`, { as: 'nandhini' });
  assert.equal(preview.status, 200, preview.json.message);
  assert.equal(preview.json.data.body, after.chaseDraft.body, 'the draft is what the dialog shows');
  assert.equal(preview.json.data.drafted, true);
  assert.match(preview.json.data.subject, /how does it suit/);

  const gone = await api(`/api/samples/${sample._id}/customer-message`, { method: 'POST', as: 'nandhini', body: { event: 'sample_feedback_chase', channels: ['whatsapp'] } });
  assert.equal(gone.status, 201, gone.json.message);
  assert.equal(gone.json.data[0].status, 'sent');
  assert.equal(gone.json.data[0].body, after.chaseDraft.body);
  assert.equal(gone.json.data[0].automatic, false, 'sent by a person, never by itself');
});
