/**
 * Several people creating at the same moment, on a replica set, so every transaction and lock is
 * real: quotation numbers (NP/26-27/001, no gaps), sales-order numbers (no gaps), sample numbers
 * (unique), and the "one open" rules — one open sample per enquiry, one open quotation per
 * enquiry when the automation raises it — when two requests arrive in the same instant.
 *
 *   node --test tests/numbering-races.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { raiseEnquiryFor, withEnquiries } from './support/onEnquiry.js';

process.env.JWT_SECRET = 'numbering-races-test-secret';
process.env.RATE_LIMIT_MAX = '100000';

let rs;
let server;
let baseUrl;
let admin;
const people = [];
const buyers = [];

const rawApi = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const api = withEnquiries(rawApi);
const signIn = async (email, password) => (await rawApi('/api/auth/login', { method: 'POST', body: { email, password } })).json.data?.token;
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const tail = (number) => Number(String(number).match(/(\d+)$/)[1]);
const consecutive = (numbers) => {
  const seq = numbers.map(tail).sort((a, b) => a - b);
  return seq.every((value, index) => value === seq[0] + index);
};
const why = (results) => results.map((r) => `${r.status} ${r.json.message || ''}`).join(' | ');

const quote = (token, customer, price = 9.5) => api('/api/quotations', {
  method: 'POST', token,
  body: { customer, paymentTerms: '30 days', validUntil: inDays(30), lines: [{ quantity: 10000, unitPrice: price, modelNumber: 'NH-400' }] },
});

test.before(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGO_URI = rs.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await rawApi('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  admin = await signIn('admin@np.com', 'Admin@12345');
  for (const [index, name] of ['Nandhini S', 'Priya K', 'Arun M', 'Kavya R'].entries()) {
    const email = `m${index}@np.com`;
    const made = await rawApi('/api/users', { method: 'POST', token: admin, body: { name, email, password: 'Pass@123456', department: 'marketing' } });
    assert.equal(made.status, 201, made.json.message);
    const token = await signIn(email, 'Pass@123456');
    const me = (await rawApi('/api/auth/me', { token })).json.data.id;
    const buyer = await rawApi('/api/customers', { method: 'POST', token, body: { assignedTo: me, name: `Race Buyer ${index}`, mobile: `98400999${String(index).padStart(2, '0')}` } });
    assert.equal(buyer.status, 201, buyer.json.message);
    people.push(token);
    buyers.push(buyer.json.data._id);
  }
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await rs?.stop();
});

test('four people raising five quotations each, all at once: twenty quotations, numbered without a gap', async () => {
  const results = await Promise.all(people.flatMap((token, who) => Array.from({ length: 5 }, (_, i) => quote(token, buyers[who], 9 + i / 10))));
  assert.ok(results.every((result) => result.status === 201), why(results));
  const numbers = results.map((result) => result.json.data.number);
  assert.equal(new Set(numbers).size, 20, 'no number given twice');
  assert.ok(numbers.every((number) => /^NP\/\d{2}-\d{2}\/\d{3}$/.test(number)), numbers.join(', '));
  assert.ok(consecutive(numbers), `consecutive: ${numbers.join(', ')}`);
});

test('six sales orders booked at once from six quotations: six orders, numbered without a gap', async () => {
  const quotes = [];
  for (let i = 0; i < 6; i += 1) {
    const made = await quote(people[i % 4], buyers[i % 4], 8 + i / 10);
    assert.equal(made.status, 201, made.json.message);
    const id = made.json.data._id;
    await rawApi(`/api/quotations/${id}/send`, { method: 'POST', token: admin, body: {} });
    const accepted = await rawApi(`/api/quotations/${id}/response`, { method: 'POST', token: admin, body: { accepted: true } });
    assert.equal(accepted.status, 200, accepted.json.message);
    quotes.push(made.json.data);
  }
  const results = await Promise.all(quotes.map((row, i) => rawApi(`/api/quotations/${row._id}/order`, {
    method: 'POST', token: admin, body: { customerPo: { number: `PO-RACE-${i}` }, lines: [{ quotationLine: row.lines[0]._id, quantity: 10000 }] },
  })));
  assert.ok(results.every((result) => result.status === 201), why(results));
  const numbers = results.map((result) => result.json.data.number);
  assert.equal(new Set(numbers).size, 6);
  assert.ok(consecutive(numbers), `consecutive: ${numbers.join(', ')}`);
});

test('sample requests from four people at once on four enquiries: four samples, four different numbers', async () => {
  const results = await Promise.all(people.map((token, who) => api('/api/samples', { method: 'POST', token, body: { customer: buyers[who], modelNumber: 'NH-400', quantity: 2 } })));
  assert.ok(results.every((result) => result.status === 201), why(results));
  assert.equal(new Set(results.map((result) => result.json.data.number)).size, 4);
});

test('six sample requests on one enquiry in the same instant: one sample; the rest are told it is open', async () => {
  const { default: Sample } = await import('../src/models/Sample.js');
  const { default: User } = await import('../src/models/User.js');
  const owner = (await User.findOne({ email: 'm0@np.com' }))._id;
  const enquiry = await raiseEnquiryFor({ customer: buyers[0], owner });
  const results = await Promise.all(Array.from({ length: 6 }, () => rawApi('/api/samples', {
    method: 'POST', token: people[0], body: { enquiry: String(enquiry._id), customer: buyers[0], modelNumber: 'NH-400', quantity: 2 },
  })));
  assert.equal(await Sample.countDocuments({ enquiry: enquiry._id }), 1, `one sample, not several: ${why(results)}`);
  assert.equal(results.filter((result) => result.status === 201).length, 1);
  assert.ok(results.every((result) => [201, 409].includes(result.status)), why(results));
});

test('the automation raising the enquiry’s quotation twice in the same instant leaves one open quotation', async () => {
  const { default: Quotation } = await import('../src/models/Quotation.js');
  const { default: User } = await import('../src/models/User.js');
  const { inTransaction } = await import('../src/utils/transaction.js');
  const { ensureCostingFor } = await import('../src/services/costingRequest.service.js');
  const owner = (await User.findOne({ email: 'm1@np.com' }))._id;
  const enquiry = await raiseEnquiryFor({ customer: buyers[1], owner });
  await mongoose.connection.collection('enquiries').updateOne({ _id: enquiry._id }, { $set: { requirement: { modelNumber: 'NH-500' } } });
  const fresh = await mongoose.model('Enquiry').findById(enquiry._id);
  const runs = await Promise.allSettled(Array.from({ length: 6 }, () => inTransaction(async () => {
    const { default: Enquiry } = await import('../src/models/Enquiry.js');
    const mine = await Enquiry.findById(fresh._id);
    return ensureCostingFor(mine);
  })));
  assert.ok(runs.every((run) => run.status === 'fulfilled'), runs.map((run) => run.reason?.message || 'ok').join(' | '));
  assert.equal(await Quotation.countDocuments({ enquiry: enquiry._id }), 1, 'one quotation for the enquiry, not one per request');
  assert.equal(runs.filter((run) => run.value.created).length, 1);
});
