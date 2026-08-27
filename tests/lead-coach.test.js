/**
 * The lead's activity log: what it says, what to do about it, and the scoreboard.
 *
 * Three things are worth testing here and fluency is not one of them. The arithmetic has to
 * be reproducible from the log by hand. The model has to propose and never write. And the
 * scoreboard has to be unfarmable — the whole point of scoring outcomes rather than activity.
 *
 * Anthropic is intercepted, so no test costs a call or touches the network.
 *
 *   node --test tests/lead-coach.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'lead-coach-test-secret';

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let leadLog;
let scoreboard;
let Lead;
let Todo;

const DAY = 24 * 60 * 60 * 1000;

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

let sequence = 0;
async function makeLead(overrides = {}) {
  sequence += 1;
  const { json } = await api('/api/leads', {
    method: 'POST',
    token: nandhini,
    body: {
      company: `Buyer ${sequence}`,
      contactName: 'R Kumar',
      mobile: `98400${String(20000 + sequence).slice(-5)}`,
      ...overrides,
    },
  });
  assert.equal(json.data?._id, json.data?._id);
  return json.data;
}

/** A log written straight to the record, so the clock is the only variable. */
const logged = (id, entries) =>
  Lead.updateOne(
    { _id: id },
    { $set: { activities: entries.map((e) => ({ type: e.type || 'note', summary: e.summary || 'x', occurredAt: e.at })) } }
  );

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  leadLog = await import('../src/services/leadLog.service.js');
  scoreboard = await import('../src/services/scoreboard.service.js');
  ({ default: Lead } = await import('../src/models/Lead.js'));
  ({ default: Todo } = await import('../src/models/Todo.js'));

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
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------ The arithmetic ------------------------------ */

test('the log says how long it has been, and what the usual gap is', async () => {
  const now = Date.now();
  const lead = await makeLead();
  await logged(lead._id, [
    { at: new Date(now - 30 * DAY), type: 'call' },
    { at: new Date(now - 20 * DAY), type: 'whatsapp' },
    { at: new Date(now - 10 * DAY), type: 'whatsapp' },
  ]);

  const stats = leadLog.analyse(await Lead.findById(lead._id), now);

  assert.equal(stats.total, 3);
  assert.equal(stats.daysSinceContact, 10);
  assert.equal(stats.cadenceDays, 10, 'two gaps of ten days');
  assert.equal(stats.spanDays, 20);
  assert.equal(stats.twoWayContacts, 1, 'only the call was two-way');
  assert.deepEqual(stats.byChannel, { call: 1, whatsapp: 2 });
});

test('"cooling" is measured against the lead\'s own rhythm, not a fixed number of days', async () => {
  /*
   * A buyer worked weekly who has gone quiet for three weeks is in trouble; a buyer worked
   * monthly at three weeks is not. One threshold for both would be wrong for whichever it was
   * not written for.
   */
  const now = Date.now();

  const weekly = await makeLead();
  await logged(weekly._id, [
    { at: new Date(now - 35 * DAY) },
    { at: new Date(now - 28 * DAY) },
    { at: new Date(now - 21 * DAY) },
  ]);

  const monthly = await makeLead();
  await logged(monthly._id, [
    { at: new Date(now - 81 * DAY) },
    { at: new Date(now - 51 * DAY) },
    { at: new Date(now - 21 * DAY) },
  ]);

  assert.equal(leadLog.analyse(await Lead.findById(weekly._id), now).cooling, true);
  assert.equal(
    leadLog.analyse(await Lead.findById(monthly._id), now).cooling,
    false,
    'three weeks is normal for this one'
  );
});

test('messages sent into silence do not read as a conversation', async () => {
  // The figure that usually explains a lead that has "been worked for months".
  const now = Date.now();
  const lead = await makeLead();
  await logged(lead._id, Array.from({ length: 6 }, (_, i) => ({
    at: new Date(now - (12 - i) * DAY),
    type: 'whatsapp',
  })));

  const stats = leadLog.analyse(await Lead.findById(lead._id), now);
  assert.equal(stats.total, 6);
  assert.equal(stats.twoWayContacts, 0, 'one thing tried six times');
});

/* ------------------------------- Propose only ------------------------------- */

test('the suggestion writes nothing to the lead', async () => {
  /*
   * The whole safety design. A misread has to cost a suggestion somebody declines, not a
   * wrong follow-up date on a real buyer that nobody can tell a model set.
   */
  const lead = await makeLead({ nextAction: 'Call about the 400mm', nextFollowUpDate: new Date(Date.now() + 3 * DAY) });
  const before = await Lead.findById(lead._id);

  const { status, json } = await api(`/api/leads/${lead._id}/suggest`, { method: 'POST', token: nandhini });
  assert.equal(status, 200);
  assert.ok(json.data.nextAction, 'it proposes one');

  const after = await Lead.findById(lead._id);
  assert.equal(after.nextAction, before.nextAction, 'and changed nothing');
  assert.deepEqual(after.nextFollowUpDate, before.nextFollowUpDate);
  assert.equal(after.status, before.status);
});

test('with no key it still answers, from the arithmetic', async () => {
  // A marketing person pressing this in the middle of a call should get an answer, and the
  // things that are simply true of a stalled lead are most of what needs saying.
  const now = Date.now();
  const lead = await makeLead();
  await logged(lead._id, Array.from({ length: 5 }, (_, i) => ({
    at: new Date(now - (30 - i * 2) * DAY),
    type: 'whatsapp',
  })));

  const { json } = await api(`/api/leads/${lead._id}/suggest`, { method: 'POST', token: nandhini });

  assert.equal(json.data.readBy, 'rules');
  assert.equal(json.meta.model, false, 'and says the model is not configured');
  assert.match(
    json.data.blockers.join(' '),
    /one-way|nobody has actually spoken/i,
    `got: ${json.data.blockers.join(' | ')}`
  );
  assert.equal(json.data.nextActionType, 'call');
});

test('a colleague cannot ask about a lead they cannot open', async () => {
  await api('/api/users', {
    method: 'POST',
    token: admin,
    body: { name: 'Priya R', email: 'priya@np.com', password: 'Passw0rd@123', department: 'marketing' },
  });
  const priya = await signIn('priya@np.com', 'Passw0rd@123');

  const lead = await makeLead();
  const { status } = await api(`/api/leads/${lead._id}/suggest`, { method: 'POST', token: priya });
  assert.equal(status, 404);
});

/* -------------------------------- Reminders -------------------------------- */

test('setting a next step puts a reminder in the owner’s list', async () => {
  // A date nobody is shown is a date nobody keeps. It sat in a field until now.
  const lead = await makeLead({
    nextAction: 'Call about the 400mm shoulder',
    nextActionType: 'call',
    nextFollowUpDate: new Date(Date.now() + 2 * DAY),
  });

  const task = await Todo.findOne({ originKey: `lead:${lead._id}:followup`, completed: false });
  assert.ok(task, 'a reminder was raised');
  assert.match(task.title, /^Call /);
  assert.match(task.title, new RegExp(lead.company));
  assert.equal(task.notes, 'Call about the 400mm shoulder');
  assert.ok(task.link.endsWith(String(lead._id)));
});

test('moving the date replaces the reminder rather than adding one', async () => {
  /*
   * Keyed on the date as well, a lead pushed three times would leave three reminders — and a
   * list with three lines for one lead is a list people stop opening.
   */
  const lead = await makeLead({ nextAction: 'Call them', nextFollowUpDate: new Date(Date.now() + DAY) });

  await api(`/api/leads/${lead._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { nextFollowUpDate: new Date(Date.now() + 5 * DAY), nextAction: 'Call them after Pongal' },
  });

  const open = await Todo.find({ originKey: `lead:${lead._id}:followup`, completed: false });
  assert.equal(open.length, 1, 'one reminder, not two');
  assert.equal(open[0].notes, 'Call them after Pongal');
});

test('clearing the date clears the reminder — and null means cleared', async () => {
  /*
   * `z.coerce.date()` turns null into one January 1970, which is a valid Date and passes. So
   * clearing a follow-up did not clear it: it set the date to fifty-six years ago, where it
   * sat permanently overdue raising a reminder nobody could remove, because the field they
   * would clear looked set.
   */
  const lead = await makeLead({ nextAction: 'Call them', nextFollowUpDate: new Date(Date.now() + DAY) });
  assert.ok(await Todo.findOne({ originKey: `lead:${lead._id}:followup`, completed: false }));

  await api(`/api/leads/${lead._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { nextFollowUpDate: null },
  });

  const after = await Lead.findById(lead._id);
  assert.equal(after.nextFollowUpDate, null, 'cleared, not set to the epoch');
  assert.equal(
    await Todo.countDocuments({ originKey: `lead:${lead._id}:followup`, completed: false }),
    0,
    'a task list that still chases finished work is one people learn to skim'
  );
});

test('a lead that is won or written off stops reminding anybody', async () => {
  const lead = await makeLead({ nextAction: 'Call them', nextFollowUpDate: new Date(Date.now() + DAY) });

  await api(`/api/leads/${lead._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { status: 'disqualified', disqualifyReason: 'no_response' },
  });

  assert.equal(
    await Todo.countDocuments({ originKey: `lead:${lead._id}:followup`, completed: false }),
    0,
    'the work has been decided against; the reminder should not outlive the decision'
  );
});

test('logging a call can set the next step in the same submission', async () => {
  // The moment somebody records a call is the moment they know what happens next. A second
  // dialog to say so is where the next step quietly stops being set.
  const lead = await makeLead();

  const { status, json } = await api(`/api/leads/${lead._id}/activities`, {
    method: 'POST',
    token: nandhini,
    body: {
      type: 'call',
      summary: 'Spoke to the merchandiser, wants a 400mm sample',
      nextAction: 'Raise the sample request',
      nextActionType: 'send_sample',
      nextFollowUpDate: new Date(Date.now() + 2 * DAY),
    },
  });

  assert.equal(status, 201, json.message);
  assert.equal(json.data.nextAction, 'Raise the sample request');
  assert.equal(json.data.status, 'contacted', 'and logging contact is itself progress');
  assert.ok(json.meta.log.total >= 1, 'the reply carries the fresh log figures');

  const task = await Todo.findOne({ originKey: `lead:${lead._id}:followup`, completed: false });
  assert.match(task.title, /^Send a sample to /);
});

/* ------------------------------- Follow-ups ------------------------------- */

test('the queue keeps the four failures apart, because they have different fixes', async () => {
  await Lead.deleteMany({});
  const now = Date.now();

  await makeLead({ company: 'Overdue Mills', nextAction: 'Call', nextFollowUpDate: new Date(now - 4 * DAY) });
  await makeLead({ company: 'Due Today Ltd', nextAction: 'Call', nextFollowUpDate: new Date(now + 60 * 1000) });
  await makeLead({ company: 'Undecided Exports' });

  const quiet = await makeLead({ company: 'Quiet Knits', nextAction: 'Call', nextFollowUpDate: new Date(now + 30 * DAY) });
  await logged(quiet._id, [
    { at: new Date(now - 40 * DAY) },
    { at: new Date(now - 33 * DAY) },
    { at: new Date(now - 26 * DAY) },
  ]);

  const { json } = await api('/api/leads/follow-ups', { token: nandhini });
  const { overdue, dueToday, noNextAction, goneQuiet } = json.data;

  assert.equal(overdue.length, 1, `overdue: ${overdue.map((r) => r.company)}`);
  assert.equal(overdue[0].company, 'Overdue Mills');
  assert.ok(overdue[0].overdueByDays >= 3);

  assert.ok(dueToday.some((row) => row.company === 'Due Today Ltd'), 'due today');
  assert.ok(noNextAction.some((row) => row.company === 'Undecided Exports'), 'nobody decided anything');
  assert.ok(
    goneQuiet.some((row) => row.company === 'Quiet Knits'),
    'not late by its own date, and cooling against its own rhythm'
  );
});

/* ------------------------------- The scoreboard ------------------------------- */

test('the streak counts days something moved, not entries', async () => {
  /*
   * The distinction the whole scoreboard rests on. A tenth call today must do nothing for it,
   * or the streak becomes another thing to farm.
   */
  const now = new Date('2026-08-26T12:00:00Z').getTime(); // a Wednesday

  const oneEach = [
    new Date('2026-08-26T09:00:00Z'),
    new Date('2026-08-25T09:00:00Z'),
    new Date('2026-08-24T09:00:00Z'),
  ];
  const tenToday = [
    ...Array.from({ length: 10 }, () => new Date('2026-08-26T09:00:00Z')),
    new Date('2026-08-25T09:00:00Z'),
    new Date('2026-08-24T09:00:00Z'),
  ];

  assert.equal(scoreboard.streakFrom(oneEach, now), 3);
  assert.equal(scoreboard.streakFrom(tenToday, now), 3, 'ten in a day is still one day');
});

test('the streak survives Sunday, and survives not having started today', async () => {
  const monday = new Date('2026-08-24T12:00:00Z').getTime();
  // Saturday and Friday worked; Sunday is the plant's day off and is skipped.
  const days = [new Date('2026-08-22T09:00:00Z'), new Date('2026-08-21T09:00:00Z')];

  assert.equal(scoreboard.streakFrom(days, monday), 2, 'a streak that resets every Monday measures nothing');
});

test('the scoreboard ranks on outcomes, and shows contacts without scoring them', async () => {
  const { json } = await api('/api/leads/scoreboard', { token: nandhini });
  const mine = json.data.mine;

  for (const field of ['streakDays', 'convertedThisMonth', 'wonThisMonth', 'promisesKeptPercent']) {
    assert.ok(field in mine, `missing ${field}`);
  }
  assert.ok('contactsThisMonth' in mine, 'shown as context');
  assert.equal(json.data.team, null, 'a marketing person sees their own card, not the team');
});

test('management sees the team, ranked on conversions', async () => {
  const { json } = await api('/api/leads/scoreboard', { token: admin });
  assert.ok(Array.isArray(json.data.team), 'management sees the team');
});

/* ------------------------------- The lead book ------------------------------- */

test('the funnel keeps stage order, because a sorted funnel is not a funnel', async () => {
  await Lead.deleteMany({});
  await makeLead({ status: 'new' });
  await makeLead();
  await makeLead();
  const qualified = await makeLead();
  await api(`/api/leads/${qualified._id}`, { method: 'PATCH', token: nandhini, body: { status: 'qualified' } });

  const { json } = await api('/api/leads/overview', { token: nandhini });

  assert.deepEqual(
    json.data.byStage.map((row) => row.label),
    ['new', 'contacted', 'qualified', 'converted', 'disqualified'],
    'sorted by size it would be a bar chart that lost the thing it was drawing'
  );
  assert.equal(json.data.total, 4);
});

test('a rate never appears without its denominator', async () => {
  /*
   * The commonest way a dashboard misleads without saying anything false: 100% of two leads
   * is not a track record, and a percentage alone cannot say so.
   */
  const { json } = await api('/api/leads/overview', { token: nandhini });

  assert.ok('decided' in json.data, 'the denominator is returned beside the rate');
  assert.ok('converted' in json.data);
  if (json.data.conversionRatePercent !== null) {
    assert.ok(json.data.decided > 0, 'a rate implies something was decided');
  }
});

test('an open lead nobody has touched is an anomaly, however its status reads', async () => {
  // A status field says "contacted" forever. This is what says otherwise.
  await Lead.deleteMany({});
  const now = Date.now();

  const ghost = await makeLead({ company: 'Ghost Mills' });
  await logged(ghost._id, [{ at: new Date(now - 40 * DAY), type: 'call' }]);
  await Lead.updateOne({ _id: ghost._id }, { $set: { status: 'contacted' } });

  await makeLead({ company: 'Worked Yesterday Ltd' });

  const { json } = await api('/api/leads/overview', { token: nandhini });
  const flagged = json.data.untouchedLeads;

  assert.equal(flagged.length, 1, `got: ${flagged.map((r) => r.company)}`);
  assert.equal(flagged[0].company, 'Ghost Mills');
  assert.equal(flagged[0].status, 'contacted', 'which is exactly why the status could not tell you');
  assert.ok(flagged[0].idleDays >= 40);
  assert.match(flagged[0].reason, /No contact for/);
});

test('a lead never contacted at all says so, rather than reading as quiet', async () => {
  await Lead.deleteMany({});
  const never = await makeLead({ company: 'Never Called Exports' });
  // Through the raw collection: Mongoose's timestamps middleware rewrites createdAt on a
  // model update, so the backdate silently did not happen.
  await mongoose.connection
    .collection('leads')
    .updateOne(
      { _id: new mongoose.Types.ObjectId(String(never._id)) },
      { $set: { createdAt: new Date(Date.now() - 30 * DAY) } }
    );

  const { json } = await api('/api/leads/overview', { token: nandhini });
  assert.equal(json.data.untouchedLeads.length, 1);
  assert.match(json.data.untouchedLeads[0].reason, /Never contacted/);
  assert.equal(json.data.untouchedLeads[0].contacts, 0);
});

test('management is told about a quiet lead, and not every morning', async () => {
  /*
   * A lead is going to sit for a fortnight by definition. A fresh task each day for the same
   * one is how a manager learns to clear this list without reading it — so it is keyed on the
   * week of silence, and speaks again when the silence gets a week worse.
   */
  await Lead.deleteMany({});
  await Todo.deleteMany({});
  const now = Date.now();

  const quiet = await makeLead({ company: 'Quiet Mills' });
  await logged(quiet._id, [{ at: new Date(now - 20 * DAY) }]);

  const anomaly = await import('../src/services/anomaly.service.js');
  await anomaly.runLeadStaleSweep({ now });
  await anomaly.runLeadStaleSweep({ now });

  const raised = await Todo.find({ originKey: /:stale:/, completed: false });
  assert.equal(raised.length, 1, 'not raised twice on the same day');
  assert.match(raised[0].title, /Quiet Mills has gone quiet/);
  assert.equal(raised[0].priority, 'high');

  // A week worse is news again.
  await anomaly.runLeadStaleSweep({ now: now + 8 * DAY });
  assert.equal(await Todo.countDocuments({ originKey: /:stale:/, completed: false }), 2);
});

test('the owner is not told — they have had it on their screen for a fortnight', async () => {
  await Lead.deleteMany({});
  await Todo.deleteMany({});
  const now = Date.now();

  const quiet = await makeLead();
  await logged(quiet._id, [{ at: new Date(now - 20 * DAY) }]);

  const anomaly = await import('../src/services/anomaly.service.js');
  await anomaly.runLeadStaleSweep({ now });

  const nandhiniUser = await mongoose.connection
    .collection('users')
    .findOne({ email: 'nandhini@np.com' });

  assert.equal(
    await Todo.countDocuments({ user: nandhiniUser._id, originKey: /:stale:/ }),
    0,
    'telling them again is not new information; management is who can reassign or write it off'
  );
});
