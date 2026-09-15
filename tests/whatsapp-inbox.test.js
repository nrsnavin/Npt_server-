/**
 * The WhatsApp front door [BLUEPRINT §41].
 *
 * §41.11 asks for ten acceptance tests, "from number matching before lead creation through to
 * duplicate suppression on repeat messages". Both ends of that sentence describe the same kind
 * of failure — something created that should not have been — and neither one errors when it
 * goes wrong. A ten-year account appears as a stranger; a webhook retry becomes a second
 * message; a buyer sending four lines about one job becomes four rows in somebody's queue. The
 * system looks like it is working the whole time.
 *
 *   node --test tests/whatsapp-inbox.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'whatsapp-test-secret-value';
process.env.WHATSAPP_WEBHOOK_TOKEN = 'test-webhook-token';

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;      // marketing — owns the customer below
let nandhiniId;
let arun;          // marketing — the other half of the rotation
let arunId;
let customer;      // Sri Kumaran Knits, owned by Nandhini
let mould;

const KNOWN = '+919840011223';        // the customer's own WhatsApp number
const CONTACT = '+919840099887';      // their merchandiser, on the contacts array
const STRANGER = '+919000000001';     // nobody has this

const api = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

const signIn = async (email, password) => {
  const { json } = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  return json.data?.token;
};

/** One inbound message, shaped the way Twilio posts it. */
let sid = 0;
const inbound = (from, body, extra = {}) =>
  api('/api/whatsapp/inbound', {
    method: 'POST',
    headers: { 'x-webhook-token': 'test-webhook-token' },
    body: {
      From: `whatsapp:${from}`,
      Body: body,
      MessageSid: extra.MessageSid ?? `SM${String((sid += 1)).padStart(8, '0')}`,
      ...extra,
    },
  });

const threadFor = async (number, token = admin) => {
  const { json } = await api('/api/whatsapp/threads?limit=100', { token });
  return (json.data || []).find((row) => row.number === number);
};

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

  for (const person of [
    { name: 'Nandhini S', email: 'nandhini@np.com', password: 'Passw0rd@123', department: 'marketing' },
    { name: 'Arun K', email: 'arun@np.com', password: 'Passw0rd@456', department: 'marketing' },
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: person });
  }
  nandhini = await signIn('nandhini@np.com', 'Passw0rd@123');
  arun = await signIn('arun@np.com', 'Passw0rd@456');
  nandhiniId = (await api('/api/auth/me', { token: nandhini })).json.data.id;
  arunId = (await api('/api/auth/me', { token: arun })).json.data.id;

  const madeMould = await api('/api/moulds', {
    method: 'POST',
    token: admin,
    body: {
      mouldCode: 'M-NH-400', name: 'Shirt hanger 400mm', category: 'shirt', sizeMm: 400,
      material: 'pp', cavities: 4, partWeightGrams: 26, cycleTimeSeconds: 28,
    },
  });
  mould = madeMould.json.data._id;

  const madeCustomer = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: {
      name: 'Sri Kumaran Knits',
      whatsapp: KNOWN,
      city: 'Tiruppur',
      state: 'Tamil Nadu',
      contacts: [{ name: 'Selvi R', designation: 'Merchandiser', whatsapp: CONTACT }],
    },
  });
  assert.equal(madeCustomer.status, 201, madeCustomer.json.message);
  customer = madeCustomer.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------ The door itself ------------------------------ */

test('the webhook refuses anything without the token', async () => {
  /* The one route in the application with no session behind it. Its only guard is this. */
  const naked = await api('/api/whatsapp/inbound', {
    method: 'POST',
    body: { From: `whatsapp:${STRANGER}`, Body: 'hello' },
  });
  assert.equal(naked.status, 401);

  const wrong = await api('/api/whatsapp/inbound', {
    method: 'POST',
    headers: { 'x-webhook-token': 'not-the-token' },
    body: { From: `whatsapp:${STRANGER}`, Body: 'hello' },
  });
  assert.equal(wrong.status, 401);
});

test('a message with no usable sender is refused, but not with a retryable error', async () => {
  const { status, json } = await inbound('', 'who is this');

  /*
   * 200 with `success: false`, and that is deliberate. A provider reads a non-2xx as "send it
   * again", so refusing with a 4xx buys an endless redelivery loop for a message we have
   * already decided to drop.
   */
  assert.equal(status, 200);
  assert.equal(json.success, false);
  assert.equal(json.outcome, 'rejected');
});

/* --------------------- §41.2: match before you create --------------------- */

test('a known customer’s number attaches to that customer, and to their owner', async () => {
  const { status, json } = await inbound(KNOWN, 'Need 40,000 of the 400mm shirt hanger');
  assert.equal(status, 200, json.why);
  assert.equal(json.outcome, 'created');

  const thread = await threadFor(KNOWN);
  assert.ok(thread, 'the conversation is in the inbox');
  assert.equal(thread.matchedBy, 'customer', 'matched on the number, not on the display name');
  assert.equal(thread.customer?._id, customer);
  /* §29: the account already has a person, and being handed to somebody else reads as the
     plant having lost their file. */
  assert.equal(thread.assignedTo?._id, nandhiniId);
  assert.equal(thread.assignedByRotation, false);
});

test('a contact’s number matches the customer too, not just the headline number', async () => {
  /*
   * The person who messages is usually the merchandiser rather than whoever the account was
   * opened under. Matching only the customer's own number would call a ten-year account a
   * stranger the first time their buyer texts.
   */
  const { json } = await inbound(CONTACT, 'Sending the artwork now');
  assert.equal(json.outcome, 'created');

  const thread = await threadFor(CONTACT);
  assert.equal(thread.matchedBy, 'customer');
  assert.equal(thread.customer?._id, customer);
  assert.equal(thread.assignedTo?._id, nandhiniId);
});

test('an unknown number becomes its own conversation, assigned by rotation', async () => {
  const { json } = await inbound(STRANGER, 'Do you make velvet hangers?');
  assert.equal(json.outcome, 'created');

  const thread = await threadFor(STRANGER);
  assert.equal(thread.matchedBy, 'unknown');
  assert.equal(thread.customer, undefined, 'nothing is invented for a number nobody holds');
  assert.ok(thread.assignedTo, 'but somebody owns it — §41.3');
  assert.equal(thread.assignedByRotation, true, 'and the inbox can say the rotation chose');
});

test('an open lead carrying the number captures the conversation', async () => {
  const lead = await api('/api/leads', {
    method: 'POST',
    token: nandhini,
    body: {
      company: 'Everblue Knitwear', mobile: '+919000000077',
      nextAction: 'Call about their hanger requirement', nextFollowUpDate: '2026-10-01',
    },
  });
  assert.equal(lead.status, 201, lead.json.message);

  const { json } = await inbound('+919000000077', 'Following up on my enquiry');
  assert.equal(json.outcome, 'created');

  const thread = await threadFor('+919000000077');
  assert.equal(thread.matchedBy, 'lead');
  assert.equal(thread.lead?._id, lead.json.data._id);
  assert.equal(thread.assignedTo?._id, nandhiniId, 'whoever is working the lead keeps it');
});

/**
 * The inversion §41.2 exists to prevent, and the one the other tests did not catch.
 *
 * A buyer is routinely both: an account the plant has invoiced for years, and an old lead
 * record from before they were one. Ask the lead first and a ten-year customer comes back as a
 * prospect — attached to a stale record, routed to whoever was chasing them in 2023, and shown
 * to marketing as somebody they have never sold to. Nothing errors. The conversation simply
 * lands on the wrong desk with the wrong history behind it.
 */
test('a number on both a customer and an open lead matches the customer', async () => {
  const BOTH = '+919000000055';

  const account = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'Vogue Retail India', whatsapp: BOTH, city: 'Chennai', state: 'Tamil Nadu' },
  });
  assert.equal(account.status, 201, account.json.message);

  /* The same number on an open lead, which is the ordinary mess of a real customer book. */
  const stale = await api('/api/leads', {
    method: 'POST',
    token: arun,
    body: {
      company: 'Vogue Retail (old enquiry)', mobile: BOTH,
      nextAction: 'Call them back', nextFollowUpDate: '2026-10-01',
    },
  });
  assert.equal(stale.status, 201, stale.json.message);

  await inbound(BOTH, 'Same rate as last season?');

  const thread = await threadFor(BOTH);
  assert.equal(thread.matchedBy, 'customer', 'the account wins — §41.2 asks the customer first');
  assert.equal(thread.customer?._id, account.json.data._id);
  assert.equal(thread.lead, undefined, 'and the stale lead does not capture it');
  assert.equal(
    thread.assignedTo?._id,
    nandhiniId,
    'so it goes to the person who owns the relationship, not whoever chased the old lead'
  );
});

test('a disqualified lead does not capture a fresh message', async () => {
  /*
   * The buyer has come back, which is news. Attaching it to a closed record would bury that
   * under a status nobody is watching.
   */
  const lead = await api('/api/leads', {
    method: 'POST',
    token: nandhini,
    body: {
      company: 'Coral Fashions', mobile: '+919000000088',
      nextAction: 'Call them', nextFollowUpDate: '2026-10-01',
    },
  });
  await api(`/api/leads/${lead.json.data._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { status: 'disqualified', disqualifyReason: 'price_shopper', disqualifyNote: 'Too dear for them' },
  });

  await inbound('+919000000088', 'Are you still making the 380?');

  const thread = await threadFor('+919000000088');
  assert.equal(thread.matchedBy, 'unknown', 'a closed lead is not a match');
  assert.equal(thread.lead, undefined);
});

/* ------------------- §41.2: one conversation, not one per message ------------------- */

test('a second message from the same number joins the conversation', async () => {
  const before = await threadFor(KNOWN);

  const { json } = await inbound(KNOWN, 'White, and we need them by Diwali');
  assert.equal(json.outcome, 'appended', 'never a second row for the same buyer');

  const after = await threadFor(KNOWN);
  assert.equal(after._id, before._id, 'the same conversation');
  assert.equal(after.messageCount, before.messageCount + 1);
  assert.match(after.lastMessagePreview, /Diwali/, 'and the inbox shows the newest line');
});

test('a webhook retry is not a message', async () => {
  const before = await threadFor(KNOWN);

  const first = await inbound(KNOWN, 'Can you confirm the rate?', { MessageSid: 'SM-RETRY-0001' });
  assert.equal(first.json.outcome, 'appended');

  /* The same id again — a slow reply, a deploy mid-request. Twilio sends it twice. */
  const again = await inbound(KNOWN, 'Can you confirm the rate?', { MessageSid: 'SM-RETRY-0001' });
  assert.equal(again.json.outcome, 'duplicate');

  const after = await threadFor(KNOWN);
  assert.equal(after.messageCount, before.messageCount + 1, 'one message, not two');
});

test('a photo with no caption still reads as something in the inbox', async () => {
  /* The commonest WhatsApp enquiry there is: a competitor's hanger held up to the camera. */
  await inbound(CONTACT, '', {
    NumMedia: '1',
    MediaUrl0: 'https://api.twilio.com/media/abc',
    MediaContentType0: 'image/jpeg',
  });

  const thread = await threadFor(CONTACT);
  assert.equal(thread.lastMessagePreview, '(a photo)', 'not a blank row');
});

/* ------------------------------ §41.3: assignment ------------------------------ */

test('the rotation spreads unknown numbers across marketing', async () => {
  const owners = new Set();
  for (const number of ['+919000000101', '+919000000102', '+919000000103', '+919000000104']) {
    await inbound(number, 'Price for 300mm please');
    const thread = await threadFor(number);
    owners.add(String(thread.assignedTo?._id));
  }

  assert.ok(owners.size > 1, `round-robin should not park everything on one person: ${[...owners]}`);
  for (const id of owners) assert.ok([nandhiniId, arunId].includes(id), 'and only over marketing');
});

test('a person can take a conversation, and the rotation stops claiming credit', async () => {
  const thread = await threadFor(STRANGER);

  const taken = await api(`/api/whatsapp/threads/${thread._id}`, {
    method: 'PATCH',
    token: admin,
    body: { assignedTo: arunId },
  });
  assert.equal(taken.status, 200, taken.json.message);
  assert.equal(taken.json.data.assignedTo._id, arunId);
  assert.equal(taken.json.data.assignedByRotation, false, 'a person chose, not the rotation');
});

/* ------------------------------ §41.5: the queues ------------------------------ */

test('the inbox counts every queue, not just the one being looked at', async () => {
  const { json } = await api('/api/whatsapp/threads?status=new&limit=100', { token: admin });

  assert.ok(json.stageCounts, 'the tally travels with the rows');
  assert.ok(json.data.every((row) => row.status === 'new'), 'the list is narrowed');
  assert.equal(typeof json.unassigned, 'number', 'and Unassigned is its own count');
  /* Narrowed to the queue chosen, the other chips would read zero and there would be no way
     back to them. */
  assert.ok((json.stageCounts.new?.leads ?? 0) > 0);
});

test('marketing sees their own conversations, not the whole plant’s', async () => {
  const mine = await api('/api/whatsapp/threads?limit=100', { token: arun });
  assert.equal(mine.status, 200);
  assert.ok(
    mine.json.data.every((row) => String(row.assignedTo?._id) === String(arunId)),
    '§29: a marketing person reads their own book'
  );

  const everything = await api('/api/whatsapp/threads?limit=100', { token: admin });
  assert.ok(everything.json.data.length > mine.json.data.length, 'management sees all of it');
});

test('a thread nobody owns is reachable as its own queue', async () => {
  const { json } = await api('/api/whatsapp/threads?unassigned=true&limit=100', { token: admin });
  assert.ok(json.data.every((row) => !row.assignedTo), 'only the ones nobody has');
});

/* --------------------------- §41.4: converting --------------------------- */

test('a conversation with no customer cannot become an enquiry, and says what to do', async () => {
  const thread = await threadFor('+919000000101');

  const refused = await api(`/api/whatsapp/threads/${thread._id}/enquiry`, {
    method: 'POST',
    token: admin,
    body: { requirement: { modelNumber: 'NH-300' } },
  });

  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /Link this conversation to a customer/);
});

test('linking a customer also teaches the number, so the next message matches itself', async () => {
  const thread = await threadFor('+919000000102');

  const fresh = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'Northstar Apparel', city: 'Tiruppur', state: 'Tamil Nadu' },
  });
  assert.equal(fresh.status, 201, fresh.json.message);

  const linked = await api(`/api/whatsapp/threads/${thread._id}`, {
    method: 'PATCH',
    token: admin,
    body: { customer: fresh.json.data._id },
  });
  assert.equal(linked.status, 200, linked.json.message);
  assert.equal(linked.json.data.matchedBy, 'customer');

  /* The point of doing it here rather than on the customer screen: it is a one-off.
     The detail route answers `{ customer, timeline }`, so the record is a level in. */
  const after = await api(`/api/customers/${fresh.json.data._id}`, { token: admin });
  assert.equal(after.json.data.customer.whatsapp, '+919000000102', 'the number is now on the customer');
});

test('converting raises an enquiry without re-entering what we already knew', async () => {
  const thread = await threadFor(KNOWN);

  const converted = await api(`/api/whatsapp/threads/${thread._id}/enquiry`, {
    method: 'POST',
    token: admin,
    /* Only the requirement — the part that was prose in a chat and had to be read by a person. */
    body: {
      mould,
      requirement: { modelNumber: 'NH-400', colour: 'White' },
      nextAction: 'Send the costing once it is approved',
      nextFollowUpDate: '2026-10-05',
    },
  });

  assert.equal(converted.status, 201, converted.json.message);
  const enquiry = converted.json.data;

  /* The four things §41.4 says must not be retyped. */
  assert.equal(String(enquiry.customer), String(customer), 'the customer came off the thread');
  assert.equal(String(enquiry.assignedTo), nandhiniId, 'and so did the owner');
  assert.equal(enquiry.source, 'whatsapp', 'and the origin, which §23 reports on');
  assert.equal(enquiry.conversation?.reference, KNOWN, 'and the thread stays reachable [§41.6]');

  assert.equal(converted.json.thread.status, 'converted');
  assert.equal(String(converted.json.thread.enquiry?._id ?? converted.json.thread.enquiry), String(enquiry._id));
});

test('a converted conversation cannot be converted again', async () => {
  const thread = await threadFor(KNOWN);

  const again = await api(`/api/whatsapp/threads/${thread._id}/enquiry`, {
    method: 'POST',
    token: admin,
    body: { requirement: { modelNumber: 'NH-400' } },
  });

  assert.equal(again.status, 409);
  assert.match(again.json.message, /already been converted/);
});

test('converted is what raising an enquiry does, never something typed', async () => {
  /* Otherwise the inbox fills with threads marked converted and no enquiry behind them — the
     one thing it exists to track, lied about. */
  const thread = await threadFor(STRANGER);

  const faked = await api(`/api/whatsapp/threads/${thread._id}`, {
    method: 'PATCH',
    token: admin,
    body: { status: 'converted' },
  });

  assert.equal(faked.status, 400);
  assert.match(faked.json.message, /raising an enquiry/);
});

test('a reply reopens a conversation that was waiting on the customer', async () => {
  const thread = await threadFor(CONTACT);
  await api(`/api/whatsapp/threads/${thread._id}`, {
    method: 'PATCH',
    token: admin,
    body: { status: 'waiting_for_customer' },
  });

  await inbound(CONTACT, 'Sorry for the delay — yes, go ahead');

  const after = await threadFor(CONTACT);
  assert.equal(after.status, 'new', 'the answer must not sit in a queue nobody reads');
});

test('the conversation is gated on the grant, like everything else', async () => {
  const sampling = await api('/api/users', {
    method: 'POST',
    token: admin,
    body: { name: 'Bala S', email: 'bala@np.com', password: 'Passw0rd@789', department: 'sampling' },
  });
  assert.equal(sampling.status, 201, sampling.json.message);
  const bench = await signIn('bala@np.com', 'Passw0rd@789');

  const refused = await api('/api/whatsapp/threads', { token: bench });
  assert.equal(refused.status, 403, 'the bench does not read the front door');
});
