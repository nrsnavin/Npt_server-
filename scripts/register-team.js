/**
 * Registers the plant's team from data/team.json: one account per email, in its department(s),
 * each sent the welcome email with a link to choose their own password — the same as adding a
 * person on the Users screen [controllers/user.controller.js `create`].
 *
 * Usage:
 *   npm run register-team                    # dry run: who would be added, who is already there
 *   npm run register-team -- --confirm       # add them and send the welcome emails
 *   npm run register-team -- --confirm --update
 *                                            # also set the departments of accounts already there
 *   npm run register-team -- path/to/team.json --confirm
 *
 * A person's first department is their main one; the rest are extra desks on the same login
 * (Sivakumar: Marketing and Production). When mail is not set up, the set-password links are
 * printed instead, to pass on by hand. Reads MONGO_URI from .env; safe to run again.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import User from '../src/models/User.js';
import { DEPARTMENT_KEYS, defaultAccessForAll, findDepartment } from '../src/config/modules.js';
import { sendWelcome } from '../src/services/passwordLink.service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith('--')) || path.join(here, '..', 'data', 'team.json');
const confirm = args.includes('--confirm');
const update = args.includes('--update');

const label = (keys) => keys.map((key) => findDepartment(key)?.label || key).join(' + ');

/** The team file, checked before anything is touched: a wrong department refuses the whole run. */
function readTeam() {
  const team = JSON.parse(readFileSync(file, 'utf8'));
  const seen = new Set();
  for (const person of team) {
    person.email = String(person.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(person.email)) throw new Error(`Not an email: "${person.email}"`);
    if (seen.has(person.email)) throw new Error(`${person.email} is in the file twice — give one entry all its departments`);
    seen.add(person.email);
    const unknown = (person.departments || []).filter((key) => !DEPARTMENT_KEYS.includes(key));
    if (!person.departments?.length || unknown.length) {
      throw new Error(`${person.email}: unknown department ${unknown.join(', ') || '(none given)'} — one of ${DEPARTMENT_KEYS.join(', ')}`);
    }
  }
  return team;
}

async function main() {
  const team = readTeam();
  await connectDatabase();
  console.log(`Database: ${mongoose.connection.name}`);
  console.log(`Team file: ${path.basename(file)} — ${team.length} people\n`);

  const existing = new Map((await User.find({ email: { $in: team.map((person) => person.email) } })).map((user) => [user.email, user]));
  for (const person of team) {
    const user = existing.get(person.email);
    const wanted = label(person.departments);
    if (!user) console.log(`  add      ${person.email} · ${wanted}${person.role === 'admin' ? ' (Admin)' : ''}`);
    else {
      const has = [user.department, ...(user.extraDepartments || [])].filter(Boolean);
      const same = has.length === person.departments.length && person.departments.every((key) => has.includes(key));
      console.log(`  ${same ? 'there   ' : update ? 'update  ' : 'differs '} ${person.email} · ${same ? wanted : `${label(has)} → ${wanted}`}`);
    }
  }
  if (!confirm) {
    console.log('\nDry run — nothing written. Run again with --confirm to add them (and --update to correct departments).');
    return;
  }

  const by = await User.findOne({ role: 'admin', email: { $nin: team.map((person) => person.email) } }) || await User.findOne({ role: 'admin' });
  const links = [];
  let added = 0;
  let corrected = 0;
  for (const person of team) {
    const [department, ...extraDepartments] = person.departments;
    let user = existing.get(person.email);
    if (!user) {
      user = await User.create({
        name: person.name || person.email.split('@')[0],
        email: person.email,
        phone: person.phone || undefined,
        department,
        extraDepartments,
        role: person.role === 'admin' ? 'admin' : 'member',
        /* An admin's access is implicit, so storing grants for one would only mislead. */
        moduleAccess: person.role === 'admin' ? [] : defaultAccessForAll(person.departments),
      });
      added += 1;
      const invitation = await sendWelcome(user, { by: by || undefined });
      if (invitation.delivered) console.log(`  added ${person.email} — welcome email sent`);
      else {
        console.log(`  added ${person.email} — email not sent; link below`);
        links.push([person.email, invitation.link]);
      }
    } else if (update) {
      const has = [user.department, ...(user.extraDepartments || [])].filter(Boolean);
      const same = has.length === person.departments.length && person.departments.every((key) => has.includes(key));
      if (same) continue;
      user.department = department;
      user.extraDepartments = extraDepartments;
      if (user.role !== 'admin') user.moduleAccess = defaultAccessForAll(person.departments);
      await user.save();
      corrected += 1;
      console.log(`  updated ${person.email} · ${label(person.departments)}`);
    }
  }
  console.log(`\n${added} added, ${corrected} updated.`);
  if (links.length) {
    console.log('\nSet-password links (each works once) — send each to its person:');
    for (const [email, link] of links) console.log(`  ${email}\n    ${link}`);
  }
}

main()
  .catch((error) => {
    console.error(`\nStopped: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase().catch(() => {}));
