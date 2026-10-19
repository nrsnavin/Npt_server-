/**
 * The buyer's order contact on a department task's form [handoff.service `orderContactOf`]: the
 * SO team's "Contact person" and "Mobile number" come filled from it.
 *
 *   node --test tests/order-contact.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'order-contact-test-secret';
const { orderContactOf } = await import('../src/services/handoff.service.js');

test('the primary contact, with their mobile', () => {
  const customer = { mobile: '+919800000000', contacts: [{ name: 'Ravi', mobile: '+919811111111' }, { name: 'Kumar', mobile: '+919822222222', isPrimary: true }] };
  assert.deepEqual(orderContactOf(customer), { name: 'Kumar', phone: '+919822222222', whatsapp: '+919822222222' });
});

test('the contact the enquiry names comes first', () => {
  const customer = { contacts: [{ _id: 'a1', name: 'Ravi', mobile: '+919811111111' }, { _id: 'b2', name: 'Kumar', isPrimary: true }] };
  assert.equal(orderContactOf(customer, { contact: 'a1' }).name, 'Ravi');
});

test('a contact saved with only a WhatsApp number still gives a number', () => {
  const customer = { whatsapp: '+919833333333', contacts: [{ name: 'Selvi', whatsapp: '+919833333333', isPrimary: true }] };
  assert.deepEqual(orderContactOf(customer), { name: 'Selvi', phone: '+919833333333', whatsapp: '+919833333333' });
  assert.equal(orderContactOf({ whatsapp: '+919844444444', contacts: [] }).phone, '+919844444444', 'no contact: the company’s WhatsApp');
});

test('no contact on the customer: the person taken down when it was a prospect', () => {
  const enquiry = { prospect: { name: 'TEST', contactPerson: 'Anand', mobile: '+919855555555' } };
  assert.deepEqual(orderContactOf({ contacts: [] }, enquiry), { name: 'Anand', phone: '+919855555555', whatsapp: '+919855555555' });
  assert.deepEqual(orderContactOf(null, enquiry), { name: 'Anand', phone: '+919855555555', whatsapp: '+919855555555' });
});
