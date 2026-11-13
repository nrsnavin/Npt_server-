/**
 * Customers from Excel [services/customerImport.service.js]: the template with its sample row,
 * a preview that writes nothing, the import, and a customer already on the books skipped.
 *
 *   node --test tests/customer-import.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'customer-import-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
const ids = {};
let Customer;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
  });
  const type = response.headers.get('content-type') || '';
  return { status: response.status, type, buffer: type.includes('json') ? null : Buffer.from(await response.arrayBuffer()), json: type.includes('json') ? await response.json() : {} };
};

const csv = (rows) => rows.map((row) => row.map((cell) => (/[,"\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(',')).join('\r\n');
const upload = (as, content, { commit = false, defaultOwner, name = 'customers.csv', type = 'text/csv' } = {}) => {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), name);
  if (defaultOwner) form.append('defaultOwner', defaultOwner);
  if (commit) form.append('commit', 'true');
  return api('/api/customers/import', { method: 'POST', as, body: form });
};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Customer } = await import('../src/models/Customer.js'));
  await (await import('../src/services/defaultRoutes.service.js')).ensureDefaultRoutes();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['kavi', 'Kavi M', 'marketing'], ['ravi', 'Ravi Despatch', 'despatch']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    assert.equal(made.status, 201, made.json.message);
    ids[key] = made.json.data.id;
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the template is an Excel file with every column and one sample row that imports as it is', async () => {
  const template = await api('/api/customers/import/template', { as: 'nandhini' });
  assert.equal(template.status, 200);
  assert.match(template.type, /spreadsheetml/);
  const { sheetRows } = await import('../src/services/sheetRows.js');
  const rows = sheetRows(template.buffer);
  assert.deepEqual(rows[0].slice(0, 7), ['Customer name *', 'Customer type', 'Contact person', 'Designation', 'Mobile *', 'WhatsApp', 'Email']);
  for (const heading of ['Purchase contact', 'Purchase mobile', 'Purchase email', 'Accounts contact', 'Accounts mobile', 'Accounts email', 'GST number', 'Address', 'Pincode', 'Marketing owner']) assert.ok(rows[0].includes(heading), heading);
  assert.equal(rows[1][0], 'Sri Lakshmi Garments');

  /* The sample row, uploaded as downloaded, with an owner picked on the screen. */
  const preview = await upload('nandhini', template.buffer, { name: 'customer-import-template.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', defaultOwner: ids.nandhini });
  assert.equal(preview.status, 200, preview.json.message);
  assert.deepEqual(preview.json.data.summary, { create: 1, exists: 0, error: 0 });
  assert.equal(await Customer.countDocuments({}), 0, 'a preview writes nothing');
  const done = await upload('nandhini', template.buffer, { name: 'customer-import-template.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', defaultOwner: ids.nandhini, commit: true });
  assert.equal(done.status, 200, done.json.message);
  assert.equal(done.json.data.created, 1);
  const made = await Customer.findOne({ name: 'Sri Lakshmi Garments' }).lean();
  assert.match(made.code, /^CUST-/);
  assert.equal(made.gstin, '33ABCDE1234F1Z5');
  assert.equal(made.email, 'info@srilakshmigarments.in');
  const purchase = made.contacts.find((contact) => contact.designation === 'Purchase');
  assert.deepEqual([purchase.name, purchase.mobile, purchase.email, purchase.isPrimary], ['M. Priya', '+919894012345', 'purchase@srilakshmigarments.in', false]);
  assert.deepEqual([made.accountsContact.name, made.accountsContact.phone, made.accountsContact.email, made.accountsContact.sameAsOrder], ['K. Ramesh', '+919894054321', 'accounts@srilakshmigarments.in', false]);
  assert.equal(made.city, 'Tiruppur');
  assert.equal(made.pincode, '641603');
  assert.equal(made.customerType, 'garment_factory');
  assert.equal(made.deliveryMode, 'own_vehicle');
  const { default: DeliveryRoute } = await import('../src/models/DeliveryRoute.js');
  assert.equal(String(made.deliveryRoute), String((await DeliveryRoute.findOne({ name: 'Avinashi Road' }))._id), 'the delivery route by name');
  assert.equal(made.landmark, 'Opp. Bus Stand', 'the landmark is plain text');
  assert.equal(made.creditTermsDays, 30);
  assert.equal(String(made.assignedTo), ids.nandhini);
  assert.equal(made.contacts[0].name, 'R. Senthil Kumar');
  assert.equal(made.contacts[0].isPrimary, true);
});

test('each row is checked: owner by email, GST shape, email, pincode, the drop-down words; a customer already there is skipped', async () => {
  const sheet = csv([
    ['Title line the business keeps above its table'],
    ['Customer name', 'Mobile', 'Email', 'GST number', 'Pincode', 'Customer type', 'Marketing owner', 'City'],
    ['Aruna Knits', '98400 11001', 'accounts@arunaknits.com', '33AAACA1234B1Z9', '641604', 'Exporter', 'kavi@np.com', 'Tiruppur'],
    ['Bad GST Co', '9840011002', '', 'GST12345', '641604', '', '', ''],
    ['Bad Mail Co', '9840011003', 'not-an-email', '', '64160', 'Factory', '', ''],
    ['No Phone Co', '', '', '', '', '', '', ''],
    ['Twin of Aruna', '9840011001', '', '', '', '', '', ''],
    ['Sri Lakshmi again', '9876543210', '', '', '', '', '', ''],
    ['Unknown owner Co', '9840011009', '', '', '', '', 'nobody@np.com', ''],
    ['Despatch-owned Co', '9840011010', '', '', '', '', 'ravi@np.com', ''],
    ['Kumaran Prints', '9840011020', '', '', '', '', '', 'Erode'],
    [],
  ]);
  const noOwner = await upload('admin', sheet);
  assert.equal(noOwner.status, 200, noOwner.json.message);
  const byRow = Object.fromEntries(noOwner.json.data.plan.map((entry) => [entry.row, entry]));
  assert.equal(byRow[3].action, 'create', 'owner named by email');
  assert.equal(byRow[3].owner.name, 'Kavi M');
  assert.match(byRow[3].fields.state, /Tamil Nadu/, 'state read from the GST number');
  assert.match(byRow[4].problems.join(' '), /GST number "GST12345"/);
  assert.match(byRow[4].problems.join(' '), /No marketing owner/, 'no owner, none picked');
  assert.match(byRow[5].problems.join(' '), /Email "not-an-email"/);
  assert.match(byRow[5].problems.join(' '), /Pincode "64160"/);
  assert.match(byRow[5].problems.join(' '), /Customer type "Factory"/);
  assert.match(byRow[6].problems.join(' '), /No mobile number/);
  assert.equal(byRow[8].action, 'exists', 'already a customer — by phone');
  assert.equal(byRow[8].existing.name, 'Sri Lakshmi Garments');
  assert.match(byRow[9].problems.join(' '), /"nobody@np.com" is not a marketing person/);
  assert.match(byRow[10].problems.join(' '), /"ravi@np.com" is not a marketing person/, 'only marketing or Admin own a buyer');

  const withOwner = await upload('admin', sheet, { defaultOwner: ids.nandhini });
  const again = Object.fromEntries(withOwner.json.data.plan.map((entry) => [entry.row, entry]));
  assert.equal(again[11].action, 'create', 'the owner picked fills the rows naming none');
  assert.equal(again[11].owner.name, 'Nandhini S');
  assert.match(again[7].problems.join(' '), /Same GST number or phone as row 3/, 'two rows, one buyer: the second is refused');
  assert.equal(again[3].action, 'create');

  const done = await upload('admin', sheet, { defaultOwner: ids.nandhini, commit: true });
  assert.equal(done.json.data.created, done.json.data.summary.create);
  assert.ok(await Customer.exists({ name: 'Aruna Knits', assignedTo: ids.kavi }));
  const second = await upload('admin', sheet, { defaultOwner: ids.nandhini });
  assert.equal(second.json.data.summary.create, 0, 'uploaded again: nothing new');
  assert.ok(second.json.data.summary.exists >= 2);
});

test('who may: a customers writer imports; the template needs the customers screen; the owner picked must be marketing', async () => {
  assert.equal((await upload('ravi', csv([['Customer name', 'Mobile'], ['X Co', '9840011111']]))).status, 403);
  const bad = await upload('admin', csv([['Customer name', 'Mobile'], ['X Co', '9840011111']]), { defaultOwner: ids.ravi });
  assert.equal(bad.status, 400);
  assert.match(bad.json.message, /not an active marketing person/);
  const noHeader = await upload('admin', csv([['Foo', 'Bar'], ['1', '2']]));
  assert.equal(noHeader.status, 400);
  assert.match(noHeader.json.message, /Customer name column/);
});

test('purchase and accounts contacts: checked like the rest; a purchase contact alone is the primary one', async () => {
  const sheet = csv([
    ['Customer name', 'Mobile', 'Purchase contact', 'Purchase mobile', 'Purchase email', 'Accounts contact', 'Accounts mobile', 'Accounts email'],
    ['Velan Fashions', '9840022001', 'S. Anand', '9840022002', 'anand@velan.in', 'P. Lakshmi', '9840022003', 'accounts@velan.in'],
    ['Broken Contacts Co', '9840022011', 'X', '123', 'no-mail', '', '', 'bad@'],
  ]);
  const preview = await upload('admin', sheet, { defaultOwner: ids.nandhini });
  const byRow = Object.fromEntries(preview.json.data.plan.map((entry) => [entry.row, entry]));
  assert.equal(byRow[2].action, 'create');
  assert.match(byRow[3].problems.join(' '), /Purchase mobile "123"/);
  assert.match(byRow[3].problems.join(' '), /Purchase email "no-mail"/);
  assert.match(byRow[3].problems.join(' '), /Accounts email "bad@"/);
  await upload('admin', sheet, { defaultOwner: ids.nandhini, commit: true });
  const made = await Customer.findOne({ name: 'Velan Fashions' }).lean();
  assert.equal(made.contacts.length, 1);
  assert.deepEqual([made.contacts[0].name, made.contacts[0].designation, made.contacts[0].isPrimary], ['S. Anand', 'Purchase', true]);
  assert.equal(made.accountsContact.email, 'accounts@velan.in');
});

test('delivery routes: the eight roads are added once, readable from the customer screens; an unknown route is refused; an old landmark road becomes the route', async () => {
  const { ensureDefaultRoutes } = await import('../src/services/defaultRoutes.service.js');
  const { default: DeliveryRoute } = await import('../src/models/DeliveryRoute.js');
  const legacy = await Customer.create({ code: 'CUST-OLD-1', name: 'Old Landmark Co', landmark: 'palladam road', assignedTo: ids.nandhini });
  const again = await ensureDefaultRoutes();
  assert.equal(again.added, 0, 'already there — nothing added twice');
  assert.equal(await DeliveryRoute.countDocuments({}), 8);
  assert.equal(String((await Customer.findById(legacy._id)).deliveryRoute), String((await DeliveryRoute.findOne({ name: 'Palladam Road' }))._id));
  const list = await api('/api/customers/delivery-routes', { as: 'nandhini' });
  assert.equal(list.status, 200, list.json.message);
  assert.deepEqual(list.json.data.map((row) => row.name).slice(0, 2), ['Avinashi Road', 'College Road']);
  const bad = await upload('admin', csv([['Customer name', 'Mobile', 'Delivery route'], ['Route Co', '9840033001', 'Moon Road']]), { defaultOwner: ids.nandhini });
  assert.match(bad.json.data.plan[0].problems.join(' '), /Delivery route "Moon Road" is not one of the routes/);
});
