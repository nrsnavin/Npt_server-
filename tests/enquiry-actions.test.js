/**
 * Doing things to an enquiry, rather than picking a database word out of a dropdown.
 *
 * The screen offered twelve stages and a free-text box. "Move to sample_required" is not a
 * thing a marketing person does; raising a sample request is. And the free text meant one
 * intention — chase the bench — was typed a hundred ways, so no list could group it, count it
 * or act on it.
 *
 * The automation on the far side was already there and always had been. These tests are mostly
 * about the front door reaching it, and about each action refusing to happen without the one
 * thing it cannot be done without.
 *
 *   node --test tests/enquiry-actions.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'enquiry-actions-test-secret-value';

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
const followUp = { nextAction: 'Call the buyer', nextFollowUpDate: inDays(3) };

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let product;
let customer;

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

const raise = async (extra = {}) => {
  const { status, json } = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer,
      product,
      requirement: { quantity: 10000, modelNumber: 'NH-400' },
      estimatedValue: 250000,
      ...followUp,
      ...extra,
    },
  });
  assert.equal(status, 201, json.message);
  return json.data;
};

const act = (id, body, token = nandhini) =>
  api(`/api/enquiries/${id}/actions`, { method: 'POST', token, body });

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

  await api('/api/users', {
    method: 'POST',
    token: admin,
    body: { name: 'Nandhini S', email: 'nandhini@np.com', password: 'Passw0rd@123', department: 'marketing' },
  });
  nandhini = await signIn('nandhini@np.com', 'Passw0rd@123');

  const madeProduct = await api('/api/products', {
    method: 'POST',
    token: admin,
    body: { modelCode: 'NH-400', name: 'Shirt hanger 400mm', category: 'shirt', material: 'plastic', sizeMm: 400 },
  });
  product = madeProduct.json.data._id;

  const madeCustomer = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'Sri Kumaran Knits', mobile: '9840011223' },
  });
  customer = madeCustomer.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------ What can be done ------------------------------ */

test('the screen is told what it can do, not left to guess', async () => {
  const enquiry = await raise();
  const { json } = await api(`/api/enquiries/${enquiry._id}/actions`, { token: nandhini });

  const keys = json.data.map((row) => row.action);
  assert.ok(keys.includes('raise_sample'));
  assert.ok(keys.includes('confirm_order'));
  assert.ok(keys.includes('follow_up'));

  const sample = json.data.find((row) => row.action === 'raise_sample');
  assert.equal(sample.label, 'Raise a sample request');
  assert.deepEqual(sample.needs, [], 'and what it needs asking for');
  assert.equal(sample.defaultFollowUpDate, inDays(3), 'and the date it will set');

  const won = json.data.find((row) => row.action === 'confirm_order');
  assert.deepEqual(won.needs, ['value'], 'winning cannot happen without the figure');
});

test('a closed enquiry offers no actions at all', async () => {
  // It reopens through its own door; offering "raise a sample" on a lost enquiry would be a
  // button that can only produce an error.
  const enquiry = await raise();
  await act(enquiry._id, { action: 'mark_lost', lostReason: 'price' });

  const { json } = await api(`/api/enquiries/${enquiry._id}/actions`, { token: nandhini });
  assert.deepEqual(json.data, []);

  const blocked = await act(enquiry._id, { action: 'raise_sample' });
  assert.equal(blocked.status, 400);
  assert.match(blocked.json.message, /reopened/i);
});

/* ------------------------------- Raising a sample ------------------------------- */

test('raising a sample request actually creates the sample', async () => {
  /*
   * The whole point of the change. The automation existed — moving to `sample_required` has
   * always raised the request — but it was behind a dropdown of twelve database words that
   * nobody would find it in.
   */
  const enquiry = await raise();
  const done = await act(enquiry._id, { action: 'raise_sample' });

  assert.equal(done.status, 200, done.json.message);
  assert.equal(done.json.data.status, 'sample_required');
  assert.equal(done.json.did, 'Raise a sample request');

  // The bus is asynchronous; give the subscriber its turn.
  await new Promise((resolve) => setTimeout(resolve, 250));

  const samples = await api(`/api/samples?enquiry=${enquiry._id}`, { token: admin });
  assert.ok(samples.json.data.length, 'a sample request exists for this enquiry');
});

test('the action writes its own next step', async () => {
  /*
   * "chase sample", "follow up sampling", "ask bench" were one intention in three spellings,
   * and no follow-up list could group them. The action knows what happens next, so it says so.
   */
  const enquiry = await raise();
  const { json } = await act(enquiry._id, { action: 'raise_sample' });

  assert.match(json.data.nextAction, /chase the sample/i);
  assert.equal(json.data.nextActionType, 'send_sample', 'and it is typed, not just text');
  assert.equal(json.data.nextFollowUpDate.slice(0, 10), inDays(3));
});

test('the written next step is a default, not a cage', async () => {
  const enquiry = await raise();
  const { json } = await act(enquiry._id, {
    action: 'raise_sample',
    nextAction: 'Ask Murugan to use the softer clip',
    nextFollowUpDate: inDays(6),
  });

  assert.equal(json.data.nextAction, 'Ask Murugan to use the softer clip');
  assert.equal(json.data.nextFollowUpDate.slice(0, 10), inDays(6));
});

/* -------------------------------- Asking a price -------------------------------- */

test('asking for a price queues whoever prices a job', async () => {
  const enquiry = await raise();
  const done = await act(enquiry._id, { action: 'request_pricing' });

  assert.equal(done.status, 200, done.json.message);
  assert.equal(done.json.data.status, 'pricing_required');
  await new Promise((resolve) => setTimeout(resolve, 250));

  const tasks = await api('/api/workspace/todos', { token: admin });
  const costing = (tasks.json.data || []).find((row) => row.title?.includes(`Price ${enquiry.number}`));
  assert.ok(costing, 'the costing request is on somebody’s list');
});

/* ------------------------------ Confirming an order ------------------------------ */

test('confirming an order needs the figure, then hands it to order confirmation', async () => {
  /*
   * `ENQUIRY_WON` was published and nobody was listening: the enquiry went green and the sales
   * order got raised because somebody remembered. That is the one place in the chain where
   * forgetting costs a confirmed order rather than a follow-up.
   */
  const enquiry = await raise({ estimatedValue: undefined });

  const bare = await act(enquiry._id, { action: 'confirm_order' });
  assert.equal(bare.status, 400);
  assert.match(bare.json.message, /value/i);

  const done = await act(enquiry._id, { action: 'confirm_order', estimatedValue: 512000 });
  assert.equal(done.status, 200, done.json.message);
  assert.equal(done.json.data.status, 'won');
  assert.equal(done.json.data.estimatedValue, 512000);
  assert.equal(done.json.data.nextAction, undefined, 'winning clears the chase');

  await new Promise((resolve) => setTimeout(resolve, 250));
  const tasks = await api('/api/workspace/todos', { token: admin });
  const order = (tasks.json.data || []).find((row) =>
    row.title?.includes(`Raise the sales order for ${enquiry.number}`)
  );
  assert.ok(order, 'order confirmation has been told');
});

/* --------------------------------- Losing one --------------------------------- */

test('losing one needs a reason, and cancels the sample behind it', async () => {
  const enquiry = await raise();
  await act(enquiry._id, { action: 'raise_sample' });
  await new Promise((resolve) => setTimeout(resolve, 250));

  const bare = await act(enquiry._id, { action: 'mark_lost' });
  assert.equal(bare.status, 400);
  assert.match(bare.json.message, /reason/i);

  const done = await act(enquiry._id, { action: 'mark_lost', lostReason: 'competitor' });
  assert.equal(done.status, 200, done.json.message);
  assert.equal(done.json.data.status, 'lost');

  await new Promise((resolve) => setTimeout(resolve, 250));
  const samples = await api(`/api/samples?enquiry=${enquiry._id}`, { token: admin });
  assert.ok(
    samples.json.data.every((row) => row.status === 'cancelled'),
    'work nobody will buy comes off the bench'
  );
});

/* --------------------------------- Holding one --------------------------------- */

test('holding one needs to say what it waits on', async () => {
  const enquiry = await raise();

  const bare = await act(enquiry._id, { action: 'hold' });
  assert.equal(bare.status, 400);
  assert.match(bare.json.message, /waiting on/i);

  const done = await act(enquiry._id, { action: 'hold', holdReason: 'Buyer’s budget frozen till April' });
  assert.equal(done.status, 200, done.json.message);
  assert.equal(done.json.data.status, 'hold');
  assert.match(done.json.data.nextAction, /can move again/i);
  assert.equal(done.json.data.nextFollowUpDate.slice(0, 10), inDays(14), 'and comes back in a fortnight');
});

/* ------------------------------ Nothing happened ------------------------------ */

test('a chase that moved nothing is not recorded as a stage change', async () => {
  /*
   * Most days nothing moves. Without an action for that, people move the stage to record
   * having chased — which is how a funnel fills with movement that never happened.
   */
  const enquiry = await raise();
  const before = enquiry.statusHistory.length;

  const done = await act(enquiry._id, {
    action: 'follow_up',
    nextAction: 'Call again on Monday',
    nextFollowUpDate: inDays(4),
  });

  assert.equal(done.status, 200, done.json.message);
  assert.equal(done.json.data.status, enquiry.status, 'the stage is where it was');
  assert.equal(done.json.data.statusHistory.length, before, 'and the history has not grown');
  assert.equal(done.json.data.nextAction, 'Call again on Monday');
  assert.equal(done.json.data.nextFollowUpDate.slice(0, 10), inDays(4));
});

test('a follow-up still cannot be set in the past', async () => {
  const enquiry = await raise();
  const done = await act(enquiry._id, {
    action: 'follow_up',
    nextAction: 'Call again',
    nextFollowUpDate: inDays(-3),
  });

  assert.equal(done.status, 400);
  assert.match(done.json.message, /past/i);
});

/* -------------------------------- The two doors -------------------------------- */

test('the action door enforces the same rules as the stage door', async () => {
  /*
   * Both reach the same function on purpose. An action that skipped the won-needs-a-value rule
   * would be a hole with a friendly button on it.
   */
  const enquiry = await raise({ estimatedValue: undefined });

  const viaStage = await api(`/api/enquiries/${enquiry._id}/status`, {
    method: 'POST',
    token: nandhini,
    body: { status: 'won' },
  });
  const viaAction = await act(enquiry._id, { action: 'confirm_order' });

  assert.equal(viaStage.status, 400);
  assert.equal(viaAction.status, 400);
  assert.equal(viaStage.json.message, viaAction.json.message, 'and refuse in the same words');
});

test('an action that would not move it is refused', async () => {
  const enquiry = await raise();
  await act(enquiry._id, { action: 'raise_sample' });

  const again = await act(enquiry._id, { action: 'raise_sample' });
  assert.equal(again.status, 400);
  assert.match(again.json.message, /already at/i);
});

test('a made-up action is refused by the schema', async () => {
  const enquiry = await raise();
  const { status } = await act(enquiry._id, { action: 'delete_everything' });
  assert.equal(status, 400);
});

test('reading the actions needs only read, doing one needs write', async () => {
  // Sampling can see an enquiry but must not move it [§29 access, not ownership].
  await api('/api/users', {
    method: 'POST',
    token: admin,
    body: { name: 'Murugan V', email: 'bench@np.com', password: 'Passw0rd@789', department: 'sampling' },
  });
  const bench = await signIn('bench@np.com', 'Passw0rd@789');
  const enquiry = await raise();

  const read = await api(`/api/enquiries/${enquiry._id}/actions`, { token: bench });
  assert.equal(read.status, 200, 'the bench may see what could happen');

  const write = await act(enquiry._id, { action: 'raise_sample' }, bench);
  assert.equal(write.status, 403, 'but may not do it');
});

/* --------------------------- The funnel runs one way --------------------------- */

const setStage = (id, body, token = nandhini) =>
  api(`/api/enquiries/${id}/status`, { method: 'POST', token, body });

test('an enquiry cannot be dragged back down the funnel', async () => {
  const enquiry = await raise();
  const moved = await setStage(enquiry._id, { status: 'negotiation', ...followUp });
  assert.equal(moved.status, 200, moved.json.message);

  const back = await setStage(enquiry._id, { status: 'sample_required', ...followUp });
  assert.equal(back.status, 400);
  assert.match(back.json.message, /already reached Negotiation/i);
  assert.match(back.json.message, /cannot go back to Sample required/i);
  // And it says what to do instead, or the rule is just a wall.
  assert.match(back.json.message, /hold|lost/i);
});

test('it may still skip forward — not every job needs a sample', async () => {
  const enquiry = await raise();
  const jumped = await setStage(enquiry._id, { status: 'quote_submitted', ...followUp });
  assert.equal(jumped.status, 200, jumped.json.message);
});

test('lost and hold stay reachable from anywhere', async () => {
  const parked = await raise();
  await setStage(parked._id, { status: 'po_expected', ...followUp });
  const held = await setStage(parked._id, { status: 'hold', holdReason: 'Buyer travelling' });
  assert.equal(held.status, 200, held.json.message);

  const dying = await raise();
  await setStage(dying._id, { status: 'negotiation', ...followUp });
  const lost = await setStage(dying._id, { status: 'lost', lostReason: 'price' });
  assert.equal(lost.status, 200, lost.json.message);
});

test('coming off hold resumes where it was parked, and no earlier', async () => {
  const enquiry = await raise();
  await setStage(enquiry._id, { status: 'negotiation', ...followUp });
  await setStage(enquiry._id, { status: 'hold', holdReason: 'Buyer travelling' });

  // `hold` is not a rung, so the floor has to come from the history rather than the status.
  const back = await setStage(enquiry._id, { status: 'pricing_required', ...followUp });
  assert.equal(back.status, 400);
  assert.match(back.json.message, /already reached Negotiation/i);

  const resumed = await setStage(enquiry._id, { status: 'negotiation', ...followUp });
  assert.equal(resumed.status, 200, resumed.json.message);
});

test('reopening is exempt — it is the one move meant to rewind', async () => {
  const enquiry = await raise();
  await setStage(enquiry._id, { status: 'negotiation', ...followUp });
  await setStage(enquiry._id, { status: 'lost', lostReason: 'price' });

  const reopened = await setStage(enquiry._id, {
    status: 'requirement_clarification',
    note: 'Buyer came back with a smaller quantity',
    ...followUp,
  });
  assert.equal(reopened.status, 200, reopened.json.message);

  /*
   * And the floor resets with it. Without the reopen window the enquiry would still be
   * measured against `lost`, and a revived enquiry could never be worked again.
   */
  const onwards = await setStage(enquiry._id, { status: 'sample_required', ...followUp });
  assert.equal(onwards.status, 200, onwards.json.message);
});

test('a backwards action is not offered in the first place', async () => {
  const enquiry = await raise();
  await setStage(enquiry._id, { status: 'negotiation', ...followUp });

  const { json } = await api(`/api/enquiries/${enquiry._id}/actions`, { token: nandhini });
  const keys = json.data.map((row) => row.action);

  assert.ok(!keys.includes('raise_sample'), 'the sample has been and gone');
  assert.ok(!keys.includes('request_pricing'), 'so has the price');
  // What is still ahead stays on offer, and so do the two ways out.
  assert.ok(keys.includes('expect_po'));
  assert.ok(keys.includes('confirm_order'));
  assert.ok(keys.includes('mark_lost'));
  assert.ok(keys.includes('hold'));
  // A plain follow-up moves no stage at all, so it is never a fall back.
  assert.ok(keys.includes('follow_up'));
});
