/**
 * Seeds one account per role so the login and profile screens can be exercised.
 *
 * Usage: npm run seed
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import User from '../models/User.js';
import OtpToken from '../models/OtpToken.js';

const USERS = [
  { name: 'Navin R', email: 'admin@npthangers.com', password: 'Admin@12345', role: 'admin', department: 'management', phone: '9876500001' },
  { name: 'Priya Sales', email: 'sales@npthangers.com', password: 'Sales@12345', role: 'sales', department: 'sales', phone: '9876500002' },
  { name: 'Ramesh Plant', email: 'production@npthangers.com', password: 'Prod@123456', role: 'production', department: 'production', phone: '9876500003' },
  { name: 'Anita Stores', email: 'stores@npthangers.com', password: 'Store@12345', role: 'inventory', department: 'stores', phone: '9876500004' },
  { name: 'Kiran Accounts', email: 'accounts@npthangers.com', password: 'Accts@12345', role: 'accounts', department: 'accounts', phone: '9876500005' },
  { name: 'Sunil Quality', email: 'quality@npthangers.com', password: 'Qual@123456', role: 'viewer', department: 'quality', phone: '9876500006' },
];

async function seed() {
  await connectDatabase();
  console.log('Connected. Clearing existing data...');
  await Promise.all([User.deleteMany({}), OtpToken.deleteMany({})]);

  await User.create(USERS.map((user) => ({ ...user, emailVerified: true })));

  console.log('\nSeed complete. Sign in with a password:');
  for (const user of USERS) {
    console.log(`  ${user.email.padEnd(26)} ${user.password.padEnd(14)} ${user.role}`);
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
