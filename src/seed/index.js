/**
 * Seeds one account per department, each with that department's default module access,
 * plus an admin. Enough to exercise sign-in, the profile and user administration.
 *
 * Usage: npm run seed
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import User from '../models/User.js';
import OtpToken from '../models/OtpToken.js';
import { defaultAccessFor, DEPARTMENTS } from '../config/modules.js';

const PEOPLE = [
  { name: 'Navin R', email: 'admin@npthangers.com', password: 'Admin@12345', role: 'admin', department: 'management', phone: '9876500001' },
  { name: 'Meera Sampling', email: 'sampling@npthangers.com', password: 'Sample@1234', department: 'sampling', phone: '9876500002' },
  { name: 'Priya Orders', email: 'orders@npthangers.com', password: 'Orders@1234', department: 'order_confirmation', phone: '9876500003' },
  { name: 'Ramesh Plant', email: 'production@npthangers.com', password: 'Prod@123456', department: 'production', phone: '9876500004' },
  { name: 'Sunil Quality', email: 'quality@npthangers.com', password: 'Qual@123456', department: 'quality', phone: '9876500005' },
  { name: 'Anita Despatch', email: 'despatch@npthangers.com', password: 'Desp@123456', department: 'despatch', phone: '9876500006' },
  { name: 'Kiran Accounts', email: 'accounts@npthangers.com', password: 'Accts@12345', department: 'accounts', phone: '9876500007' },
  { name: 'Divya Comms', email: 'comms@npthangers.com', password: 'Comms@12345', department: 'communications', phone: '9876500008' },
];

async function seed() {
  await connectDatabase();
  console.log('Connected. Clearing existing data...');
  await Promise.all([User.deleteMany({}), OtpToken.deleteMany({})]);

  await User.create(
    PEOPLE.map((person) => ({
      ...person,
      role: person.role || 'member',
      emailVerified: true,
      // Admins need no grants; everyone else starts on their department's template.
      moduleAccess: person.role === 'admin' ? [] : defaultAccessFor(person.department),
    }))
  );

  const labels = Object.fromEntries(DEPARTMENTS.map((d) => [d.key, d.label]));

  console.log('\nSeed complete. Sign in with a password:\n');
  for (const person of PEOPLE) {
    const grants = person.role === 'admin' ? 'all modules' : `${defaultAccessFor(person.department).length} modules`;
    console.log(
      `  ${person.email.padEnd(28)} ${person.password.padEnd(13)} ${(labels[person.department] || '').padEnd(26)} ${grants}`
    );
  }
  console.log('\nOr sign in with a code sent to any of those emails or phone numbers.');
  console.log('Without SMTP/Twilio configured the code is printed to the API console.');

  await disconnectDatabase();
}

seed().catch(async (error) => {
  console.error('Seed failed:', error);
  await mongoose.connection.close();
  process.exit(1);
});
