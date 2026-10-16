/**
 * An enquiry before there is a customer: taken down on a prospect's name and number, worked like
 * any other, and converted into a customer — a new one from the form, or one already on the
 * register — when there is a buyer to quote, sample or book for. Every enquiry of the same
 * conversation moves with it. The customer form's delivery and accounts contacts are kept too.
 *
 *   node --test tests/prospect-enquiry.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'prospect-enquiry-test-secret';

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

const followUp = () => ({ nextAction: 'Call back', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() });

const prospectEnquiry = async (as, prospect, extra = {}) => {
  const made = await api('/api/enquiries', { method: 'POST', as, body: { prospect, requirement: { modelNumber: 'NH-400' }, ...followUp(), ...extra } });
  assert.equal(made.status, 201, made.json.message);
  return made.json.data;
};

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
  for (const [key, name] of [['nandhini', 'Nandhini S'], ['arun', 'Arun K']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department: 'marketing' } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
    ids[key] = (await api('/api/auth/me', { as: key })).json.data.id;
  }
  const buyer = await api('/api/customers', { method: 'POST', as: 'arun', body: { name: 'SCM Garments', mobile: '9840060002', assignedTo: ids.arun } });
  assert.equal(buyer.status, 201, buyer.json.message);
  ids.scm = buyer.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('an enquiry is taken down on a prospect — a name and a way to reach them — and is the taker\'s', async () => {
  const enquiry = await prospectEnquiry('nandhini', { name: 'Galaxy Apparels', contactPerson: 'Ravi', mobile: '98400 70001', city: 'Tiruppur' });
  assert.equal(enquiry.customer ?? null, null);
  assert.equal(enquiry.prospect.name, 'Galaxy Apparels');
  assert.equal(enquiry.prospect.mobile, '+919840070001', 'stored the way a customer\'s number is, so conversion can match it');
  assert.equal(String(enquiry.assignedTo), ids.nandhini);

  const listed = await api('/api/enquiries?search=Galaxy', { as: 'nandhini' });
  assert.ok(listed.json.data.some((row) => row._id === enquiry._id), 'found by the prospect\'s name');
  const others = await api(`/api/enquiries/${enquiry._id}`, { as: 'arun' });
  assert.equal(others.status, 404, 'another marketing person does not see it');

  const nameless = await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { requirement: { modelNumber: 'NH-400' }, ...followUp() } });
  assert.equal(nameless.status, 400);
  const unreachable = await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { prospect: { name: 'Nobody' }, requirement: { modelNumber: 'NH-400' }, ...followUp() } });
  assert.equal(unreachable.status, 400);
  assert.match(JSON.stringify(unreachable.json.details), /phone number or an email/);
});

test('a prospect whose number is already a customer\'s is sent to that customer', async () => {
  const { status, json } = await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { prospect: { name: 'SCM', mobile: '9840060002' }, requirement: { modelNumber: 'NH-400' }, ...followUp() } });
  assert.equal(status, 409);
  assert.match(json.message, /SCM Garments .* is already a customer/);
  assert.equal(json.details?.existing, undefined, 'not named as a link to somebody else\'s buyer');
});

test('no quotation, sample or won stage until the prospect is a customer', async () => {
  const enquiry = await prospectEnquiry('nandhini', { name: 'Opera Clothing', mobile: '9840070003' });
  const quote = await api('/api/quotations', { method: 'POST', as: 'nandhini', body: { enquiry: enquiry._id, lines: [{ modelNumber: 'NH-400', unitPrice: 7.5 }] } });
  assert.equal(quote.status, 400);
  assert.match(quote.json.message, /prospect's enquiry — convert it to a customer first/);
  const sample = await api(`/api/enquiries/${enquiry._id}/status`, { method: 'POST', as: 'nandhini', body: { status: 'sample_required' } });
  assert.equal(sample.status, 400);
  assert.match(sample.json.message, /convert it to a customer first/);
});

test('converting makes the customer from the form, with its contacts, and moves the whole conversation', async () => {
  const group = await api('/api/enquiries/group', {
    method: 'POST',
    as: 'nandhini',
    body: {
      prospect: { name: 'DSP International', contactPerson: 'Deepa', mobile: '9840070004' },
      shared: followUp(),
      enquiries: [{ requirement: { modelNumber: 'NH-400' } }, { requirement: { modelNumber: 'NH-380' } }],
    },
  });
  assert.equal(group.status, 201, group.json.message);
  const [first, second] = group.json.data.enquiries || group.json.data;

  const converted = await api(`/api/enquiries/${first._id}/customer`, {
    method: 'POST',
    as: 'nandhini',
    body: {
      name: 'DSP International',
      mobile: '9840070004',
      landmark: 'Kangeyam Road',
      contacts: [{ name: 'Deepa', mobile: '9840070004', isPrimary: true }],
      deliveryContact: { sameAsOrder: false, name: 'Murugan', phone: '9840070005' },
      accountsContact: { sameAsOrder: true },
    },
  });
  assert.equal(converted.status, 201, converted.json.message);
  const customer = converted.json.data.customer;
  assert.equal(String(customer.assignedTo), ids.nandhini, 'the enquiry owner\'s buyer');
  assert.equal(customer.landmark, 'Kangeyam Road');
  assert.equal(converted.json.data.enquiries.length, 2);

  for (const row of [first, second]) {
    const { json } = await api(`/api/enquiries/${row._id}`, { as: 'nandhini' });
    assert.equal(json.data.customer._id, customer._id, `${row.number} moved with it`);
    assert.ok(json.data.prospect.convertedAt);
    assert.equal(json.data.customer.deliveryContact.name, 'Murugan');
    assert.equal(json.data.customer.deliveryContact.phone, '+919840070005');
    assert.equal(json.data.customer.accountsContact.sameAsOrder, true);
  }

  const again = await api(`/api/enquiries/${first._id}/customer`, { method: 'POST', as: 'nandhini', body: { customer: customer._id } });
  assert.equal(again.status, 409, 'converted once');

  const quote = await api('/api/quotations', { method: 'POST', as: 'nandhini', body: { enquiry: first._id, lines: [{ modelNumber: 'NH-400', unitPrice: 7.5 }] } });
  assert.equal(quote.status, 201, quote.json.message);
});

test('converting onto a customer already on the register links it; a duplicate number offers that customer', async () => {
  const own = await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Raymond Exports', mobile: '9840070010', assignedTo: ids.nandhini } });
  assert.equal(own.status, 201, own.json.message);
  const enquiry = await prospectEnquiry('nandhini', { name: 'Raymond', email: 'buy@raymond.example' });

  const duplicate = await api(`/api/enquiries/${enquiry._id}/customer`, { method: 'POST', as: 'nandhini', body: { name: 'Raymond', mobile: '9840070010' } });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.details?.existing?._id, own.json.data._id, 'offered as the one to link');

  const somebodyElses = await api(`/api/enquiries/${enquiry._id}/customer`, { method: 'POST', as: 'nandhini', body: { customer: ids.scm } });
  assert.equal(somebodyElses.status, 403);

  const linked = await api(`/api/enquiries/${enquiry._id}/customer`, { method: 'POST', as: 'nandhini', body: { customer: own.json.data._id } });
  assert.equal(linked.status, 201, linked.json.message);
  const { json } = await api(`/api/enquiries/${enquiry._id}`, { as: 'nandhini' });
  assert.equal(json.data.customer.name, 'Raymond Exports');
});

test('the customer form keeps delivery and accounts contacts', async () => {
  const made = await api('/api/customers', {
    method: 'POST',
    as: 'arun',
    body: {
      name: 'Kumar Knits', mobile: '9840070020', assignedTo: ids.arun, landmark: 'Palladam Road',
      deliveryContact: { sameAsOrder: true },
      accountsContact: { name: 'Lakshmi', phone: '9840070021' },
    },
  });
  assert.equal(made.status, 201, made.json.message);
  assert.equal(made.json.data.deliveryContact.sameAsOrder, true);
  assert.equal(made.json.data.accountsContact.phone, '+919840070021');

  const edited = await api(`/api/customers/${made.json.data._id}`, { method: 'PATCH', as: 'arun', body: { accountsContact: { sameAsOrder: true } } });
  assert.equal(edited.status, 200, edited.json.message);
  assert.equal(edited.json.data.accountsContact.sameAsOrder, true);
});

test('a prospect reached on one number is on WhatsApp on the same number unless another is given', async () => {
  const onlyMobile = await prospectEnquiry('nandhini', { name: 'One Number Knits', mobile: '9840070031' });
  assert.equal(onlyMobile.prospect.whatsapp, '+919840070031', 'the draft can be messaged from');
  const both = await prospectEnquiry('nandhini', { name: 'Two Numbers Knits', mobile: '9840070032', whatsapp: '9840070033' });
  assert.equal(both.prospect.whatsapp, '+919840070033', 'a WhatsApp number of its own stands');
});
