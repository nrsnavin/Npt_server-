/**
 * Queries: a threaded question about a buyer, and the room it gathers [queries].
 *
 * Distinct from `OrderQuery`, which is one question to one department with a clock on it. This
 * one names a *customer*, accumulates participants rather than moving between them, and has no
 * single department that owes an answer — "the buyer is disputing the September invoice" needs
 * accounts, then despatch for the POD, then marketing to ring them, and none of those is a
 * hand-over.
 *
 * **The access story is the half worth testing hardest**, because it runs the opposite way to
 * everything else in the app. Everywhere else, access flows from the record: you may read an
 * order because you may read orders. Here the *thread* decides, and being in the thread grants
 * sight of the buyer it names — which is what makes the feature possible at all, since despatch
 * cannot own a customer and never will.
 *
 * That is a door, so what is tested is that it is a door and not a hole: every grant is signed,
 * reading is not writing, and a stranger sees nothing.
 *
 *   node --test tests/queries.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'queries-test-secret-value';

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;   // marketing — owns the buyer, asks the question
let priya;      // marketing — owns nothing here, and must stay out
let kavitha;    // despatch — cannot own a customer, and is who gets asked
let ramesh;     // production — pulled in later by despatch
let customerId;
let nandhiniId;
let kavithaId;
let rameshId;

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
const whoIs = async (token) => (await api('/api/auth/me', { token })).json.data.id;

let seq = 0;
const raise = (extra = {}, token = nandhini) =>
  api('/api/queries', {
    method: 'POST',
    token,
    body: {
      customer: customerId,
      subject: `Disputed invoice ${++seq}`,
      question: 'The buyer says the September load was short. What went on the lorry?',
      participants: [{ department: 'despatch' }],
      ...extra,
    },
  });

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

  for (const [name, email, department] of [
    ['Nandhini S', 'nandhini@np.com', 'marketing'],
    ['Priya R', 'priya@np.com', 'marketing'],
    ['Kavitha D', 'kavitha@np.com', 'despatch'],
    ['Ramesh P', 'ramesh@np.com', 'production'],
  ]) {
    const made = await api('/api/users', {
      method: 'POST',
      token: admin,
      body: { name, email, password: 'Pass@123456', department },
    });
    assert.equal(made.status, 201, made.json.message);
  }

  nandhini = await signIn('nandhini@np.com', 'Pass@123456');
  priya = await signIn('priya@np.com', 'Pass@123456');
  kavitha = await signIn('kavitha@np.com', 'Pass@123456');
  ramesh = await signIn('ramesh@np.com', 'Pass@123456');

  nandhiniId = await whoIs(nandhini);
  kavithaId = await whoIs(kavitha);
  rameshId = await whoIs(ramesh);

  const customer = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { assignedTo: nandhiniId, name: 'SCM Garments', mobile: '9876500011' },
  });
  assert.equal(customer.status, 201, customer.json.message);
  customerId = customer.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------- Raising one ------------------------------- */

test('a query names a buyer and at least one person to ask', async () => {
  const { status, json } = await raise();

  assert.equal(status, 201, json.message);
  assert.match(json.data.number, /^QRY-/);
  assert.equal(String(json.data.customer._id), String(customerId));
  assert.equal(json.data.status, 'open');
  assert.equal(json.data.participants.length, 1);
  assert.equal(json.data.participants[0].department, 'despatch');
  assert.equal(json.data.participants[0].user, undefined, 'a department, not a person');
  assert.equal(String(json.data.participants[0].addedBy._id), String(nandhiniId), 'signed');
  assert.ok(json.data.participants[0].addedAt, 'and dated');
});

test('a query addressed to nobody is refused', async () => {
  /* A note to self is a to-do, and that list already exists. A thread nobody was told about is
     the WhatsApp message this feature replaces. */
  const { status, json } = await raise({ participants: [] });
  assert.equal(status, 400);
  assert.match(JSON.stringify(json), /participants|somebody/i);
});

test('a person can be asked, not only a department', async () => {
  const { status, json } = await raise({ participants: [{ user: rameshId }] });

  assert.equal(status, 201, json.message);
  const [row] = json.data.participants;
  assert.equal(String(row.user._id), String(rameshId));
  assert.equal(row.department, 'production', 'read off the person, not off what was sent');
});

test('a person is reached through their real department, whatever the form said', async () => {
  /* Two fields that can disagree about where somebody works is a filter that stops finding
     them. The person's own record wins. */
  const { json } = await raise({ participants: [{ user: rameshId, department: 'accounts' }] });
  assert.equal(json.data.participants[0].department, 'production');
});

test('you cannot start a thread about a buyer you could never see', async () => {
  /* Otherwise "raise a query" is a way to enumerate the customer master one id at a time. */
  const { status } = await raise({}, priya);
  assert.equal(status, 404, 'and it reads as missing, not as forbidden');
});

/* ------------------------------- Who is in the room ------------------------------- */

test('the department asked can read it, though it owns no customers', async () => {
  /*
   * The case the whole feature exists for. Despatch is not ownership-scoped and will never own
   * a buyer, so a rule reading "you may see queries about customers you can see" would mean
   * despatch could never be asked anything at all.
   */
  const { json } = await raise();

  const theirs = await api(`/api/queries/${json.data._id}`, { token: kavitha });
  assert.equal(theirs.status, 200, 'despatch is in the room');
  assert.equal(theirs.json.data.number, json.data.number);
});

test('a marketing colleague who is not in it sees nothing', async () => {
  const { json } = await raise();

  const nosy = await api(`/api/queries/${json.data._id}`, { token: priya });
  assert.equal(nosy.status, 404, 'not in the room, and told nothing about it existing');

  const list = await api('/api/queries', { token: priya });
  assert.equal(list.status, 200);
  assert.ok(
    !list.json.data.some((row) => row.number === json.data.number),
    'and it is not on their list either'
  );
});

test('naming one person does not put their colleagues in', async () => {
  /*
   * The narrowing `participant.user` exists for. "Ask Ramesh, he was there when the mould was
   * cut" must not quietly mean "ask production", or the distinction is lost the first time it
   * is used.
   */
  const { json } = await raise({ participants: [{ user: rameshId }] });

  const him = await api(`/api/queries/${json.data._id}`, { token: ramesh });
  assert.equal(him.status, 200, 'the person named is in');

  /* Somebody else in production is not — asserted through a second production user. */
  const made = await api('/api/users', {
    method: 'POST',
    token: admin,
    body: { name: 'Other Production', email: 'other-prod@np.com', password: 'Pass@123456', department: 'production' },
  });
  assert.equal(made.status, 201, made.json.message);
  const colleague = await signIn('other-prod@np.com', 'Pass@123456');

  const theirs = await api(`/api/queries/${json.data._id}`, { token: colleague });
  assert.equal(theirs.status, 404, 'a colleague in the same department is not');
});

/* ------------------------------- The grant ------------------------------- */

test('being asked grants sight of the buyer, and says so', async () => {
  /*
   * The decision this module rests on: a participant can open the customer the thread names.
   * Despatch asked where a load went needs the delivery address, and a thread they cannot
   * follow through to the record is a thread they cannot answer.
   */
  const before = await api(`/api/customers/${customerId}`, { token: kavitha });
  assert.equal(before.status, 200, 'despatch is not ownership-scoped, so this is not the proof');

  /* Proved on somebody who *is* scoped: another marketing person, added by name. */
  const { json } = await raise();
  const blind = await api(`/api/customers/${customerId}`, { token: priya });
  assert.equal(blind.status, 404, 'before being added, the buyer is invisible to them');

  const added = await api(`/api/queries/${json.data._id}/participants`, {
    method: 'POST',
    token: nandhini,
    body: { user: await whoIs(priya) },
  });
  assert.equal(added.status, 201, added.json.message);
  assert.equal(added.json.granted.customer, true, 'the answer says what the press granted');
  assert.ok(added.json.granted.people >= 1);

  const now = await api(`/api/customers/${customerId}`, { token: priya });
  assert.equal(now.status, 200, 'and now they can open the buyer');
});

test('the grant lets them read the buyer, never edit it', async () => {
  /*
   * The shape of the door. A query shares the buyer so a participant can follow the question
   * through to the record — the address, the contact, the history. Despatch being asked where a
   * load went is not a reason for despatch to change the credit terms.
   */
  const { json } = await raise();
  await api(`/api/queries/${json.data._id}/participants`, {
    method: 'POST', token: nandhini, body: { user: kavithaId },
  });

  const read = await api(`/api/customers/${customerId}`, { token: kavitha });
  assert.equal(read.status, 200);

  const write = await api(`/api/customers/${customerId}`, {
    method: 'PATCH',
    token: kavitha,
    body: { creditTermsDays: 90, expectedUpdatedAt: read.json.data.updatedAt },
  });
  assert.notEqual(write.status, 200, 'editing is still the account owner’s');
});

/* ------------------------------- Widening the room ------------------------------- */

test('anybody in the room can pull somebody else in', async () => {
  /*
   * What the feature turns on. Despatch reads the question, knows production packed it, and
   * adds them — without going back to marketing to ask permission, which is the round trip that
   * makes people give up and use the phone.
   */
  const { json } = await raise();

  const pulled = await api(`/api/queries/${json.data._id}/participants`, {
    method: 'POST',
    token: kavitha,
    body: { user: rameshId },
  });
  assert.equal(pulled.status, 201, pulled.json.message);

  const row = pulled.json.data.participants.find(
    (participant) => String(participant.user?._id) === String(rameshId)
  );
  assert.ok(row, 'production is in');
  assert.equal(String(row.addedBy._id), String(kavithaId), 'and the record says who opened the door');

  const theirs = await api(`/api/queries/${json.data._id}`, { token: ramesh });
  assert.equal(theirs.status, 200);
});

test('somebody outside the room cannot add themselves', async () => {
  const { json } = await raise();

  const sneaky = await api(`/api/queries/${json.data._id}/participants`, {
    method: 'POST',
    token: priya,
    body: { user: await whoIs(priya) },
  });
  assert.equal(sneaky.status, 404, 'they cannot even see the thread to add to it');
});

test('the same participant twice is refused, in words', async () => {
  const { json } = await raise();
  const again = await api(`/api/queries/${json.data._id}/participants`, {
    method: 'POST', token: nandhini, body: { department: 'despatch' },
  });
  assert.equal(again.status, 409);
  assert.match(again.json.message, /already in this query/i);
});

/* ------------------------------- Saying things ------------------------------- */

test('a reply answers it; a note does not', async () => {
  /*
   * The distinction that makes a thread readable. Collapsing the two gives nine entries and no
   * way to see whether anybody actually answered, which is the state the plant is in now.
   */
  const { json } = await raise();

  const noted = await api(`/api/queries/${json.data._id}/messages`, {
    method: 'POST', token: kavitha, body: { kind: 'note', body: 'Rang the transporter, no answer' },
  });
  assert.equal(noted.status, 201, noted.json.message);
  assert.equal(noted.json.data.status, 'open', 'a note does not answer it');

  const replied = await api(`/api/queries/${json.data._id}/messages`, {
    method: 'POST', token: kavitha, body: { body: '9,000 pcs went on LR-88202, signed for' },
  });
  assert.equal(replied.status, 201, replied.json.message);
  assert.equal(replied.json.data.status, 'answered');
  assert.equal(replied.json.data.messages.length, 2, 'both are in the thread, in order');
  assert.equal(replied.json.data.messages[0].kind, 'note');
  assert.equal(replied.json.data.messages[1].kind, 'reply');
});

/* ------------------------------- Finishing ------------------------------- */

test('only whoever asked may close it', async () => {
  /*
   * An answer that did not answer is the common case. Letting the answerer close is letting
   * them mark their own work.
   */
  const { json } = await raise();
  await api(`/api/queries/${json.data._id}/messages`, {
    method: 'POST', token: kavitha, body: { body: 'It went out on Tuesday, all of it' },
  });

  const theirs = await api(`/api/queries/${json.data._id}/close`, { method: 'POST', token: kavitha });
  assert.equal(theirs.status, 403);
  assert.match(theirs.json.message, /whoever asked/i);

  const asker = await api(`/api/queries/${json.data._id}/close`, { method: 'POST', token: nandhini });
  assert.equal(asker.status, 200, asker.json.message);
  assert.equal(asker.json.data.status, 'closed');
  assert.equal(asker.json.data.closedBy.name, 'Nandhini S');
});

test('a closed thread takes no more replies until somebody re-opens it', async () => {
  /* A reply that silently revives a finished thread is how a closed queue fills back up
     without anybody deciding to. */
  const { json } = await raise();
  await api(`/api/queries/${json.data._id}/close`, { method: 'POST', token: nandhini });

  const late = await api(`/api/queries/${json.data._id}/messages`, {
    method: 'POST', token: kavitha, body: { body: 'One more thing' },
  });
  assert.equal(late.status, 400);
  assert.match(late.json.message, /closed/i);

  const opened = await api(`/api/queries/${json.data._id}/reopen`, { method: 'POST', token: kavitha });
  assert.equal(opened.status, 200, opened.json.message);

  const now = await api(`/api/queries/${json.data._id}/messages`, {
    method: 'POST', token: kavitha, body: { body: 'One more thing' },
  });
  assert.equal(now.status, 201, now.json.message);
});

test('a closed thread cannot be used to grant somebody the customer', async () => {
  /*
   * The same door as the reply rule, and the one that matters more: adding a participant is not
   * only a message, it is an access grant — it opens the buyer's record to them. On a finished
   * question that is a door opened for no live reason, which is the kind nobody notices.
   *
   * Checked against the *customer* rather than the refusal, because the refusal is only the
   * mechanism: what must not happen is somebody gaining sight of a buyer through a thread
   * nobody is working.
   */
  const { json } = await raise();
  await api(`/api/queries/${json.data._id}/close`, { method: 'POST', token: nandhini });

  const Customer = mongoose.model('Customer');
  const before = await Customer.findById(json.data.customer._id).lean();
  const refused = await api(`/api/queries/${json.data._id}/participants`, {
    method: 'POST', token: nandhini, body: { department: 'accounts' },
  });

  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /closed/i);

  const after = await Customer.findById(json.data.customer._id).lean();
  assert.equal(
    (after.sharedWith || []).length,
    (before.sharedWith || []).length,
    'and nobody gained sight of the buyer on the way to that refusal'
  );

  /* Re-opening is the way in: then somebody has decided the thread is live again. */
  await api(`/api/queries/${json.data._id}/reopen`, { method: 'POST', token: nandhini });
  const allowed = await api(`/api/queries/${json.data._id}/participants`, {
    method: 'POST', token: nandhini, body: { department: 'accounts' },
  });
  assert.equal(allowed.status, 201, allowed.json.message);
});

/* ------------------------------- Finding one again ------------------------------- */

test('the list finds a thread by the buyer’s name', async () => {
  /* How people actually look: they remember the company, never QRY-2026-0042. */
  await raise();

  const found = await api('/api/queries?customerName=SCM', { token: nandhini });
  assert.equal(found.status, 200, found.json.message);
  assert.ok(found.json.data.length, 'the buyer’s name finds their threads');
  assert.ok(found.json.data.every((row) => String(row.customer._id) === String(customerId)));

  const nothing = await api('/api/queries?customerName=NoSuchMills', { token: nandhini });
  assert.deepEqual(nothing.json.data, []);
});

test('searching text and being in the room both hold at once', async () => {
  /*
   * Both are `$or`s — the room, and the text search — and one assigned over the other is the
   * second silently winning. That bug returns a *plausible* list, which is the worst kind: a
   * search that quietly shows threads the reader is not in, or a room filter that quietly drops
   * the search. Both directions are checked, because either half winning alone looks fine from
   * the other side.
   *
   * A brand-new person, not one of the fixtures above: an earlier test adds Priya to a thread,
   * and a test that assumes somebody is uninvolved has to make them so rather than hope.
   */
  const made = await api('/api/users', {
    method: 'POST',
    token: admin,
    body: { name: 'Uninvolved M', email: 'uninvolved@np.com', password: 'Pass@123456', department: 'marketing' },
  });
  assert.equal(made.status, 201, made.json.message);
  const outsider = await signIn('uninvolved@np.com', 'Pass@123456');

  /* The room holds even when the search matches everything. */
  const theirs = await api('/api/queries?search=lorry', { token: outsider });
  assert.equal(theirs.status, 200);
  assert.deepEqual(theirs.json.data, [], 'somebody in no thread finds nothing, whatever they type');

  /* And the search holds for somebody who *is* in the room — it narrows rather than being
     replaced by the room filter. */
  const mine = await api('/api/queries?search=lorry', { token: kavitha });
  assert.equal(mine.status, 200);
  assert.ok(mine.json.data.length, 'despatch is in these threads and the word is in them');

  const nonsense = await api('/api/queries?search=zzzznothinglikethis', { token: kavitha });
  assert.deepEqual(nonsense.json.data, [], 'and a word in none of them finds none of them');
});

test('the picker offers departments and the people in them', async () => {
  const { status, json } = await api('/api/queries/options', { token: nandhini });
  assert.equal(status, 200, json.message);

  const despatch = json.data.find((department) => department.key === 'despatch');
  assert.ok(despatch, 'departments are offered');
  assert.ok(despatch.people.some((person) => person.name === 'Kavitha D'), 'and the people in them');
});

/* ------------------------------- Reaching the department ------------------------------- */

test('an unanswered question lands on the asked department’s card', async () => {
  /*
   * The whole feature turns on this. A thread addressed to despatch and read by nobody in
   * despatch is the WhatsApp message it replaces, and it would survive intact if the only way to
   * find one were to open the Queries screen every morning.
   */
  const { json } = await raise({ subject: 'Where did Tuesday’s load go?' });

  const card = await api('/api/workspace/todos/needs-me', { token: kavitha });
  assert.equal(card.status, 200, card.json.message);

  const row = (card.json.data.asked || []).find((query) => query.number === json.data.number);
  assert.ok(row, 'despatch is told, on the card they already read at nine o’clock');
  assert.equal(row.customer.name, 'SCM Garments', 'with the buyer, which is how it is recognised');
  assert.equal(row.raisedBy.name, 'Nandhini S');

  /* The count the heading prints has to include them, or the card says three and shows four. */
  assert.equal(
    card.json.meta.open,
    card.json.data.handedOver.length + card.json.data.urgent.length + card.json.data.asked.length
  );
});

test('a thread you raised is not something you owe', async () => {
  /*
   * The difference between what I am waiting on and what I owe. Mixing them makes the card a
   * list of things that are merely open, which is a list nobody acts on.
   *
   * Asked of *marketing*, which is Nandhini's own department, because that is the only shape
   * where the rule does any work: a question put to despatch never matches her anyway, so a
   * test using one would pass with the rule deleted and prove nothing. Here she is both the
   * asker and inside the department that was asked, and being the asker has to win.
   */
  const { json } = await raise({
    subject: 'Waiting on my own department',
    participants: [{ department: 'marketing' }],
  });

  const hers = await api('/api/workspace/todos/needs-me', { token: nandhini });
  assert.ok(
    !(hers.json.data.asked || []).some((query) => query.number === json.data.number),
    'the asker is waiting, not answering'
  );

  /* And it does reach the colleague it was actually for, or the rule has simply hidden it. */
  const theirs = await api('/api/workspace/todos/needs-me', { token: priya });
  assert.ok(
    (theirs.json.data.asked || []).some((query) => query.number === json.data.number),
    'her marketing colleague owes the answer'
  );
});

test('one reply takes the question off the card', async () => {
  /* The card is what is unanswered, not a second copy of the queue — so it has to empty as the
     department works, on the same signal the thread screen uses. */
  const { json } = await raise({ subject: 'Answer me and I should vanish' });

  await api(`/api/queries/${json.data._id}/messages`, {
    method: 'POST', token: kavitha, body: { body: 'It went on LR-88202' },
  });

  const after = await api('/api/workspace/todos/needs-me', { token: kavitha });
  assert.ok(
    !(after.json.data.asked || []).some((query) => query.number === json.data.number),
    'answered is not outstanding'
  );
});

test('a note does not take it off the card', async () => {
  /* The same distinction the thread screen draws, held here: "rang them, no answer" is not an
     answer, and a card that cleared on it would let a question go quiet without being resolved. */
  const { json } = await raise({ subject: 'A note is not an answer' });

  await api(`/api/queries/${json.data._id}/messages`, {
    method: 'POST', token: kavitha, body: { kind: 'note', body: 'Rang the transporter' },
  });

  const after = await api('/api/workspace/todos/needs-me', { token: kavitha });
  assert.ok(
    (after.json.data.asked || []).some((query) => query.number === json.data.number),
    'still owed'
  );
});

test('the card does not hand queries to somebody without the grant', async () => {
  /*
   * This card sits on the workspace grant, and every query route sits on the queries grant. An
   * access rule that holds on one route and not on a card quoting the same records is not a
   * rule — a department that has had queries taken away would still be reading thread subjects
   * and buyer names off their dashboard every morning.
   */
  const { json } = await raise({ subject: 'Not for somebody without the grant' });

  const people = await api('/api/users?search=kavitha@np.com', { token: admin });
  const kavithaRow = people.json.data[0];
  const had = kavithaRow.moduleAccess;

  const stripped = await api(`/api/users/${kavithaRow.id}/access`, {
    method: 'PUT',
    token: admin,
    body: { moduleAccess: had.filter((grant) => grant.module !== 'queries') },
  });
  assert.equal(stripped.status, 200, stripped.json.message);

  const card = await api('/api/workspace/todos/needs-me', { token: kavitha });
  assert.deepEqual(card.json.data.asked, [], 'nothing comes through the side door');

  /* And the route itself refuses, which is the rule this was keeping faith with. */
  const direct = await api(`/api/queries/${json.data._id}`, { token: kavitha });
  assert.equal(direct.status, 403);

  /* Put it back, so the order these run in cannot change what they mean. */
  await api(`/api/users/${kavithaRow.id}/access`, {
    method: 'PUT', token: admin, body: { moduleAccess: had },
  });
});

/* ------------------------------- The customer map ------------------------------- */

test('the map gathers a buyer’s strands, and only the ones this reader may have', async () => {
  /*
   * The map reaches eight collections at once, which makes it the easiest place in the app to
   * hand somebody a record their grants do not cover. Opening a customer is one permission;
   * knowing what they owe is another, and a picture is not a way round the second.
   *
   * Kavitha is despatch: consignments and orders yes, enquiries, samples, costings and money
   * no. What must not appear is as much the point as what must.
   */
  const { json } = await raise({ subject: 'One for the map' });

  /*
   * Something for the gate to actually withhold. Without this the assertions below are true of
   * an empty database as readily as of a working rule — which is exactly how the first version
   * of this test passed with the gate deleted.
   */
  const enquiry = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      requirement: { modelNumber: 'NPT-400S' },
      nextAction: 'Send the quote',
    },
  });
  assert.equal(enquiry.status, 201, enquiry.json.message);

  const theirsFirst = await api(`/api/customers/${customerId}/map`, { token: nandhini });
  assert.ok(
    theirsFirst.json.data.enquiries.some((row) => row.label === enquiry.json.data.number),
    'marketing, who holds the grant, has it on their map'
  );
  assert.ok(theirsFirst.json.data.totals.enquiries > 0);

  const hers = await api(`/api/customers/${customerId}/map`, { token: kavitha });
  assert.equal(hers.status, 200, hers.json.message);

  assert.ok(
    hers.json.data.queries.some((row) => row.label === json.data.number),
    'a thread she is in is on it'
  );
  assert.deepEqual(hers.json.data.enquiries, [], 'no enquiries — despatch has no such grant');
  assert.deepEqual(hers.json.data.samples, [], 'and no samples');
  assert.deepEqual(hers.json.data.receivables, [], 'and nothing about money');

  /*
   * The counts too. A branch that said "11 receivables" while listing none would hand over the
   * eleven, which is the fact being withheld.
   */
  assert.equal(hers.json.data.totals.receivables, 0);
  assert.equal(hers.json.data.totals.enquiries, 0);

});

test('the map does not show a thread the reader was never in', async () => {
  /*
   * Narrowed twice: by the grant, and then by the room. Priya is marketing and may open plenty
   * of buyers, but a query is private to whoever was asked — and a map must not be the place
   * somebody learns that a conversation about a buyer is going on without them.
   */
  await raise({ subject: 'Not for Priya' });

  /* She has to be able to see the customer at all for the refusal to be about the thread. */
  await api(`/api/customers/${customerId}`, {
    method: 'PATCH', token: admin, body: { assignedTo: await whoIs(priya) },
  });

  const hers = await api(`/api/customers/${customerId}/map`, { token: priya });
  assert.equal(hers.status, 200, hers.json.message);
  assert.ok(
    !hers.json.data.queries.some((row) => row.sublabel === 'Not for Priya'),
    'the thread is not on her map'
  );

  /* Put the buyer back, so the tests after this one mean what they say. */
  await api(`/api/customers/${customerId}`, {
    method: 'PATCH', token: admin, body: { assignedTo: nandhiniId },
  });
});

test('a buyer you cannot see has no map either', async () => {
  /* The same refusal the detail gives, and for the same reason: a map keyed on an id anybody
     can guess would be a way to enumerate the customer master one picture at a time. */
  const theirs = await api('/api/customers/507f1f77bcf86cd799439011/map', { token: kavitha });
  assert.equal(theirs.status, 404);
});
