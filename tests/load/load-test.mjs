/**
 * Load and concurrency test for the API.
 *
 * Starts its own throwaway database and a real API process (`src/server.js`), so it never
 * touches a real deployment. The API and its database are pinned to two CPU cores where
 * `taskset` exists, to stand in for the t3.small the deploy guide recommends.
 *
 *   node tests/load/load-test.mjs              the full run (about five minutes)
 *   node tests/load/load-test.mjs --quick      smaller numbers, for a smoke check
 *
 * What it checks:
 *   1. A year of history: 36,500 queries (100 a day) with their threads, then how fast the
 *      screens that read them still answer.
 *   2. The same moment: 100 queries raised at once, 40 replies to one thread at once,
 *      five people labelling one thread at once, quotes raised and revised at once, and two
 *      people saving the same customer at once.
 *   3. A busy office: 25 people working flat out for a minute.
 *
 * Exits non-zero if anything is wrong, so it can gate a release.
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

const QUICK = process.argv.includes('--quick');
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PORT = 5400 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const YEAR_OF_QUERIES = QUICK ? 3650 : 36500;
const OFFICE = 25;
const BUSY_SECONDS = QUICK ? 15 : 60;

const failures = [];
const check = (ok, what) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures.push(what);
};

const pin = (pid) => {
  if (spawnSync('which', ['taskset']).status === 0) spawnSync('taskset', ['-a', '-p', '-c', '0,1', String(pid)]);
};

/* ---------------------------------------------------------------- stack --- */

console.log('Starting a throwaway database and API…');
const mongo = await MongoMemoryServer.create({ instance: { storageEngine: 'wiredTiger' } });
pin(mongo.instanceInfo.instance.mongodProcess.pid);
const uri = mongo.getUri('npt_load');
const env = {
  ...process.env,
  MONGO_URI: uri,
  PORT: String(PORT),
  NODE_ENV: 'development',
  JWT_SECRET: 'load-test-only-secret-value',
  CORS_ORIGIN: 'http://127.0.0.1',
  /* The production default, on purpose: the limiter is part of what is under test. */
  RATE_LIMIT_MAX: '',
  ANTHROPIC_API_KEY: '',
};

/* Asynchronously: the database's log is read through this process, and blocking it stalls the database. */
await new Promise((resolve, reject) => {
  let output = '';
  const seed = spawn(process.execPath, ['src/seed/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  seed.stdout.on('data', (chunk) => (output += chunk));
  seed.stderr.on('data', (chunk) => (output += chunk));
  seed.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`seed failed:\n${output.slice(-2000)}`))));
});

let apiLog = '';
const api = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
api.stdout.on('data', (chunk) => (apiLog += chunk));
api.stderr.on('data', (chunk) => (apiLog += chunk));
let apiExited = null;
api.on('exit', (code, signal) => (apiExited = { code, signal }));
pin(api.pid);
for (let i = 0; i < 100 && !/listening on port/.test(apiLog); i++) await new Promise((r) => setTimeout(r, 200));
if (!/listening on port/.test(apiLog)) throw new Error(`API did not start:\n${apiLog}`);

await mongoose.connect(uri);
const db = mongoose.connection.db;

const rss = () => {
  const status = spawnSync('ps', ['-o', 'rss=', '-p', String(api.pid)], { encoding: 'utf8' }).stdout.trim();
  return Math.round(Number(status) / 1024);
};

/* ----------------------------------------------------------------- http --- */

const timings = new Map();
const statuses = new Map();
const record = (name, ms, status) => {
  if (!timings.has(name)) timings.set(name, []);
  timings.get(name).push(ms);
  const key = `${name} ${status}`;
  statuses.set(key, (statuses.get(key) || 0) + 1);
};

async function call(path, { method = 'GET', body, token, name = `${method} ${path.split('?')[0].replace(/[0-9a-f]{24}/g, ':id')}` } = {}) {
  const started = performance.now();
  let status = 0;
  let json = {};
  try {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    status = response.status;
    json = await response.json().catch(() => ({}));
  } catch (error) {
    json = { message: error.message };
  }
  record(name, performance.now() - started, status);
  return { status, json };
}

const pct = (list, p) => {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
};

/* ---------------------------------------------------------------- people --- */

const signIn = async (email, password) => (await call('/api/auth/login', { method: 'POST', body: { email, password } })).json.data?.token;
const admin = await signIn('rsnavin1@gmail.com', 'Admin@12345');
if (!admin) throw new Error('admin sign-in failed');

const ROLES = ['marketing', 'marketing', 'marketing', 'marketing', 'despatch', 'accounts', 'quality', 'production', 'sampling', 'order_confirmation'];
const people = [];
for (let i = 0; i < OFFICE; i++) {
  const department = ROLES[i % ROLES.length];
  const email = `load${i}@npt.test`;
  const made = await call('/api/users', {
    method: 'POST', token: admin,
    body: { name: `Load Person ${i}`, email, password: 'Load@123456', department },
  });
  if (made.status !== 201) throw new Error(`user ${i}: ${made.status} ${made.json.message}`);
  people.push({ id: made.json.data._id || made.json.data.id, department, token: await signIn(email, 'Load@123456') });
}
const marketing = people.filter((person) => person.department === 'marketing');
for (const person of marketing) {
  const customer = await call('/api/customers', {
    method: 'POST', token: person.token,
    body: { assignedTo: person.id, name: `Load Buyer ${person.id.slice(-4)}`, mobile: `98${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` },
  });
  if (customer.status !== 201) throw new Error(`customer: ${customer.status} ${customer.json.message}`);
  person.customer = customer.json.data._id;
}

const ask = (person, n) => call('/api/queries', {
  method: 'POST', token: person.token, name: 'POST /api/queries',
  body: {
    customer: person.customer,
    subject: `Load question ${n}`,
    question: `When can the ${n % 7 === 0 ? 'velvet' : 'shirt'} hangers for order ${n} leave the plant?`,
    participants: [{ department: 'despatch' }, { department: 'accounts' }],
  },
});

/* --------------------------------------------------- 1. a year of history --- */

console.log(`\n1. A year of history: ${YEAR_OF_QUERIES.toLocaleString()} queries, 100 a day`);
{
  const users = people.map((person) => new mongoose.Types.ObjectId(person.id));
  const customers = marketing.map((person) => new mongoose.Types.ObjectId(person.customer));
  const WORDS = 'carton delivery invoice payment hook clip print colour velvet shirt suit bottom transport lorry pallet sample rate'.split(' ');
  const sentence = (n) => Array.from({ length: n }, () => WORDS[Math.floor(Math.random() * WORDS.length)]).join(' ');
  const start = Date.now() - 365 * 86400000;
  const started = performance.now();
  for (let batch = 0; batch < YEAR_OF_QUERIES; batch += 2000) {
    const docs = [];
    for (let i = batch; i < Math.min(batch + 2000, YEAR_OF_QUERIES); i++) {
      const at = new Date(start + (i / YEAR_OF_QUERIES) * 365 * 86400000);
      const by = users[i % users.length];
      docs.push({
        number: `QRY-HIST-${String(i).padStart(6, '0')}`,
        customer: customers[i % customers.length],
        subject: `Question ${i} about ${sentence(3)}`,
        question: sentence(40),
        raisedBy: by,
        participants: [
          { department: 'despatch', addedBy: by, addedAt: at },
          { department: 'accounts', addedBy: by, addedAt: at },
        ],
        messages: Array.from({ length: 4 }, (_, m) => ({
          _id: new mongoose.Types.ObjectId(), kind: 'reply', body: sentence(25), by: users[(i + m + 1) % users.length], at,
        })),
        status: i > YEAR_OF_QUERIES - 60 ? 'open' : 'closed',
        isUrgent: i % 97 === 0,
        labels: i % 3 === 0 ? ['delivery'] : [],
        createdAt: at,
        updatedAt: at,
        __v: 0,
      });
    }
    await db.collection('queries').insertMany(docs, { ordered: false });
  }
  const stats = await db.command({ collStats: 'queries' });
  console.log(`  loaded in ${((performance.now() - started) / 1000).toFixed(1)}s — ${(stats.size / 1048576).toFixed(1)} MB of data, ${(stats.totalIndexSize / 1048576).toFixed(1)} MB of indexes, ${(stats.storageSize / 1048576).toFixed(1)} MB on disk`);

  const someone = marketing[0];
  const despatch = people.find((person) => person.department === 'despatch');
  const screens = [
    ['query list (marketing)', () => call('/api/queries?limit=25', { token: someone.token, name: 'history: list' })],
    ['query list (despatch)', () => call('/api/queries?limit=25&department=despatch&status=open', { token: despatch.token, name: 'history: department' })],
    ['search "velvet"', () => call('/api/queries?limit=25&search=velvet', { token: someone.token, name: 'history: search' })],
    ['label filter', () => call('/api/queries?limit=25&label=delivery', { token: admin, name: 'history: label' })],
    ['inbox (bell)', () => call('/api/inbox', { token: despatch.token, name: 'history: inbox' })],
    ['customer timeline', () => call(`/api/customers/${someone.customer}/timeline`, { token: someone.token, name: 'history: timeline' })],
  ];
  for (const [label, run] of screens) {
    const times = [];
    let bad = 0;
    for (let i = 0; i < 15; i++) {
      const started2 = performance.now();
      const { status } = await run();
      times.push(performance.now() - started2);
      if (status !== 200) bad++;
    }
    const p95 = pct(times, 95);
    check(bad === 0 && p95 < 1000, `${label}: p50 ${pct(times, 50).toFixed(0)} ms, p95 ${p95.toFixed(0)} ms${bad ? `, ${bad} failed` : ''}`);
  }
}

/* ------------------------------------------------------ 2. the same moment --- */

console.log('\n2. The same moment');
{
  /* 100 queries raised in the same instant. */
  const made = await Promise.all(Array.from({ length: 100 }, (_, n) => ask(marketing[n % marketing.length], n)));
  const ok = made.filter((row) => row.status === 201);
  const numbers = new Set(ok.map((row) => row.json.data.number));
  check(ok.length === 100, `100 queries at once: ${ok.length} created${ok.length < 100 ? ` (${[...new Set(made.map((r) => r.status))].join(', ')})` : ''}`);
  check(numbers.size === ok.length, `  …with ${numbers.size} different numbers`);

  /* 40 replies to one thread in the same instant, from its participants. */
  const thread = ok[0].json.data;
  const repliers = people.filter((person) => ['despatch', 'accounts'].includes(person.department));
  const replies = await Promise.all(Array.from({ length: 40 }, (_, n) => call(`/api/queries/${thread._id}/messages`, {
    method: 'POST', token: repliers[n % repliers.length].token, name: 'POST /api/queries/:id/messages',
    body: { kind: 'reply', body: `Reply ${n}` },
  })));
  const replyCodes = replies.reduce((acc, row) => ({ ...acc, [row.status]: (acc[row.status] || 0) + 1 }), {});
  const stored = await db.collection('queries').findOne({ _id: new mongoose.Types.ObjectId(thread._id) });
  const kept = stored.messages.filter((message) => /^Reply \d+$/.test(message.body || '')).length;
  check(replyCodes[201] === 40, `40 replies to one thread at once: ${JSON.stringify(replyCodes)}`);
  check(kept === (replyCodes[201] || 0), `  …and every accepted reply is in the thread (${kept} stored)`);

  /* Five people who can all see one thread, each adding a different label at the same moment. */
  const tags = ['urgent-stock', 'transport', 'invoice', 'quality', 'rework'];
  const target = ok[1].json.data;
  const raiser = marketing.find((person) => person.customer === (target.customer?._id || target.customer));
  const labellers = [raiser.token, admin, ...repliers.slice(0, 3).map((person) => person.token)];
  const labelled = await Promise.all(tags.map((label, n) => call('/api/queries/labels', {
    method: 'POST', token: labellers[n], name: 'POST /api/queries/labels',
    body: { ids: [target._id], add: label },
  })));
  const afterLabels = await db.collection('queries').findOne({ _id: new mongoose.Types.ObjectId(target._id) });
  const applied = labelled.filter((row) => row.status === 200 && row.json.data.updated.length === 1).length;
  check(applied === 5, `5 people labelling one thread at once: ${applied} applied (${labelled.map((row) => row.status === 200 ? (row.json.data.updated.length ? 'ok' : row.json.data.skipped[0]?.reason) : row.status).join(', ')})`);
  const reported = tags.filter((label, n) => labelled[n].status === 200 && labelled[n].json.data.updated.length === 1);
  check(reported.every((label) => afterLabels.labels.includes(label)) && afterLabels.labels.length === reported.length,
    `  …and exactly the labels reported as applied are on it (${afterLabels.labels.join(', ')})`);

  /* Quotes raised at once, then one quote revised by two people at once. */
  const quotes = await Promise.all(Array.from({ length: 30 }, (_, n) => {
    const person = marketing[n % marketing.length];
    return call('/api/quotations', {
      method: 'POST', token: person.token, name: 'POST /api/quotations',
      body: { customer: person.customer, paymentTerms: '30 days', validUntil: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), lines: [{ modelNumber: 'NH-400', unitPrice: 7.5 }] },
    });
  }));
  const quoteNumbers = quotes.filter((row) => row.status === 201).map((row) => row.json.data.number);
  check(quoteNumbers.length === 30 && new Set(quoteNumbers).size === 30, `30 quotes at once: ${quoteNumbers.length} created, ${new Set(quoteNumbers).size} different numbers (${quoteNumbers.sort()[0]} …)`);

  const quote = quotes.find((row) => row.status === 201).json.data;
  const owner = marketing.find((person) => person.customer === quote.customer || person.customer === quote.customer?._id);
  const revisions = await Promise.all([7.2, 7.1].map((price) => call(`/api/quotations/${quote._id}/revisions`, {
    method: 'POST', token: owner.token, name: 'POST /api/quotations/:id/revisions',
    body: { lines: [{ modelNumber: 'NH-400', unitPrice: price }], note: `to ${price}` },
  })));
  const storedQuote = await db.collection('quotations').findOne({ _id: new mongoose.Types.ObjectId(quote._id) });
  const revNumbers = storedQuote.revisions.map((rev) => rev.revision);
  const codes = revisions.map((row) => row.status).sort();
  check(!codes.includes(500) && codes.includes(200), `one quote revised by two people at once: ${codes.join(', ')} (a 409 is the right answer for the second)`);
  check(new Set(revNumbers).size === revNumbers.length && storedQuote.revision === revNumbers.at(-1), `  …and the history has no duplicate revision (${revNumbers.join(', ')})`);

  /* Two people saving the same customer, both from the version they loaded. */
  const person = marketing[0];
  const loaded = (await call(`/api/customers/${person.customer}`, { token: person.token })).json.data;
  const saves = await Promise.all(['Ground floor', 'First floor'].map((address) => call(`/api/customers/${person.customer}`, {
    method: 'PATCH', token: person.token, name: 'PATCH /api/customers/:id',
    body: { address, expectedUpdatedAt: loaded.updatedAt },
  })));
  const saveCodes = saves.map((row) => row.status).sort();
  check(saveCodes.join() === '200,409', `two people saving one customer at once: ${saveCodes.join(', ')} (one wins, the other is told)`);
}

/* ------------------------------------------------------- 3. a busy office --- */

console.log(`\n3. A busy office: ${OFFICE} people working flat out for ${BUSY_SECONDS}s`);
{
  /* Each person works on the threads they can see — their own list, as the screen shows it. */
  for (const person of people) {
    const mine = (await call('/api/queries?limit=50', { token: person.token, name: 'setup' })).json.data || [];
    person.threads = mine.map((row) => row._id);
    person.open = mine.filter((row) => row.status !== 'closed').map((row) => row._id);
  }
  const before = rss();
  let peak = before;
  const sampler = setInterval(() => (peak = Math.max(peak, rss())), 1000);
  const until = Date.now() + BUSY_SECONDS * 1000;
  let n = 1000;
  const think = () => new Promise((r) => setTimeout(r, 150 + Math.random() * 250));

  const work = async (person) => {
    while (Date.now() < until) {
      const roll = Math.random();
      const pickFrom = (list) => list[Math.floor(Math.random() * list.length)];
      const thread = pickFrom(person.threads);
      const open = pickFrom(person.open);
      if (roll < 0.30) await call('/api/queries?limit=25', { token: person.token, name: 'busy: query list' });
      else if (roll < 0.45 && thread) await call(`/api/queries/${thread}`, { token: person.token, name: 'busy: open thread' });
      else if (roll < 0.55) await call('/api/inbox', { token: person.token, name: 'busy: inbox' });
      else if (roll < 0.62) await call('/api/queries?limit=25&search=hanger', { token: person.token, name: 'busy: search' });
      else if (roll < 0.72) await call('/api/auth/me', { token: person.token, name: 'busy: session' });
      else if (roll < 0.80 && person.customer) await ask(person, n++);
      else if (roll < 0.90 && open) await call(`/api/queries/${open}/messages`, { method: 'POST', token: person.token, name: 'busy: reply', body: { body: 'On it' } });
      else if (person.customer) await call('/api/quotations?limit=25', { token: person.token, name: 'busy: quotes' });
      else await call('/api/workspace/todos?status=open', { token: person.token, name: 'busy: tasks' });
      await think();
    }
  };
  const started = performance.now();
  await Promise.all(people.map(work));
  clearInterval(sampler);
  const seconds = (performance.now() - started) / 1000;

  const busy = [...timings.entries()].filter(([name]) => name.startsWith('busy:'));
  const all = busy.flatMap(([, list]) => list);
  const byStatus = {};
  for (const [key, count] of statuses) {
    if (!key.startsWith('busy:')) continue;
    const status = key.split(' ').at(-1);
    byStatus[status] = (byStatus[status] || 0) + count;
  }
  console.log(`  ${all.length.toLocaleString()} requests in ${seconds.toFixed(0)}s — ${(all.length / seconds).toFixed(0)} a second; responses ${JSON.stringify(byStatus)}`);
  for (const [name, list] of busy) {
    console.log(`    ${name.padEnd(20)} n=${String(list.length).padStart(5)}  p50 ${pct(list, 50).toFixed(0).padStart(4)} ms  p95 ${pct(list, 95).toFixed(0).padStart(4)} ms  p99 ${pct(list, 99).toFixed(0).padStart(4)} ms`);
  }
  const serverErrors = Object.entries(byStatus).filter(([status]) => status === '0' || status.startsWith('5')).reduce((sum, [, count]) => sum + count, 0);
  const limited = byStatus['429'] || 0;
  const conflicts = byStatus['409'] || 0;
  check(serverErrors === 0, `no server errors or dropped connections (${serverErrors})`);
  check(limited === 0, `nobody working normally is rate-limited (${limited} × 429)`);
  check(conflicts === 0, `no false "someone else changed this" on replies (${conflicts} × 409)`);
  check(pct(all, 95) < 1500, `p95 across everything ${pct(all, 95).toFixed(0)} ms (under 1.5 s)`);
  check(peak < 600, `API memory ${before} MB → peak ${peak} MB (under 600 MB)`);
}

check(apiExited === null, `the API is still running at the end${apiExited ? ` (exited ${JSON.stringify(apiExited)})` : ''}`);
const errorsLogged = apiLog.split('\n').filter((line) => /Unhandled|uncaught|TypeError|ReferenceError/i.test(line));
check(errorsLogged.length === 0, `no crashes or programming errors in the API log${errorsLogged.length ? `:\n      ${errorsLogged.slice(0, 5).join('\n      ')}` : ''}`);

api.kill('SIGTERM');
await mongoose.disconnect();
await mongo.stop();

console.log(failures.length ? `\n${failures.length} FAILED:\n  - ${failures.join('\n  - ')}` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
