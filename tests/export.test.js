/**
 * The export button every list screen needs.
 *
 * The interesting parts are not the commas. They are that the file opens correctly on the
 * Windows desktops it lands on, that a remarks field cannot execute when somebody opens it,
 * and that an export is a read — it must not hand somebody rows their screen would not show.
 *
 *   node --test tests/export.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'export-test-secret';

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let priya;
let cell;

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

const download = async (path, token) => {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    disposition: response.headers.get('content-disposition'),
    // Bytes, not text: the UTF-8 decoder strips a leading BOM, so `.text()` cannot tell you
    // whether the file has one — and the BOM is the whole point on a Windows desktop.
    bytes: new Uint8Array(await response.clone().arrayBuffer()),
    body: await response.text(),
  };
};

const signIn = async (email, password) => {
  const { json } = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  return json.data?.token;
};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  ({ cell } = await import('../src/utils/csv.js'));

  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' },
  });
  admin = await signIn('admin@np.com', 'Admin@12345');

  for (const [name, email] of [['Nandhini S', 'nandhini@np.com'], ['Priya R', 'priya@np.com']]) {
    await api('/api/users', {
      method: 'POST',
      token: admin,
      body: { name, email, password: 'Passw0rd@123', department: 'marketing' },
    });
  }
  nandhini = await signIn('nandhini@np.com', 'Passw0rd@123');
  priya = await signIn('priya@np.com', 'Passw0rd@123');

  await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: {
      name: 'Sri Vēnkatēswara Exports, Ltd',
      customerType: 'exporter',
      mobile: '9876500101',
      // The two things that break a CSV: a separator inside a field, and a formula.
      notes: '=cmd|"/c calc"!A1',
    },
  });

  await api('/api/customers', {
    method: 'POST',
    token: priya,
    body: { name: 'Not Yours Ltd', customerType: 'retailer', mobile: '9876500202' },
  });
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* -------------------------------- The file -------------------------------- */

test('a separator inside a field cannot end it early', () => {
  assert.equal(cell('Sri Vēnkatēswara Exports, Ltd'), '"Sri Vēnkatēswara Exports, Ltd"');
  assert.equal(cell('He said "no"'), '"He said ""no"""');
  assert.equal(cell('Line one\nLine two'), '"Line one\nLine two"');
});

test('a field that starts like a formula is kept as text', () => {
  // CSV injection: a cell beginning `=`, `+`, `-` or `@` is executed on open, and the field
  // it turns up in is the free-text one somebody pasted from an email.
  for (const dangerous of ['=1+1', '+1', '-1', '@SUM(A1)']) {
    assert.match(cell(dangerous), /^'/, `${dangerous} was left executable`);
  }
});

test('it arrives as a download Excel can read', async () => {
  const file = await download('/api/customers/export', nandhini);

  assert.equal(file.status, 200);
  assert.match(file.type, /text\/csv/);
  assert.match(file.disposition, /attachment; filename="customers-\d{4}-\d{2}-\d{2}\.csv"/);
  // The byte-order mark, without which Excel reads UTF-8 as the local codepage and every
  // non-ASCII name arrives as mojibake.
  assert.deepEqual(
    Array.from(file.bytes.slice(0, 3)),
    [0xef, 0xbb, 0xbf],
    'no BOM: Excel will read UTF-8 as the local codepage and mangle every name'
  );
  assert.match(file.body, /Sri Vēnkatēswara/);
});

/* ------------------------------ It is a read ------------------------------ */

test('an export shows what the screen would show, and no more', async () => {
  const mine = await download('/api/customers/export', nandhini);

  assert.match(mine.body, /Sri Vēnkatēswara/);
  assert.doesNotMatch(mine.body, /Not Yours Ltd/, "a colleague's customer is not in my export");

  // Management is not ownership-scoped and gets both, exactly as on screen.
  const all = await download('/api/customers/export', admin);
  assert.match(all.body, /Not Yours Ltd/);
});

test('an export carries the filters the screen is on', async () => {
  // Exporting "the retailers" and getting everybody is worse than no export, because the
  // file looks right.
  const filtered = await download('/api/customers/export?customerType=retailer', admin);

  assert.match(filtered.body, /Not Yours Ltd/);
  assert.doesNotMatch(filtered.body, /Sri Vēnkatēswara/);
});

test('a department without the grant cannot export around it', async () => {
  await api('/api/users', {
    method: 'POST',
    token: admin,
    body: { name: 'Karthik V', email: 'karthik@np.com', password: 'Passw0rd@123', department: 'production' },
  });
  const karthik = await signIn('karthik@np.com', 'Passw0rd@123');

  const { status } = await download('/api/customers/export', karthik);
  assert.equal(status, 403);
});
