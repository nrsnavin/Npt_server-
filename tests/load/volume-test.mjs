/**
 * Every screen, against years of data.
 *
 * Builds a database far larger than the plant will have for years and times every GET the API
 * serves against it, as three different people, then has 25 people work on it at once.
 *
 *   node tests/load/volume-test.mjs            the full run (~1,500 copies of the business, 110,000 queries)
 *   node tests/load/volume-test.mjs --quick    a tenth of it, for a smoke check
 *
 * How the volume is made: the demo data is one small, *connected* business — a customer, their
 * enquiry, its sample, costing, quote, order, dispatch and payment all pointing at each other.
 * It is copied COPIES times, each copy with fresh ids and every reference rewritten to the same
 * copy, so every record in the database is as consistent as a real one; each copy is moved
 * back in time so the whole spreads over three years. Then three years of query threads at 100
 * a day, and half a million history rows, go on top.
 *
 * Starts its own database and API (tests/load/stack.mjs) — it never touches a real deployment.
 * Exits non-zero on any server error, any screen over 3 s, or the API falling over.
 */
import { readFileSync } from 'node:fs';
import { ROOT, client, pct, startStack } from './stack.mjs';
import { buildVolume } from './volume.mjs';

const QUICK = process.argv.includes('--quick');
/* --backlog keeps every copied record in its demo status: years of work never finished, a worst case no plant carries. */
const BACKLOG = process.argv.includes('--backlog');
const COPIES = QUICK ? 150 : 1500;
const QUERY_HISTORY = QUICK ? 11000 : 110000;
const AUDIT_ROWS = QUICK ? 50000 : 500000;
const SLOW_MS = 1000;
const FAIL_MS = 3000;

const failures = [];
const warnings = [];
const check = (ok, what) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures.push(what);
};

/* ------------------------------------------------------------------ routes --- */

/** Every GET route the API mounts, read from the route files, so a new screen is tested without being listed here. */
function everyGetRoute() {
  const mounts = { auth: '/auth', user: '/users', workspace: '/workspace', sample: '/samples', whatsapp: '/whatsapp', pricing: '', order: '', query: '', pipeline: '' };
  const routes = [];
  for (const [file, prefix] of Object.entries(mounts)) {
    const source = readFileSync(`${ROOT}/src/routes/${file}.routes.js`, 'utf8');
    for (const [, path] of source.matchAll(/router\.get\(\s*'([^']+)'/g)) routes.push(`${prefix}${path === '/' ? '' : path}` || '/');
  }
  const index = readFileSync(`${ROOT}/src/routes/index.js`, 'utf8');
  for (const [, path] of index.matchAll(/router\.get\(\s*'([^']+)'/g)) routes.push(path);
  return [...new Set(routes)];
}

/* Where an :id comes from, by the path it sits in. */
const ID_SOURCE = [
  [/^\/users\/:id/, 'users'], [/^\/samples\/:id/, 'samples'], [/^\/pricings\/:id/, 'pricings'], [/^\/quotations\/:id/, 'quotations'],
  [/^\/orders\/:id/, 'salesorders'], [/^\/payments\/:id/, 'receivables'], [/^\/dispatches\/:id/, 'dispatches'], [/^\/queries\/:id/, 'queries'],
  [/^\/moulds\/:id/, 'moulds'], [/^\/materials\/:id/, 'materials'], [/^\/components\/:id/, 'components'], [/^\/customers\/:id/, 'customers'],
  [/^\/leads\/:id/, 'leads'], [/^\/enquiries\/:id/, 'enquiries'], [/^\/workspace\/todos\/:id/, 'todos'], [/^\/whatsapp\/threads\/:id/, 'whatsappthreads'],
];
/* What a route needs to be asked sensibly. */
const QUERY_FOR = {
  '/search': '?q=hanger', '/places/cities': '?state=Tamil%20Nadu', '/customers/check-duplicate': '?name=Sri%20Kumaran',
  '/components': '?kind=hook', '/components/export': '?kind=hook',
};
/* Not screens: a password link, a raw file, the model's status. */
const SKIP = new Set(['/auth/password/reset/:token', '/files/:key']);

async function concrete(db, route) {
  if (SKIP.has(route)) return null;
  let path = route;
  if (path.includes('/:collection/:id/')) {
    const row = await db.collection('customers').findOne({}, { skip: 500 });
    path = path.replace(':collection', 'customers').replace(':id', row._id);
  } else if (path.startsWith('/history/')) {
    const row = await db.collection('enquiries').findOne({}, { skip: 500 });
    path = `/history/Enquiry/${row._id}`;
  } else if (path.includes(':id')) {
    const source = ID_SOURCE.find(([pattern]) => pattern.test(path));
    if (!source) return null;
    const count = await db.collection(source[1]).estimatedDocumentCount();
    if (!count) return null;
    const row = await db.collection(source[1]).findOne({}, { skip: Math.floor(count / 2) });
    path = path.replace(':id', row._id);
  }
  if (path.includes(':')) return null;
  return `/api${path}${QUERY_FOR[route] || ''}`;
}

/* -------------------------------------------------------------------- run --- */

console.log(`Building ${QUICK ? 'a tenth of ' : ''}the volume database…`);
const stack = await startStack({
  prepare: (db) => buildVolume(db, { copies: COPIES, queryHistory: QUERY_HISTORY, auditRows: AUDIT_ROWS, settle: !BACKLOG }), env: {
    RATE_LIMIT_MAX: '100000',
    /* As the deploy guide runs it under pm2, so a screen that needs more memory than production has fails here. */
    NODE_OPTIONS: '--max-old-space-size=512',
  },
});
const { call, timings, statuses } = client(stack.base);
const signIn = async (email, password) => (await call('/api/auth/login', { method: 'POST', body: { email, password }, name: 'sign in' })).json.data?.token;
const people = {
  admin: await signIn('rsnavin1@gmail.com', 'Admin@12345'),
  marketing: await signIn('marketing@npthangers.com', 'Mktg@123456'),
  despatch: await signIn('despatch@npthangers.com', 'Desp@123456'),
};

const routes = everyGetRoute();
const urls = [];
for (const route of routes) {
  const url = await concrete(stack.db, route);
  if (url) urls.push([route, url]);
}
console.log(`\n1. Every screen, five times each: ${urls.length} of ${routes.length} GET routes (the rest need a file or a token)`);

const serverErrors = [];
const reachable = { admin: [], marketing: [], despatch: [] };
for (const [who, token] of Object.entries(people)) {
  const rows = [];
  for (const [route, url] of urls) {
    const times = [];
    let status = 0;
    let bytes = 0;
    for (let i = 0; i < 5; i++) {
      const result = await call(url, { token, name: `${who} ${route}` });
      times.push(result.ms);
      status = result.status;
      bytes = result.bytes;
      if (result.status >= 500 || result.status === 0) serverErrors.push(`${who} ${url} → ${result.status} ${result.json?.message || ''}`);
    }
    if (status === 200) reachable[who].push(url);
    rows.push({ route, status, p50: pct(times, 50), p95: pct(times, 95), kb: Math.round(bytes / 1024) });
  }
  const answered = rows.filter((row) => row.status === 200);
  const slow = answered.filter((row) => row.p95 >= SLOW_MS).sort((a, b) => b.p95 - a.p95);
  const failing = answered.filter((row) => row.p95 >= FAIL_MS);
  const refused = rows.filter((row) => row.status === 403).length;
  const other = rows.filter((row) => ![200, 403].includes(row.status));
  console.log(`\n  As ${who}: ${answered.length} screens answered, ${refused} refused by module access${other.length ? `, others: ${other.map((row) => `${row.route} ${row.status}`).join(', ')}` : ''}`);
  console.log(`    all answered screens: p50 ${pct(answered.map((row) => row.p50), 50).toFixed(0)} ms, slowest p95 ${Math.max(...answered.map((row) => row.p95)).toFixed(0)} ms`);
  for (const row of [...answered].sort((a, b) => b.p95 - a.p95).slice(0, 8)) {
    console.log(`    ${row.route.padEnd(38)} p50 ${row.p50.toFixed(0).padStart(5)} ms  p95 ${row.p95.toFixed(0).padStart(5)} ms  ${String(row.kb).padStart(5)} KB`);
  }
  for (const row of slow) if (row.p95 < FAIL_MS) warnings.push(`${who} ${row.route} p95 ${row.p95.toFixed(0)} ms`);
  check(failing.length === 0, `as ${who}: no screen over ${FAIL_MS / 1000} s${failing.length ? ` (${failing.map((row) => `${row.route} ${row.p95.toFixed(0)} ms`).join(', ')})` : ''}`);
}
check(serverErrors.length === 0, `no server errors on any screen${serverErrors.length ? `:\n      ${[...new Set(serverErrors)].slice(0, 15).join('\n      ')}` : ''}`);

/* 25 people at once, on the screens their access actually reaches. */
console.log('\n2. 25 people at once on the full database, for 60 s');
{
  const crowd = Array.from({ length: 25 }, (_, i) => ['admin', 'marketing', 'marketing', 'despatch'][i % 4]);
  const until = Date.now() + (QUICK ? 15000 : 60000);
  const seen = { total: 0, errors: 0, byStatus: {} };
  const times = [];
  const peakBefore = stack.rss();
  let peak = peakBefore;
  const sampler = setInterval(() => (peak = Math.max(peak, stack.rss())), 1000);
  await Promise.all(crowd.map(async (who) => {
    while (Date.now() < until) {
      /* Downloads are an occasional act, not one click in ten: 2% of clicks, as in an office. */
      const pool = reachable[who].filter((u) => u.includes('/export') === (Math.random() < 0.02));
      const url = pool[Math.floor(Math.random() * pool.length)];
      const result = await call(url, { token: people[who], name: url.includes('/export') ? 'crowd export' : 'crowd' });
      seen.total++;
      times.push(result.ms);
      seen.byStatus[result.status] = (seen.byStatus[result.status] || 0) + 1;
      if (result.status >= 500 || result.status === 0) {
        seen.errors++;
        serverErrors.push(`crowd ${url} → ${result.status}`);
      }
      await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));
    }
  }));
  clearInterval(sampler);
  console.log(`  ${seen.total.toLocaleString()} requests; responses ${JSON.stringify(seen.byStatus)}; p50 ${pct(times, 50).toFixed(0)} ms, p95 ${pct(times, 95).toFixed(0)} ms, p99 ${pct(times, 99).toFixed(0)} ms`);
  const exportsTaken = timings.get('crowd export') || [];
  if (exportsTaken.length) console.log(`  of which ${exportsTaken.length} downloads: p50 ${pct(exportsTaken, 50).toFixed(0)} ms, slowest ${Math.max(...exportsTaken).toFixed(0)} ms`);
  check(seen.errors === 0, `no server errors with 25 people on the full database (${seen.errors})`);
  check(pct(times, 95) < 2000, `p95 under 2 s (${pct(times, 95).toFixed(0)} ms)`);
  check(peak < 800, `API memory ${peakBefore} MB → peak ${peak} MB (under 800 MB)`);
}

check(stack.exited() === null, 'the API is still running at the end');
const logged = stack.log().split('\n').filter((line) => /Unhandled|uncaught|TypeError|ReferenceError|RangeError|\[process\]/i.test(line));
check(logged.length === 0, `no crashes or programming errors in the API log${logged.length ? `:\n      ${logged.slice(0, 8).join('\n      ')}` : ''}`);
void timings; void statuses;

await stack.stop();
if (warnings.length) console.log(`\nSlower than ${SLOW_MS / 1000} s (not failures):\n  - ${warnings.join('\n  - ')}`);
console.log(failures.length ? `\n${failures.length} FAILED:\n  - ${failures.join('\n  - ')}` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
