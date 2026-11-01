/**
 * Field visits [config/fieldVisits.js; services/fieldVisit.service.js]: Admin's marks on who goes
 * out, who plans and for whom; one device per field account; a visit planned from a task, a
 * customer or on its own; the day — office punch or field duty with lunch; check-in with the fix,
 * a fix every five minutes and the checks that read them; check-out with the outcome the
 * category asks for; the day's report for Admin; the sweep's reminders.
 *
 *   node --test tests/field-visits.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'field-visits-secret';

let mongo;
let server;
let baseUrl;
let app;
const token = {};
const ids = {};
let FieldVisit;
let FieldDay;
let Todo;
let TaskNotice;
let Receivable;
let service;
let customerId;
let prtTask;

const api = async (path, { method = 'GET', body, as, bearer } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(bearer || as ? { Authorization: `Bearer ${bearer || token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const login = async (email, password = 'Pass@123456') => (await api('/api/auth/login', { method: 'POST', body: { email, password } })).json.data.token;
/* Tiruppur, by the bus stand; and a spot 400 m north of it. */
const GATE = { lat: 11.1085, lng: 77.3411, accuracyM: 6 };
const STREET = { lat: 11.1085, lng: 77.3411, accuracyM: 40 };
const AWAY = { lat: 11.1121, lng: 77.3411, accuracyM: 7 };
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const imagery = async () => ({ ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => JPEG.buffer.slice(JPEG.byteOffset, JPEG.byteOffset + JPEG.byteLength) });

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  ({ default: app } = await import('../src/app.js'));
  app.set('imageryFetch', imagery);
  ({ default: FieldVisit } = await import('../src/models/FieldVisit.js'));
  ({ default: FieldDay } = await import('../src/models/FieldDay.js'));
  ({ default: Todo } = await import('../src/models/Todo.js'));
  ({ default: TaskNotice } = await import('../src/models/TaskNotice.js'));
  ({ default: Receivable } = await import('../src/models/Receivable.js'));
  service = await import('../src/services/fieldVisit.service.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = await login('admin@np.com', 'Admin@12345');
  ids.admin = (await api('/api/auth/me', { as: 'admin' })).json.data.id;
  for (const [key, name, department] of [['ravi', 'Ravi PRT', 'payment_recovery'], ['mani', 'Mani Sampler', 'sampling'], ['nandhini', 'Nandhini S', 'marketing'], ['kumar', 'Kumar Accounts', 'accounts']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    assert.equal(made.status, 201, made.json.message);
    ids[key] = made.json.data.id;
    token[key] = await login(`${key}@np.com`);
  }
  customerId = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Field Knits', mobile: '9840033001', assignedTo: ids.nandhini, city: 'Tiruppur', state: 'Tamil Nadu' } })).json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('Admin marks who goes out, who plans for whom, who plans their own — the Field visits module comes with the mark', async () => {
  const before = (await api('/api/auth/me', { as: 'ravi' })).json.data;
  assert.deepEqual(before.fieldVisit, { allowed: false, mayAssign: false, assignTo: [], maySelfPlan: false });
  assert.ok(!before.modules.find((module) => module.key === 'field_visits')?.canRead, 'not theirs until marked');

  const ravi = await api(`/api/users/${ids.ravi}`, { method: 'PATCH', as: 'admin', body: { fieldVisit: { allowed: true, maySelfPlan: true } } });
  assert.equal(ravi.status, 200, ravi.json.message);
  assert.deepEqual(ravi.json.data.fieldVisit, { allowed: true, mayAssign: false, assignTo: [], maySelfPlan: true });
  assert.ok(ravi.json.data.modules.find((module) => module.key === 'field_visits')?.canWrite, 'the module opens with the mark');
  const mani = await api(`/api/users/${ids.mani}`, { method: 'PATCH', as: 'admin', body: { fieldVisit: { allowed: true } } });
  assert.equal(mani.status, 200);
  /* Nandhini plans for Ravi — Kumar, who does not go out, is dropped from her list. */
  const nandhini = await api(`/api/users/${ids.nandhini}`, { method: 'PATCH', as: 'admin', body: { fieldVisit: { mayAssign: true, assignTo: [ids.ravi, ids.kumar] } } });
  assert.deepEqual(nandhini.json.data.fieldVisit, { allowed: false, mayAssign: true, assignTo: [ids.ravi], maySelfPlan: false });
  assert.equal((await api('/api/auth/me', { as: 'admin' })).json.data.fieldVisit.allowed, true, 'Admin holds every mark');
  assert.equal((await api(`/api/users/${ids.ravi}`, { method: 'PATCH', as: 'ravi', body: { fieldVisit: { mayAssign: true } } })).status, 403, 'the marks are Admin’s to set');
});

test('a field account works on one device: a second sign-in signs the first out; office accounts are untouched', async () => {
  const first = await login('ravi@np.com');
  assert.equal((await api('/api/auth/me', { bearer: first })).status, 200);
  const second = await login('ravi@np.com');
  const refused = await api('/api/auth/me', { bearer: first });
  assert.equal(refused.status, 401);
  assert.match(refused.json.message, /signed in on another device/);
  assert.equal((await api('/api/auth/me', { bearer: second })).status, 200, 'the latest phone works');
  assert.equal((await api('/api/auth/me', { as: 'ravi' })).status, 401, 'the token from set-up is the earliest of all');
  token.ravi = second;
  /* Kumar, in the office, keeps both. */
  const desk = await login('kumar@np.com');
  await login('kumar@np.com');
  assert.equal((await api('/api/auth/me', { bearer: desk })).status, 200);
  /* Mani, marked after signing in: the old token still works until the next sign-in. */
  assert.equal((await api('/api/auth/me', { as: 'mani' })).status, 200);
  token.mani = await login('mani@np.com');
});

test('a visit is planned for a person on a day — from a task, from a customer, or on its own — by whoever may plan for them', async () => {
  const today = service.dayIST();
  const raised = await api('/api/workspace/team-tasks', { method: 'POST', as: 'admin', body: { kind: 'prt_recovery', note: 'Collect the old balance', customer: customerId, brief: { prtMode: 'Collect cheque' } } });
  assert.equal(raised.status, 201, JSON.stringify(raised.json));
  prtTask = raised.json.data.task;
  /* Nandhini may plan for Ravi, not for Mani. */
  assert.equal((await api('/api/field/visits', { method: 'POST', as: 'nandhini', body: { assignee: ids.mani, purpose: 'Sample to Field Knits', date: today } })).status, 403);
  const planned = await api('/api/field/visits', { method: 'POST', as: 'nandhini', body: { assignee: ids.ravi, task: prtTask._id, date: today, time: '11:00', note: 'Ask for the cheque' } });
  assert.equal(planned.status, 201, planned.json.message);
  const visit = planned.json.data;
  assert.deepEqual([visit.category, visit.purpose, visit.user.name, visit.assignedBy.name, visit.customer.name, visit.status, visit.plannedDate, visit.plannedTime], ['prt_collection', prtTask.title, 'Ravi PRT', 'Nandhini S', 'Field Knits', 'planned', today, '11:00'], 'the task gives the category, purpose and buyer');
  /* The task reads it as its own move: Visit Planned, the visitor and the date on its brief, due that day. */
  const planned0 = await Todo.findById(prtTask._id).lean();
  assert.deepEqual([planned0.status, planned0.brief.visitor, planned0.brief.visitDate, service.dayIST(planned0.dueDate)], ['visit_planned', 'Ravi PRT', today, today]);
  assert.match(planned0.updates.at(-1).note, /Visit planned: Ravi PRT on .* — Ask for the cheque/, 'said on the task');
  assert.ok(await TaskNotice.findOne({ recipient: ids.ravi, statusLabel: 'Visit planned: PRT Collection' }), 'Ravi is told');
  assert.equal((await api('/api/field/visits', { method: 'POST', as: 'admin', body: { assignee: ids.ravi, task: prtTask._id, date: today } })).status, 409, 'one open visit per task');
  /* Ravi plans his own general visit; Mani, not marked to plan his own, cannot. */
  const bank = await api('/api/field/visits', { method: 'POST', as: 'ravi', body: { category: 'bank_cash', purpose: 'Cash withdrawal — SBI Avinashi Road', date: today } });
  assert.equal(bank.status, 201, bank.json.message);
  assert.equal((await api('/api/field/visits', { method: 'POST', as: 'mani', body: { category: 'others', purpose: 'Courier', date: today } })).status, 403);
  assert.equal((await api('/api/field/visits', { method: 'POST', as: 'kumar', body: { category: 'others', purpose: 'Courier', date: today } })).status, 403, 'not a field person');
  assert.equal((await api('/api/field/visits', { method: 'POST', as: 'admin', body: { assignee: ids.ravi, purpose: 'Yesterday', date: '2020-01-01' } })).status, 400, 'today or later');
  const mine = (await api('/api/field/me', { as: 'ravi' })).json.data;
  assert.deepEqual(mine.visits.map((row) => row.purpose), [prtTask.title, 'Cash withdrawal — SBI Avinashi Road']);
  assert.deepEqual(mine.people.map((person) => person.name), ['Ravi PRT'], 'he may plan for himself only');
  assert.deepEqual((await api('/api/field/me', { as: 'nandhini' })).json.data.people.map((person) => person.name), ['Ravi PRT']);
  ids.prtVisit = visit._id;
  ids.bankVisit = bank.json.data._id;
});

test('the day: one attendance — the office punch refuses a running field duty, and a punch followed by field duty is flagged', async () => {
  assert.equal((await api('/api/field/day', { method: 'POST', as: 'kumar', body: { action: 'duty_start' } })).status, 403, 'field duty is for field people');
  const punched = await api('/api/field/day', { method: 'POST', as: 'kumar', body: { action: 'punch_in', fix: GATE } });
  assert.equal(punched.status, 200, punched.json.message);
  assert.equal((await api('/api/field/day', { method: 'POST', as: 'kumar', body: { action: 'punch_in', fix: GATE } })).status, 409, 'once');
  assert.equal((await api('/api/field/day', { method: 'POST', as: 'kumar', body: { action: 'punch_out', fix: GATE } })).status, 200);

  assert.equal((await api('/api/field/day', { method: 'POST', as: 'mani', body: { action: 'punch_in', fix: GATE } })).status, 200);
  const field = await api('/api/field/day', { method: 'POST', as: 'mani', body: { action: 'duty_start', fix: GATE } });
  assert.equal(field.status, 200);
  assert.deepEqual(field.json.data.flags.map((row) => row.key), ['office_and_field']);
  assert.equal((await api('/api/field/day', { method: 'POST', as: 'mani', body: { action: 'punch_in', fix: GATE } })).status, 409, 'and not the other way round');
  assert.equal((await api('/api/field/day', { method: 'POST', as: 'mani', body: { action: 'lunch_end' } })).status, 409, 'lunch not started');
  assert.equal((await api('/api/field/day', { method: 'POST', as: 'mani', body: { action: 'lunch_start', fix: GATE } })).status, 200);
  assert.equal((await api('/api/field/day', { method: 'POST', as: 'mani', body: { action: 'duty_end', fix: GATE } })).status, 409, 'end lunch first');
  assert.equal((await api('/api/field/day', { method: 'POST', as: 'mani', body: { action: 'lunch_end', fix: GATE } })).status, 200);
  const ended = await api('/api/field/day', { method: 'POST', as: 'mani', body: { action: 'duty_end', fix: GATE } });
  assert.equal(ended.status, 200, ended.json.message);
  assert.equal(ended.json.data.summary.planned, 0);
});

test('check-in at the gate: the fix verified, the day started, the task’s visit recorded with its picture; one visit at a time; lunch refused meanwhile', async () => {
  assert.equal((await api(`/api/field/visits/${ids.prtVisit}/check-in`, { method: 'POST', as: 'nandhini', body: { fix: GATE } })).status, 403, 'only the visitor');
  const arrived = await api(`/api/field/visits/${ids.prtVisit}/check-in`, { method: 'POST', as: 'ravi', body: { fix: { ...GATE, capturedAt: new Date().toISOString() }, device: 'Chrome on Android' } });
  assert.equal(arrived.status, 200, arrived.json.message);
  const visit = arrived.json.data;
  assert.deepEqual([visit.status, visit.checkIn.verified, visit.checkIn.place.name, visit.checkIn.accuracyM, visit.checkIn.device], ['checked_in', true, 'Tiruppur', 6, 'Chrome on Android']);
  assert.deepEqual(visit.flags, [], 'a clean check-in');
  const day = await FieldDay.findOne({ user: ids.ravi, date: service.dayIST() });
  assert.equal(day.dutyStart.auto, true, 'field duty started by the check-in');
  const task = await Todo.findById(prtTask._id);
  assert.equal(task.visits.length, 1, 'recorded on the task');
  assert.equal(String(task.visits[0]._id), String(visit.checkIn.taskVisit));
  assert.ok(task.visits[0].image, 'with its satellite picture');
  assert.equal(task.status, 'visited', 'the PRT task reads Visited');
  assert.equal((await api(`/api/field/visits/${ids.bankVisit}/check-in`, { method: 'POST', as: 'ravi', body: { fix: GATE } })).status, 409, 'one at a time');
  assert.match((await api(`/api/field/visits/${ids.bankVisit}/check-in`, { method: 'POST', as: 'ravi', body: { fix: GATE } })).json.message, /check out there first/);
  assert.equal((await api('/api/field/day', { method: 'POST', as: 'ravi', body: { action: 'lunch_start', fix: GATE } })).status, 409, 'not during a visit');
  assert.equal((await api('/api/field/day', { method: 'POST', as: 'ravi', body: { action: 'duty_end', fix: GATE } })).status, 409, 'nor is the day ended with a visit open');
  assert.equal((await api('/api/field/me', { as: 'ravi' })).json.data.checkedIn._id, ids.prtVisit);
});

test('a fix every five minutes while checked in: kept with its distance; leaving is flagged, a frozen GPS is flagged', async () => {
  const near = await api(`/api/field/visits/${ids.prtVisit}/ping`, { method: 'POST', as: 'ravi', body: { fix: { lat: 11.10852, lng: 77.34112, accuracyM: 8 } } });
  assert.equal(near.status, 200, near.json.message);
  assert.ok(near.json.data.distanceM < 20 && near.json.data.flags.length === 0, `still there: ${JSON.stringify(near.json.data)}`);
  await api(`/api/field/visits/${ids.prtVisit}/ping`, { method: 'POST', as: 'ravi', body: { fix: AWAY } });
  const gone = await api(`/api/field/visits/${ids.prtVisit}/ping`, { method: 'POST', as: 'ravi', body: { fix: { ...AWAY, lat: 11.1122 } } });
  assert.ok(gone.json.data.distanceM > 300 && gone.json.data.flags.includes('left_site'), `two fixes away: ${JSON.stringify(gone.json.data)}`);
  assert.deepEqual([gone.json.data.discrepancy.kind, gone.json.data.discrepancy.strikes, gone.json.data.discrepancy.limit], ['away', 2, 5], 'the person is told, and may re-check');
  /* A re-check at the gate confirms the place and clears the ask; the strikes stay counted. */
  const confirmed = await api(`/api/field/visits/${ids.prtVisit}/ping`, { method: 'POST', as: 'ravi', body: { fix: { lat: 11.10851, lng: 77.34111, accuracyM: 7 }, recheck: true } });
  assert.deepEqual([confirmed.json.data.confirmed, confirmed.json.data.discrepancy, confirmed.json.data.strikes], [true, null, 2]);
  assert.equal((await FieldVisit.findById(ids.prtVisit)).tracking.pendingRecheck, false);
  for (let i = 0; i < 3; i += 1) await api(`/api/field/visits/${ids.prtVisit}/ping`, { method: 'POST', as: 'ravi', body: { fix: { lat: 11.10850, lng: 77.34110, accuracyM: 5 } } });
  const frozen = await FieldVisit.findById(ids.prtVisit).lean();
  assert.deepEqual(frozen.flags.map((row) => row.key), ['implausible_travel', 'left_site', 'stale_fix'], '400 m in a second is said too; the frozen fix is one strike, not yet the limit');
  assert.equal(frozen.pings.length, 7);
  assert.deepEqual([frozen.tracking.strikes, frozen.tracking.pendingRecheck, frozen.tracking.suspectAt], [3, true, undefined]);
  /* Two more strays: the limit — Admin and whoever planned the visit hear something is wrong, under Needs your action. */
  await api(`/api/field/visits/${ids.prtVisit}/ping`, { method: 'POST', as: 'ravi', body: { fix: { ...AWAY, lat: 11.1130 } } });
  const fifth = await api(`/api/field/visits/${ids.prtVisit}/ping`, { method: 'POST', as: 'ravi', body: { fix: { ...AWAY, lat: 11.1131 } } });
  assert.deepEqual([fifth.json.data.discrepancy.strikes, fifth.json.data.discrepancy.suspect], [5, true]);
  const suspect = await FieldVisit.findById(ids.prtVisit).lean();
  assert.ok(suspect.tracking.suspectAt && suspect.flags.some((row) => row.key === 'suspect_tracking'));
  const toAdmin = await TaskNotice.findOne({ recipient: ids.admin, statusLabel: 'Something wrong in a field visit: Ravi PRT' }).lean();
  assert.ok(toAdmin, 'Admin is told');
  assert.match(toAdmin.note, /strayed 5 times/);
  assert.equal(toAdmin.link, `/field/team?date=${service.dayIST()}&user=${ids.ravi}`);
  assert.ok(await TaskNotice.findOne({ recipient: ids.nandhini, statusLabel: 'Something wrong in a field visit: Ravi PRT' }), 'and whoever planned the visit');
  assert.equal(await TaskNotice.countDocuments({ statusLabel: 'Something wrong in a field visit: Ravi PRT' }), 2, 'once');
  await api(`/api/field/visits/${ids.prtVisit}/ping`, { method: 'POST', as: 'ravi', body: { fix: { ...AWAY, lat: 11.1132 } } });
  assert.equal(await TaskNotice.countDocuments({ statusLabel: 'Something wrong in a field visit: Ravi PRT' }), 2, 'not again on the sixth');
  const today = (await api(`/api/field/team?date=${service.dayIST()}`, { as: 'admin' })).json.data.rows.find((row) => row.user.name === 'Ravi PRT');
  assert.deepEqual([today.suspects.length, today.suspects[0].strikes], [1, 6], 'on Field today');
  assert.equal((await api(`/api/field/visits/${ids.bankVisit}/ping`, { method: 'POST', as: 'ravi', body: { fix: GATE } })).status, 409, 'not checked in there');
});

test('check-out: the outcome the category asks for, the collected money on the task’s dues for Accounts, the words written up, the flags for Admin', async () => {
  assert.equal((await api(`/api/field/visits/${ids.prtVisit}/check-out`, { method: 'POST', as: 'ravi', body: { fix: GATE, outcome: { key: 'collected' } } })).status, 400, 'the amount is needed');
  assert.match((await api(`/api/field/visits/${ids.prtVisit}/check-out`, { method: 'POST', as: 'ravi', body: { fix: GATE, outcome: { key: 'delivered' } } })).json.message, /Collected \/ Promised \/ Refused \/ Person Unavailable/, 'the category’s outcomes');
  const left = await api(`/api/field/visits/${ids.prtVisit}/check-out`, {
    method: 'POST', as: 'ravi',
    body: { fix: STREET, outcome: { key: 'collected', amount: 12500, mode: 'cheque', reference: 'CHQ 448812' }, words: { met: 'accounts madam', happened: 'cheque given', response: 'balance next month' } },
  });
  assert.equal(left.status, 200, left.json.message);
  const visit = left.json.data;
  assert.deepEqual([visit.status, visit.outcome.label, visit.outcome.amount, visit.outcome.mode, visit.outcome.completes, visit.checkOut.verified], ['completed', 'Collected', 12500, 'cheque', true, false]);
  assert.ok(visit.outcome.receivable?.number, 'logged as a receipt for Accounts to confirm');
  const receivable = await Receivable.findById(visit.outcome.receivable._id).lean();
  assert.deepEqual([receivable.kind, receivable.receipts.at(-1).amount, receivable.receipts.at(-1).reference], ['on_account', 12500, 'CHQ 448812']);
  const moved = await Todo.findById(prtTask._id).lean();
  assert.deepEqual([moved.status, moved.statusHistory.at(-1).status, moved.updates.at(-1).fields?.reference], ['cheque_collected', 'cheque_collected', 'CHQ 448812'], 'the task reads Cheque Collected — Send to Accounts, as the desk would have set it');
  assert.match(visit.outcome.report.text, /accounts madam/);
  assert.equal((await Todo.findById(prtTask._id)).visits[0].report.text, visit.outcome.report.text, 'the task’s visit carries the same report');
  const keys = visit.flags.map((row) => row.key);
  assert.ok(keys.includes('gps_not_verified') && keys.includes('too_short'), `a rough fix at the gate and a short stay are said: ${keys}`);
  assert.ok(await TaskNotice.findOne({ recipient: ids.admin, statusLabel: 'PRT Collection visit: Collected' }), 'Admin hears the outcome');
  assert.ok(await TaskNotice.findOne({ recipient: ids.nandhini, statusLabel: 'PRT Collection visit: Collected' }), 'and the buyer’s marketing person');
  assert.equal((await api(`/api/field/visits/${ids.prtVisit}/check-out`, { method: 'POST', as: 'ravi', body: { fix: GATE, outcome: { key: 'collected', amount: 1, mode: 'cash' } } })).status, 409, 'once');
});

test('a general visit checked out as not done is put off to another day; the day ends only once every visit is settled, and Admin gets the report', async () => {
  const today = service.dayIST();
  const tomorrow = new Date(Date.now() + 86400000 + 330 * 60000).toISOString().slice(0, 10);
  assert.equal((await api(`/api/field/visits/${ids.bankVisit}/check-in`, { method: 'POST', as: 'ravi', body: { fix: { ...GATE, lat: 11.1090 } } })).status, 200);
  const putOff = await api(`/api/field/visits/${ids.bankVisit}/check-out`, { method: 'POST', as: 'ravi', body: { fix: { ...GATE, lat: 11.1090 }, outcome: { key: 'not_done', reason: 'Bank closed for lunch' }, reschedule: { date: tomorrow } } });
  assert.equal(putOff.status, 200, putOff.json.message);
  assert.deepEqual([putOff.json.data.status, putOff.json.data.outcome.label], ['rescheduled', 'Not done']);
  const next = await FieldVisit.findById(putOff.json.data.rescheduledTo).lean();
  assert.deepEqual([next.plannedDate, next.status, next.reschedules, String(next.rescheduledFrom)], [tomorrow, 'planned', 1, ids.bankVisit]);
  /* A third visit, never made: settled from the list. */
  const courier = (await api('/api/field/visits', { method: 'POST', as: 'ravi', body: { category: 'others', purpose: 'Courier office', date: today } })).json.data;
  const blocked = await api('/api/field/day', { method: 'POST', as: 'ravi', body: { action: 'duty_end', fix: GATE } });
  assert.equal(blocked.status, 409);
  assert.match(blocked.json.message, /Courier office \(not visited\)/);
  assert.equal((await api(`/api/field/visits/${courier._id}/settle`, { method: 'POST', as: 'ravi', body: { status: 'not_completed', reason: 'No time today' } })).status, 200);
  const ended = await api('/api/field/day', { method: 'POST', as: 'ravi', body: { action: 'duty_end', fix: GATE } });
  assert.equal(ended.status, 200, ended.json.message);
  const summary = ended.json.data.summary;
  assert.deepEqual([summary.planned, summary.completed, summary.notCompleted, summary.rescheduled, summary.visited, summary.gpsNotVerified], [3, 1, 1, 1, 2, 0]);
  const report = await TaskNotice.findOne({ recipient: ids.admin, statusLabel: 'Field day report: Ravi PRT' }).lean();
  assert.ok(report, 'Admin gets the day');
  assert.match(report.note, /1 completed, 1 not completed, 1 put off/);
  assert.ok(await TaskNotice.findOne({ recipient: ids.nandhini, statusLabel: 'Field day report: Ravi PRT' }), 'as does whoever plans his visits');
});

test('a visit made without the phone is entered later with why — never verified; Admin corrects times with why, and the record keeps both', async () => {
  const inAt = new Date(Date.now() - 3 * 3600000).toISOString();
  const outAt = new Date(Date.now() - 2 * 3600000).toISOString();
  assert.equal((await api('/api/field/visits/late', { method: 'POST', as: 'ravi', body: { category: 'marketing', purpose: 'Met Raja Textiles', checkInAt: inAt, checkOutAt: outAt, reason: 'ok', outcome: { key: 'met', metWhom: 'Raja' } } })).status, 400, 'a real reason');
  const late = await api('/api/field/visits/late', { method: 'POST', as: 'ravi', body: { category: 'marketing', purpose: 'Met Raja Textiles', customer: customerId, checkInAt: inAt, checkOutAt: outAt, reason: 'Phone battery was dead', outcome: { key: 'met', metWhom: 'Raja', summary: 'Wants 2000 pcs quote' }, words: { response: 'quote by Friday' } } });
  assert.equal(late.status, 201, late.json.message);
  const visit = late.json.data;
  assert.deepEqual([visit.status, visit.checkIn.enteredLater, visit.checkIn.verified, visit.checkOut.verified, visit.flags.map((row) => row.key)], ['completed', true, false, false, ['entered_later', 'gps_not_verified']]);
  assert.ok(await TaskNotice.findOne({ recipient: ids.admin, statusLabel: 'GPS not verified: Ravi PRT' }), 'Admin is told');
  assert.equal((await api(`/api/field/visits/${visit._id}/times`, { method: 'POST', as: 'ravi', body: { checkInAt: inAt, reason: 'I came earlier' } })).status, 403, 'Admin only');
  const corrected = await api(`/api/field/visits/${visit._id}/times`, { method: 'POST', as: 'admin', body: { checkInAt: new Date(Date.now() - 4 * 3600000).toISOString(), reason: 'Raja confirmed he came at ten' } });
  assert.equal(corrected.status, 200, corrected.json.message);
  assert.ok(corrected.json.data.flags.some((row) => row.key === 'times_edited'));
  const edit = corrected.json.data.history.at(-1);
  assert.deepEqual([edit.action, edit.by.name, edit.note, new Date(edit.from.checkInAt).toISOString()], ['times_edited', 'Navin R', 'Raja confirmed he came at ten', inAt]);
});

test('Field today: Admin sees everyone who went out; an assigner their own people; the office sees nothing', async () => {
  const today = service.dayIST();
  const admin = await api(`/api/field/team?date=${today}`, { as: 'admin' });
  assert.equal(admin.status, 200, admin.json.message);
  const ravi = admin.json.data.rows.find((row) => row.user.name === 'Ravi PRT');
  assert.deepEqual([ravi.mode, ravi.summary.completed, ravi.day.dutyStart.auto, ravi.flags.some((row) => row.key === 'left_site')], ['field', 2, true, true]);
  const mani = admin.json.data.rows.find((row) => row.user.name === 'Mani Sampler');
  assert.deepEqual(mani.flags.map((row) => row.key), ['office_and_field']);
  assert.deepEqual((await api(`/api/field/team?date=${today}`, { as: 'nandhini' })).json.data.rows.map((row) => row.user.name), ['Ravi PRT'], 'her list only');
  assert.equal((await api(`/api/field/team?date=${today}`, { as: 'kumar' })).status, 403);
  assert.equal((await api(`/api/field/day?date=${today}&user=${ids.ravi}`, { as: 'nandhini' })).status, 200);
  assert.equal((await api(`/api/field/day?date=${today}&user=${ids.mani}`, { as: 'nandhini' })).status, 403);
  const onTask = (await api(`/api/field/tasks/${prtTask._id}`, { as: 'admin' })).json.data;
  assert.deepEqual(onTask.map((row) => row.status), ['completed'], 'the task’s visits');
  /* The PRT desk card and the Sampling queue row carry the open visit, so they offer Check in rather than Needs visit. */
  const again = (await api('/api/field/visits', { method: 'POST', as: 'admin', body: { assignee: ids.ravi, task: prtTask._id, date: service.dayIST(new Date(Date.now() + 86400000)) } })).json.data;
  const home = (await api('/api/payments/day', { as: 'ravi' })).json.data;
  const card = (home.recovery || []).find((row) => String(row._id) === String(prtTask._id));
  assert.ok(card, 'the case is on the PRT desk');
  assert.deepEqual([card.fieldVisit._id, card.fieldVisit.status, card.fieldVisit.user.name], [again._id, 'planned', 'Ravi PRT']);
});

test('Promised, Person Unavailable and Refused reach the PRT task: its status and date, the put-off visit as Visit Planned, the refusal on the record', async () => {
  const today = service.dayIST();
  const tomorrow = service.dayIST(new Date(Date.now() + 86400000));
  const raise = async (note) => (await api('/api/workspace/team-tasks', { method: 'POST', as: 'admin', body: { kind: 'prt_recovery', note, customer: customerId, brief: { prtMode: 'Collect cheque' }, allowDuplicate: true } })).json.data.task;
  const visitOn = async (task) => (await api('/api/field/visits', { method: 'POST', as: 'admin', body: { assignee: ids.ravi, task: task._id, date: today } })).json.data;
  const go = async (visit, outcome, extra = {}) => {
    assert.equal((await api(`/api/field/visits/${visit._id}/check-in`, { method: 'POST', as: 'ravi', body: { fix: GATE } })).status, 200);
    const left = await api(`/api/field/visits/${visit._id}/check-out`, { method: 'POST', as: 'ravi', body: { fix: GATE, outcome, ...extra } });
    assert.equal(left.status, 200, left.json.message);
    return left.json.data;
  };
  const promised = await raise('Promised case');
  await go(await visitOn(promised), { key: 'promised', committedDate: tomorrow });
  const afterPromise = await Todo.findById(promised._id).lean();
  assert.deepEqual([afterPromise.status, afterPromise.statusHistory.at(-1).date, service.dayIST(afterPromise.dueDate)], ['promised', tomorrow, tomorrow], 'Promised with its date; the task falls due that day');
  const pastVisit = await visitOn(await raise('Past promise'));
  assert.equal((await api(`/api/field/visits/${pastVisit._id}/check-in`, { method: 'POST', as: 'ravi', body: { fix: GATE } })).status, 200);
  const ravisOpen = await FieldVisit.findOne({ user: ids.ravi, status: 'checked_in' });
  assert.equal((await api(`/api/field/visits/${ravisOpen._id}/check-out`, { method: 'POST', as: 'ravi', body: { fix: GATE, outcome: { key: 'promised', committedDate: '2020-01-01' } } })).status, 400, 'a promise is for a day to come');
  const gone = await api(`/api/field/visits/${ravisOpen._id}/check-out`, { method: 'POST', as: 'ravi', body: { fix: GATE, outcome: { key: 'person_unavailable' }, reschedule: { date: tomorrow } } });
  assert.equal(gone.status, 200, gone.json.message);
  const away = gone.json.data;
  assert.equal(away.status, 'rescheduled');
  const afterAway = await Todo.findById(ravisOpen.task).lean();
  assert.deepEqual([afterAway.status, afterAway.brief.visitDate, service.dayIST(afterAway.dueDate)], ['visit_planned', tomorrow, tomorrow], 'the next visit is the task’s Visit Planned');
  assert.match(afterAway.updates.find((row) => /person unavailable/.test(row.note))?.note || '', /Field visit — person unavailable — visit again/);
  const refused = await raise('Refused case');
  await go(await visitOn(refused), { key: 'refused', reason: 'Disputes the rate' });
  const afterRefusal = await Todo.findById(refused._id).lean();
  assert.equal(afterRefusal.status, 'visited', 'Refused is not a status of the task');
  assert.match(afterRefusal.updates.at(-1).note, /Field visit — refused — Disputes the rate/, 'but it is on the task’s record');
  const chequePlanned = await visitOn(await raise('Cheque case'));
  assert.equal((await api(`/api/field/visits/${chequePlanned._id}/check-in`, { method: 'POST', as: 'ravi', body: { fix: GATE } })).status, 200);
  const chequeVisit = await FieldVisit.findOne({ user: ids.ravi, status: 'checked_in' });
  assert.match((await api(`/api/field/visits/${chequeVisit._id}/check-out`, { method: 'POST', as: 'ravi', body: { fix: GATE, outcome: { key: 'collected', amount: 500, mode: 'cheque' } } })).json.message, /cheque number/, 'a cheque has a number');
  assert.match((await api(`/api/field/visits/${chequeVisit._id}/check-out`, { method: 'POST', as: 'ravi', body: { fix: GATE, outcome: { key: 'collected', amount: 500, mode: 'cheque', reference: 'CHQ 448812' } } })).json.message, /already recorded/, 'the same cheque is not entered twice — refused back to the gate, nothing kept');
  assert.equal((await FieldVisit.findById(chequeVisit._id)).status, 'checked_in', 'still at the gate');
  const cash = await api(`/api/field/visits/${chequeVisit._id}/check-out`, { method: 'POST', as: 'ravi', body: { fix: GATE, outcome: { key: 'collected', amount: 500, mode: 'cash' } } });
  assert.equal(cash.status, 200, cash.json.message);
  assert.equal((await Todo.findById(chequeVisit.task)).status, 'collected', 'cash reads Payment Received — Send to Accounts');
});

test('Sample Delivered hands the sample over: the Sampling task closes as Sample handed and the sample is with the buyer', async () => {
  const today = service.dayIST();
  const enquiry = (await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { customer: customerId, requirement: { modelNumber: 'NPT-400S' }, nextAction: 'Sample', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() } })).json.data;
  const raised = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'sample_request', note: 'Take the sample to the buyer', brief: { items: [{ model: 'NPT-400S', quantity: '3' }] } } });
  assert.equal(raised.status, 201, JSON.stringify(raised.json));
  const task = raised.json.data.task;
  const visit = (await api('/api/field/visits', { method: 'POST', as: 'admin', body: { assignee: ids.mani, task: task._id, date: today } })).json.data;
  assert.deepEqual([visit.category, visit.enquiry.number], ['sample_delivery', enquiry.number]);
  assert.equal(service.dayIST((await Todo.findById(task._id)).dueDate), today, 'due the day of the visit');
  assert.equal((await api(`/api/field/visits/${visit._id}/check-in`, { method: 'POST', as: 'mani', body: { fix: GATE } })).status, 200);
  const left = await api(`/api/field/visits/${visit._id}/check-out`, { method: 'POST', as: 'mani', body: { fix: GATE, outcome: { key: 'delivered', receivedBy: 'Merchandiser Priya', pieces: 3 }, words: { met: 'Priya', response: 'will show the buyer' } } });
  assert.equal(left.status, 200, left.json.message);
  const done = await Todo.findById(task._id).lean();
  assert.deepEqual([done.completed, done.outcome?.fields?.courier, done.outcome?.fields?.pieces], [true, 'Direct handover', '3'], 'the Sample Request closed as a sample sent is');
  assert.match(done.outcome.note, /handed over to Merchandiser Priya/);
  const { default: Sample } = await import('../src/models/Sample.js');
  const sample = await Sample.findOne({ enquiry: enquiry._id }).lean();
  assert.deepEqual([sample.status, sample.handedTo, sample.collection.pieces, sample.deliveryMethod], ['delivered', 'Merchandiser Priya', 3, 'direct']);
  const { default: Enquiry } = await import('../src/models/Enquiry.js');
  const fresh = await Enquiry.findById(enquiry._id).lean();
  assert.deepEqual([fresh.activities.at(-1).type, fresh.activities.at(-1).spokeTo], ['visit', 'Priya'], 'and an activity on the enquiry');
  assert.match(fresh.activities.at(-1).note, /Field visit — .*Delivered · received by Merchandiser Priya/);
  const records = await api(`/api/enquiries/${enquiry._id}/records`, { as: 'admin' });
  assert.equal(records.status, 200, records.json.message);
  assert.deepEqual(records.json.data.fieldVisits.map((row) => [row.status, row.outcome.label]), [['completed', 'Delivered']], 'read on the enquiry');
  ids.sampleEnquiry = enquiry._id;
});

test('a marketing visit met: the enquiry’s next follow-up moves and the meeting is its activity; a general visit is linked to the enquiry at the end', async () => {
  const today = service.dayIST();
  const next = service.dayIST(new Date(Date.now() + 5 * 86400000));
  const visit = (await api('/api/field/visits', { method: 'POST', as: 'ravi', body: { category: 'marketing', purpose: 'Meet Field Knits about the new model', date: today } })).json.data;
  assert.equal((await api(`/api/field/visits/${visit._id}/check-in`, { method: 'POST', as: 'ravi', body: { fix: GATE } })).status, 200);
  const left = await api(`/api/field/visits/${visit._id}/check-out`, { method: 'POST', as: 'ravi', body: { fix: GATE, outcome: { key: 'met', metWhom: 'Owner Raja', summary: 'Wants 2000 pcs', nextFollowUp: next }, link: { customer: customerId, enquiry: ids.sampleEnquiry } } });
  assert.equal(left.status, 200, left.json.message);
  assert.equal(left.json.data.enquiry?._id, ids.sampleEnquiry, 'linked at the end');
  const { default: Enquiry } = await import('../src/models/Enquiry.js');
  const fresh = await Enquiry.findById(ids.sampleEnquiry).lean();
  assert.equal(service.dayIST(fresh.nextFollowUpDate), next, 'the next follow-up is the visit’s');
  assert.deepEqual([fresh.activities.at(-1).type, fresh.activities.at(-1).spokeTo], ['visit', 'Owner Raja']);
});

test('a task closed cancels the visit still planned on it and tells the visitor; a task deleted is caught by the sweep; the PRT form’s visitor and date plan the visit', async () => {
  const tomorrow = service.dayIST(new Date(Date.now() + 86400000));
  const raised = (await api('/api/workspace/team-tasks', { method: 'POST', as: 'admin', body: { kind: 'prt_recovery', note: 'Visitor on the form', customer: customerId, brief: { prtMode: 'Collect cheque', visitor: ids.ravi, visitDate: tomorrow }, allowDuplicate: true } })).json.data.task;
  const fromForm = await FieldVisit.findOne({ task: raised._id }).lean();
  assert.ok(fromForm, 'the form planned it');
  assert.deepEqual([String(fromForm.user), fromForm.plannedDate, fromForm.status], [ids.ravi, tomorrow, 'planned']);
  assert.ok(await TaskNotice.findOne({ recipient: ids.ravi, statusLabel: 'Visit planned: PRT Collection', note: new RegExp(tomorrow) }), 'Ravi is told');
  const closed = await api(`/api/workspace/todos/${raised._id}/admin-close`, { method: 'POST', as: 'admin', body: { reason: 'Buyer paid online' } });
  assert.equal(closed.status, 200, closed.json.message);
  const cancelled = await FieldVisit.findById(fromForm._id).lean();
  assert.deepEqual([cancelled.status, cancelled.settled.reason], ['cancelled', 'Closed by Admin: Buyer paid online']);
  assert.ok(await TaskNotice.findOne({ recipient: ids.ravi, statusLabel: 'Visit cancelled' }));
  const another = (await api('/api/workspace/team-tasks', { method: 'POST', as: 'admin', body: { kind: 'prt_recovery', note: 'To be deleted', customer: customerId, brief: { prtMode: 'Collect cheque' }, allowDuplicate: true } })).json.data.task;
  const orphan = (await api('/api/field/visits', { method: 'POST', as: 'admin', body: { assignee: ids.ravi, task: another._id, date: tomorrow } })).json.data;
  await Todo.deleteOne({ _id: another._id });
  const told = await service.runFieldVisitSweep();
  assert.ok(told.some((entry) => entry.startsWith('orphans:')), `the sweep caught it: ${told}`);
  assert.deepEqual([(await FieldVisit.findById(orphan._id)).status, (await FieldVisit.findById(orphan._id)).settled.reason], ['cancelled', 'Task deleted']);
});

test('the sweep: a check-in two hours old is reminded; one left overnight is flagged and Admin told; a day never ended is an incomplete report', async () => {
  const today = service.dayIST();
  const visit = await FieldVisit.create({ user: ids.mani, assignedBy: ids.admin, category: 'sample_delivery', purpose: 'Sample to Field Knits', plannedDate: today, customer: customerId, status: 'checked_in', checkIn: { at: new Date(Date.now() - 3 * 3600000), lat: GATE.lat, lng: GATE.lng, accuracyM: 6, verified: true, by: ids.mani } });
  const noon = new Date(`${today}T12:00:00+05:30`);
  const told = await service.runFieldVisitSweep({ now: new Date(Math.max(noon, Date.now())) });
  assert.ok(told.includes(`afterHours:${visit._id}`), `reminded: ${told}`);
  assert.ok(await TaskNotice.findOne({ recipient: ids.mani, statusLabel: 'Still checked in?' }));
  const evening = await service.runFieldVisitSweep({ now: new Date(`${today}T18:30:00+05:30`) });
  assert.ok(evening.includes(`evening:${visit._id}`));
  assert.ok(await TaskNotice.findOne({ recipient: ids.admin, statusLabel: 'Still checked in: Mani Sampler' }));
  assert.equal((await service.runFieldVisitSweep({ now: new Date(`${today}T19:00:00+05:30`) })).length, 0, 'said once');
  const tomorrow = new Date(`${today}T09:00:00+05:30`.replace(today, service.dayIST(new Date(Date.now() + 86400000))));
  const next = await service.runFieldVisitSweep({ now: tomorrow });
  assert.ok(next.includes(`overnight:${visit._id}`), `overnight: ${next}`);
  assert.ok((await FieldVisit.findById(visit._id)).flags.some((row) => row.key === 'overnight'));
  await FieldDay.create({ user: ids.nandhini, date: '2026-10-20', dutyStart: { at: new Date('2026-10-20T03:30:00Z'), verified: true } });
  const stale = await service.runFieldVisitSweep({ now: tomorrow });
  assert.ok(stale.some((entry) => entry.startsWith('incomplete:')));
  assert.match((await TaskNotice.findOne({ recipient: ids.admin, statusLabel: 'Field day report incomplete: Nandhini S' })).note, /2026-10-20/);
});
