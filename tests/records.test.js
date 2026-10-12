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
process.env.WHATSAPP_WEBHOOK_TOKEN = 'records-webhook-token';

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

test('a QC sheet is prefilled from the task, enquiry, SO and line; the enquiry shows its SOs, QC and dispatch', async () => {
  const mould = await addMould({ hookType: 'swivel', sizeMm: 400, partWeightGrams: 31 });
  const enquiry = await enquiryFor('Kavya Exports', '9840040007');
  const customer = enquiry.customer?._id || enquiry.customer;

  /* Before there is an SO: the enquiry's one item. */
  const early = await api(`/api/qc-records/prefill?enquiry=${enquiry._id}`, { as: 'priya' });
  assert.equal(early.status, 200, early.json.message);
  assert.equal(early.json.data.lineKind, 'enquiry');
  assert.equal(early.json.data.customer, 'Kavya Exports');
  assert.equal(early.json.data.fields.modelNumber, 'NH-400');

  const order = await SalesOrder.create({
    number: 'SO-PRE-1', customer, enquiry: enquiry._id, assignedTo: ids.nandhini, status: 'production_running', customerPo: { number: 'PO/KE/9' },
    lines: [
      { mould: mould._id, modelNumber: mould.mouldCode, material: 'pp', colour: 'Black', printing: 'Pad print, white logo', quantity: 6000, unitPrice: 7.5 },
      { modelNumber: 'NH-500', colour: 'White', quantity: 2000, unitPrice: 9 },
    ],
  });
  const check = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'quality_check', note: 'Check it', brief: {} } })).json.data.task;

  /* From the task, two lines: the choices, and nothing per-model until one is picked. */
  const choices = (await api(`/api/qc-records/prefill?task=${check._id}`, { as: 'priya' })).json.data;
  assert.equal(choices.order.number, 'SO-PRE-1');
  assert.equal(choices.order.buyerPo, 'PO/KE/9');
  assert.equal(choices.enquiry.number, enquiry.number);
  assert.equal(choices.lines.length, 2);
  assert.equal(choices.line, null);
  assert.deepEqual(choices.fields, {});

  const picked = (await api(`/api/qc-records/prefill?task=${check._id}&orderLine=${order.lines[0]._id}`, { as: 'priya' })).json.data;
  assert.equal(picked.line, String(order.lines[0]._id));
  const { fields } = picked;
  assert.equal(fields.modelNumber, mould.mouldCode);
  assert.equal(fields.mould, String(mould._id));
  assert.equal(fields.size, '400 mm');
  assert.equal(fields.mouldingType, 'injection_assembly', 'a swivel hook is fitted after moulding');
  assert.equal(fields.cavities, 'All 4');
  assert.deepEqual(fields.resin, { name: 'PP', colour: 'Black' });
  assert.equal(fields.hook.type, 'swivel');
  assert.deepEqual(fields.print, { type: 'pad', artwork: 'Pad print, white logo' });
  assert.deepEqual(fields.weight, { target: 31 });
  assert.deepEqual(fields.measurements, [{ name: 'Width', unit: 'mm', target: 400 }]);
  assert.equal(fields.lotSize, 6000);

  assert.equal((await api(`/api/qc-records/prefill?order=${order._id}&orderLine=${mould._id}`, { as: 'priya' })).status, 400);
  assert.equal((await api('/api/qc-records/prefill?enquiry=nope', { as: 'priya' })).status, 400);
  assert.equal((await api(`/api/qc-records/prefill?enquiry=${enquiry._id}`, { as: 'ravi' })).status, 403, 'Quality’s form');

  /* The enquiry's own page: its SO, its QC sheets, its dispatch with the SO on each request. */
  await api('/api/qc-records', { method: 'POST', as: 'priya', body: { ...SHEET, task: check._id, orderLine: String(order.lines[0]._id) } });
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'invoice_dispatch', note: 'Go', brief: { quantity: '6000' } } });
  assert.equal(sent.status, 201, sent.json.message);
  const records = await api(`/api/enquiries/${enquiry._id}/records`, { as: 'nandhini' });
  assert.equal(records.status, 200, records.json.message);
  assert.deepEqual(records.json.data.orders.map((row) => [row.number, row.buyerPo, row.quantity]), [['SO-PRE-1', 'PO/KE/9', 8000]]);
  assert.equal(records.json.data.qc.length, 1);
  assert.equal(records.json.data.qc[0].order.number, 'SO-PRE-1');
  assert.equal(records.json.data.dispatch.requests[0].order.number, 'SO-PRE-1');
  assert.equal(records.json.data.dispatch.requests[0].quantity, '6000');
  /* Dispatch, which works the enquiry, sees it too; another marketing person does not. */
  assert.equal((await api(`/api/enquiries/${enquiry._id}/records`, { as: 'ravi' })).status, 200);
  assert.equal((await api(`/api/enquiries/${enquiry._id}/records`, { as: 'arun' })).status, 404);
});

test('a model’s and a buyer’s test standards fill the minimums; AQL decides the sample; the new tests are worked out', async () => {
  const mould = await addMould({ hookType: 'swivel', sizeMm: 400 });
  const standards = await api(`/api/moulds/${mould._id}`, { method: 'PATCH', as: 'siva', body: { qcStandards: { breakingMinKg: 15, hookPullMinKg: 8, hookTurns: 500, widthToleranceMm: 2, moistureMaxPercent: 0.2, piecesPerCarton: 200, aql: 2.5 } } });
  assert.equal(standards.status, 200, standards.json.message);
  const enquiry = await enquiryFor('Ruby Garments', '9840040008');
  const buyer = await api(`/api/customers/${enquiry.customer?._id || enquiry.customer}`, { as: 'nandhini' });
  const buyerDoc = buyer.json.data.customer;
  const stricter = await api(`/api/customers/${buyerDoc._id}`, { method: 'PATCH', as: 'nandhini', body: { qcStandards: { breakingMinKg: 18 }, expectedUpdatedAt: buyerDoc.updatedAt } });
  assert.equal(stricter.status, 200, stricter.json.message);
  const order = await SalesOrder.create({ number: 'SO-STD-1', customer: buyerDoc._id, enquiry: enquiry._id, assignedTo: ids.nandhini, status: 'production_running', lines: [{ mould: mould._id, modelNumber: mould.mouldCode, quantity: 10000, unitPrice: 7 }] });

  const { fields } = (await api(`/api/qc-records/prefill?order=${order._id}`, { as: 'priya' })).json.data;
  assert.equal(fields.breaking.requiredKg, 18, 'the buyer’s figure wins');
  assert.equal(fields.hook.pullRequiredKg, 8, 'the model’s where the buyer says nothing');
  assert.equal(fields.hookTurns.required, 500);
  assert.equal(fields.resinChecks.moistureMaxPercent, 0.2);
  assert.equal(fields.packing.piecesPerCarton, 200);
  assert.equal(fields.measurements[0].tolerance, 2);
  assert.equal(fields.aql, 2.5);
  assert.match(fields.standardsFrom, new RegExp(`model ${mould.mouldCode} · buyer Ruby Garments`));

  /* AQL 2.5 on 10,000: 200 pieces, accept up to 10 — five rejects still pass the lot. */
  const lot = { ...SHEET, order: String(order._id), lotSize: 10000, sampleSize: undefined, aql: 2.5, rejected: 5, defects: [{ type: 'flash', count: 5 }] };
  const within = await api('/api/qc-records', { method: 'POST', as: 'priya', body: lot });
  assert.equal(within.status, 201, within.json.message);
  assert.deepEqual(within.json.data.aqlPlan, { letter: 'L', sampleSize: 200, accept: 10, reject: 11 });
  assert.equal(within.json.data.sampleSize, 200);
  assert.equal(within.json.data.aqlResult, 'pass');
  const over = await api('/api/qc-records', { method: 'POST', as: 'priya', body: { ...lot, rejected: 12, defects: [{ type: 'flash', count: 12 }] } });
  assert.equal(over.status, 400);
  assert.match(over.json.message, /AQL sample/);

  /* The new tests, worked out from their figures. */
  const tested = await api('/api/qc-records', {
    method: 'POST', as: 'priya',
    body: {
      ...SHEET, verdict: 'rejected',
      hookTurns: { required: 500, achieved: 650 },
      shrinkage: { mouldMm: 402, partMm: 400, maxPercent: 1 },
      resinChecks: { moisturePercent: 0.3, moistureMaxPercent: 0.2, mfi: 11, mfiMin: 8, mfiMax: 12 },
      packing: { piecesPerCarton: 200, piecesFound: 196, labels: 'pass' },
      uv: { hours: 72, result: 'pass' },
      cartonDrop: { heightCm: 90, drops: 3, result: 'fail' },
    },
  });
  assert.equal(tested.status, 201, tested.json.message);
  const record = tested.json.data;
  assert.equal(record.hookTurns.result, 'pass');
  assert.equal(record.shrinkage.percent, 0.5);
  assert.equal(record.shrinkage.result, 'pass');
  assert.equal(record.resinChecks.moistureResult, 'fail');
  assert.equal(record.resinChecks.mfiResult, 'pass');
  assert.equal(record.packing.result, 'fail', 'four short a carton');
  assert.deepEqual(record.failedTests, ['Resin moisture', 'Packing', 'Carton drop']);
  const pdf = await request(`/api/qc-records/${record._id}/certificate`, { as: 'priya' });
  assert.equal(pdf.status, 200);
});

test('a rejected lot warns Dispatch on the open request — and the request still moves', async () => {
  const enquiry = await enquiryFor('Zara Knit Wear', '9840040009');
  const customer = enquiry.customer?._id || enquiry.customer;
  const order = await SalesOrder.create({ number: 'SO-WARN-1', customer, enquiry: enquiry._id, assignedTo: ids.nandhini, status: 'production_running', lines: [{ modelNumber: 'NH-400', quantity: 5000, unitPrice: 7 }] });
  const request = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'invoice_dispatch', note: 'Send it', brief: { quantity: '5000' } } })).json.data.task;
  const { default: TaskNotice } = await import('../src/models/TaskNotice.js');
  const before = await TaskNotice.countDocuments({ task: request._id });

  const rejected = await api('/api/qc-records', { method: 'POST', as: 'priya', body: { ...SHEET, stage: 'pre_dispatch', enquiry: enquiry._id, order: String(order._id), verdict: 'rejected', breaking: { requiredKg: 15, samplesKg: [12, 13] } } });
  assert.equal(rejected.status, 201, rejected.json.message);
  const told = await Todo.findById(request._id).lean();
  assert.ok(told.updates.some((row) => row.note.includes(rejected.json.data.number) && /not held/.test(row.note)));
  const notices = await TaskNotice.find({ task: request._id }).lean();
  assert.ok(notices.length > before, 'Dispatch, marketing and Admin hear it');
  assert.ok(notices.some((row) => String(row.recipient) === ids.ravi), 'the dispatch desk');
  assert.ok(notices.some((row) => String(row.recipient) === ids.nandhini), 'the marketing person');

  /* The plan and the SO's dispatch details show it; the request moves on regardless. */
  const plan = (await api('/api/dispatch-planning/plan', { as: 'ravi' })).json.data;
  const stop = [...plan.groups.flatMap((group) => group.stops), ...plan.notReady, ...plan.waitingPayment].find((row) => String(row.task) === String(request._id));
  assert.equal(stop.qc.verdict, 'rejected');
  assert.deepEqual(stop.qc.failed, ['Breaking strength']);
  const details = (await api(`/api/orders/${order._id}/dispatch-details`, { as: 'nandhini' })).json.data;
  assert.equal(details.requests[0].qc.number, rejected.json.data.number);
  const moved = await api(`/api/workspace/todos/${request._id}/status`, { method: 'POST', as: 'ravi', body: { status: 'dispatched', note: 'Buyer accepted it as is' } });
  assert.equal(moved.status, 200, moved.json.message);

  /* An incoming-material check is not about the goods going out: no warning. */
  const count = (await Todo.findById(request._id).lean()).updates.length;
  await api('/api/qc-records', { method: 'POST', as: 'priya', body: { ...SHEET, stage: 'incoming', enquiry: enquiry._id, verdict: 'on_hold' } });
  assert.equal((await Todo.findById(request._id).lean()).updates.length, count);
});

test('the reject report adds up QC sheets and press rejects; maintenance reminders are raised once and closed by the maintenance', async () => {
  const mould = await addMould({ maintenanceEveryShots: 100 });
  const machine = await addMachine({ serviceEveryDays: 30 });
  await api('/api/qc-records', { method: 'POST', as: 'priya', body: { ...SHEET, mould: mould._id, verdict: 'rejected', sampleSize: 50, rejected: 5, defects: [{ type: 'short_shot', count: 3 }, { type: 'flash', count: 2 }], breaking: { requiredKg: 15, samplesKg: [10, 11] } } });
  const run = (await api('/api/mould-runs', { method: 'POST', as: 'siva', body: { mould: mould._id, machine: machine._id } })).json.data;
  await api(`/api/mould-runs/${run._id}/finish`, { method: 'POST', as: 'siva', body: { counterEnd: 150, goodPieces: 570, rejectedPieces: 30, downtimeMinutes: 25 } });

  const report = await api('/api/qc-records/report', { as: 'priya' });
  assert.equal(report.status, 200, report.json.message);
  const row = report.json.data.moulds.find((entry) => entry.mould.code === mould.mouldCode);
  assert.equal(row.sampleRejectPercent, 10);
  assert.equal(row.rejectPercent, 5);
  assert.equal(row.failedSheets, 1);
  const press = report.json.data.machines.find((entry) => entry.machine.code === machine.code);
  assert.deepEqual([press.made, press.rejected, press.rejectPercent, press.downtimeMinutes], [600, 30, 5, 25]);
  assert.ok(report.json.data.defects.some((entry) => entry.type === 'short_shot' && entry.count >= 3));
  assert.ok(report.json.data.failedTests.some((entry) => entry.name === 'Breaking strength'));
  assert.equal((await api('/api/qc-records/report', { as: 'siva' })).status, 200, 'production reads it');
  assert.equal((await api('/api/qc-records/report', { as: 'nandhini' })).status, 200, 'marketing holds the quality read');
  assert.equal((await api('/api/qc-records/report', { as: 'ravi' })).status, 200);

  /* 150 shots past a 100-shot interval: the tool room is told at once, once. */
  const mouldTasks = () => Todo.find({ originKey: `mould-maintenance:${mould._id}`, completed: false }).lean();
  assert.equal((await mouldTasks()).length, 1);
  assert.equal((await mouldTasks())[0].department, 'mould');
  const { runMaintenanceReminders } = await import('../src/services/records.service.js');
  await runMaintenanceReminders();
  assert.equal((await mouldTasks()).length, 1, 'not twice');
  await api('/api/maintenance', { method: 'POST', as: 'murali', body: { asset: 'mould', mould: mould._id, type: 'polishing', workDone: 'Polished' } });
  assert.equal((await mouldTasks()).length, 0, 'closed by the maintenance');

  /* A machine whose service fell due: production is told; recording the service closes it. */
  const { default: Machine } = await import('../src/models/Machine.js');
  await Machine.updateOne({ _id: machine._id }, { $set: { nextServiceDue: new Date(Date.now() - 86400000) } });
  const raised = await runMaintenanceReminders();
  assert.ok(raised.includes(`machine ${machine.code}`));
  const machineTask = await Todo.findOne({ originKey: `machine-service:${machine._id}`, completed: false }).lean();
  assert.equal(machineTask.department, 'production');
  assert.match(machineTask.title, /overdue/);
  await api('/api/maintenance', { method: 'POST', as: 'siva', body: { asset: 'machine', machine: machine._id, type: 'preventive', workDone: 'Oil changed' } });
  assert.equal(await Todo.countDocuments({ originKey: `machine-service:${machine._id}`, completed: false }), 0);
});

test('a run on an SO line adds its good pieces to the line once; the resin it used leaves the store; low stock asks to reorder', async () => {
  const mould = await addMould();
  const machine = await addMachine();
  const enquiry = await enquiryFor('Aadhya Fashions', '9840040010');
  const order = await SalesOrder.create({
    number: 'SO-RUN-1', customer: enquiry.customer?._id || enquiry.customer, enquiry: enquiry._id, assignedTo: ids.nandhini, status: 'production_running',
    lines: [{ mould: mould._id, modelNumber: mould.mouldCode, quantity: 10000, unitPrice: 7, production: { producedQty: 1000 } }, { modelNumber: 'NH-900', quantity: 500, unitPrice: 9 }],
  });
  const material = await api('/api/materials', { method: 'POST', as: 'siva', body: { name: 'PP H110MA', ratePerKg: 110 } });
  assert.equal(material.status, 201, material.json.message);
  const resin = material.json.data;
  const received = await api(`/api/materials/${resin._id}/stock`, { method: 'POST', as: 'siva', body: { kind: 'receipt', kg: 500, reference: 'GRN-41' } });
  assert.equal(received.status, 201, received.json.message);
  assert.equal(received.json.data.material.stockKg, 500);
  assert.equal((await api(`/api/materials/${resin._id}/stock`, { method: 'POST', as: 'siva', body: { kind: 'receipt', kg: -5 } })).status, 400);
  assert.equal((await api(`/api/materials/${resin._id}/stock`, { method: 'POST', as: 'nandhini', body: { kind: 'receipt', kg: 5 } })).status, 403);

  /* Started from the enquiry: its SO, and the line on this mould. */
  const started = await api('/api/mould-runs', { method: 'POST', as: 'siva', body: { mould: mould._id, machine: machine._id, enquiry: enquiry._id, resin: { material: String(resin._id), name: 'PP' } } });
  assert.equal(started.status, 201, started.json.message);
  assert.equal(started.json.data.order.number, 'SO-RUN-1');
  assert.equal(started.json.data.orderLine, String(order.lines[0]._id));
  const finished = await api(`/api/mould-runs/${started.json.data._id}/finish`, { method: 'POST', as: 'siva', body: { counterEnd: 600, goodPieces: 2350, rejectedPieces: 50, resin: { usedKg: 80 } } });
  assert.equal(finished.status, 200, finished.json.message);
  assert.equal(finished.json.data.producedAdded, 2350);
  assert.match(finished.json.data.productionNote, /2,350 added to SO-RUN-1/);
  assert.equal(finished.json.data.resinIssued, 80);
  const line = (await SalesOrder.findById(order._id).lean()).lines[0];
  assert.equal(line.production.producedQty, 3350);
  const book = (await api(`/api/materials/${resin._id}/stock`, { as: 'siva' })).json.data;
  assert.equal(book.material.stockKg, 420);
  assert.deepEqual(book.movements.map((row) => [row.kind, row.kg, row.balanceAfter]), [['issue', -80, 420], ['receipt', 500, 500]]);
  assert.equal(book.movements[0].run.number, started.json.data.number);

  /* An SO not yet released: the pieces wait, and the run says so. */
  const held = await SalesOrder.create({ number: 'SO-RUN-2', customer: order.customer, enquiry: (await enquiryFor('Held Buyer', '9840040011'))._id, assignedTo: ids.nandhini, status: 'order_verification', lines: [{ mould: mould._id, quantity: 100, unitPrice: 7 }] });
  const early = (await api('/api/mould-runs', { method: 'POST', as: 'siva', body: { mould: mould._id, order: String(held._id) } })).json.data;
  const notYet = (await api(`/api/mould-runs/${early._id}/finish`, { method: 'POST', as: 'siva', body: { counterEnd: 700, goodPieces: 400 } })).json.data;
  assert.equal(notYet.producedAdded, undefined);
  assert.match(notYet.productionNote, /not in production/);
  assert.equal((await api('/api/mould-runs', { method: 'POST', as: 'siva', body: { mould: mould._id, order: String(held._id), orderLine: String(order.lines[0]._id) } })).status, 400);

  /* Below the reorder level: production is asked once; a receipt above it closes the ask. */
  const updated = await api(`/api/materials/${resin._id}`, { method: 'PATCH', as: 'siva', body: { reorderKg: 450, expectedUpdatedAt: book.material.updatedAt } });
  assert.equal(updated.status, 200, updated.json.message);
  const { runMaintenanceReminders } = await import('../src/services/records.service.js');
  assert.ok((await runMaintenanceReminders()).includes('stock PP H110MA'));
  assert.equal(await Todo.countDocuments({ originKey: `low-stock:${resin._id}`, completed: false }), 1);
  await api(`/api/materials/${resin._id}/stock`, { method: 'POST', as: 'siva', body: { kind: 'receipt', kg: 300 } });
  assert.equal(await Todo.countDocuments({ originKey: `low-stock:${resin._id}`, completed: false }), 0);
});

test('a buyer is asked on WhatsApp for their location; the location they share is pinned on them', async () => {
  const enquiry = await enquiryFor('Mehta Garments', '9840040012');
  const customerId = enquiry.customer?._id || enquiry.customer;
  const asked = await api(`/api/customers/${customerId}/ask-location`, { method: 'POST', as: 'ravi' });
  assert.equal(asked.status, 201, asked.json.message);
  const { default: Customer } = await import('../src/models/Customer.js');
  assert.ok((await Customer.findById(customerId).lean()).locationAskedAt);
  assert.equal((await api(`/api/customers/${customerId}/ask-location`, { method: 'POST', as: 'priya' })).status, 403);
  assert.equal((await api(`/api/customers/${customerId}/ask-location`, { method: 'POST', as: 'arun' })).status, 404, 'another marketing person’s buyer');

  const shared = await fetch(`${baseUrl}/api/whatsapp/inbound`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-webhook-token': 'records-webhook-token' },
    body: JSON.stringify({ From: 'whatsapp:+919840040012', MessageSid: 'SMLOC0001', Latitude: '11.1085', Longitude: '77.3411', Label: 'Mehta Garments, Tiruppur' }),
  });
  assert.equal(shared.status, 200, await shared.text());
  const pinned = await Customer.findById(customerId).lean();
  assert.equal(pinned.site.lat, 11.1085);
  assert.equal(pinned.site.lng, 77.3411);
  assert.equal(pinned.site.source, 'whatsapp');
  assert.equal(pinned.locationAskedAt, undefined, 'the ask is answered');

  /* Not asked again: a later location stays in the thread and does not move the pin. */
  await fetch(`${baseUrl}/api/whatsapp/inbound`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-webhook-token': 'records-webhook-token' },
    body: JSON.stringify({ From: 'whatsapp:+919840040012', MessageSid: 'SMLOC0003', Latitude: '12.9', Longitude: '80.2' }),
  });
  assert.equal((await Customer.findById(customerId).lean()).site.lat, 11.1085);

  /* Meta's webhook shape carries the location the same way. */
  const { parseMetaWebhook } = await import('../src/providers/meta.js');
  const { messages } = parseMetaWebhook({ entry: [{ changes: [{ value: { messages: [{ from: '919840040012', id: 'wamid.1', type: 'location', location: { latitude: 11.2, longitude: 77.4, name: 'Gate 2' } }] } }] }] });
  assert.deepEqual(messages[0].location, { lat: 11.2, lng: 77.4, name: 'Gate 2', address: undefined });
  assert.equal(messages[0].body, '📍 Gate 2');
});

test('a task names which SO it is for when the enquiry has several', async () => {
  const enquiry = await enquiryFor('Twin Orders Ltd', '9840040013');
  const customer = enquiry.customer?._id || enquiry.customer;
  const first = await SalesOrder.create({ number: 'SO-TWIN-1', customer, enquiry: enquiry._id, assignedTo: ids.nandhini, lines: [{ modelNumber: 'A', quantity: 10, unitPrice: 1 }] });
  await SalesOrder.create({ number: 'SO-TWIN-2', customer, enquiry: enquiry._id, assignedTo: ids.nandhini, lines: [{ modelNumber: 'B', quantity: 10, unitPrice: 1 }] });
  const other = await SalesOrder.create({ number: 'SO-TWIN-X', customer, enquiry: (await enquiryFor('Elsewhere', '9840040014'))._id, assignedTo: ids.nandhini, lines: [{ modelNumber: 'C', quantity: 10, unitPrice: 1 }] });

  const picked = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'quality_check', note: 'Check SO 1', brief: {}, order: String(first._id) } });
  assert.equal(picked.status, 201, picked.json.message);
  assert.equal(String((await Todo.findById(picked.json.data.task._id).lean()).order), String(first._id));
  const wrong = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'lr_copy', note: 'LR', brief: {}, order: String(other._id) } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.message, /not on this enquiry/);
});
