import { MongoMemoryServer } from 'mongodb-memory-server';
import { execFileSync } from 'node:child_process';

const mongo = await MongoMemoryServer.create();
const uri = mongo.getUri();
process.env.MONGO_URI = uri;
process.env.JWT_SECRET = 'reset-test-secret';

const mongoose = (await import('mongoose')).default;
await mongoose.connect(uri);
const User = (await import('/home/user/Npt_server-/src/models/User.js')).default;
const Lead = (await import('/home/user/Npt_server-/src/models/Lead.js')).default;
const Customer = (await import('/home/user/Npt_server-/src/models/Customer.js')).default;

await User.create([
  { name: 'Navin R', email: 'rsnavin02@gmail.com', password: 'Passw0rd@123', role: 'member', department: 'marketing' },
  { name: 'Someone Else', email: 'other@np.com', password: 'Passw0rd@123', role: 'member', department: 'marketing' },
]);
const owner = await User.findOne({ email: 'rsnavin02@gmail.com' });
await Customer.create({ name: 'Acme', code: 'CUST-1', assignedTo: owner._id });
await Lead.create([
  { number: 'LEAD-1', company: 'A', assignedTo: owner._id, status: 'new' },
  { number: 'LEAD-2', company: 'B', assignedTo: owner._id, status: 'new' },
]);
await mongoose.disconnect();

const run = (args) => {
  try {
    return execFileSync('node', ['scripts/reset-data.js', ...args], {
      cwd: '/home/user/Npt_server-', env: { ...process.env, MONGO_URI: uri }, encoding: 'utf8',
    });
  } catch (error) {
    return (error.stdout || '') + (error.stderr || '');
  }
};

console.log('=== 1. wrong email — must refuse and delete nothing ===');
console.log(run(['--keep=typo@nowhere.com', '--confirm']));

await mongoose.connect(uri);
console.log('leads still present after the refusal:', await Lead.countDocuments());
await mongoose.disconnect();

console.log('=== 2. dry run (default) ===');
console.log(run([]));

await mongoose.connect(uri);
console.log('leads still present after the dry run:', await Lead.countDocuments());
await mongoose.disconnect();

console.log('=== 3. for real ===');
console.log(run(['--confirm']));

await mongoose.connect(uri);
console.log('leads:', await Lead.countDocuments(), '| customers:', await Customer.countDocuments());
const left = await User.find().select('email role').lean();
console.log('users left:', JSON.stringify(left.map((u) => `${u.email} (${u.role})`)));
await mongoose.disconnect();
await mongo.stop();
