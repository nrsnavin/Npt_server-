/**
 * Gives everybody a read cursor on the threads that existed before read state did.
 *
 * Unread counts compare what was said against how far each person has read. On the day this
 * ships nobody has a cursor anywhere, so every message in every thread would count as unread —
 * and the first thing each person saw would be forty threads badged with numbers that mean
 * nothing, which teaches them to ignore the badge on the first morning.
 *
 * So each existing thread gets a cursor at its last message for everybody in it: the asker, the
 * people named on it, and the current members of each department on it. From then on, only what
 * is said after launch is new — which is what "unread" should mean.
 *
 * `$max`, so running it after somebody has already read past that point never moves them back.
 * Idempotent: a second run changes nothing. Dry run by default.
 *
 *   node scripts/migrate-query-reads.js            # show me
 *   node scripts/migrate-query-reads.js --confirm  # do it
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';

const confirm = process.argv.includes('--confirm');

async function migrate() {
  await connectDatabase();
  const db = mongoose.connection;
  const queries = await db.collection('queries').find({}).toArray();
  const users = await db.collection('users')
    .find({ isActive: { $ne: false } }, { projection: { _id: 1, department: 1 } })
    .toArray();

  const inDepartment = (department) =>
    users.filter((user) => user.department === department).map((user) => user._id);

  let cursors = 0;
  for (const query of queries) {
    const messages = query.messages || [];
    const lastAt = messages.length ? messages[messages.length - 1].at : query.createdAt;

    const people = new Map();
    const add = (id) => id && people.set(String(id), id);
    add(query.raisedBy);
    for (const participant of query.participants || []) {
      if (participant.user) add(participant.user);
      else inDepartment(participant.department).forEach(add);
    }

    console.log(`  ${query.number}  →  ${people.size} reader(s) up to ${new Date(lastAt).toISOString()}`);
    cursors += people.size;

    if (confirm) {
      const writes = [...people.values()].map((user) => ({
        updateOne: {
          filter: { query: query._id, user },
          update: { $max: { at: lastAt } },
          upsert: true,
        },
      }));
      if (writes.length) await db.collection('queryreads').bulkWrite(writes, { ordered: false });
    }
  }

  console.log('');
  console.log(confirm
    ? `Set ${cursors} cursor(s) across ${queries.length} thread(s).`
    : `Dry run — nothing was changed. Re-run with --confirm to set ${cursors} cursor(s).`);

  await disconnectDatabase();
}

migrate().catch(async (error) => {
  console.error(error);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
