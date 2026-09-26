/**
 * Sending a quotation: the dialog opens pre-filled, whatever the sender edits is what goes, and
 * the quote is marked sent only when it actually went.
 *
 * A small SMTP server in this file receives the mail, so the attachment is checked for real.
 *
 *   node --test tests/quotation-send.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

/* -------- A mail server just big enough to take one message at a time -------- */
const mails = [];
const smtp = net.createServer((socket) => {
  let data = false;
  let buffer = '';
  const say = (line) => socket.write(`${line}\r\n`);
  say('220 test ESMTP');
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    if (data) {
      const end = buffer.indexOf('\r\n.\r\n');
      if (end < 0) return;
      mails.push(buffer.slice(0, end));
      buffer = buffer.slice(end + 5);
      data = false;
      say('250 queued');
    }
    let at;
    while (!data && (at = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const verb = line.slice(0, 4).toUpperCase();
      if (verb === 'EHLO' || verb === 'HELO') say('250 test');
      else if (verb === 'MAIL' || verb === 'RCPT' || verb === 'RSET' || verb === 'NOOP') say('250 ok');
      else if (verb === 'DATA') { data = true; say('354 go ahead'); }
      else if (verb === 'QUIT') { say('221 bye'); socket.end(); }
      else say('250 ok');
    }
  });
});
await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));

process.env.JWT_SECRET = 'quotation-send-test-secret';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(smtp.address().port);
process.env.SMTP_FROM = 'sales@navinhangers.com';
delete process.env.SMTP_USER;

/* WhatsApp is not configured here, so a WhatsApp send is printed — and the PDF link with it. */
const printed = [];
const log = console.log;
console.log = (...args) => {
  const text = args.join(' ');
  if (text.includes('[whatsapp] to')) printed.push(text);
  else log(...args);
};

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let customer;
let CustomerMessage;

const api = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const signIn = async (email, password) =>
  (await api('/api/auth/login', { method: 'POST', body: { email, password } })).json.data?.token;
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const quote = async (to = customer) => {
  const made = await api('/api/quotations', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: to, paymentTerms: '30 days', validUntil: inDays(30),
      lines: [{ modelNumber: 'NH-400', unitPrice: 7.5, moq: 5000 }, { modelNumber: 'NH-450V', unitPrice: 9.25 }],
    },
  });
  assert.equal(made.status, 201, made.json.message);
  return made.json.data;
};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: CustomerMessage } = await import('../src/models/CustomerMessage.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  admin = await signIn('admin@np.com', 'Admin@12345');
  const made = await api('/api/users', {
    method: 'POST', token: admin,
    body: { name: 'Nandhini S', email: 'nandhini@np.com', password: 'Pass@123456', department: 'marketing', phone: '+919876500011' },
  });
  assert.equal(made.status, 201, made.json.message);
  nandhini = await signIn('nandhini@np.com', 'Pass@123456');
  const me = (await api('/api/auth/me', { token: nandhini })).json.data.id;

  const buyer = await api('/api/customers', {
    method: 'POST', token: nandhini,
    body: {
      assignedTo: me, name: 'Sri Murugan Garments', mobile: '9840099999', email: 'office@smg.in',
      contacts: [{ name: 'R. Senthil', email: 'senthil@smg.in', whatsapp: '9840011223', isPrimary: true }],
    },
  });
  assert.equal(buyer.status, 201, buyer.json.message);
  customer = buyer.json.data._id;
});

test.after(async () => {
  console.log = log;
  server?.close();
  smtp.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the dialog opens pre-filled: to the primary contact, with the quote’s models and rates', async () => {
  const made = await quote();
  const preview = await api(`/api/quotations/${made._id}/send-preview`, { token: nandhini });
  assert.equal(preview.status, 200, preview.json.message);
  const { email, whatsapp, attachment } = preview.json.data;

  assert.equal(email.to, 'senthil@smg.in', 'the primary contact, not the office address');
  assert.equal(whatsapp.to, '+919840011223');
  assert.equal(email.subject, `Quotation ${made.number} — Navin Plastic Tech`);
  assert.match(email.body, /^Dear R\. Senthil,/);
  assert.match(email.body, new RegExp(`quotation ${made.number}`));
  assert.match(email.body, /NH-400 — ₹7\.50 per piece \(minimum 5,000 pcs\)/);
  assert.match(email.body, /NH-450V — ₹9\.25 per piece/);
  assert.match(email.body, /Payment terms: 30 days\./);
  assert.match(email.body, /Regards,\nNandhini S\nNavin Plastic Tech\n\+919876500011/, 'signed by the sender');
  assert.match(whatsapp.body, /Dear R\. Senthil,[\s\S]*NH-400/);
  assert.equal(attachment, `${made.number.replaceAll('/', '-')}.pdf`);
});

test('what the sender edits is what is sent — the address, the subject and the words — with the PDF attached', async () => {
  const made = await quote();
  mails.length = 0;
  printed.length = 0;
  const sent = await api(`/api/quotations/${made._id}/send`, {
    method: 'POST', token: nandhini,
    body: {
      email: { send: true, to: 'Purchase@SMG.in', subject: 'Our rates for 400mm hangers', body: 'Dear Senthil,\nAs discussed — rates attached.\nNandhini' },
      whatsapp: { send: true, to: '98400 55555', body: 'Senthil sir, our quote is attached. — Nandhini' },
    },
  });
  assert.equal(sent.status, 200, sent.json.message);
  assert.equal(sent.json.data.status, 'sent');

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(mails.length, 1, 'one email went out');
  const mail = mails[0];
  assert.match(mail, /^To: purchase@smg\.in/m, 'to the address as edited');
  assert.match(mail, /^Subject: Our rates for 400mm hangers/m, 'with the subject as edited');
  assert.match(mail, /As discussed — rates attached|As discussed =E2=80=94 rates attached/, 'with the words as edited');
  assert.match(mail, /Content-Type: application\/pdf; name=.*\.pdf/, 'with the quotation attached');
  assert.match(mail, new RegExp(`filename=.?${made.number.replaceAll('/', '-')}\\.pdf`));

  assert.match(printed.join('\n'), /\[whatsapp\] to \+919840055555\nSenthil sir, our quote is attached\. — Nandhini/);

  const logged = await CustomerMessage.find({ quotation: made._id }).sort('channel');
  assert.deepEqual(logged.map((row) => [row.channel, row.status, row.recipient, row.edited]), [
    ['email', 'sent', 'purchase@smg.in', true],
    ['whatsapp', 'sent', '+919840055555', true],
  ]);
  const history = sent.json.data.statusHistory.at(-1);
  assert.match(history.note, /Sent by email to purchase@smg\.in and whatsapp to \+919840055555/);
});

test('the WhatsApp link opens the PDF without signing in, and only with its signature', async () => {
  const made = await quote();
  printed.length = 0;
  await api(`/api/quotations/${made._id}/send`, {
    method: 'POST', token: nandhini, body: { whatsapp: { send: true, to: '9840011223', body: 'Quote attached.' } },
  });
  const link = printed.join('\n').match(/https?:\/\/\S+\/public\/quotations\/\S+\.pdf/)?.[0];
  assert.ok(link, 'the message carries a link to the PDF');

  const opened = await fetch(link);
  assert.equal(opened.status, 200);
  assert.equal(opened.headers.get('content-type'), 'application/pdf');
  assert.equal((await opened.arrayBuffer()).byteLength > 1000, true);

  const tampered = link.replace(/\/([0-9a-f]{64})\//, (_, sig) => `/${sig.replace(/^./, sig[0] === 'a' ? 'b' : 'a')}/`);
  assert.equal((await fetch(tampered)).status, 404, 'a changed signature opens nothing');
  const expired = link.replace(/\/(\d{13})\//, `/${Date.now() - 1000}/`);
  assert.equal((await fetch(expired)).status, 404, 'nor an expired or altered date');
  const other = await quote();
  assert.equal((await fetch(link.replace(String(made._id), String(other._id)))).status, 404, 'nor anybody else’s quote');
});

test('an address that is not one is refused before anything is sent', async () => {
  const made = await quote();
  const badEmail = await api(`/api/quotations/${made._id}/send`, { method: 'POST', token: nandhini, body: { email: { send: true, to: 'senthil at smg', subject: 'Q', body: 'Hi' } } });
  assert.equal(badEmail.status, 400);
  assert.match(badEmail.json.message, /email address/);
  const badPhone = await api(`/api/quotations/${made._id}/send`, { method: 'POST', token: nandhini, body: { whatsapp: { send: true, to: '12', body: 'Hi' } } });
  assert.equal(badPhone.status, 400);
  const empty = await api(`/api/quotations/${made._id}/send`, { method: 'POST', token: nandhini, body: { email: { send: true, to: 'a@b.in', subject: 'Q', body: '  ' } } });
  assert.equal(empty.status, 400);
  const still = await api(`/api/quotations/${made._id}`, { token: nandhini });
  assert.notEqual(still.json.data.status, 'sent');
});

test('a quote whose every channel was refused is not marked sent', async () => {
  const me = (await api('/api/auth/me', { token: nandhini })).json.data.id;
  const quiet = await api('/api/customers', {
    method: 'POST', token: nandhini,
    body: { assignedTo: me, name: 'No Email Please Ltd', mobile: '9840022222', email: 'noemail@x.in', notifications: { email: false } },
  });
  const made = await quote(quiet.json.data._id);
  const preview = await api(`/api/quotations/${made._id}/send-preview`, { token: nandhini });
  assert.equal(preview.json.data.email.optedOut, true, 'the dialog is told before sending');

  const tried = await api(`/api/quotations/${made._id}/send`, {
    method: 'POST', token: nandhini, body: { email: { send: true, to: 'noemail@x.in', subject: 'Q', body: 'Hi' } },
  });
  assert.equal(tried.status, 502);
  assert.match(tried.json.message, /not sent[\s\S]*asked not to be messaged/);
  const still = await api(`/api/quotations/${made._id}`, { token: nandhini });
  assert.notEqual(still.json.data.status, 'sent');
});

test('recording a quote handed over in person still works — no channel, no message', async () => {
  const made = await quote();
  const sent = await api(`/api/quotations/${made._id}/send`, { method: 'POST', token: nandhini, body: { note: 'Given at the meeting' } });
  assert.equal(sent.status, 200, sent.json.message);
  assert.equal(sent.json.data.status, 'sent');
  assert.equal(await CustomerMessage.countDocuments({ quotation: made._id }), 0);
});
