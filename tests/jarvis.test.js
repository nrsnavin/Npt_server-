/**
 * Ask Jarvis — the parser, the answers, and the two ways an assistant becomes worthless.
 *
 * It becomes worthless by being confidently wrong, and by reaching past the permission
 * system. Most of what follows is about those two rather than about fluency.
 *
 *   node --test tests/jarvis.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'jarvis-test-secret-value';

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;   // marketing
let priya;      // marketing — a colleague, must not appear in Nandhini's answers
let meera;      // sampling
let parse;
let customerId;
let mouldId;

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

/** The whole feature, from the reader's side: a sentence back. */
const ask = async (message, token) => {
  const { json } = await api('/api/jarvis/ask', { method: 'POST', token, body: { message } });
  return json.data || {};
};

const soon = (days = 3) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
};
const followUp = { nextAction: 'Call the buyer', nextFollowUpDate: soon() };

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  ({ parse } = await import('../src/services/jarvis.intents.js'));

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
    ['Meera B', 'meera@np.com', 'sampling'],
  ]) {
    await api('/api/users', {
      method: 'POST',
      token: admin,
      body: { name, email, password: 'Passw0rd@123', department },
    });
  }
  nandhini = await signIn('nandhini@np.com', 'Passw0rd@123');
  priya = await signIn('priya@np.com', 'Passw0rd@123');
  meera = await signIn('meera@np.com', 'Passw0rd@123');

  mouldId = (await api('/api/moulds', {
    method: 'POST',
    token: admin,
    body: {
      mouldCode: 'M-NPT-400S', name: 'Shirt Hanger 400mm', category: 'shirt', sizeMm: 400, material: 'plastic',
      /* Measured facts, which the register will not take a model without. */
      cavities: 4, partWeightGrams: 26, cycleTimeSeconds: 28, moq: 5000,
    },
  })).json.data._id;

  customerId = (await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'Trendline Apparels', mobile: '9840011221', customerType: 'garment_factory' },
  })).json.data._id;

  // A live pipeline to ask about. Without one, "how many are open" answers "nothing" and
  // every assertion about counts passes for the wrong reason.
  for (const [model, quantity] of [['NPT-400S', 5000], ['NPT-420T', 12000]]) {
    const created = await api('/api/enquiries', {
      method: 'POST',
      token: nandhini,
      body: {
        customer: customerId,
        mould: mouldId,
        requirement: { modelNumber: model, quantity },
        ...followUp,
      },
    });
    assert.equal(created.status, 201, created.json.message);
  }
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* -------------------------------- The parse -------------------------------- */

test('a document number is understood however it is typed', () => {
  // People say it the way it is written on the job card, and the sequence is zero-padded in
  // the database. A lookup that fails on the spoken form is one nobody uses twice.
  for (const typed of ['SMP-2026-0004', 'smp 2026 4', 'where is SMP2026-0004?', 'SMP-2026-4']) {
    assert.equal(parse(typed).entities.reference, 'SMP-2026-0004', typed);
    assert.equal(parse(typed).subject, 'samples', typed);
  }
});

test('a number is a question about that record, whatever else was said', () => {
  // "SMP-2026-0004 overdue?" reads as lateness to the aspect matcher, but the reader is
  // holding one sample. The record's own answer says whether it is late anyway.
  assert.equal(parse('is SMP-2026-0004 overdue?').aspect, 'record');
});

test('overdue beats open, because "which open samples are late" is about lateness', () => {
  assert.equal(parse('which open samples are late').aspect, 'overdue');
  assert.equal(parse('how many samples are open').aspect, 'open');
});

test('the window is read from the question, and defaults out loud', () => {
  assert.equal(parse('any new enquiries today').entities.window.days, 1);
  assert.equal(parse('new enquiries this month').entities.window.days, 30);

  const unstated = parse('any new enquiries').entities.window;
  assert.equal(unstated.days, 7);
  assert.equal(unstated.stated, false, 'so the answer can say which span it used');
});

test('a named party is picked out of the sentence, and grammar is not', () => {
  assert.equal(parse('what is happening with Trendline Apparels').entities.party, 'Trendline Apparels');
  assert.equal(parse('anything on "Sunrise Exports"?').entities.party, 'Sunrise Exports');
  assert.equal(parse('status of the samples').entities.party, null, '"the" is not a customer');
});

/* ------------------------- Never confidently wrong ------------------------- */

test('a module that does not exist is said so, never answered as zero', async () => {
  /*
   * The single most important answer here. An administrator asks how many orders are pending,
   * reads "0", and concludes there is no pending work — when in truth the orders module has
   * not been written. A wrong number nobody can tell is wrong is worse than no feature.
   */
  for (const question of ['how many orders are pending', 'any new orders this week', 'status of quotations']) {
    const { answer } = await ask(question, admin);
    assert.doesNotMatch(answer, /\b0\b|\bno orders\b|\bnothing\b/i, `"${question}" answered: ${answer}`);
    assert.match(answer, /not built yet|later phase/i, `"${question}" answered: ${answer}`);
  }
});

test('a subject it understood with an aspect it did not says which half is missing', async () => {
  // "I did not understand" would send the reader off rephrasing a question that was clear.
  const { answer } = await ask('samples', admin);
  assert.match(answer, /asking about samples/i);
  assert.match(answer, /overdue/i, 'and offers what it can actually answer');
});

test('a question about nothing in particular does not guess', async () => {
  const { answer } = await ask('what is going on', admin);
  assert.match(answer, /did not catch/i);
  assert.doesNotMatch(answer, /\d+ samples?\b/i, 'a summary nobody asked for is a wrong answer');
});

test('two customers matching one name are reported, not resolved to the first', async () => {
  // Picking one would answer about a different customer than the one meant, and every figure
  // after that is wrong in a way the reader cannot see.
  await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'Trendline Exports', mobile: '9840011999' },
  });

  const { answer, rows } = await ask('what is happening with Trendline', admin);
  assert.match(answer, /2 customers match/i, answer);
  assert.equal(rows.length, 2, 'and both are offered');
});

/* --------------------------------- Answers --------------------------------- */

test('a sample is answered with its stage, its buyer and who is holding it', async () => {
  const raised = await api('/api/samples', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      mould: mouldId,
      modelNumber: 'NPT-400S',
      quantity: 6,
      standaloneReason: 'Buyer asked at the counter',
    },
  });
  assert.equal(raised.status, 201, raised.json.message);
  const sample = raised.json.data;

  const { answer, rows } = await ask(`where is ${sample.number}`, admin);
  assert.match(answer, new RegExp(sample.number));
  assert.match(answer, /Trendline Apparels/);
  assert.match(answer, /nobody has picked it up/i, 'an unassigned sample says so plainly');
  assert.equal(rows[0].link, `/samples/${sample._id}`, 'every figure carries the record behind it');
});

test('overdue names the oldest, because that is the one somebody acts on', async () => {
  await api('/api/samples', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      modelNumber: 'Late shape',
      quantity: 4,
      standaloneReason: 'Trial',
    },
  });

  // Backdate it so there is something genuinely late.
  const late = new Date();
  late.setDate(late.getDate() - 11);
  await mongoose.connection
    .collection('samples')
    .updateOne({ modelNumber: 'Late shape' }, { $set: { requiredDate: late } });

  const { answer, rows } = await ask('what is overdue on the bench', admin);
  assert.match(answer, /overdue/i, answer);
  assert.match(answer, /11 days/, `the age is the actionable part: ${answer}`);
  assert.ok(rows.length, 'with the records behind it');
});

test('new enquiries answer within a window, and name the window used', async () => {
  const { answer, total } = await ask('any new enquiries this week', admin);
  assert.ok(total >= 2, `expected the two just raised, got: ${answer}`);
  assert.match(answer, /new enquiries/i, answer);
  assert.match(answer, /last 7 days/i, 'so nobody assumes a different span than they were given');

  // And a window with nothing in it says so, rather than reporting the default span's count.
  const none = await ask('any new leads today', admin);
  assert.match(none.answer, /no new leads today/i, none.answer);
});

test('a count says the shape of the pile, not only its size', async () => {
  const { answer, total } = await ask('how many enquiries are open', admin);
  assert.match(answer, /enquiries open/i, answer);
  assert.ok(total >= 1);
  // "12 open" is a number; "5 new, 4 sample required" is where the work actually is.
  assert.match(answer, /:/, `expected a stage breakdown, got: ${answer}`);
});

test('a customer question gathers every module that has something open', async () => {
  const { answer, rows } = await ask('what is happening with Trendline Apparels', admin);
  assert.match(answer, /Trendline Apparels/);
  assert.match(answer, /open enquir/i, answer);
  assert.ok(rows.some((row) => row.link.startsWith('/samples/')), 'samples as well as enquiries');
});

/* ------------------------------- Permissions ------------------------------- */

test('only an administrator may ask', async () => {
  // It answers across every module at once, which is a management view of the plant rather
  // than anybody's own screen.
  for (const [who, token] of [['marketing', nandhini], ['the bench', meera]]) {
    const { status, json } = await api('/api/jarvis/ask', {
      method: 'POST',
      token,
      body: { message: 'what is overdue on the bench' },
    });
    assert.equal(status, 403, `${who} was answered: ${JSON.stringify(json)}`);
  }

  const allowed = await api('/api/jarvis/ask', {
    method: 'POST',
    token: admin,
    body: { message: 'what is overdue on the bench' },
  });
  assert.equal(allowed.status, 200);
});

test('the scoping under the gate is still real', async () => {
  /*
   * An administrator bypasses ownership, so the filters inside the answers change nothing
   * today. They are tested anyway: the day this opens to marketing, a permission model
   * retro-fitted to a feature that has been running without one is how a colleague's book
   * ends up in somebody else's answer. Called directly, since the route is gated.
   */
  const { answer } = await import('../src/services/jarvis.service.js');
  const { default: User } = await import('../src/models/User.js');
  const priyaUser = await User.findOne({ email: 'priya@np.com' });

  const parsed = {
    subject: 'customers',
    aspect: 'status',
    entities: { reference: null, party: 'Trendline Apparels', window: { days: 7, label: '', stated: false } },
    text: 'what is happening with Trendline Apparels',
  };

  const asColleague = await answer(priyaUser, parsed);
  assert.match(asColleague.answer, /cannot find/i, asColleague.answer);
  assert.equal(asColleague.rows.length, 0);
});

test('a grant nobody holds is explained rather than silently empty', async () => {
  /*
   * "Nothing open" and "you cannot see this" are different statements, and only one of them
   * is true. Answering the first would tell somebody the pipeline is empty when in fact it is
   * none of their business — and they would repeat it in a meeting.
   */
  const { answer } = await import('../src/services/jarvis.service.js');
  const { default: User } = await import('../src/models/User.js');

  const narrow = await User.create({
    name: 'Bench Only',
    email: `benchonly${Date.now()}@np.com`,
    password: 'Passw0rd@123',
    department: 'sampling',
    moduleAccess: [{ module: 'samples', level: 'write' }],
  });

  const reply = await answer(narrow, {
    subject: 'enquiries',
    aspect: 'open',
    entities: { reference: null, party: null, window: { days: 7, label: '', stated: false } },
    text: 'how many enquiries are open',
  });

  assert.match(reply.answer, /do not have access/i, reply.answer);
  assert.doesNotMatch(reply.answer, /nothing|\b0\b/i, 'silence would read as an empty pipeline');
});

/* --------------------------------- Shape --------------------------------- */

test('it says what it understood, so a wrong answer can be debugged', async () => {
  const { understood } = await ask('what is overdue on the bench', admin);
  assert.equal(understood.subject, 'samples');
  assert.equal(understood.aspect, 'overdue');
  // Which parser read it, so a wrong answer can be pinned on the model or the fallback.
  assert.equal(understood.readBy, 'rules', 'no key is configured in the suite, so it never calls out');
});

test('an empty or oversized question is refused rather than guessed at', async () => {
  const empty = await api('/api/jarvis/ask', { method: 'POST', token: admin, body: { message: '  ' } });
  assert.equal(empty.status, 400);

  const long = await api('/api/jarvis/ask', {
    method: 'POST',
    token: admin,
    body: { message: 'a'.repeat(501) },
  });
  assert.equal(long.status, 400);
});

test('it needs a session, like everything else', async () => {
  const { status } = await api('/api/jarvis/ask', { method: 'POST', body: { message: 'what is overdue' } });
  assert.equal(status, 401);
});
