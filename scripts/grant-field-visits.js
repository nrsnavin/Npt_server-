/**
 * Gives everyone the field-visit marks their department gets [services/fieldGrants.service.js]:
 *
 *   Admin                      everything, by role.
 *   Management                 goes out, plans their own, assigns visits to everyone who goes out.
 *   Marketing                  goes out, plans their own, assigns to Sampling, Payment Collection, PRT.
 *   Sampling / Payment Collection / PRT   goes out, plans their own.
 *   Everyone else              nothing — the office punch alone.
 *
 * Marks are only ever raised, never taken away; `assignTo` is widened, never trimmed; the Field
 * visits module is granted at write to anyone marked. Idempotent: a second run finds nobody left.
 * Dry run by default.
 *
 *   node scripts/grant-field-visits.js             # show me
 *   node scripts/grant-field-visits.js --confirm   # do it
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { planFieldGrants } from '../src/services/fieldGrants.service.js';

const confirm = process.argv.includes('--confirm');
const yes = (value) => (value ? 'yes' : 'no');

async function grant() {
  await connectDatabase();
  const users = mongoose.connection.collection('users');
  const everybody = await users.find({}).toArray();
  const names = new Map(everybody.map((user) => [String(user._id), user.name]));
  const plan = planFieldGrants(everybody);
  console.log(`Field visits — ${everybody.length} user(s), ${plan.length} to mark\n`);

  for (const row of plan) {
    const { user, before, after, moduleAccess } = row;
    const line = (marks) => `goes out ${yes(marks.allowed)} · own ${yes(marks.maySelfPlan)} · assigns ${yes(marks.mayAssign)}${marks.assignTo.length ? ` to ${marks.assignTo.map((id) => names.get(id) || id).join(', ')}` : ''}`;
    console.log(`  ${user.email || user.name}  (${[user.department, ...(user.extraDepartments || [])].filter(Boolean).join(' + ')})`);
    console.log(`      was  ${line(before)}`);
    console.log(`      now  ${line(after)}${moduleAccess ? ' · + Field visits module (write)' : ''}`);
    if (confirm) {
      await users.updateOne({ _id: user._id }, { $set: { fieldVisit: { ...after, assignTo: after.assignTo.map((id) => new mongoose.Types.ObjectId(id)) }, ...(moduleAccess ? { moduleAccess } : {}) } });
    }
  }

  console.log('');
  if (!plan.length) console.log('Nothing to do — everyone already has their marks.');
  else if (confirm) console.log(`Marked ${plan.length} user(s). Admin can adjust any of them on the Users page.`);
  else console.log(`Dry run — nothing was changed. Re-run with --confirm to mark ${plan.length}.`);
  await disconnectDatabase();
}

grant().catch(async (error) => {
  console.error(error);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
