/**
 * Twenty people (or `--users=N`) working the enquiry workflow at the same time, on a replica set.
 *
 * Starts its own throwaway replica set and a real API process, so it never touches a real
 * deployment. Twenty accounts across the departments — eight in marketing, the rest in SO,
 * Production, Assembly, Mould, Quality, Dispatch, Reception, Accounts and Sampling — then, for a
 * fixed time, every one of them works as fast as the API answers:
 *
 *   marketing    makes buyers and enquiries, logs calls, sets the marketing status, raises
 *                department tasks, reads the enquiry list and the overview
 *   departments  move their tasks through their own statuses with a remark, post updates,
 *                Dispatch asks Production, and every one reads its dashboard
 *
 * On purpose, people collide: several departments work tasks on the same enquiry, and two
 * people move the same task in the same instant.
 *
 *   node tests/load/workflow-load.mjs            the full run (about three minutes)
 *   node tests/load/workflow-load.mjs --quick    a smoke check
 *   node tests/load/workflow-load.mjs --users=50 --seconds=180              fifty, flat out
 *   node tests/load/workflow-load.mjs --users=50 --think=3000               fifty at a working pace
 *
 * What it holds the API to, and exits non-zero if any fails:
 *   - no 5xx, and the API process is still running at the end
 *   - every refusal is one a person could be shown (400/403/404/409), none a crash
 *   - no enquiry number or customer is duplicated, and no enquiry has two open tasks of a kind
 *   - no lock is left behind, and every handover (outbox row) is delivered, none failed
 *   - 95% of writes answer within 1.5 s and of reads within 1 s
 */
import { performance } from 'node:perf_hooks';
import { startStack, client, pct } from './stack.mjs';

const QUICK = process.argv.includes('--quick');
const option = (name, fallback) => Number(process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1]) || fallback;
const SECONDS = option('seconds', QUICK ? 20 : 120);
/* How many people: `--users=50`. Four in ten are marketing, the rest spread over the departments. */
const USERS = option('users', 20);
/*
 * `--think=3000`: each person pauses about that long between actions (half to one and a half
 * times it), as people do — reading a screen, typing a remark. Without it every person clicks
 * as fast as the API answers, which is a stress test rather than a working office.
 */
const THINK = option('think', 0);
const pause = () => (THINK ? new Promise((resolve) => setTimeout(resolve, THINK * (0.5 + Math.random()))) : null);
const failures = [];
const check = (ok, what) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures.push(what);
};

console.log('Starting a throwaway replica set and API…');
/* `--instances=2`: two API processes, as `pm2 start -i 2` runs them on a two-vCPU server. */
const INSTANCES = option('instances', 1);
const stack = await startStack({ replSet: true, instances: INSTANCES });
const { call, timings, statuses, reasons } = client(stack.bases);

const signIn = async (email, password) => (await call('/api/auth/login', { method: 'POST', body: { email, password } })).json.data?.token;
const admin = await signIn('rsnavin1@gmail.com', 'Admin@12345');
if (!admin) throw new Error('admin sign-in failed');

const DEPARTMENTS = [
  'order_confirmation', 'order_confirmation', 'production', 'production', 'assembling', 'mould',
  'quality', 'despatch', 'despatch', 'reception', 'accounts', 'sampling',
];
const MARKETING = Math.round(USERS * 0.4);
const TEAM = [
  ...Array(MARKETING).fill('marketing'),
  ...Array.from({ length: USERS - MARKETING }, (_, i) => DEPARTMENTS[i % DEPARTMENTS.length]),
];
const run = Date.now().toString(36);
const people = [];
for (const [i, department] of TEAM.entries()) {
  const email = `wf${i}.${run}@npt.test`;
  const made = await call('/api/users', { method: 'POST', token: admin, body: { name: `Workflow ${department} ${i}`, email, password: 'Load@123456', department } });
  if (made.status !== 201) throw new Error(`user ${i}: ${made.status} ${made.json.message}`);
  people.push({ department, email, id: made.json.data._id || made.json.data.id });
}
/* Everybody signs in at the same moment, as the office does at nine — through one address. */
await Promise.all(people.map(async (person) => { person.token = await signIn(person.email, 'Load@123456'); }));
if (people.some((person) => !person.token)) throw new Error(`${people.filter((person) => !person.token).length} people could not sign in`);
console.log(`  ${people.length} people signed in`);

/* What marketing has raised, by the department that works it — shared, as a real office's lists are. */
const KIND_FOR = {
  order_confirmation: 'po_so', production: 'ask_edd', assembling: 'ask_assembling_edd', mould: 'mould_issue',
  quality: 'quality_check', despatch: 'invoice_dispatch', reception: 'lr_copy', accounts: 'ac_clarify', sampling: 'sample_request',
};
const BRIEF = {
  mould_issue: { problem: 'Hook cavity flashing' },
  sample_request: { items: [{ model: 'NH-400', quantity: 2 }] },
};
const raised = new Map(Object.values(KIND_FOR).map((kind) => [kind, []]));
const enquiries = [];
const statusesOf = new Map();
const handoffs = (await call('/api/handoffs', { token: admin })).json.data?.buttons || [];
for (const button of handoffs) statusesOf.set(button.key, (button.form?.statuses || []).map((entry) => entry));

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
let phoneSeq = 0;
const phone = () => `9${String(Date.now() % 1e5).padStart(5, '0')}${String(phoneSeq++).padStart(4, '0')}`.slice(0, 10);

async function marketingStep(person) {
  const roll = Math.random();
  if (roll < 0.15 || enquiries.length < 10) {
    const buyer = await call('/api/customers', { method: 'POST', token: person.token, body: { name: `Load Buyer ${phoneSeq}`, mobile: phone(), assignedTo: person.id, area: pick(['Kumar Nagar', 'Avinashi Road', 'Anupparpalayam']), city: 'Tiruppur' } });
    if (buyer.status !== 201) return;
    const made = await call('/api/enquiries', { method: 'POST', token: person.token, body: { customer: buyer.json.data._id, requirement: { modelNumber: 'NH-400' }, nextAction: 'Call', nextFollowUpDate: inDays(3) } });
    if (made.status === 201) enquiries.push({ id: made.json.data._id, owner: person });
    return;
  }
  const mine = enquiries.filter((entry) => entry.owner === person);
  const enquiry = pick(mine.length ? mine : enquiries);
  const owner = enquiry.owner;
  if (roll < 0.35) {
    await call(`/api/enquiries/${enquiry.id}/activities`, { method: 'POST', token: owner.token, body: { type: 'call', note: 'Spoke to the buyer about the order', nextAction: 'Call back', nextFollowUpDate: inDays(2) } });
  } else if (roll < 0.45) {
    await call(`/api/enquiries/${enquiry.id}/marketing-status`, { method: 'POST', token: owner.token, body: { status: pick(['photos_sent', 'pricing_discussion', 'po_awaiting', 'price_approved']) } });
  } else if (roll < 0.75) {
    const kind = pick([...raised.keys()]);
    const sent = await call(`/api/enquiries/${enquiry.id}/handoffs`, { method: 'POST', token: owner.token, name: 'POST /api/enquiries/:id/handoffs', body: { kind, note: 'Please take this up', brief: { model: 'NH-400', quantity: '10000', ...BRIEF[kind] } } });
    if (sent.status === 201 && sent.json.data?.task?._id) raised.get(kind).push(sent.json.data.task._id);
  } else if (roll < 0.9) {
    await call('/api/enquiries?limit=25', { token: person.token });
  } else {
    await call('/api/dashboard/overview', { token: person.token });
  }
}

async function departmentStep(person) {
  const kind = KIND_FOR[person.department];
  const tasks = raised.get(kind) || [];
  const roll = Math.random();
  if (!tasks.length || roll < 0.2) {
    await call(`/api/departments/${person.department}/dashboard`, { token: person.token, name: 'GET /api/departments/:key/dashboard' });
    return;
  }
  const task = pick(tasks);
  const ladder = (statusesOf.get(kind) || []).filter((entry) => !entry.pdf && !entry.sent && !entry.raises);
  if (roll < 0.7 && ladder.length) {
    const step = pick(ladder.slice(1));
    if (!step) return;
    const body = { status: step.key, note: 'Moved on by the department', ...(step.date === 'required' ? { date: inDays(5) } : {}) };
    /* Now and then two people move the same task in the same instant. */
    const moves = [call(`/api/workspace/todos/${task}/status`, { method: 'POST', token: person.token, body, name: 'POST /api/workspace/todos/:id/status' })];
    if (Math.random() < 0.15) moves.push(call(`/api/workspace/todos/${task}/status`, { method: 'POST', token: admin, body, name: 'POST /api/workspace/todos/:id/status' }));
    const answers = await Promise.all(moves);
    if (answers.some((answer) => answer.status === 200 && step.done)) tasks.splice(tasks.indexOf(task), 1);
  } else if (roll < 0.85 && kind === 'invoice_dispatch') {
    await call(`/api/workspace/todos/${task}/ask`, { method: 'POST', token: person.token, body: { kind: 'ask_edd', note: 'When will the goods be ready?' }, name: 'POST /api/workspace/todos/:id/ask' });
  } else {
    await call(`/api/workspace/todos/${task}/update`, { method: 'POST', token: person.token, body: { note: 'Working on it, will update by evening' }, name: 'POST /api/workspace/todos/:id/update' });
  }
}

console.log(`${people.length} people working for ${SECONDS} s…`);
const stopAt = performance.now() + SECONDS * 1000;
let steps = 0;
const rssBefore = stack.rss();
await Promise.all(people.map(async (person) => {
  /* At a working pace people do not all click in the same millisecond: each starts somewhere in the first pause. */
  if (THINK) await new Promise((resolve) => setTimeout(resolve, Math.random() * THINK));
  while (performance.now() < stopAt) {
    await (person.department === 'marketing' ? marketingStep(person) : departmentStep(person));
    steps += 1;
    await pause();
  }
}));
console.log(`  ${steps} steps, ${enquiries.length} enquiries, API memory ${rssBefore} → ${stack.rss()} MB`);

/* Handovers are delivered after the commit; give the last ones a moment. */
const { db } = stack;
for (let i = 0; i < 50 && (await db.collection('outboxes').countDocuments({ status: 'pending' })); i++) await new Promise((r) => setTimeout(r, 200));

console.log('\nWhat came back');
const byStatus = new Map();
for (const [key, count] of statuses) {
  const status = Number(key.split(' ').at(-1));
  byStatus.set(status, (byStatus.get(status) || 0) + count);
}
console.log(`  ${[...byStatus].sort((a, b) => a[0] - b[0]).map(([status, count]) => `${status}: ${count}`).join(' · ')}`);
const refusals = [...statuses].filter(([key]) => Number(key.split(' ').at(-1)) >= 400);
for (const [key, count] of refusals.sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`    ${count} × ${key}`);
  for (const said of reasons.get(key) || []) console.log(`        “${said}”`);
}

console.log('\nTimings (p50 / p95 ms)');
for (const [label, list] of [...timings].sort()) console.log(`  ${label.padEnd(48)} ${String(Math.round(pct(list, 50))).padStart(5)} / ${String(Math.round(pct(list, 95))).padStart(5)}  (${list.length})`);

console.log('\nChecks');
const serverErrors = [...byStatus].filter(([status]) => status >= 500 || status === 0).reduce((sum, [, count]) => sum + count, 0);
check(serverErrors === 0, `no server errors or dropped connections (${serverErrors})`);
check(!stack.exited(), 'the API process is still running');
const odd = [...byStatus].filter(([status]) => status >= 400 && ![400, 403, 404, 409].includes(status));
check(!odd.length, `every refusal is one a person can be shown (${odd.map(([s, c]) => `${s}×${c}`).join(', ') || 'none other'})`);

const dupNumbers = await db.collection('enquiries').aggregate([{ $group: { _id: '$number', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]).toArray();
check(!dupNumbers.length, `no enquiry number used twice (${dupNumbers.length})`);
const dupCustomers = await db.collection('customers').aggregate([{ $match: { mobile: { $exists: true } } }, { $group: { _id: '$mobile', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]).toArray();
check(!dupCustomers.length, `no customer made twice (${dupCustomers.length})`);
const twinTasks = await db.collection('todos').aggregate([
  { $match: { enquiry: { $exists: true }, kind: { $exists: true, $ne: null }, completed: false, holds: { $ne: true } } },
  { $group: { _id: { enquiry: '$enquiry', kind: '$kind' }, n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } },
]).toArray();
check(!twinTasks.length, `no enquiry has two open tasks of one kind (${twinTasks.length})`);
const locks = await db.collection('operationlocks').countDocuments();
check(locks === 0, `no lock left behind (${locks})`);
const [pending, failed] = await Promise.all([
  db.collection('outboxes').countDocuments({ status: 'pending' }),
  db.collection('outboxes').countDocuments({ status: 'failed' }),
]);
check(pending === 0 && failed === 0, `every handover delivered (pending ${pending}, failed ${failed})`);

const writes = [...timings].filter(([label]) => !label.startsWith('GET')).flatMap(([, list]) => list);
const reads = [...timings].filter(([label]) => label.startsWith('GET')).flatMap(([, list]) => list);
check(pct(writes, 95) < 1500, `95% of writes within 1.5 s (${Math.round(pct(writes, 95))} ms)`);
check(pct(reads, 95) < 1000, `95% of reads within 1 s (${Math.round(pct(reads, 95))} ms)`);

const log = stack.log();
const crashes = log.split('\n').filter((line) => /uncaught|unhandled|TypeError|ReferenceError|gave up after/i.test(line));
check(!crashes.length, `no crash or give-up in the API log (${crashes.length})`);
for (const line of crashes.slice(0, 8)) console.log(`    ${line.slice(0, 220)}`);

await stack.stop();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed');
process.exit(0);
