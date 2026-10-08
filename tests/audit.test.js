/**
 * Gaps found auditing the pipeline and sampling modules.
 *
 * Each test states a rule the modules should already hold to. They were written to fail
 * first, so the fix is demonstrated rather than asserted.
 *
 *   node --test tests/audit.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { withEnquiries } from './support/onEnquiry.js';

process.env.JWT_SECRET = 'audit-test-secret-value';

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;   // marketing
let priya;      // marketing — a colleague
let meera;      // sampling
let mouldId;

const rawApi = async (path, { method = 'GET', body, token } = {}) => {
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

/**
 * Who a token belongs to.
 *
 * Creating a customer names its owner now, rather than inheriting whoever posted the
 * request — see `assertCanOwnBuyer`. These fixtures always meant "the person making this call
 * owns it", which is what they relied on the old default for; this says it out loud.
 */
const tokenOwnerId = async (token) => (await api('/api/auth/me', { token })).json.data.id;

const signIn = async (email, password) => {
  const { json } = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  return json.data?.token;
};

const soon = (days = 3) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
};

const followUp = { nextAction: 'Call the buyer', nextFollowUpDate: soon() };
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

const requirement = (extra = {}) => ({
  modelNumber: 'NPT-400S',
  category: 'shirt',
  quantity: 5000,
  ...extra,
});

let sequence = 0;
const unique = () => (sequence += 1);

async function makeCustomer(token, extra = {}) {
  const n = unique();
  const { json } = await api('/api/customers', {
    method: 'POST',
    token,
    body: { assignedTo: await tokenOwnerId(token), name: `Buyer ${n}`, mobile: `98765${String(100000 + n).slice(-5)}`, ...extra },
  });
  return json.data;
}

async function makeEnquiry(token, customerId, extra = {}) {
  const { json } = await api('/api/enquiries', {
    method: 'POST',
    token,
    body: { customer: customerId, mould: mouldId, requirement: requirement(), ...followUp, ...extra },
  });
  return json.data;
}

/* Samples, costings, quotations and orders are raised on an enquiry — see tests/support/onEnquiry.js. */
const api = withEnquiries(rawApi);

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' },
  });
  admin = await signIn('admin@np.com', 'Admin@12345');

  for (const [name, email, department, password] of [
    ['Nandhini S', 'nandhini@np.com', 'marketing', 'Mktg@123456'],
    ['Priya R', 'priya@np.com', 'marketing', 'Mktg@123456'],
    ['Meera S', 'meera@np.com', 'sampling', 'Samp@123456'],
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: { name, email, password, department } });
  }

  nandhini = await signIn('nandhini@np.com', 'Mktg@123456');
  priya = await signIn('priya@np.com', 'Mktg@123456');
  meera = await signIn('meera@np.com', 'Samp@123456');

  const madeMould = await api('/api/moulds', {
    method: 'POST',
    token: admin,
    body: {
      mouldCode: 'M-NPT-400S', name: 'Shirt Hanger 400mm', category: 'shirt', sizeMm: 400, material: 'plastic',
      /* Measured facts, which the register will not take a model without. */
      cavities: 4, partWeightGrams: 26, cycleTimeSeconds: 28, moq: 5000,
    },
  });
  mouldId = madeMould.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('a group that fails half way creates none of its enquiries', async () => {
  const customer = await makeCustomer(nandhini);

  const { status } = await api('/api/enquiries/group', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customer._id,
      shared: followUp,
      enquiries: [
        { mould: mouldId, requirement: requirement({ modelNumber: 'A' }) },
        // Nothing that says what was asked for — no mould, no model number, no development
        // flag — so this one is refused, and the first must not survive it.
        { requirement: requirement({ modelNumber: undefined }) },
      ],
    },
  });
  assert.equal(status, 400);

  const after = await api(`/api/enquiries?customer=${customer._id}`, { token: nandhini });
  assert.equal(after.json.data.length, 0, 'a partial group is worse than none');
});

/* --------------------------- Ownership on every route --------------------------- */

test('ownership holds on sample writes, not just reads', async () => {
  // Marketing does not normally hold samples write; an admin can grant it, and then the
  // record-level rule has to hold on the write routes too.
  const users = await api('/api/users?search=priya', { token: admin });
  const priyaId = users.json.data[0].id;
  await api(`/api/users/${priyaId}/access`, {
    method: 'PUT',
    token: admin,
    body: {
      moduleAccess: [
        { module: 'samples', level: 'write' },
        { module: 'enquiries', level: 'write' },
        { module: 'customers', level: 'write' },
      ],
    },
  });
  const priyaWithSamples = await signIn('priya@np.com', 'Mktg@123456');

  const customer = await makeCustomer(nandhini);
  const enquiry = await makeEnquiry(nandhini, customer._id);
  await api(`/api/enquiries/${enquiry._id}/status`, {
    method: 'POST',
    token: nandhini,
    body: { status: 'sample_required', ...followUp },
  });
  await settle();

  const list = await api(`/api/samples?enquiry=${enquiry._id}`, { token: meera });
  const sample = list.json.data[0];
  assert.ok(sample, 'the automation should have raised one');

  for (const [label, path, body] of [
    ['status', `/api/samples/${sample._id}/status`, { status: 'checking_stock' }],
    ['assign', `/api/samples/${sample._id}/assign`, {}],
    ['edit', `/api/samples/${sample._id}`, { colour: 'Hijacked' }],
  ]) {
    const { status } = await api(path, {
      method: label === 'edit' ? 'PATCH' : 'POST',
      token: priyaWithSamples,
      body,
    });
    assert.equal(status, 404, `a colleague's sample should not be reachable to ${label}`);
  }
});

test('a sample cannot be raised against a colleague’s enquiry', async () => {
  const customer = await makeCustomer(nandhini);
  const enquiry = await makeEnquiry(nandhini, customer._id);

  const { status } = await api('/api/samples', {
    method: 'POST',
    token: await signIn('priya@np.com', 'Mktg@123456'),
    body: { enquiry: enquiry._id },
  });
  assert.equal(status, 404);
});

/* ----------------------- Closing an enquiry closes its work ----------------------- */

test('losing an enquiry takes its open sample off the bench', async () => {
  const customer = await makeCustomer(nandhini);
  const enquiry = await makeEnquiry(nandhini, customer._id);
  await api(`/api/enquiries/${enquiry._id}/status`, {
    method: 'POST',
    token: nandhini,
    body: { status: 'sample_required', ...followUp },
  });
  await settle();

  const before = await api(`/api/samples?enquiry=${enquiry._id}`, { token: meera });
  const sample = before.json.data[0];
  assert.equal(sample.status, 'request_received');

  await api(`/api/enquiries/${enquiry._id}/status`, {
    method: 'POST',
    token: nandhini,
    body: { status: 'lost', lostReason: 'price' },
  });
  await settle();

  const after = await api(`/api/samples/${sample._id}`, { token: meera });
  assert.equal(
    after.json.data.status,
    'cancelled',
    'the bench must not keep making a sample for a dead enquiry'
  );

  const open = await api('/api/samples?open=true', { token: meera });
  assert.ok(!open.json.data.some((row) => row._id === sample._id));
});

/* ------------------------------ The shared queue ------------------------------ */

test('a sample can be handed back to the queue', async () => {
  const customer = await makeCustomer(nandhini);
  const enquiry = await makeEnquiry(nandhini, customer._id);
  await api(`/api/enquiries/${enquiry._id}/status`, {
    method: 'POST',
    token: nandhini,
    body: { status: 'sample_required', ...followUp },
  });
  await settle();

  const list = await api(`/api/samples?enquiry=${enquiry._id}`, { token: meera });
  const sample = list.json.data[0];

  await api(`/api/samples/${sample._id}/assign`, { method: 'POST', token: meera, body: {} });

  const released = await api(`/api/samples/${sample._id}/assign`, {
    method: 'POST',
    token: meera,
    body: { assignedTo: null },
  });
  assert.equal(released.status, 200);
  assert.equal(released.json.data.assignedTo, null, 'picking something up must be reversible');

  const queue = await api('/api/samples?unassigned=true', { token: meera });
  assert.ok(queue.json.data.some((row) => row._id === sample._id));
});

test('management is not queued the bench’s own work', async () => {
  const customer = await makeCustomer(nandhini);
  const enquiry = await makeEnquiry(nandhini, customer._id);
  await api(`/api/enquiries/${enquiry._id}/status`, {
    method: 'POST',
    token: nandhini,
    body: { status: 'sample_required', ...followUp },
  });
  await settle();

  // The admin is the MD. Being able to do everything is not a reason to be told to do it.
  const adminTasks = await api('/api/workspace/todos', { token: admin });
  assert.ok(
    !adminTasks.json.data.some((todo) => todo.title.startsWith('Prepare sample')),
    'an admin should not be handed the sample team’s queue'
  );

  const benchTasks = await api('/api/workspace/todos', { token: meera });
  assert.ok(benchTasks.json.data.some((todo) => todo.title.startsWith('Prepare sample')));
});

/* --------------------------- Reassignment is management --------------------------- */

test('only an administrator can move a customer to someone else', async () => {
  const customer = await makeCustomer(nandhini);
  const users = await api('/api/users?search=priya', { token: admin });
  const priyaId = users.json.data[0].id;

  const bySelf = await api(`/api/customers/${customer._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { assignedTo: priyaId },
  });
  assert.equal(bySelf.status, 403, 'giving a relationship away is a management decision');

  const byAdmin = await api(`/api/customers/${customer._id}`, {
    method: 'PATCH',
    token: admin,
    body: { assignedTo: priyaId },
  });
  assert.equal(byAdmin.status, 200);
});

/* ------------------------ The duplicate check and ownership ------------------------ */

test('the duplicate check warns without handing over a colleague’s record', async () => {
  await makeCustomer(nandhini, { name: 'Confidential Mills', gstin: '33AABCC9999X1ZQ' });

  const { json } = await api('/api/customers/check-duplicate?gstin=33AABCC9999X1ZQ', {
    token: priya,
  });

  // Priya must be told the record exists — otherwise she creates a second one — but the
  // name, code and id belong to Nandhini's relationship.
  assert.equal(json.data.duplicate, true);
  assert.equal(json.data.customer, undefined, 'a colleague’s record must not be handed over');
  assert.equal(json.data.owner, 'Nandhini S', 'say who to talk to instead');
});

/* ------------------ The handover chain [§C.1, §5, §6] ------------------ */

test('the automated route into pricing raises the same handover as the manual one', async () => {
  // §C.1 is the whole point of the CRM: completing a stage creates the next department's
  // task. Marketing moving an enquiry to pricing publishes the handover event; the sample
  // team approving a sample moves the same enquiry to the same status through a different
  // code path. If only one of them announces it, half the plant's work never reaches
  // pricing — and the half that goes missing is the half nobody typed by hand.
  const { EVENTS, subscribe, unsubscribe } = await import('../src/services/events.service.js');

  const seen = [];
  const listener = ({ enquiry }) => seen.push(String(enquiry._id));
  subscribe(EVENTS.ENQUIRY_PRICING_REQUIRED, listener);

  try {
    const customer = await makeCustomer(nandhini);
    const enquiry = await makeEnquiry(nandhini, customer._id);

    await api(`/api/enquiries/${enquiry._id}/status`, {
      method: 'POST',
      token: nandhini,
      body: { status: 'sample_required', ...followUp },
    });
    await settle();

    const { json: samples } = await api(`/api/samples?enquiry=${enquiry._id}`, { token: meera });
    const sample = samples.data[0];
    assert.ok(sample, 'the enquiry raised a sample');

    for (const status of ['sample_ready', 'dispatched']) {
      await api(`/api/samples/${sample._id}/status`, {
        method: 'POST',
        token: meera,
        body: { status, courier: 'Blue Dart', awbNumber: '77219900001', dispatchedQuantity: 5 },
      });
    }
    await settle();

    await api(`/api/samples/${sample._id}/feedback`, {
      method: 'POST',
      token: nandhini,
      body: { outcome: 'approved', note: 'Buyer approved.' },
    });
    await settle();

    const { json: after } = await api(`/api/enquiries/${enquiry._id}`, { token: nandhini });
    assert.equal(after.data.status, 'pricing_required', 'the enquiry did move');
    assert.ok(
      seen.includes(String(enquiry._id)),
      'and said so — otherwise pricing hears nothing when Phase 3 lands'
    );
  } finally {
    unsubscribe(EVENTS.ENQUIRY_PRICING_REQUIRED, listener);
  }
});

test('a request raised by hand queues the bench, exactly as an automated one does', async () => {
  // Manual entry is the primary path [§8] and permanent. A counter request that lands in
  // nobody's list is the black hole the automation exists to close — and it is worse than
  // the automated case, because there is no enquiry sitting anywhere to notice it either.
  const customer = await makeCustomer(nandhini);

  const raised = await api('/api/samples', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customer._id,
      modelNumber: 'NPT-400S',
      quantity: 4,
      standaloneReason: 'Asked for one at the counter',
    },
  });
  assert.equal(raised.status, 201);
  await settle();

  const { json: bench } = await api('/api/workspace/todos', { token: meera });
  const queued = bench.data.filter((todo) => todo.link === `/samples/${raised.json.data._id}`);

  assert.ok(queued.length, 'the sample team was told there is a sample to make');
  assert.match(queued[0].title, new RegExp(raised.json.data.number));
});

test('reaching pricing queues someone to do the pricing', async () => {
  // §5 and §41.8. The pricing module is Phase 3; the handover is §C.1 and is due now, or
  // every enquiry that reached pricing before Phase 3 landed is one nobody was ever told about.
  const customer = await makeCustomer(nandhini);
  const enquiry = await makeEnquiry(nandhini, customer._id, { targetPrice: 7.2 });

  await api(`/api/enquiries/${enquiry._id}/status`, {
    method: 'POST',
    token: nandhini,
    body: { status: 'pricing_required', ...followUp },
  });
  await settle();

  // No costing team here, so it falls to management — the arrangement §7 describes.
  const { json } = await api('/api/workspace/todos', { token: admin });
  const queued = json.data.filter((todo) => todo.link === `/enquiries/${enquiry._id}`);

  assert.ok(queued.length, 'somebody was asked to price it');
  assert.match(queued[0].title, new RegExp(enquiry.number));
  assert.match(queued[0].notes, /target/, "and told what the buyer is asking");
});

test('a customer’s timeline carries its samples, not only its enquiries', async () => {
  // §2: opening a customer must show the whole story in one place. Sending marketing back to
  // the bench to ask where a sample is, is the phone call §40 measures this CRM on removing.
  const customer = await makeCustomer(nandhini);
  const enquiry = await makeEnquiry(nandhini, customer._id);

  await api(`/api/enquiries/${enquiry._id}/status`, {
    method: 'POST',
    token: nandhini,
    body: { status: 'sample_required', ...followUp },
  });
  await settle();

  const { json } = await api(`/api/customers/${customer._id}`, { token: nandhini });
  const { samples, sampleTotal } = json.data.timeline;

  assert.ok(Array.isArray(samples), 'the timeline has a samples strand');
  assert.equal(samples.length, 1);
  assert.equal(sampleTotal, 1);
  assert.match(samples[0].number, /^SMP-/);
  assert.ok(samples[0].status, 'and says where it has got to');
});

/* ---------------- Gaps §8 asked to be closed before WhatsApp ---------------- */

test('a buyer arriving with nobody attached goes round the marketing team', async () => {
  /*
   * §41.3, and §8 is explicit that it is a marketing-team rule rather than a WhatsApp one.
   *
   * Tested through the service rather than through the form, because the form no longer asks it
   * this question: a person filling one in names the owner. The rotation is the *front-door*
   * rule now — the WhatsApp number nobody recognises, the IndiaMART enquiry that lands at two in
   * the morning. There is nobody to ask on either, so something still has to choose, and this is
   * the call both of them make.
   */
  const { ownerForNewBuyer } = await import('../src/services/intake.service.js');

  const owners = [];
  for (let index = 0; index < 4; index += 1) {
    owners.push(String((await ownerForNewBuyer(null)).user));
  }

  assert.ok(new Set(owners).size > 1, 'they did not all land on one person');
  assert.ok(
    owners[0] !== owners[1],
    'consecutive buyers go to different people — that is what round-robin means'
  );
  // Two marketing people here, so the third is back with the first.
  assert.equal(owners[0], owners[2]);
  assert.equal(owners[1], owners[3]);

  // Never an administrator: they hold every grant, but they are not on the marketing rota.
  const { json: me } = await api('/api/auth/me', { token: admin });
  assert.ok(!owners.includes(String(me.data.id)));
});

test('creating a customer without naming an owner is refused, not guessed', async () => {
  /*
   * The form asks, and a request that does not answer is refused rather than filled in. The
   * owner is the most consequential field on the screen: under §29 it decides whose list the
   * buyer appears on and who can see them at all.
   */
  const silent = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: `Unowned ${unique()}`, mobile: `96543${String(400000 + unique()).slice(-5)}` },
  });

  assert.equal(silent.status, 400, silent.json.message);
  assert.match(JSON.stringify(silent.json), /assignedTo/, 'and it says which field is missing');
});

test('somebody in marketing may name themselves, which is the ordinary case', async () => {
  const { json: me } = await api('/api/auth/me', { token: nandhini });
  const customer = await makeCustomer(nandhini);
  assert.equal(String(customer.assignedTo), String(me.data.id));
});

test('a record with no conversation behind it is the normal case', async () => {
  // §8: an enquiry with no thread is not a defect, and must never be required.
  const customer = await makeCustomer(nandhini);
  const enquiry = await makeEnquiry(nandhini, customer._id);

  assert.equal(enquiry.conversation, undefined);
});

test('naming the first owner is not a reassignment', async () => {
  /*
   * The old rule: only an administrator could name an owner on create, because handing a buyer to
   * a colleague was refused by PATCH and allowed by POST, so anybody could do in one step what
   * they were forbidden from doing in two.
   *
   * That reasoning is about a *reassignment* — taking a record off the person who has been
   * working it, which is a management decision and which `updateCustomer` still refuses. It does
   * not apply to a customer being created, because there is no owner yet to take it from. Somebody in
   * marketing writing up an enquiry for the colleague whose account it is was being refused for
   * a rule that was not about them.
   */
  const users = await api('/api/users?search=priya', { token: admin });
  const priyaId = users.json.data[0].id;

  const placed = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: {
      name: `Handover Test ${unique()}`,
      mobile: `96543${String(200000 + unique()).slice(-5)}`,
      assignedTo: priyaId,
    },
  });
  assert.equal(placed.status, 201, placed.json.message);
  assert.equal(String(placed.json.data.assignedTo), String(priyaId));

  /*
   * And she cannot take it back — 404 rather than 403, which is worth spelling out because it is
   * the consequence the form warns about before she picks. Under §29 the customer is Priya's now,
   * so it is not on Nandhini's screens at all; the reassignment rule never even gets asked,
   * because as far as she is concerned the record does not exist. `updateCustomer` still holds
   * that rule for a customer she *can* see — tested above, under its own name.
   */
  const takeBack = await api(`/api/customers/${placed.json.data._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { assignedTo: (await api('/api/auth/me', { token: nandhini })).json.data.id },
  });
  assert.equal(takeBack.status, 404, 'handed over means out of sight, not merely read-only');
});

test('a sample raised by hand against an enquiry keeps that enquiry’s customer', async () => {
  // The request body names no customer, because the enquiry already knows who it is for.
  // Passing the absent value through anyway overwrote the inherited one, and a sample with
  // no customer is not a cosmetic gap: §6 and §42 tell the customer when it is ready and
  // when it goes out, and there is nobody to tell. It fails silently, on the path a person
  // uses rather than the automated one.
  const customer = await makeCustomer(nandhini);
  const enquiry = await makeEnquiry(nandhini, customer._id);

  const { status, json } = await api('/api/samples', {
    method: 'POST',
    token: nandhini,
    body: { enquiry: enquiry._id, quantity: 6 },
  });

  assert.equal(status, 201);
  assert.equal(
    String(json.data.customer?._id || json.data.customer),
    String(customer._id),
    'the sample knows who it is for'
  );

  // Which is what makes the customer reachable at all.
  const preview = await api(`/api/samples/${json.data._id}/customer-message/preview?event=sample_ready`, {
    token: nandhini,
  });
  assert.equal(preview.status, 200);
  assert.ok(preview.json.data.body, 'there is a customer to draft a message to');
});

/* ------------------------ Two people, one record ------------------------ */

test('a second person saving over your edit is refused, not silently accepted', async () => {
  // Both open the same enquiry. She changes the follow-up date, he changes the remarks.
  // Last write wins means his save quietly reverts hers, and neither of them ever finds out
  // — they discover it a week later when the customer was not called.
  const customer = await makeCustomer(nandhini);
  const enquiry = await makeEnquiry(nandhini, customer._id, { remarks: 'Original' });

  // Two readers, both holding the version they loaded.
  const hers = (await api(`/api/enquiries/${enquiry._id}`, { token: nandhini })).json.data;
  const his = (await api(`/api/enquiries/${enquiry._id}`, { token: nandhini })).json.data;
  assert.equal(hers.updatedAt, his.updatedAt, 'they read the same version');

  const herSave = await api(`/api/enquiries/${enquiry._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { remarks: 'She got there first', expectedUpdatedAt: hers.updatedAt },
  });
  assert.equal(herSave.status, 200);

  const hisSave = await api(`/api/enquiries/${enquiry._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { remarks: 'He overwrote her', expectedUpdatedAt: his.updatedAt },
  });

  assert.equal(hisSave.status, 409, 'the stale write is refused');
  assert.match(hisSave.json.message, /changed|reload|someone/i, `got: ${hisSave.json.message}`);

  const after = (await api(`/api/enquiries/${enquiry._id}`, { token: nandhini })).json.data;
  assert.equal(after.remarks, 'She got there first', 'and her edit survived');
});

test('a caller that sends no version is not blocked', async () => {
  // The check is opt-in per request. An integration or a script that has not been taught
  // about versions must keep working rather than start failing on every write.
  const customer = await makeCustomer(nandhini);
  const enquiry = await makeEnquiry(nandhini, customer._id);

  const { status } = await api(`/api/enquiries/${enquiry._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { remarks: 'No version supplied' },
  });
  assert.equal(status, 200);
});

test('a customer opened from its own screen can actually be saved', async () => {
  // The detail route populates `assignedTo` into an object so the screen can show the
  // owner's name. The edit form is seeded from that same record and sends it back, so the
  // owner arrives as `{_id, name, email}` where the schema wants an id — and every save
  // from that screen is refused with a validation error about a field nobody touched.
  const customer = await makeCustomer(nandhini);
  const loaded = (await api(`/api/customers/${customer._id}`, { token: nandhini })).json.data.customer;

  const { status, json } = await api(`/api/customers/${customer._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { ...loaded, name: 'Renamed From Their Own Screen' },
  });

  assert.equal(
    status,
    200,
    `saving what the screen handed back was refused: ${json.message} ${JSON.stringify(json.details || [])}`
  );
  assert.equal(json.data.name, 'Renamed From Their Own Screen');
});
