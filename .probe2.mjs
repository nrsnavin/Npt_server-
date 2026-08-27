import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { spawnSync } from 'node:child_process';

const mongo = await MongoMemoryServer.create();
const uri = mongo.getUri('probe');

// Hold a connection open for the whole probe, so mongod cannot be the variable.
const keepAlive = await mongoose.createConnection(uri).asPromise();
await keepAlive
  .collection('customers')
  .createIndex({ id: 1, reference_value: 1 }, { unique: true, name: 'id_1_reference_value_1' });
await keepAlive.collection('customers').insertOne({ name: 'Seed' });

const run = (args) => {
  const result = spawnSync('node', ['scripts/doctor-indexes.js', ...args], {
    env: { ...process.env, MONGO_URI: uri, JWT_SECRET: 'probe' },
    encoding: 'utf8',
  });
  return ((result.stdout || '') + (result.stderr || '')).trim();
};

console.log('=== fix ===\n' + run(['--fix']));
console.log('\n=== after ===\n' + run([]));

const left = await keepAlive.collection('customers').indexes();
console.log('\nindexes remaining:', left.map((i) => i.name).join(', '));

// And creation works again.
await keepAlive.collection('customers').insertOne({ name: 'Second' });
console.log('second insert after fix: ok');

await keepAlive.close();
await mongo.stop();
