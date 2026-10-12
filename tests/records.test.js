/**
 * The plant's records:
 *   - QC records: breaking strength worked out from the samples, a failed test cannot be Passed,
 *     a deviation needs a reason, the Quality task hears it, approval by someone else, the PDF
 *   - machines and their maintenance: the next service falls due from the last one
 *   - mould maintenance and runs: one run at a time on a machine and a mould, the shots added to
 *     the mould's life once, maintenance due by shot count
 *   - the dispatch register: trips that left, with the LR details, as JSON and CSV
 *
 *   node --test tests/records.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'records-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
const ids = {};
let Todo;
let Trip;
let SalesOrder;

const request = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return response;
};
const api = async (path, options) => {
  const response = await request(path, options);
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const enquiryFor = async (name, mobile) => {
  const buyer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name, mobile, assignedTo: ids.nandhini } })).json.data;
  return (await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { customer: buyer._id, requirement: { modelNumber: 'NH-400' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() } })).json.data;
};
let mouldSeq = 0;
const addMould = async (body = {}) => {
  const made = await api('/api/moulds', { method: 'POST', as: 'siva', body: { mouldCode: `M-R${++mouldSeq}`, name: '400mm shirt hanger', cavities: 4, partWeightGrams: 30, runnerWeightGrams: 12, cycleTimeSeconds: 30, ...body } });
  assert.equal(made.status, 201, made.json.message);
  return made.json.data;
};
let machineSeq = 0;
const addMachine = async (body = {}) => {
  const made = await api('/api/machines', { method: 'POST', as: 'siva', body: { code: `IM-${++machineSeq}`, name: 'Toshiba 150T', tonnage: 150, ...body } });
  assert.equal(made.status, 201, made.json.message);
  return made.json.data;
};

const SHEET = {
  stage: 'final',
  modelNumber: 'NH-400',
  size: '400 mm',
  mouldingType: 'injection_assembly',
  resin: { name: 'PP', grade: 'H110MA', batch: 'B-2291', colour: 'Black', masterbatch: 'Black MB', masterbatchPercent: 2, regrindPercent: 10 },
  hook: { type: 'Chrome swivel', finish: 'Chrome', pullRequiredKg: 8, pullActualKg: 11 },
  clip: { type: 'Pinch clips', gripRequiredKg: 1.5, gripActualKg: 2 },
  print: { type: 'pad', colour: 'White', artwork: 'NPT logo', adhesion: 'pass' },
  weight: { target: 30, tolerance: 1, actual: 30.4 },
  measurements: [{ name: 'Width', unit: 'mm', target: 400, tolerance: 2, actual: 399 }],
  breaking: { requiredKg: 15, samplesKg: [18, 17.5, 19, 16] },
  hangLoad: { loadKg: 5, hours: 24, deflectionMm: 4, allowedDeflectionMm: 6 },
  lotSize: 10000,
  sampleSize: 80,
  rejected: 0,
  verdict: 'passed',
};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  ({ default: Trip } = await import('../src/models/Trip.js'));
  ({ default: SalesOrder } = await import('../src/models/SalesOrder.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['arun', 'Arun K', 'marketing'], ['siva', 'Sivakumar', 'production'], ['priya', 'Priya QC', 'quality'], ['kavin', 'Kavin QC Head', 'quality'], ['murali', 'Murali Mould', 'mould'], ['ravi', 'Ravi Despatch', 'despatch']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
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

test('a QC record works out breaking strength and every test from the figures, and the Quality task hears it', async () => {
  const enquiry = await enquiryFor('Lakshmi Apparels', '9840040001');
  const raised = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'quality_check', note: 'Check before dispatch', brief: {} } });
  assert.equal(raised.status, 201, raised.json.message);
  const task = raised.json.data.task._id;
  const mould = await addMould();
  const machine = await addMachine();

  const made = await api('/api/qc-records', { method: 'POST', as: 'priya', body: { ...SHEET, task, mould: mould._id, machine: machine._id, shift: 'A', operator: 'Mani' } });
  assert.equal(made.status, 201, made.json.message);
  const record = made.json.data;
  assert.match(record.number, /^QCR/);
  assert.deepEqual([record.breaking.minKg, record.breaking.avgKg, record.breaking.maxKg, record.breaking.result], [16, 17.6, 19, 'pass']);
  assert.equal(record.hook.result, 'pass');
  assert.equal(record.clip.result, 'pass');
  assert.equal(record.weight.result, 'pass');
  assert.equal(record.measurements[0].result, 'pass');
  assert.equal(record.hangLoad.result, 'pass');
  assert.equal(record.accepted, 80, 'accepted is the sample less the rejected');
  assert.deepEqual(record.failedTests, []);
  /* The enquiry and buyer come off the task. */
  assert.equal(record.enquiry.number, enquiry.number);
  assert.equal(record.customer.name, 'Lakshmi Apparels');
  assert.equal(record.mould.mouldCode, mould.mouldCode);
  assert.equal(record.machine.code, machine.code);

  const updates = (await Todo.findById(task).lean()).updates || [];
  assert.ok(updates.some((row) => row.note.includes(record.number) && row.note.includes('passed')), 'the task carries the record');

  const listed = await api(`/api/qc-records?enquiry=${enquiry._id}`, { as: 'priya' });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.data.length, 1);
  assert.equal(listed.json.pagination.total, 1);
});

test('a failed test cannot be marked Passed; a deviation needs its reason; rejected pieces need their defects', async () => {
  const weak = { ...SHEET, breaking: { requiredKg: 15, samplesKg: [18, 14.2, 17] } };
  const refused = await api('/api/qc-records', { method: 'POST', as: 'priya', body: weak });
  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /Breaking strength failed/);

  const noReason = await api('/api/qc-records', { method: 'POST', as: 'priya', body: { ...weak, verdict: 'passed_with_deviation' } });
  assert.equal(noReason.status, 400);
  assert.match(noReason.json.message, /deviation/);

  const deviation = await api('/api/qc-records', { method: 'POST', as: 'priya', body: { ...weak, verdict: 'passed_with_deviation', remarks: 'Buyer agreed 14 kgf on the phone' } });
  assert.equal(deviation.status, 201, deviation.json.message);
  assert.deepEqual(deviation.json.data.failedTests, ['Breaking strength']);

  const rejectedNoDefects = await api('/api/qc-records', { method: 'POST', as: 'priya', body: { ...SHEET, rejected: 3, verdict: 'rejected' } });
  assert.equal(rejectedNoDefects.status, 400);
  assert.match(rejectedNoDefects.json.message, /what was wrong/);

  const rejectedPassed = await api('/api/qc-records', { method: 'POST', as: 'priya', body: { ...SHEET, rejected: 3, defects: [{ type: 'flash', count: 3 }] } });
  assert.equal(rejectedPassed.status, 400, 'rejected pieces are not a clean pass');

  const tooMany = await api('/api/qc-records', { method: 'POST', as: 'priya', body: { ...SHEET, sampleSize: 5, rejected: 6, defects: [{ type: 'flash', count: 6 }], verdict: 'rejected' } });
  assert.equal(tooMany.status, 400);

  const notQuality = await enquiryFor('Kumaran Tex', '9840040002');
  const dispatchTask = (await api(`/api/enquiries/${notQuality._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'invoice_dispatch', note: 'Go', brief: {} } })).json.data.task._id;
  const wrongTask = await api('/api/qc-records', { method: 'POST', as: 'priya', body: { ...SHEET, task: dispatchTask } });
  assert.equal(wrongTask.status, 400);
  assert.match(wrongTask.json.message, /Quality task/);
});

test('a QC record is approved by someone other than its inspector, once, and prints as a PDF', async () => {
  const record = (await api('/api/qc-records', { method: 'POST', as: 'priya', body: SHEET })).json.data;
  const own = await api(`/api/qc-records/${record._id}/approve`, { method: 'POST', as: 'priya' });
  assert.equal(own.status, 403);
  const approved = await api(`/api/qc-records/${record._id}/approve`, { method: 'POST', as: 'kavin' });
  assert.equal(approved.status, 200, approved.json.message);
  assert.equal(approved.json.data.approvedBy.name, 'Kavin QC Head');
  const twice = await api(`/api/qc-records/${record._id}/approve`, { method: 'POST', as: 'admin' });
  assert.equal(twice.status, 409);

  const pdf = await request(`/api/qc-records/${record._id}/certificate`, { as: 'priya' });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
});

test('QC records are Quality’s to write; production reads them, dispatch does not', async () => {
  assert.equal((await api('/api/qc-records', { method: 'POST', as: 'siva', body: SHEET })).status, 403);
  assert.equal((await api('/api/qc-records', { as: 'siva' })).status, 200);
  assert.equal((await api('/api/qc-records', { as: 'murali' })).status, 403);
  assert.equal((await api('/api/qc-records', { method: 'POST', as: 'priya', body: { ...SHEET, stage: 'somewhere' } })).status, 400);
  assert.equal((await api('/api/qc-records/not-an-id', { as: 'priya' })).status, 404);
});

test('maintenance on a machine sets when the next service falls due and puts it back in service', async () => {
  const machine = await addMachine({ serviceEveryDays: 90, status: 'breakdown' });
  const doneOn = new Date(Date.now() - 2 * 86400000);
  const done = await api('/api/maintenance', { method: 'POST', as: 'siva', body: { asset: 'machine', machine: machine._id, type: 'breakdown', doneOn: doneOn.toISOString(), problem: 'Hydraulic leak', workDone: 'Replaced the main seal', parts: [{ name: 'Seal kit', quantity: 1, cost: 2400 }], labourCost: 600, downtimeHours: 5 } });
  assert.equal(done.status, 201, done.json.message);
  assert.match(done.json.data.number, /^MNT/);
  assert.equal(done.json.data.totalCost, 3000);

  const detail = (await api(`/api/machines/${machine._id}`, { as: 'siva' })).json.data;
  assert.equal(detail.machine.status, 'idle', 'back in service after the repair');
  assert.equal(new Date(detail.machine.lastServiceAt).getTime(), doneOn.getTime());
  assert.equal(new Date(detail.machine.nextServiceDue).getTime(), doneOn.getTime() + 90 * 86400000);
  assert.equal(detail.maintenance.length, 1);
  assert.equal(detail.maintenance[0].workDone, 'Replaced the main seal');

  /* An older record filed late does not pull the last service back. */
  await api('/api/maintenance', { method: 'POST', as: 'siva', body: { asset: 'machine', machine: machine._id, type: 'cleaning', doneOn: new Date(Date.now() - 30 * 86400000).toISOString(), workDone: 'Greased the toggles' } });
  const after = (await api(`/api/machines/${machine._id}`, { as: 'siva' })).json.data;
  assert.equal(new Date(after.machine.lastServiceAt).getTime(), doneOn.getTime());
  assert.equal(after.maintenance.length, 2);

  const future = await api('/api/maintenance', { method: 'POST', as: 'siva', body: { asset: 'machine', machine: machine._id, type: 'preventive', doneOn: new Date(Date.now() + 5 * 86400000).toISOString(), workDone: 'Not yet' } });
  assert.equal(future.status, 400);
  const noMachine = await api('/api/maintenance', { method: 'POST', as: 'siva', body: { asset: 'machine', type: 'preventive', workDone: 'Something' } });
  assert.equal(noMachine.status, 400);

  /* Machines are production’s to add; the tool room reads them and records mould maintenance. */
  assert.equal((await api('/api/machines', { method: 'POST', as: 'murali', body: { code: 'IM-X' } })).status, 403);
  assert.equal((await api('/api/machines', { as: 'murali' })).status, 200);
  assert.equal((await api('/api/maintenance', { method: 'POST', as: 'ravi', body: { asset: 'machine', machine: machine._id, type: 'cleaning', workDone: 'Wiped it' } })).status, 403);
  const twin = await api('/api/machines', { method: 'POST', as: 'siva', body: { code: machine.code.toLowerCase() } });
  assert.equal(twin.status, 409, 'machine numbers are unique, whatever the case');
});

test('one run at a time on a machine and on a mould; finishing adds its shots to the mould once', async () => {
  const mould = await addMould({ maintenanceEveryShots: 1000 });
  const other = await addMould();
  const machine = await addMachine();
  const enquiry = await enquiryFor('Sri Murugan Garments', '9840040003');

  const started = await api('/api/mould-runs', { method: 'POST', as: 'siva', body: { mould: mould._id, machine: machine._id, enquiry: enquiry._id, plannedQuantity: 4000, shift: 'A', operator: 'Mani', resin: { name: 'PP', batch: 'B-2291' } } });
  assert.equal(started.status, 201, started.json.message);
  const run = started.json.data;
  assert.match(run.number, /^RUN/);
  assert.equal(run.counterStart, 0);
  assert.equal(run.cavitiesRunning, 4, 'from the mould');
  assert.equal(run.customer.name, 'Sri Murugan Garments');
  assert.equal((await api(`/api/machines/${machine._id}`, { as: 'siva' })).json.data.machine.status, 'running');

  const sameMachine = await api('/api/mould-runs', { method: 'POST', as: 'siva', body: { mould: other._id, machine: machine._id } });
  assert.equal(sameMachine.status, 409);
  assert.match(sameMachine.json.message, /machine/);
  const sameMould = await api('/api/mould-runs', { method: 'POST', as: 'siva', body: { mould: mould._id } });
  assert.equal(sameMould.status, 409);
  assert.match(sameMould.json.message, /mould/);

  const backwards = await api(`/api/mould-runs/${run._id}/finish`, { method: 'POST', as: 'siva', body: { counterEnd: 0 } });
  assert.equal(backwards.status, 200, 'a counter that did not move is allowed');
  const again = await api(`/api/mould-runs/${run._id}/finish`, { method: 'POST', as: 'siva', body: { counterEnd: 1200 } });
  assert.equal(again.status, 409, 'a finished run cannot be finished again');

  const second = (await api('/api/mould-runs', { method: 'POST', as: 'siva', body: { mould: mould._id, machine: machine._id, counterStart: 500 } })).json.data;
  const below = await api(`/api/mould-runs/${second._id}/finish`, { method: 'POST', as: 'siva', body: { counterEnd: 400 } });
  assert.equal(below.status, 400);
  assert.match(below.json.message, /below/);
  const finished = await api(`/api/mould-runs/${second._id}/finish`, { method: 'POST', as: 'siva', body: { counterEnd: 1700, goodPieces: 4700, rejectedPieces: 100, downtimeMinutes: 20, downtimeReason: 'Heater band' } });
  assert.equal(finished.status, 200, finished.json.message);
  assert.equal(finished.json.data.status, 'completed');
  assert.equal(finished.json.data.shots, 1200);
  assert.equal(finished.json.data.shotsCounted, 1200);
  assert.equal(finished.json.data.rejectPercent, 2.1);
  assert.equal(finished.json.data.mould.totalShots, 1200);
  assert.equal((await api(`/api/machines/${machine._id}`, { as: 'siva' })).json.data.machine.status, 'idle');

  /* Past 1,000 shots since its last maintenance: due. Maintenance at 1,200 resets the count. */
  let history = (await api(`/api/moulds/${mould._id}/history`, { as: 'siva' })).json.data;
  assert.equal(history.mould.totalShots, 1200);
  assert.equal(history.mould.shotsSinceMaintenance, 1200);
  assert.equal(history.mould.maintenanceDue, true);
  assert.equal(history.runs.length, 2);

  const serviced = await api('/api/maintenance', { method: 'POST', as: 'murali', body: { asset: 'mould', mould: mould._id, onMachine: machine._id, type: 'polishing', workDone: 'Polished cavities 1–4', doneBy: 'Tool room' } });
  assert.equal(serviced.status, 201, serviced.json.message);
  assert.equal(serviced.json.data.shotCount, 1200);
  assert.equal(serviced.json.data.nextDueShots, 2200);
  history = (await api(`/api/moulds/${mould._id}/history`, { as: 'murali' })).json.data;
  assert.equal(history.mould.lastMaintenanceShots, 1200);
  assert.equal(history.mould.shotsSinceMaintenance, 0);
  assert.equal(history.mould.maintenanceDue, false);
  assert.equal(history.maintenance.length, 1);
  /* QC sheets on the mould are Quality's: production reads them, the tool room does not. */
  await api('/api/qc-records', { method: 'POST', as: 'priya', body: { ...SHEET, mould: mould._id } });
  assert.equal((await api(`/api/moulds/${mould._id}/history`, { as: 'siva' })).json.data.qc.length, 1);
  assert.equal((await api(`/api/moulds/${mould._id}/history`, { as: 'murali' })).json.data.qc.length, 0);
  /* The interval can be set, and switched off, on the mould's own edit. */
  const reminder = await api(`/api/moulds/${mould._id}`, { method: 'PATCH', as: 'siva', body: { maintenanceEveryShots: null } });
  assert.equal(reminder.status, 200, reminder.json.message);
  assert.equal(reminder.json.data.maintenanceEveryShots ?? null, null);
  /* The machine it was on sees it in its own history too. */
  const onMachine = (await api(`/api/machines/${machine._id}`, { as: 'siva' })).json.data;
  assert.ok(onMachine.maintenance.some((row) => row.asset === 'mould'));
  assert.equal(onMachine.runs.length, 2);

  /* Runs are production’s to start. */
  assert.equal((await api('/api/mould-runs', { method: 'POST', as: 'murali', body: { mould: other._id } })).status, 403);
});

test('two people starting a run on the same machine at once: one run', async () => {
  const machine = await addMachine();
  const [first, second] = await Promise.all([addMould(), addMould()]);
  const results = await Promise.all([first, second].map((mould) => api('/api/mould-runs', { method: 'POST', as: 'siva', body: { mould: mould._id, machine: machine._id } })));
  const statuses = results.map((row) => row.status).sort();
  assert.deepEqual(statuses, [201, 409], JSON.stringify(results.map((row) => row.json.message)));
});

test('the dispatch register lists what left, with the LR details, and exports as CSV', async () => {
  const enquiry = await enquiryFor('Velan Fashions', '9840040004');
  const dispatchTask = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'invoice_dispatch', note: 'Go', brief: {} } })).json.data.task;
  const lr = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'lr_copy', note: 'LR', brief: {} } })).json.data.task;
  await Todo.updateOne({ _id: lr._id }, { $set: { brief: { lrNumber: 'LR-5521', transporter: 'KPN Parcel', invoiceNumber: 'INV-77' } } });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  await Trip.create({
    number: 'TRP-REG-1', date: today, mode: 'own_vehicle', driverName: 'Selvam', status: 'left', leftAt: new Date(), createdBy: ids.ravi,
    stops: [{ task: dispatchTask._id, enquiry: enquiry._id, customer: enquiry.customer?._id || enquiry.customer, model: 'NH-400', quantity: 5000, cartons: 25, status: 'delivered' }],
  });
  await Trip.create({ number: 'TRP-REG-2', date: today, mode: 'own_vehicle', status: 'planned', createdBy: ids.ravi, stops: [{ task: new mongoose.Types.ObjectId(), enquiry: enquiry._id }] });

  const register = await api('/api/dispatch-register', { as: 'ravi' });
  assert.equal(register.status, 200, register.json.message);
  const rows = register.json.data.filter((row) => row.enquiry === enquiry.number);
  assert.equal(rows.length, 1, 'a trip that has not left is not in the register');
  assert.equal(rows[0].customer, 'Velan Fashions');
  assert.equal(rows[0].cartons, 25);
  assert.equal(rows[0].lrNumber, 'LR-5521');
  assert.equal(rows[0].invoiceNumber, 'INV-77');
  assert.equal(rows[0].delivery, 'Delivered');
  assert.equal(rows[0].driver, 'Selvam');
  assert.equal(register.json.meta.to, today);

  const csv = await request('/api/dispatch-register?format=csv', { as: 'ravi' });
  assert.equal(csv.status, 200);
  const body = await csv.text();
  assert.match(body, /Date,Trip,Buyer/);
  assert.match(body, /LR-5521/);

  assert.equal((await api('/api/dispatch-register?from=2024-01-01&to=2026-06-01', { as: 'ravi' })).status, 400, 'at most a year');
  assert.equal((await api('/api/dispatch-register', { as: 'priya' })).status, 403);
});

test('an SO carries its QC records and its dispatch details — the trips, the delivery and the LR', async () => {
  const enquiry = await enquiryFor('Ganesh Knits', '9840040005');
  const other = await enquiryFor('Ganesh Knits Unit 2', '9840040006');
  const customer = enquiry.customer?._id || enquiry.customer;
  const order = await SalesOrder.create({
    number: 'SO-LINK-1', customer, enquiry: enquiry._id, assignedTo: ids.nandhini, status: 'production_running',
    customerPo: { number: 'PO/GK/77' },
    lines: [{ modelNumber: 'NH-400', quantity: 5000, unitPrice: 7.5 }, { modelNumber: 'NH-420', colour: 'White', quantity: 3000, unitPrice: 8 }],
  });
  const elsewhere = await SalesOrder.create({ number: 'SO-LINK-2', customer, enquiry: other._id, assignedTo: ids.nandhini, lines: [{ modelNumber: 'NH-400', quantity: 100, unitPrice: 7 }] });

  /* Tasks raised on the enquiry carry its SO. */
  const check = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'quality_check', note: 'Check the lot', brief: {} } })).json.data.task;
  assert.equal(String((await Todo.findById(check._id).lean()).order), String(order._id));

  /* From the task: the SO comes with it. Picked with a line: the model comes off the line. */
  const fromTask = await api('/api/qc-records', { method: 'POST', as: 'priya', body: { ...SHEET, modelNumber: undefined, task: check._id } });
  assert.equal(fromTask.status, 201, fromTask.json.message);
  assert.equal(fromTask.json.data.order.number, 'SO-LINK-1');
  assert.equal(fromTask.json.data.order.customerPo.number, 'PO/GK/77');
  const second = order.lines[1]._id;
  const onLine = await api('/api/qc-records', { method: 'POST', as: 'priya', body: { ...SHEET, modelNumber: undefined, order: String(order._id), orderLine: String(second) } });
  assert.equal(onLine.status, 201, onLine.json.message);
  assert.equal(onLine.json.data.modelNumber, 'NH-420');
  assert.equal(onLine.json.data.enquiry.number, enquiry.number, 'the enquiry comes off the SO');
  /* From the enquiry alone: its SO. */
  const fromEnquiry = await api('/api/qc-records', { method: 'POST', as: 'priya', body: { ...SHEET, enquiry: enquiry._id, verdict: 'rejected', rejected: 2, defects: [{ type: 'flash', count: 2 }], orderLine: String(second) } });
  assert.equal(fromEnquiry.status, 201, fromEnquiry.json.message);
  assert.equal(fromEnquiry.json.data.order.number, 'SO-LINK-1');

  const wrongLine = await api('/api/qc-records', { method: 'POST', as: 'priya', body: { ...SHEET, order: String(order._id), orderLine: String(elsewhere.lines[0]._id) } });
  assert.equal(wrongLine.status, 400);
  assert.match(wrongLine.json.message, /not on SO-LINK-1/);
  const wrongEnquiry = await api('/api/qc-records', { method: 'POST', as: 'priya', body: { ...SHEET, enquiry: enquiry._id, order: String(elsewhere._id) } });
  assert.equal(wrongEnquiry.status, 400);

  const qc = await api(`/api/orders/${order._id}/qc-records`, { as: 'priya' });
  assert.equal(qc.status, 200, qc.json.message);
  assert.equal(qc.json.data.length, 3);
  assert.deepEqual(qc.json.lines.map((line) => line.verdict), [null, 'rejected'], 'the latest verdict per line');
  assert.equal((await api(`/api/qc-records?order=${order._id}`, { as: 'priya' })).json.pagination.total, 3);
  const pdf = await request(`/api/qc-records/${onLine.json.data._id}/certificate`, { as: 'priya' });
  assert.equal(pdf.status, 200);

  /* Dispatch: the request carries the SO; the trip, the delivery and the LR come back on it. */
  const dispatch = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'invoice_dispatch', note: 'Send it', brief: { quantity: '5000' } } });
  assert.equal(dispatch.status, 201, dispatch.json.message);
  const request_ = dispatch.json.data.task;
  assert.equal(String((await Todo.findById(request_._id).lean()).order), String(order._id));
  const lr = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'lr_copy', note: 'LR', brief: {} } })).json.data.task;
  await Todo.updateOne({ _id: lr._id }, { $set: { brief: { lrNumber: 'LR-9001', transporter: 'KPN Parcel', invoiceNumber: 'INV-501' } } });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  await Trip.create({
    number: 'TRP-LINK-1', date: today, mode: 'own_vehicle', driverName: 'Selvam', status: 'left', leftAt: new Date(), createdBy: ids.ravi,
    stops: [{ task: request_._id, enquiry: enquiry._id, customer, model: 'NH-400', quantity: 5000, cartons: 25, status: 'delivered', at: new Date() }],
  });

  const details = await api(`/api/orders/${order._id}/dispatch-details`, { as: 'nandhini' });
  assert.equal(details.status, 200, details.json.message);
  const [sent] = details.json.data.requests;
  assert.equal(sent.quantity, '5000');
  assert.equal(sent.trips[0].trip, 'TRP-LINK-1');
  assert.equal(sent.trips[0].delivery, 'delivered');
  assert.equal(sent.trips[0].cartons, 25);
  assert.equal(details.json.data.lr[0].lrNumber, 'LR-9001');
  assert.equal(details.json.data.lr[0].invoiceNumber, 'INV-501');
  /* The other SO's page shows none of it. */
  assert.equal((await api(`/api/orders/${elsewhere._id}/dispatch-details`, { as: 'nandhini' })).json.data.requests.length, 0);

  /* Someone else's order is not found; the SO team reads dispatch but not the QC sheets. */
  assert.equal((await api(`/api/orders/${order._id}/dispatch-details`, { as: 'arun' })).status, 404);
  assert.equal((await api(`/api/orders/${order._id}/qc-records`, { as: 'ravi' })).status, 200, 'dispatch holds the quality read');
  assert.equal((await api('/api/orders/not-an-id/dispatch-details', { as: 'nandhini' })).status, 404);

  const register = (await api('/api/dispatch-register', { as: 'ravi' })).json.data.find((row) => row.trip === 'TRP-LINK-1');
  assert.equal(register.order, 'SO-LINK-1');
  assert.equal(register.buyerPo, 'PO/GK/77');
});
