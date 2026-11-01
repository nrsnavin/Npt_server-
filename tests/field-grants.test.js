/**
 * The field-visit marks by department [services/fieldGrants.service.js; scripts/grant-field-visits.js]:
 * who goes out, who plans their own, who assigns and to whom — raised, never lowered.
 *
 *   node --test tests/field-grants.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { marksForDepartments, planFieldGrants } from '../src/services/fieldGrants.service.js';

const user = (id, department, extra = {}) => ({ _id: id, name: id, department, isActive: true, role: 'member', moduleAccess: [], ...extra });

test('each department’s marks: Admin by role, management and marketing assign, the field teams go out and plan their own, the office nothing', () => {
  assert.equal(marksForDepartments(user('a', 'accounts', { role: 'admin' })), null, 'Admin holds every mark by role');
  assert.deepEqual(marksForDepartments(user('m', 'management')), { allowed: true, maySelfPlan: true, mayAssign: true, assignDepartments: ['marketing', 'sampling', 'payment_collection', 'payment_recovery', 'management'] });
  assert.deepEqual(marksForDepartments(user('n', 'marketing')), { allowed: true, maySelfPlan: true, mayAssign: true, assignDepartments: ['sampling', 'payment_collection', 'payment_recovery'] });
  assert.deepEqual(marksForDepartments(user('s', 'sampling')), { allowed: true, maySelfPlan: true, mayAssign: false, assignDepartments: [] });
  assert.deepEqual(marksForDepartments(user('p', 'payment_recovery')), { allowed: true, maySelfPlan: true, mayAssign: false, assignDepartments: [] });
  assert.deepEqual(marksForDepartments(user('c', 'payment_collection')).allowed, true);
  assert.equal(marksForDepartments(user('k', 'accounts')), null, 'the office punches in, nothing more');
  assert.equal(marksForDepartments(user('r', 'production', { extraDepartments: ['sampling'] })).allowed, true, 'an extra department counts');
});

test('the plan: marks raised and assignTo widened to the people who go out, the module granted; nothing lowered, nothing for the inactive, idempotent', () => {
  const people = [
    user('admin', 'management', { role: 'admin' }),
    user('nandhini', 'marketing'),
    user('mani', 'sampling'),
    user('ravi', 'payment_recovery', { fieldVisit: { allowed: true, maySelfPlan: false, mayAssign: false, assignTo: [] }, moduleAccess: [{ module: 'field_visits', level: 'write' }] }),
    user('kumar', 'accounts'),
    user('gone', 'sampling', { isActive: false }),
    user('boss', 'management', { fieldVisit: { allowed: true, maySelfPlan: true, mayAssign: true, assignTo: ['kumar'] } }),
  ];
  const plan = planFieldGrants(people);
  const byName = Object.fromEntries(plan.map((row) => [row.user._id, row]));
  assert.deepEqual(Object.keys(byName).sort(), ['boss', 'mani', 'nandhini', 'ravi'], 'Admin, the office and the inactive are left out');
  assert.deepEqual(byName.nandhini.after, { allowed: true, maySelfPlan: true, mayAssign: true, assignTo: ['mani', 'ravi'] }, 'marketing assigns to the field teams who go out — not to the one who left');
  assert.deepEqual(byName.nandhini.moduleAccess, [{ module: 'field_visits', level: 'write' }]);
  assert.deepEqual([byName.mani.after.allowed, byName.mani.after.mayAssign, byName.mani.after.assignTo], [true, false, []]);
  assert.deepEqual([byName.ravi.after.maySelfPlan, byName.ravi.moduleAccess], [true, null], 'Ravi’s own-planning mark raised; the module he already holds is left alone');
  assert.deepEqual(byName.boss.after.assignTo, ['kumar', 'nandhini', 'mani', 'ravi'], 'a list Admin set is widened, never trimmed — Kumar stays');
  /* Applied, a second run finds nothing. */
  const applied = people.map((person) => { const row = byName[person._id]; return row ? { ...person, fieldVisit: row.after, moduleAccess: row.moduleAccess || person.moduleAccess } : person; });
  assert.deepEqual(planFieldGrants(applied), [], 'idempotent');
});
