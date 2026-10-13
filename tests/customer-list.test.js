/**
 * The plant's customer list onto the register [services/customerList.service.js,
 * scripts/import-customers.js]: a customer a name, coded, under one owner; a name already there
 * (any case, spacing or punctuation) left alone; a name on the list twice added once; a second
 * run adding nothing.
 *
 *   node --test tests/customer-list.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let mongo;
let Customer;
let User;
let service;
let owner;
const list = readFileSync(new URL('../data/customers.txt', import.meta.url), 'utf8');

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: Customer } = await import('../src/models/Customer.js'));
  ({ default: User } = await import('../src/models/User.js'));
  service = await import('../src/services/customerList.service.js');
  owner = await User.create({ name: 'Navin R', email: 'owner@test.local', password: 'Secret@12345', role: 'admin', department: 'management' });
  /* A code outside the sequence the import will issue. */
  await Customer.create({ code: 'CUST-2020-9999', name: 'Ruby  fashions', assignedTo: owner._id });
});

test.after(async () => {
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the list reads a name a line, blanks left out, and names are matched by their letters alone', () => {
  const entries = service.readNames(list);
  assert.ok(entries.length > 250, `${entries.length} names`);
  assert.ok(entries.every((entry) => entry.name && !/\s{2}/.test(entry.name)));
  assert.equal(service.nameKey('K R D'), service.nameKey('KRD'));
  assert.notEqual(service.nameKey('Ruby Fashions DA'), service.nameKey('Ruby Fashions'));
  assert.equal(service.nameKey('S & S Clothing'), service.nameKey('S&S Clothing'));
  assert.notEqual(service.nameKey('ஸ்ரீ முருகன்'), service.nameKey('ஸ்ரீ வேலன்'), 'two names in Tamil are two names, not two blanks');
  assert.ok(service.nameKey('ஸ்ரீ முருகன்'));
});

test('the plan: add the new, keep the one already there, add a repeated name once; the second run adds nothing', async () => {
  const entries = service.readNames(list);
  const plan = await service.planCustomers(entries);
  const ruby = plan.find((entry) => entry.name === 'Ruby Fashions');
  assert.deepEqual([ruby.action, ruby.code, ruby.as], ['exists', 'CUST-2020-9999', 'Ruby  fashions']);
  const krd = plan.filter((entry) => service.nameKey(entry.name) === 'krd');
  assert.deepEqual(krd.map((entry) => entry.action), ['create', 'skip']);
  assert.match(krd[1].reason, /same name as line \d+ \("K R D"\)/);
  assert.equal(plan.find((entry) => entry.name === 'Ruby Fashions DA').action, 'create');

  const creates = plan.filter((entry) => entry.action === 'create').length;
  const result = await service.applyCustomers(plan, { owner: owner._id });
  assert.equal(result.created, creates);
  assert.equal(await Customer.countDocuments(), creates + 1);
  const added = await Customer.findOne({ name: 'Woodrose Apparel Company' });
  assert.match(added.code, /^CUST-\d{4}-\d{4}$/);
  assert.equal(String(added.assignedTo), String(owner._id));

  const again = await service.planCustomers(entries);
  assert.equal(again.filter((entry) => entry.action === 'create').length, 0);
  assert.equal((await service.applyCustomers(again, { owner: owner._id })).created, 0);
});
