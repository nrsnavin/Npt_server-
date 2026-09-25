/**
 * Years of data for the volume test: the demo business copied `copies` times with every
 * reference kept inside its copy, then query threads and history rows on top.
 * See volume-test.mjs for why it is built this way.
 */
import mongoose from 'mongoose';
import { performance } from 'node:perf_hooks';

/* The business records that are copied. Accounts, sessions, counters and files are not. */
const CLONED = [
  'customers', 'leads', 'enquiries', 'samples', 'samplelogs', 'pricings', 'quotations', 'salesorders',
  'dispatches', 'receivables', 'inspections', 'orderqueries', 'orderescalations', 'queries', 'queryreads',
  'todos', 'moulds', 'materials', 'components', 'customermessages',
];
/* Fields a unique index is on, rewritten per copy so no two copies collide. */
const UNIQUE_STRINGS = new Set(['number', 'code', 'mouldCode', 'originKey']);

function rewrite(value, ids, copy, shiftMs, key) {
  if (value instanceof mongoose.Types.ObjectId) return ids.get(value.toHexString()) || value;
  if (value instanceof Date) return new Date(value.getTime() - shiftMs);
  if (Array.isArray(value)) return value.map((item) => rewrite(item, ids, copy, shiftMs));
  if (value && typeof value === 'object' && value.constructor === Object) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = key === 'externalRef' && k === 'id' && typeof v === 'string' ? `${v}-${copy}` : rewrite(v, ids, copy, shiftMs, k);
    }
    return out;
  }
  if (typeof value === 'string' && UNIQUE_STRINGS.has(key)) return `${value}-${copy}`;
  return value;
}

export async function buildVolume(db, { copies, queryHistory, auditRows, years = 3, settle = true }) {
  const COPIES = copies;
  const QUERY_HISTORY = queryHistory;
  const AUDIT_ROWS = auditRows;
  const YEARS = years;
  const started = performance.now();
  const templates = {};
  for (const name of CLONED) templates[name] = await db.collection(name).find().toArray().catch(() => []);
  const everyId = CLONED.flatMap((name) => templates[name].map((doc) => doc._id.toHexString()));
  const span = YEARS * 365 * 86400000;

  const BATCH = 100;
  for (let from = 0; from < COPIES; from += BATCH) {
    const batches = Object.fromEntries(CLONED.map((name) => [name, []]));
    for (let copy = from + 1; copy <= Math.min(from + BATCH, COPIES); copy++) {
      const ids = new Map(everyId.map((hex) => [hex, new mongoose.Types.ObjectId()]));
      const shift = (copy / COPIES) * span + Math.random() * 86400000;
      for (const name of CLONED) {
        for (const doc of templates[name]) batches[name].push(rewrite(doc, ids, copy, shift));
      }
    }
    for (const name of CLONED) if (batches[name].length) await db.collection(name).insertMany(batches[name], { ordered: false });
  }

  /* Three years of query threads at 100 a day, on the copied customers, between real people. */
  const users = await db.collection('users').find().toArray();
  const customers = (await db.collection('customers').find({}, { projection: { _id: 1 } }).toArray()).map((row) => row._id);
  const WORDS = 'carton delivery invoice payment hook clip print colour velvet shirt suit bottom transport lorry pallet sample rate please check tomorrow confirmed pcs'.split(' ');
  const say = (n) => Array.from({ length: n }, () => WORDS[Math.floor(Math.random() * WORDS.length)]).join(' ');
  const departments = ['despatch', 'accounts', 'production', 'quality', 'sampling'];
  const now = Date.now();
  for (let b = 0; b < QUERY_HISTORY; b += 5000) {
    const docs = [];
    for (let i = b; i < Math.min(b + 5000, QUERY_HISTORY); i++) {
      const at = new Date(now - span + (i / QUERY_HISTORY) * span);
      const by = users[i % users.length]._id;
      const m = 2 + Math.floor(Math.random() * 7);
      docs.push({
        number: `QRY-V-${i}`, customer: customers[i % customers.length], subject: `Question ${i} about ${say(4)}`, question: say(35),
        raisedBy: by,
        participants: [departments[i % 5], departments[(i + 2) % 5]].map((department) => ({ department, addedBy: by, addedAt: at })),
        messages: Array.from({ length: m }, (_, k) => ({ _id: new mongoose.Types.ObjectId(), kind: 'reply', body: say(18), by: users[(i + k + 1) % users.length]._id, at })),
        status: i > QUERY_HISTORY - 300 ? 'open' : 'closed', isUrgent: i % 97 === 0, labels: i % 3 ? [] : ['delivery'],
        createdAt: at, updatedAt: at, __v: m,
      });
    }
    await db.collection('queries').insertMany(docs, { ordered: false });
  }

  /* Half a million history rows, spread over the copied records. */
  const models = [['Customer', 'customers'], ['Enquiry', 'enquiries'], ['Sample', 'samples'], ['SalesOrder', 'salesorders'], ['Dispatch', 'dispatches'], ['Quotation', 'quotations']];
  const targets = [];
  for (const [model, collection] of models) {
    for (const row of await db.collection(collection).find({}, { projection: { _id: 1 } }).toArray()) targets.push([model, row._id]);
  }
  for (let b = 0; b < AUDIT_ROWS; b += 20000) {
    const rows = [];
    for (let i = b; i < Math.min(b + 20000, AUDIT_ROWS); i++) {
      const [model, recordId] = targets[i % targets.length];
      rows.push({ model, recordId, action: 'updated', by: users[i % users.length]._id, at: new Date(now - Math.random() * span), changes: [{ field: 'status', from: 'open', to: 'in_progress' }], note: say(5) });
    }
    await db.collection('auditlogs').insertMany(rows, { ordered: false });
  }

  if (settle) await settleHistory(db, users[0]._id);

  await db.admin().command({ fsync: 1 });
  const stats = await db.command({ dbStats: 1 });
  console.log(`  built in ${((performance.now() - started) / 1000).toFixed(0)}s — ${(stats.objects).toLocaleString()} records, ${(stats.dataSize / 1048576).toFixed(0)} MB of data, ${((stats.storageSize + stats.indexSize) / 1048576).toFixed(0)} MB on disk`);
  const counts = {};
  for (const name of ['customers', 'leads', 'enquiries', 'samples', 'pricings', 'quotations', 'salesorders', 'dispatches', 'receivables', 'queries', 'todos', 'auditlogs']) {
    counts[name] = await db.collection(name).estimatedDocumentCount();
  }
  console.log(`  ${Object.entries(counts).map(([name, n]) => `${name} ${n.toLocaleString()}`).join(' · ')}`);
}


/**
 * What happened to the old records, as it would in a real plant.
 *
 * Every copy keeps the demo data's statuses, which are mostly "in progress" — so without this a
 * database three years deep has three years of orders still in production and every invoice
 * still owed, a backlog no plant carries. Anything older than SETTLE_DAYS is finished: orders
 * and consignments closed, invoices paid, samples decided, enquiries won or lost, tasks done.
 * The last few weeks stay as they are, which is the live work the screens are about.
 */
export const SETTLE_DAYS = 45;
export async function settleHistory(db, by) {
  const old = { createdAt: { $lt: new Date(Date.now() - SETTLE_DAYS * 86400000) } };
  await db.collection('salesorders').updateMany(old, { $set: { status: 'closed' } });
  await db.collection('dispatches').updateMany(old, { $set: { status: 'closed' } });
  await db.collection('samples').updateMany(old, { $set: { status: 'approved' } });
  await db.collection('enquiries').updateMany(old, [{ $set: { status: { $cond: [{ $eq: [{ $mod: [{ $toLong: '$createdAt' }, 3] }, 0] }, 'lost', 'won'] } } }]);
  await db.collection('leads').updateMany(old, { $set: { status: 'converted' } });
  await db.collection('quotations').updateMany(old, { $set: { status: 'accepted' } });
  await db.collection('pricings').updateMany(old, { $set: { status: 'approved' } });
  await db.collection('orderqueries').updateMany(old, { $set: { status: 'closed' } });
  await db.collection('todos').updateMany(old, [{ $set: { completed: true, completedAt: '$createdAt', completedBy: by } }]);
  await db.collection('receivables').updateMany(old, [{
    $set: {
      status: 'paid',
      receipts: [{ _id: new mongoose.Types.ObjectId(), amount: '$invoice.value', receivedAt: '$dueBy', mode: 'neft', recordedBy: by }],
    },
  }]);
}
