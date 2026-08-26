/**
 * The dock: personal tasks, the daily reminder, sticky notes and announcements.
 *
 *   node --test tests/workspace.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'workspace-test-secret-value';

let mongo;
let server;
let baseUrl;
let adminToken;
let memberToken;

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

/** A date offset from today, at a fixed hour so it never straddles midnight. */
const days = (offset, hour = 12) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
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
    body: {
      name: 'Navin R',
      email: 'admin@npthangers.com',
      password: 'Admin@12345',
      department: 'management',
    },
  });
  adminToken = await signIn('admin@npthangers.com', 'Admin@12345');

  await api('/api/users', {
    method: 'POST',
    token: adminToken,
    body: {
      name: 'Anita Despatch',
      email: 'despatch@npthangers.com',
      password: 'Desp@123456',
      department: 'despatch',
    },
  });
  memberToken = await signIn('despatch@npthangers.com', 'Desp@123456');
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('a task can be created, completed and deleted', async () => {
  const created = await api('/api/workspace/todos', {
    method: 'POST',
    token: adminToken,
    body: { title: 'Approve velvet sample', dueDate: days(0), priority: 'high' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.data.completed, false);

  const id = created.json.data._id;

  const done = await api(`/api/workspace/todos/${id}`, {
    method: 'PATCH',
    token: adminToken,
    body: { completed: true },
  });
  assert.equal(done.json.data.completed, true);
  assert.ok(done.json.data.completedAt, 'completing stamps the time');

  const reopened = await api(`/api/workspace/todos/${id}`, {
    method: 'PATCH',
    token: adminToken,
    body: { completed: false },
  });
  assert.equal(reopened.json.data.completed, false);
  assert.equal(reopened.json.data.completedAt, undefined, 'reopening clears the stamp');

  const removed = await api(`/api/workspace/todos/${id}`, { method: 'DELETE', token: adminToken });
  assert.equal(removed.status, 200);
});

test('tasks are private to their owner', async () => {
  const created = await api('/api/workspace/todos', {
    method: 'POST',
    token: adminToken,
    body: { title: 'Private to the admin' },
  });
  const id = created.json.data._id;

  const listed = await api('/api/workspace/todos', { token: memberToken });
  assert.ok(
    !listed.json.data.some((todo) => todo._id === id),
    'another user must not see it in their list'
  );

  // Nor reach it directly, even knowing the id.
  const stolen = await api(`/api/workspace/todos/${id}`, {
    method: 'PATCH',
    token: memberToken,
    body: { title: 'Hijacked' },
  });
  assert.equal(stolen.status, 404);
});

test('the daily reminder buckets by overdue, today and tomorrow', async () => {
  const mine = await api('/api/workspace/todos', { token: memberToken });
  for (const todo of mine.json.data) {
    await api(`/api/workspace/todos/${todo._id}`, { method: 'DELETE', token: memberToken });
  }

  const seed = [
    { title: 'Overdue one', dueDate: days(-2) },
    { title: 'Overdue two', dueDate: days(-1) },
    { title: 'Due today', dueDate: days(0, 15) },
    { title: 'Due tomorrow', dueDate: days(1) },
    { title: 'Next week', dueDate: days(7) },
    { title: 'No date at all' },
  ];
  for (const body of seed) {
    await api('/api/workspace/todos', { method: 'POST', token: memberToken, body });
  }

  const { json } = await api('/api/workspace/todos/reminders', { token: memberToken });

  assert.equal(json.data.counts.overdue, 2);
  assert.equal(json.data.counts.today, 1);
  assert.equal(json.data.counts.tomorrow, 1);
  // The badge shows what needs attention now, not what is merely scheduled.
  assert.equal(json.data.counts.actionable, 3);

  const titles = json.data.overdue.concat(json.data.today, json.data.tomorrow).map((t) => t.title);
  assert.ok(!titles.includes('Next week'), 'further-out tasks stay out of the reminder');
  assert.ok(!titles.includes('No date at all'), 'an undated task is not a reminder');
});

test('a completed task drops out of the reminder', async () => {
  const before = await api('/api/workspace/todos/reminders', { token: memberToken });
  const target = before.json.data.today[0];

  await api(`/api/workspace/todos/${target._id}`, {
    method: 'PATCH',
    token: memberToken,
    body: { completed: true },
  });

  const after = await api('/api/workspace/todos/reminders', { token: memberToken });
  assert.equal(after.json.data.counts.today, before.json.data.counts.today - 1);
});

test('sticky notes are created, edited, pinned and deleted', async () => {
  const created = await api('/api/workspace/notes', {
    method: 'POST',
    token: adminToken,
    body: { content: 'Mould M-101 cycle time crept to 31s', colour: 'amber' },
  });
  assert.equal(created.status, 201);

  const id = created.json.data._id;

  const edited = await api(`/api/workspace/notes/${id}`, {
    method: 'PATCH',
    token: adminToken,
    body: { content: 'Mould M-101 — ask Ramesh', colour: 'sky', pinned: true },
  });
  assert.equal(edited.json.data.colour, 'sky');
  assert.equal(edited.json.data.pinned, true);

  // Pinned notes sort to the top of the pad.
  await api('/api/workspace/notes', {
    method: 'POST',
    token: adminToken,
    body: { content: 'Unpinned note' },
  });
  const listed = await api('/api/workspace/notes', { token: adminToken });
  assert.equal(listed.json.data[0]._id, id);

  const removed = await api(`/api/workspace/notes/${id}`, { method: 'DELETE', token: adminToken });
  assert.equal(removed.status, 200);
});

test('an invalid note colour is rejected', async () => {
  const { status } = await api('/api/workspace/notes', {
    method: 'POST',
    token: adminToken,
    body: { content: 'Bad colour', colour: 'chartreuse' },
  });
  assert.equal(status, 400);
});

test('announcements are published by write holders and read by everyone addressed', async () => {
  const created = await api('/api/workspace/announcements', {
    method: 'POST',
    token: adminToken,
    body: {
      title: 'Plant shutdown for annual maintenance',
      body: 'Both moulding lines down from the 12th to the 14th.',
      category: 'urgent',
      pinned: true,
    },
  });

  assert.equal(created.status, 201);
  assert.equal(created.json.data.author.name, 'Navin R');
  assert.equal(created.json.data.read, true, 'the author has read their own notice');

  const seen = await api('/api/workspace/announcements', { token: memberToken });
  assert.equal(seen.status, 200);
  assert.ok(seen.json.data.some((item) => item.id === created.json.data.id));
  assert.equal(seen.json.meta.unread, 1);
  assert.equal(seen.json.meta.canPublish, false, 'despatch may read but not publish');
});

test('a member with read access cannot publish', async () => {
  const { status, json } = await api('/api/workspace/announcements', {
    method: 'POST',
    token: memberToken,
    body: { title: 'Should not appear', body: 'Nope.' },
  });

  assert.equal(status, 403);
  assert.match(json.message, /read-only access/i);
});

test('an announcement addressed to specific departments is hidden from the rest', async () => {
  await api('/api/workspace/announcements', {
    method: 'POST',
    token: adminToken,
    body: {
      title: 'Quality checklist update',
      body: 'Revised inspection checklist takes effect Monday.',
      category: 'quality',
      departments: ['quality', 'production'],
    },
  });

  const despatchSees = await api('/api/workspace/announcements', { token: memberToken });
  assert.ok(
    !despatchSees.json.data.some((item) => item.title === 'Quality checklist update'),
    'despatch is not addressed, so must not see it'
  );

  // The admin is in management, also not addressed — the rule holds for admins too.
  const adminSees = await api('/api/workspace/announcements', { token: adminToken });
  assert.ok(!adminSees.json.data.some((item) => item.title === 'Quality checklist update'));
});

test('marking read clears it from the unread count', async () => {
  const before = await api('/api/workspace/announcements', { token: memberToken });
  assert.ok(before.json.meta.unread > 0);

  const target = before.json.data.find((item) => !item.read);
  const marked = await api(`/api/workspace/announcements/${target.id}/read`, {
    method: 'POST',
    token: memberToken,
  });
  assert.equal(marked.json.data.read, true);

  const after = await api('/api/workspace/announcements', { token: memberToken });
  assert.equal(after.json.meta.unread, before.json.meta.unread - 1);
});

test('an expired announcement disappears', async () => {
  await api('/api/workspace/announcements', {
    method: 'POST',
    token: adminToken,
    body: { title: 'Old notice', body: 'Should not show.', expiresAt: days(-1) },
  });

  const { json } = await api('/api/workspace/announcements', { token: adminToken });
  assert.ok(!json.data.some((item) => item.title === 'Old notice'));
});
