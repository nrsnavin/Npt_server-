/**
 * Creates (or replaces) a single user account, filling everything the caller does not
 * specify with random but valid values.
 *
 * Usage:
 *   node scripts/create-user.js <email> <password> [options]
 *   npm run create-user -- rsnavin1@gmail.com navin27
 *
 * Options:
 *   --name="Full Name"     override the random name
 *   --role=admin           override the random role (admin or member)
 *   --department=sampling  override the random department
 *   --phone=9876543210     override the random phone number
 *   --replace              overwrite the account if the email already exists
 *
 * Reads MONGO_URI from .env, like the server does.
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import User, { ROLES } from '../src/models/User.js';
import { DEPARTMENT_KEYS, defaultAccessFor, findDepartment } from '../src/config/modules.js';
import { moduleAccessFor } from '../src/services/access.service.js';
import { normalisePhone } from '../src/utils/phone.js';

const FIRST_NAMES = [
  'Navin', 'Priya', 'Ramesh', 'Anita', 'Kiran', 'Sunil', 'Deepa', 'Arun',
  'Meera', 'Vikram', 'Lakshmi', 'Rahul', 'Divya', 'Suresh', 'Kavya', 'Manoj',
];
const LAST_NAMES = [
  'Kumar', 'Iyer', 'Menon', 'Sharma', 'Rao', 'Nair', 'Verma', 'Pillai',
  'Reddy', 'Shah', 'Gupta', 'Krishnan', 'Desai', 'Bose', 'Chandran',
];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const chance = (probability) => Math.random() < probability;

/** Parses `--key=value` and bare `--flag` arguments. */
function parseArgs(argv) {
  const positional = [];
  const options = {};

  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [key, ...rest] = arg.slice(2).split('=');
    options[key] = rest.length ? rest.join('=') : true;
  }

  return { positional, options };
}

/** Finds a phone number not already taken, since the field is uniquely indexed. */
async function randomFreePhone() {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = `+919${String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, '0')}`;
    if (!(await User.findOne({ phone: candidate }))) return candidate;
  }
  throw new Error('Could not find a free phone number after 25 attempts');
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const [email, password] = positional;

  if (!email || !password) {
    console.error('Usage: node scripts/create-user.js <email> <password> [--role=admin] [--replace]');
    process.exitCode = 1;
    return;
  }

  if (options.role && !ROLES.includes(options.role)) {
    throw new Error(`--role must be one of: ${ROLES.join(', ')}`);
  }
  if (options.department && !DEPARTMENT_KEYS.includes(options.department)) {
    throw new Error(`--department must be one of: ${DEPARTMENT_KEYS.join(', ')}`);
  }

  await connectDatabase();

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing && !options.replace) {
    console.error(
      `An account for ${email} already exists (role: ${existing.role}).\n` +
        'Re-run with --replace to overwrite it.'
    );
    await disconnectDatabase();
    process.exitCode = 1;
    return;
  }
  if (existing) {
    await User.deleteOne({ _id: existing._id });
    console.log(`Removed the existing account for ${email}`);
  }

  const phone = options.phone ? normalisePhone(options.phone) : await randomFreePhone();
  if (options.phone && !phone) throw new Error(`--phone is not a valid number: ${options.phone}`);

  const role = options.role || pick(ROLES);
  const department = options.department || pick(DEPARTMENT_KEYS);

  const user = new User({
    name: options.name || `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
    email,
    role,
    department,
    phone,
    emailVerified: chance(0.5),
    phoneVerified: chance(0.5),
    // Always active: a deactivated account cannot sign in, which would defeat the point.
    isActive: true,
    // Admins need no grants; members start on their department's template.
    moduleAccess: role === 'admin' ? [] : defaultAccessFor(department),
  });
  user.password = password;

  /*
   * The schema requires at least 8 characters. A shorter password is accepted here — this
   * is an operator tool, not a sign-up path — but it is called out rather than hidden,
   * because the same password cannot be set later through /auth/change-password.
   */
  const tooShort = password.length < 8;
  if (tooShort) {
    console.warn(
      `\n  Warning: "${password}" is ${password.length} characters; the schema minimum is 8.` +
        '\n  Creating it anyway with validation skipped. The account will sign in normally,' +
        '\n  but /auth/change-password will refuse to set a password this short again.\n'
    );
  }
  await user.save({ validateBeforeSave: !tooShort });

  const modules = moduleAccessFor(user);
  const readable = modules.filter((module) => module.canRead);
  const writable = modules.filter((module) => module.canWrite);

  console.log('Account created:\n');
  console.log(`  Name        ${user.name}`);
  console.log(`  Email       ${user.email}`);
  console.log(`  Password    ${password}`);
  console.log(`  Role        ${user.role}`);
  console.log(`  Department  ${findDepartment(user.department)?.label || user.department}`);
  console.log(`  Phone       ${user.phone}`);
  console.log(`  Email seen  ${user.emailVerified ? 'verified' : 'unverified'}`);
  console.log(`  Phone seen  ${user.phoneVerified ? 'verified' : 'unverified'}`);
  console.log(`\n  Module access: ${readable.length} of ${modules.length} readable, ${writable.length} writable`);
  for (const module of readable) {
    console.log(`    ${module.level.padEnd(5)}  ${module.label}`);
  }
  console.log('');

  await disconnectDatabase();
}

main().catch(async (error) => {
  console.error('\nFailed to create the account:', error.message);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
