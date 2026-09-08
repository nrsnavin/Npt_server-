/**
 * Quality [§15, stage 7] — the module the blueprint specifies least and the plant relies on most.
 *
 * §15 gives quality one line and a `quality_hold` production status. No field dictionary, no
 * status matrix, no escalation row. So almost everything below is testing a *design decision*
 * rather than a transcribed rule, and each one is named where it is exercised.
 *
 * Four of them carry the module.
 *
 * **An inspection is against a line, never an order.** The same argument that made production
 * per-line: a two-model order is inspected twice, on different days, with different results, and
 * "the order passed" is exactly the sentence that ships a bad model beside a good one.
 *
 * **A rejection sets the hold rather than sitting beside it.** Two records that can disagree
 * about whether goods are fit to send is worse than either alone.
 *
 * **Counts by defect, not a verdict.** Pass/fail can say how much was scrapped and never why —
 * and why is the only thing that fixes anything.
 *
 * **The soft gate is only safe because the override is expensive.** The plant chose warning over
 * refusal; what makes that work is a mandatory reason, a name, and a report. Take away the
 * report and the warning is a dialog people learn to dismiss.
 *
 *   node --test tests/quality.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'quality-test-secret';
/*
 * The strict policy, on for this file only.
 *
 * A consignment nobody inspected warns only when the plant has said pre-dispatch checks are
 * routine — off by default, because a warning that fires on every consignment before then fills
 * the overrides report with everything and tells nobody anything. Set before `app.js` is
 * imported, since `env.js` reads the environment once at load. `dispatch.test.js` leaves it off
 * and is the proof of the other half: nothing there had to explain itself.
 */
process.env.QUALITY_REQUIRE_PRE_DISPATCH = 'true';

let mongo;
let server;
let baseUrl;
let Todo;
let admin;
let priya;      // order confirmation — books and releases
let nandhini;   // marketing — owns the order, hears when quality holds it
let ramesh;     // production — packs it
let kavitha;    // despatch — loads it, and overrides the warning
let sunil;      // quality — owns this module
let customer;
let mould;
let material;
let nandhiniId;

const api = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

const signIn = async (email, password) => {
  const { json } = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  return json.data?.token;
};

const inDays = (days) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
};

const CHECKS = [
  'poReceived', 'correctModel', 'correctColour', 'printingApproved',
  'sampleApproved', 'priceApproved', 'deliveryDateConfirmed', 'packingConfirmed',
];

const booked = async (lines) => {
  const made = await api('/api/orders', {
    method: 'POST', token: priya, body: { customer, assignedTo: nandhiniId, lines },
  });
  assert.equal(made.status, 201, made.json.message);
  return made.json.data;
};

const released = async (lines) => {
  const order = await booked(lines ?? [
    { mould, materialRef: material, modelNumber: 'NH-400', colour: 'White', quantity: 50000, unitPrice: 7.5, deliveryDate: inDays(20) },
  ]);
  for (const check of CHECKS) {
    await api(`/api/orders/${order._id}/checks`, { method: 'POST', token: priya, body: { check } });
  }
  const out = await api(`/api/orders/${order._id}/actions`, {
    method: 'POST', token: priya, body: { action: 'release' },
  });
  assert.equal(out.status, 200, out.json.message);
  return out.json.data;
};

const pack = (order, line, readyQty) =>
  api(`/api/orders/${order._id}/lines/${line._id}/production`, {
    method: 'PATCH', token: ramesh,
    body: { status: 'part_quantity_ready', producedQty: readyQty, readyQty },
  });

const inspect = (order, body, token = sunil) =>
  api(`/api/orders/${order._id}/inspections`, { method: 'POST', token, body });

const PAPERS = {
  invoice: { number: 'INV-2026-0091', date: inDays(0) },
  transporter: 'KPN Roadways',
  lrNumber: 'LR-88213',
  destination: { address: '14 Avinashi Road, Tiruppur', city: 'Tiruppur', state: 'Tamil Nadu' },
};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' },
  });
  admin = await signIn('admin@np.com', 'Admin@12345');

  for (const person of [
    { name: 'Priya Orders', email: 'priya@np.com', password: 'Orders@1234', department: 'order_confirmation' },
    { name: 'Nandhini S', email: 'nandhini@np.com', password: 'Mktg@123456', department: 'marketing' },
    { name: 'Ramesh Plant', email: 'ramesh@np.com', password: 'Prod@123456', department: 'production' },
    { name: 'Kavitha D', email: 'kavitha@np.com', password: 'Desp@123456', department: 'despatch' },
    { name: 'Sunil Quality', email: 'sunil@np.com', password: 'Qual@123456', department: 'quality' },
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: person });
  }
  priya = await signIn('priya@np.com', 'Orders@1234');
  nandhini = await signIn('nandhini@np.com', 'Mktg@123456');
  ramesh = await signIn('ramesh@np.com', 'Prod@123456');
  kavitha = await signIn('kavitha@np.com', 'Desp@123456');
  sunil = await signIn('sunil@np.com', 'Qual@123456');
  nandhiniId = (await api('/api/auth/me', { token: nandhini })).json.data.id;

  mould = (
    await api('/api/moulds', {
      method: 'POST', token: admin,
      body: {
        mouldCode: 'M-NH-400', name: 'Shirt hanger 400mm', category: 'shirt', sizeMm: 400,
        material: 'pp', cavities: 4, partWeightGrams: 26, cycleTimeSeconds: 28,
      },
    })
  ).json.data._id;

  material = (
    await api('/api/materials', {
      method: 'POST', token: admin,
      body: { name: 'HIPS White', code: 'HIPS-W', type: 'hips', colour: 'White', ratePerKg: 92 },
    })
  ).json.data._id;

  customer = (
    await api('/api/customers', {
      method: 'POST', token: nandhini, body: { name: 'Sri Kumaran Knits', mobile: '9840011223' },
    })
  ).json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------ Recording one ------------------------------ */

test('an inspection is written against a line, and copies the tool it was run on', async () => {
  const order = await released();
  const line = order.lines[0];

  const { status, json } = await inspect(order, {
    line: line._id, stage: 'final', verdict: 'passed',
    quantityInspected: 500, quantityRejected: 0,
  });

  assert.equal(status, 201, json.message);
  assert.match(json.data.number, /^QC-\d{4}-\d{4}$/);
  assert.equal(String(json.data.line), String(line._id));

  /*
   * The tool and the resin are copied rather than joined, and that is the field that makes every
   * report possible: "which mould is making scrap" is what sends somebody to a press. Copied
   * because a line's mould can be corrected later, and an inspection is a statement about what
   * was on the machine that day.
   */
  assert.equal(json.data.mould?.mouldCode, 'M-NH-400');
  assert.equal(json.data.materialRef?.code, 'HIPS-W');
  assert.equal(json.data.quantityPassed, 500);
});

test('a line from another order is refused rather than quietly attached', async () => {
  const mine = await released();
  const theirs = await released();

  const { status, json } = await inspect(mine, {
    line: theirs.lines[0]._id, stage: 'final', verdict: 'passed', quantityInspected: 100,
  });

  assert.equal(status, 400);
  assert.match(json.message, /not on this order/i);
});

test('nothing can be inspected before the order is released', async () => {
  /* An order still being verified may have its lines changed, so an inspection against one is a
     statement about a quantity that can still become a different quantity. */
  const order = await booked([
    { mould, modelNumber: 'NH-400', quantity: 10000, unitPrice: 7.5 },
  ]);

  const { status, json } = await inspect(order, {
    line: order.lines[0]._id, stage: 'final', verdict: 'passed', quantityInspected: 100,
  });

  assert.equal(status, 400);
  assert.match(json.message, /not been released/i);
});

test('a rejection has to say what was wrong with them', async () => {
  /*
   * The record that would make every report useless — and the person filling it in is the one
   * person in the building who knows the answer.
   */
  const order = await released();
  const { status, json } = await inspect(order, {
    line: order.lines[0]._id, stage: 'final', verdict: 'passed_with_deviation',
    quantityInspected: 1000, quantityRejected: 40,
  });

  assert.equal(status, 400);
  assert.match(json.message, /say what was wrong/i);
});

test('more rejected than inspected is refused', async () => {
  const order = await released();
  const { status } = await inspect(order, {
    line: order.lines[0]._id, stage: 'final', verdict: 'rejected',
    quantityInspected: 100, quantityRejected: 400,
    defects: [{ type: 'flash', count: 400 }],
  });
  assert.equal(status, 400);
});

test('defect counts may sum above the reject count, because one piece carries two faults', async () => {
  /*
   * Deliberately allowed. Enforcing equality would either double-count the piece or forbid
   * recording the second fault — and the second fault is exactly what a Pareto needs.
   */
  const order = await released();
  const { status, json } = await inspect(order, {
    line: order.lines[0]._id, stage: 'final', verdict: 'passed_with_deviation',
    quantityInspected: 2000, quantityRejected: 30,
    defects: [{ type: 'short_shot', count: 30 }, { type: 'flash', count: 12 }],
  });

  assert.equal(status, 201, json.message);
  assert.equal(json.data.quantityRejected, 30);
  assert.equal(json.data.rejectionPercent, 1.5);
});

/* --------------------------- What a verdict does --------------------------- */

test('a rejection stops the line and tells marketing, in one action', async () => {
  const order = await released();
  const line = order.lines[0];

  const { status, json } = await inspect(order, {
    line: line._id, stage: 'final', verdict: 'rejected',
    quantityInspected: 5000, quantityRejected: 900,
    defects: [{ type: 'weak_hook', count: 900 }],
    remarks: 'Hooks pulling out of the shoulder on the whole lot',
  });

  assert.equal(status, 201, json.message);
  assert.equal(json.heldLine, true);

  /*
   * The hold is *set*, not left for somebody to also set. Two records that can disagree about
   * whether goods are fit to send is worse than either alone, and the one that loses is always
   * the one somebody forgot.
   */
  const after = await api(`/api/orders/${order._id}`, { token: ramesh });
  assert.equal(after.json.data.lines[0].production.status, 'quality_hold');
  assert.match(after.json.data.lines[0].production.holdReason, /900 of 5000 rejected/);

  /*
   * And the person who has to ring the buyer is told. They are not standing at the bench, and a
   * held lot they learn about on the delivery date is one they can do nothing about.
   */
  const told = await Todo.findOne({ originKey: `quality-hold:${json.data._id}` });
  assert.ok(told, 'marketing was not told');
  assert.equal(String(told.user), String(nandhiniId));
  assert.match(told.notes, /weak hook/);
  assert.equal(told.priority, 'high');
});

test('a passed re-inspection releases a line an earlier rejection held', async () => {
  /*
   * The latest verdict wins. A lot rejected on Monday and re-inspected on Wednesday after the
   * rejects were pulled is a passed lot — a system that remembered only the failure would hold
   * it forever.
   */
  const order = await released();
  const line = order.lines[0];

  await inspect(order, {
    line: line._id, stage: 'final', verdict: 'rejected',
    quantityInspected: 3000, quantityRejected: 200,
    defects: [{ type: 'sink_mark', count: 200 }],
  });

  const { json } = await api(`/api/orders/${order._id}/inspections`, { token: sunil });
  assert.equal(json.lines[0].held, true);

  await inspect(order, {
    line: line._id, stage: 'final', verdict: 'passed_with_deviation',
    quantityInspected: 2800, quantityRejected: 0,
  });

  const after = await api(`/api/orders/${order._id}/inspections`, { token: sunil });
  assert.equal(after.json.lines[0].held, false, 'the newer verdict stands');
  /* And the history is kept whole — losing that it ever failed would be the other failure. */
  assert.equal(after.json.lines[0].inspections, 2);
  assert.equal(after.json.lines[0].rejected, 200);
});

/* ------------------------------ The soft gate ------------------------------ */

const readyConsignment = async () => {
  const order = await released();
  const line = order.lines[0];
  await pack(order, line, 20000);

  const raised = await api('/api/dispatches', {
    method: 'POST', token: kavitha,
    body: { order: order._id, lines: [{ orderLine: line._id, quantity: 20000 }], ...PAPERS },
  });
  assert.equal(raised.status, 201, raised.json.message);
  return { order, line, dispatch: raised.json.data };
};

test('dispatching an unchecked consignment warns, and says what to do about it', async () => {
  const { dispatch } = await readyConsignment();

  const { status, json } = await api(`/api/dispatches/${dispatch._id}/actions`, {
    method: 'POST', token: kavitha, body: { action: 'dispatch' },
  });

  /* 409 rather than 400: this is not a malformed request, it is a correct one that needs a
     second, deliberate press with an answer attached — and a screen can tell those apart. */
  assert.equal(status, 409, json.message);
  assert.match(json.message, /Nobody has inspected this consignment/);
  assert.match(json.message, /say why/);
  assert.equal(json.details?.needs, 'qualityOverrideReason');
});

test('a one-word reason does not clear the warning', async () => {
  // The override has to cost something, or it is a dialog people learn to dismiss.
  const { dispatch } = await readyConsignment();

  const { status } = await api(`/api/dispatches/${dispatch._id}/actions`, {
    method: 'POST', token: kavitha,
    body: { action: 'dispatch', qualityOverrideReason: 'ok' },
  });
  assert.equal(status, 409);
});

test('it goes with a reason, and the reason is kept with a name against it', async () => {
  const { dispatch } = await readyConsignment();

  const { status, json } = await api(`/api/dispatches/${dispatch._id}/actions`, {
    method: 'POST', token: kavitha,
    body: {
      action: 'dispatch',
      qualityOverrideReason: 'Buyer inspected at our gate and accepted the lot themselves',
    },
  });

  assert.equal(status, 200, json.message);
  assert.equal(json.data.status, 'dispatched');
  assert.match(json.data.qualityOverride.reason, /accepted the lot/);
  assert.match(json.data.qualityOverride.concern, /Nobody has inspected/);
  assert.ok(json.data.qualityOverride.by);
  assert.ok(json.data.qualityOverride.at);
});

test('a passed pre-dispatch check lets it go with nothing to explain', async () => {
  const { order, line, dispatch } = await readyConsignment();

  await inspect(order, {
    line: line._id, stage: 'pre_dispatch', dispatch: dispatch._id,
    verdict: 'passed', quantityInspected: 800, quantityRejected: 0,
  });

  const { status, json } = await api(`/api/dispatches/${dispatch._id}/actions`, {
    method: 'POST', token: kavitha, body: { action: 'dispatch' },
  });

  assert.equal(status, 200, json.message);
  assert.equal(json.data.qualityOverride?.by, undefined, 'nothing was overridden');
});

test('a pre-dispatch rejection does not hold the production line', async () => {
  /*
   * The two questions are genuinely different. "Is what we made any good" is answered against
   * the line; "is what is about to go out any good" is answered against the lorry, and a lot
   * packed three weeks ago and stored badly can fail the second having passed the first.
   * Holding the run for it would stop goods that were never in question.
   */
  const { order, line, dispatch } = await readyConsignment();

  await inspect(order, {
    line: line._id, stage: 'pre_dispatch', dispatch: dispatch._id,
    verdict: 'rejected', quantityInspected: 600, quantityRejected: 90,
    defects: [{ type: 'surface_damage', count: 90 }],
  });

  const after = await api(`/api/orders/${order._id}`, { token: ramesh });
  assert.notEqual(after.json.data.lines[0].production.status, 'quality_hold');

  /* But it does warn despatch, which is the point of having checked. */
  const tried = await api(`/api/dispatches/${dispatch._id}/actions`, {
    method: 'POST', token: kavitha, body: { action: 'dispatch' },
  });
  assert.equal(tried.status, 409);
  assert.match(tried.json.message, /rejected this consignment/);
});

test('a pre-dispatch check has to name a consignment carrying that line', async () => {
  const { order, line } = await readyConsignment();
  const elsewhere = await readyConsignment();

  const missing = await inspect(order, {
    line: line._id, stage: 'pre_dispatch', verdict: 'passed', quantityInspected: 100,
  });
  assert.equal(missing.status, 400);
  assert.match(missing.json.message, /which consignment/i);

  const wrong = await inspect(order, {
    line: line._id, stage: 'pre_dispatch', dispatch: elsewhere.dispatch._id,
    verdict: 'passed', quantityInspected: 100,
  });
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.message, /not on this order/i);
});

/* -------------------------------- Reporting -------------------------------- */

test('the report ranks tools by rejection rate, not by how much they made', async () => {
  /*
   * A tool that made ten thousand and scrapped four hundred is worse than one that made a
   * million and scrapped a thousand. Sorting by volume puts the big run on top every time and
   * hides exactly the tool somebody should go and look at.
   */
  const { json } = await api('/api/quality/report', { token: sunil });

  assert.equal(typeof json.meta.rejectionPercent, 'number');
  assert.ok(json.meta.inspections > 0);

  const rates = json.data.byMould.map((row) => row.rejectionPercent);
  assert.deepEqual(rates, [...rates].sort((a, b) => b - a));
});

test('the Pareto counts defects, and the cost of rejection is priced off the order', async () => {
  const { json } = await api('/api/quality/report', { token: sunil });

  assert.ok(json.data.byDefect.length, 'no defects recorded');
  const counts = json.data.byDefect.map((row) => row.count);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a), 'the Pareto is not sorted');

  /* Labelled and grouped off the model's own list, so a report and a form cannot disagree
     about what a defect is called. */
  assert.ok(json.data.byDefect[0].label);
  assert.ok(json.data.byDefect[0].group);

  /* The number management reacts to: rejected pieces at the rate they would have sold for. */
  assert.ok(json.meta.costOfRejection > 0);
});

test('overrides are their own report, which is what makes a soft gate honest', async () => {
  const { json } = await api('/api/quality/overrides', { token: sunil });

  assert.ok(json.meta.overrides >= 1, 'nothing was recorded as overridden');
  const row = json.data[0];
  assert.ok(row.reason, 'an override with no reason');
  assert.ok(row.by, 'an override with no name');
  assert.ok(row.concern, 'an override that does not say what was wrong at the time');
});

test('with the policy off, an uninspected consignment goes without explaining itself', async () => {
  /*
   * The default, tested directly against the service because the endpoint reads the flag once at
   * boot. This is the half that keeps the module adoptable: switched on before pre-dispatch
   * checks are routine, every consignment would warn and the overrides report — the one thing
   * that makes a soft gate honest — would contain a hundred percent of consignments.
   */
  const { dispatchQuality } = await import('../src/services/quality.service.js');
  const { dispatch } = await readyConsignment();

  const relaxed = await dispatchQuality(dispatch._id, { requireCheck: false });
  assert.equal(relaxed.checked, false);
  assert.equal(relaxed.passed, true, 'nothing to answer for');
  assert.equal(relaxed.concern, null);

  const strict = await dispatchQuality(dispatch._id, { requireCheck: true });
  assert.equal(strict.passed, false);
  assert.match(strict.concern, /Nobody has inspected/);
});

test('the vocabulary comes from the server, so a form cannot invent a defect', async () => {
  const { json } = await api('/api/quality/options', { token: sunil });

  assert.ok(json.data.defects.length > 10);
  assert.ok(json.data.stages.length === 3);
  assert.ok(json.data.verdicts.length === 3);
  /* Every defect carries the group a Pareto reads, and a hint an inspector can recognise it by. */
  for (const defect of json.data.defects) {
    assert.ok(defect.key && defect.label && defect.group && defect.hint, `${defect.key} is incomplete`);
  }
});

test('the inspection register is scoped to the orders a marketing reader owns', async () => {
  /*
   * The one door in this module that leaked. The report and the overrides both resolved §29's
   * ownership through the orders behind an inspection; the register did not, so a marketing
   * person opening it saw every inspection in the building — their colleagues' customers
   * included. Found by counting rows on the seeded screen against the three the same person
   * sees on the chase list beside it.
   *
   * A second marketing person with an order of their own is what makes this assertable: with
   * one owner every scope looks correct.
   */
  const madeUser = await api('/api/users', {
    method: 'POST', token: admin,
    body: {
      name: 'Arun K', email: 'arun-quality@np.com', password: 'Mktg@654321',
      department: 'marketing',
    },
  });
  assert.equal(madeUser.status, 201, madeUser.json?.message);
  const arunId = madeUser.json.data._id || madeUser.json.data.id;

  const made = await api('/api/orders', {
    method: 'POST', token: priya,
    body: {
      customer, assignedTo: arunId,
      lines: [{
        mould, materialRef: material, modelNumber: 'NH-410', colour: 'Grey',
        quantity: 20000, unitPrice: 8, deliveryDate: inDays(25),
      }],
    },
  });
  assert.equal(made.status, 201, made.json.message);
  const theirs = made.json.data;

  for (const check of CHECKS) {
    await api(`/api/orders/${theirs._id}/checks`, { method: 'POST', token: priya, body: { check } });
  }
  await api(`/api/orders/${theirs._id}/actions`, {
    method: 'POST', token: priya, body: { action: 'release' },
  });

  const seen = await inspect(theirs, {
    line: theirs.lines[0]._id, stage: 'final',
    quantityInspected: 500, quantityRejected: 0, verdict: 'passed',
  });
  assert.equal(seen.status, 201, seen.json?.message);

  const mine = await api('/api/quality', { token: nandhini });
  assert.equal(mine.status, 200, mine.json?.message);

  const orders = new Set(mine.json.data.map((row) => String(row.order?._id || row.order)));
  assert.ok(!orders.has(String(theirs._id)), "one marketing reader can see another's inspections");

  /* And naming the order directly is not a way round it. */
  const direct = await api(`/api/quality?order=${theirs._id}`, { token: nandhini });
  assert.equal(direct.status, 200);
  assert.equal(direct.json.data.length, 0, 'naming the order defeated the scope');

  /* The bench itself is not scoped — quality inspects for the whole plant. */
  const bench = await api('/api/quality', { token: sunil });
  const benchOrders = new Set(bench.json.data.map((row) => String(row.order?._id || row.order)));
  assert.ok(benchOrders.has(String(theirs._id)), 'quality cannot see an order it inspected');
});
