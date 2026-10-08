/**
 * WhatsApp through Meta's WhatsApp Business Platform (the Cloud API), with no Twilio.
 *
 * Meta's Graph API is a local server here that records what it is sent. What is held to:
 * the webhook handshake and signature; messages and photos arriving; a quotation going out as the
 * PDF itself, as a template when one is set, and in two parts when the words are too long for a
 * caption; Meta's refusals — at the send and later on the webhook — landing on the message log in
 * words staff can act on; and sign-in codes going as the authentication template.
 *
 *   node --test tests/whatsapp-meta.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { withEnquiries } from './support/onEnquiry.js';

/* ------------------------------ A stand-in Graph API ------------------------------ */

const posted = [];
/* What went to one number — the photo test's reply to the colleague arrives in the background. */
const sentTo = (number) => posted.filter((message) => message.to === number);
let sent = [];
let nextError = null;
let wamid = 0;
const PHOTO = Buffer.from('\x89PNG\r\n\x1a\n a visiting card', 'latin1');

const graph = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': body instanceof Buffer ? 'image/png' : 'application/json' });
      res.end(body instanceof Buffer ? body : JSON.stringify(body));
    };
    if (req.headers.authorization !== 'Bearer meta-test-token') return reply(401, { error: { code: 190, message: 'bad token' } });
    if (req.method === 'POST' && req.url === '/v23.0/1098765432/messages') {
      if (nextError) {
        const error = nextError;
        nextError = null;
        return reply(400, { error });
      }
      const body = JSON.parse(raw);
      posted.push(body);
      return reply(200, { messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.TEST${++wamid}` }] });
    }
    if (req.method === 'GET' && req.url === '/v23.0/MEDIA123') {
      return reply(200, { url: `http://127.0.0.1:${graph.address().port}/files/MEDIA123`, mime_type: 'image/png', file_size: PHOTO.length, id: 'MEDIA123' });
    }
    if (req.method === 'GET' && req.url === '/files/MEDIA123') return reply(200, PHOTO);
    return reply(404, { error: { code: 100, message: 'unknown path' } });
  });
});
await new Promise((resolve) => graph.listen(0, '127.0.0.1', resolve));

process.env.JWT_SECRET = 'whatsapp-meta-test-secret';
process.env.OTP_EXPOSE_IN_RESPONSE = 'true';
process.env.META_WA_TOKEN = 'meta-test-token';
process.env.META_WA_PHONE_NUMBER_ID = '1098765432';
process.env.META_WA_APP_SECRET = 'meta-app-secret';
process.env.META_WA_VERIFY_TOKEN = 'meta-verify-token';
process.env.META_GRAPH_URL = `http://127.0.0.1:${graph.address().port}/v23.0`;
process.env.WHATSAPP_MEDIA_HOSTS = '127.0.0.1';
process.env.PUBLIC_API_URL = 'https://api.npthangers.test/api';
for (const name of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'TWILIO_MESSAGING_SERVICE_SID', 'TWILIO_WHATSAPP_FROM', 'SMTP_HOST', 'WHATSAPP_PROVIDER']) delete process.env[name];

/* The model is out of the way: a card that arrives is kept as a draft either way. */
const sdk = await import('@anthropic-ai/sdk');
Object.defineProperty(sdk.default.prototype, 'messages', {
  configurable: true,
  get: () => ({ create: async () => ({ stop_reason: 'refusal', content: [] }) }),
  set: () => {},
});

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let customer;
let CustomerMessage;

const rawApi = async (path, { method = 'GET', body, token } = {}) => {
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

/** Posts to the webhook as Meta does: the exact bytes, signed with the app secret. */
const deliver = (payload, { secret = 'meta-app-secret', sign = true } = {}) => {
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  return fetch(`${baseUrl}/api/whatsapp/inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(sign ? { 'X-Hub-Signature-256': signature } : {}) },
    body: raw,
  });
};
const change = (value) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '1098765432' }, ...value } }] }],
});

let seq = 0;
const quote = async () => {
  const made = await api('/api/quotations', {
    method: 'POST',
    token: nandhini,
    body: { customer, paymentTerms: '30 days', validUntil: inDays(30), lines: [{ modelNumber: 'NH-400', unitPrice: 7.5 + (++seq) / 100, moq: 5000 }] },
  });
  assert.equal(made.status, 201, made.json.message);
  return made.json.data;
};
const sendQuote = (id, whatsapp) =>
  api(`/api/quotations/${id}/send`, { method: 'POST', token: nandhini, body: { whatsapp: { send: true, to: '+91 98400 11223', ...whatsapp } } });

/* Samples, costings, quotations and orders are raised on an enquiry — see tests/support/onEnquiry.js. */
const api = withEnquiries(rawApi);

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: CustomerMessage } = await import('../src/models/CustomerMessage.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management', phone: '9876500001' } });
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
    body: { assignedTo: me, name: 'Sri Murugan Garments', mobile: '9840099999', contacts: [{ name: 'R. Senthil', whatsapp: '9840011223', isPrimary: true }] },
  });
  assert.equal(buyer.status, 201, buyer.json.message);
  customer = buyer.json.data._id;
});

test.after(async () => {
  server?.close();
  graph.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test.beforeEach(() => {
  posted.length = 0;
  nextError = null;
  delete process.env.WHATSAPP_TEMPLATE_QUOTE;
  delete process.env.WHATSAPP_TEMPLATE_OTP;
  delete process.env.WHATSAPP_PROVIDER;
});

/* -------------------------------- Which provider -------------------------------- */

test('Meta is used when its settings are there; WHATSAPP_PROVIDER can say otherwise', async () => {
  const { whatsappProvider } = await import('../src/providers/whatsapp.js');
  assert.equal(whatsappProvider(), 'meta');
  process.env.WHATSAPP_PROVIDER = 'twilio';
  assert.equal(whatsappProvider(), null, 'Twilio chosen but not set up: nothing, rather than the other one');
  process.env.WHATSAPP_PROVIDER = 'meta';
  assert.equal(whatsappProvider(), 'meta');
});

/* ---------------------------------- The webhook ---------------------------------- */

test('the webhook handshake echoes the challenge only for the right verify token', async () => {
  const right = await fetch(`${baseUrl}/api/whatsapp/inbound?hub.mode=subscribe&hub.verify_token=meta-verify-token&hub.challenge=1158201444`);
  assert.equal(right.status, 200);
  assert.equal(await right.text(), '1158201444');
  const wrong = await fetch(`${baseUrl}/api/whatsapp/inbound?hub.mode=subscribe&hub.verify_token=guess&hub.challenge=1158201444`);
  assert.equal(wrong.status, 403);
  /* The same token with a stray space, or pasted in quotes, is still the token. */
  const padded = await fetch(`${baseUrl}/api/whatsapp/inbound?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(' "meta-verify-token" ')}&hub.challenge=77`);
  assert.equal(padded.status, 200);
  assert.equal(await padded.text(), '77');
  /* A server not set up for Meta has no webhook to verify: not found, rather than a server fault. */
  const token = process.env.META_WA_VERIFY_TOKEN;
  delete process.env.META_WA_VERIFY_TOKEN;
  try {
    assert.equal((await fetch(`${baseUrl}/api/whatsapp/inbound?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1`)).status, 404);
  } finally {
    process.env.META_WA_VERIFY_TOKEN = token;
  }
});

test('a message from Meta is taken only when it carries the app secret’s signature', async () => {
  const payload = change({
    contacts: [{ profile: { name: 'Karthik' }, wa_id: '919840012345' }],
    messages: [{ from: '919840012345', id: 'wamid.IN1', timestamp: '1790400000', type: 'text', text: { body: 'Rate for 400mm black hangers?' } }],
  });
  assert.equal((await deliver(payload, { sign: false })).status, 401, 'unsigned');
  assert.equal((await deliver(payload, { secret: 'someone-else' })).status, 401, 'signed with the wrong secret');

  const taken = await deliver(payload);
  assert.equal(taken.status, 200);
  const { default: WhatsappThread } = await import('../src/models/WhatsappThread.js');
  const thread = await WhatsappThread.findOne({ number: '+919840012345' });
  assert.ok(thread, 'the conversation is in the inbox');
  assert.equal(thread.messages.at(-1).body, 'Rate for 400mm black hangers?');
  assert.equal(thread.profileName, 'Karthik');

  /* Meta redelivers; the same message is not kept twice. */
  await deliver(payload);
  assert.equal((await WhatsappThread.findOne({ number: '+919840012345' })).messages.length, 1);
});

test('a photo a colleague sends is fetched from Meta by its id and becomes a draft enquiry', async () => {
  const response = await deliver(change({
    messages: [{ from: '919876500011', id: 'wamid.PHOTO1', timestamp: '1790400100', type: 'image', image: { id: 'MEDIA123', mime_type: 'image/png', caption: 'met at the fair' } }],
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.outcomes[0].outcome, 'buyer_card');
  const { default: BuyerCard } = await import('../src/models/BuyerCard.js');
  const card = await BuyerCard.findOne({ providerId: 'wamid.PHOTO1:0' });
  assert.ok(card, 'a draft card from the photo');
  assert.equal(card.caption, 'met at the fair');
  assert.equal(card.mimeType, 'image/png');
});

/* --------------------------------- Quotations --------------------------------- */

test('a quotation goes as the PDF itself, with the edited words as its caption', async () => {
  const made = await quote();
  const result = await sendQuote(made._id, { body: 'Dear Senthil,\nOur quote is attached.' });
  assert.equal(result.status, 200, result.json.message);
  sent = sentTo('919840011223');

  assert.equal(sent.length, 1);
  const [message] = sent;
  assert.equal(message.messaging_product, 'whatsapp');
  assert.equal(message.to, '919840011223', 'digits, country code first, no plus');
  assert.equal(message.type, 'document');
  assert.equal(message.document.caption, 'Dear Senthil,\nOur quote is attached.');
  assert.equal(message.document.filename, `${made.number.replace(/[^A-Za-z0-9-]+/g, '-')}.pdf`);
  assert.match(message.document.link, new RegExp(`^https://api\\.npthangers\\.test/api/public/quotations/${made._id}/`));

  const logged = await CustomerMessage.findOne({ quotation: made._id, channel: 'whatsapp' });
  assert.equal(logged.status, 'sent');
  assert.match(logged.providerId, /^wamid\.TEST/);
});

test('words too long for a caption go first, then the PDF', async () => {
  const made = await quote();
  const long = `Dear Senthil,\n${'Our rates hold for thirty days. '.repeat(40)}`;
  assert.equal((await sendQuote(made._id, { body: long })).status, 200);
  sent = sentTo('919840011223');
  assert.deepEqual(sent.map((message) => message.type), ['text', 'document']);
  assert.equal(sent[0].text.body, long);
  assert.equal(sent[1].document.caption, undefined);
});

test('with a template set, it goes as the template — placeholders in order, on one line each', async () => {
  process.env.WHATSAPP_TEMPLATE_QUOTE = 'quotation_sent:en_US';
  const made = await quote();
  assert.equal((await sendQuote(made._id, { body: 'ignored for a template' })).status, 200);
  sent = sentTo('919840011223');
  const [message] = sent;
  assert.equal(message.type, 'template');
  assert.equal(message.template.name, 'quotation_sent');
  assert.deepEqual(message.template.language, { code: 'en_US' });
  const values = message.template.components[0].parameters.map((parameter) => parameter.text);
  assert.equal(values[0], 'R. Senthil');
  assert.equal(values[1], made.number);
  assert.match(values[2], /^https:\/\/api\.npthangers\.test\/api\/public\/quotations\//);

  const preview = await api(`/api/quotations/${made._id}/send-preview`, { token: nandhini });
  assert.equal(preview.json.data.whatsapp.template, true, 'the dialog knows a template is set');
});

test('Meta refusing the number is logged in words staff can act on, and the quote is not marked sent', async () => {
  nextError = { message: '(#131026) Message undeliverable', type: 'OAuthException', code: 131026, fbtrace_id: 'T1' };
  const made = await quote();
  const result = await sendQuote(made._id, { body: 'Quote attached.' });
  assert.equal(result.status, 502);
  assert.match(result.json.message, /may not be on WhatsApp/);
  const logged = await CustomerMessage.findOne({ quotation: made._id, channel: 'whatsapp' });
  assert.equal(logged.status, 'failed');
  const after = await api(`/api/quotations/${made._id}`, { token: nandhini });
  assert.notEqual(after.json.data.status, 'sent');
});

test('a refusal that arrives later on the webhook turns the sent message into a failed one', async () => {
  const made = await quote();
  assert.equal((await sendQuote(made._id, { body: 'Quote attached.' })).status, 200);
  const logged = await CustomerMessage.findOne({ quotation: made._id, channel: 'whatsapp' });

  const response = await deliver(change({
    statuses: [{ id: logged.providerId, status: 'failed', timestamp: '1790400200', recipient_id: '919840011223', errors: [{ code: 131047, title: 'Re-engagement message' }] }],
  }));
  assert.equal(response.status, 200);
  const settled = await CustomerMessage.findById(logged._id);
  assert.equal(settled.status, 'failed');
  assert.equal(settled.providerStatus, 'failed');
  assert.match(settled.error, /24 hours/);

  /* And "delivered" is recorded as it is, without touching the outcome. */
  const second = await quote();
  await sendQuote(second._id, { body: 'Quote attached.' });
  const ok = await CustomerMessage.findOne({ quotation: second._id, channel: 'whatsapp' });
  await deliver(change({ statuses: [{ id: ok.providerId, status: 'delivered', timestamp: '1790400300', recipient_id: '919840011223' }] }));
  const delivered = await CustomerMessage.findById(ok._id);
  assert.equal(delivered.status, 'sent');
  assert.equal(delivered.providerStatus, 'delivered');
});

/* ----------------------------------- Sign-in codes ----------------------------------- */

test('with no SMS, a phone sign-in code goes as the WhatsApp authentication template', async () => {
  process.env.WHATSAPP_TEMPLATE_OTP = 'npt_login_code';
  const asked = await api('/api/auth/otp/request', { method: 'POST', body: { identifier: '9876500001' } });
  assert.equal(asked.status, 200, asked.json.message);
  const code = asked.json.data.devCode;
  assert.match(code, /^\d{6}$/);

  const [message] = sentTo('919876500001');
  assert.equal(message.to, '919876500001');
  assert.equal(message.type, 'template');
  assert.equal(message.template.name, 'npt_login_code');
  const [body, button] = message.template.components;
  assert.deepEqual(body, { type: 'body', parameters: [{ type: 'text', text: code }] });
  assert.equal(button.type, 'button');
  assert.equal(button.sub_type, 'url');
  assert.deepEqual(button.parameters, [{ type: 'text', text: code }]);
});

/* ------------------------------ The sign-in check ------------------------------ */

test('with WHATSAPP_LOGIN_PING set, a sign-in sends hello_world, and its delivery report is seen', async () => {
  const signInAsAdmin = () => api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } });
  const readiness = async () => {
    await new Promise((resolve) => setTimeout(resolve, 2100)); /* past the readiness cache */
    return (await api('/health/ready')).json.platform;
  };

  /* Off by default: signing in sends nothing. */
  delete process.env.WHATSAPP_LOGIN_PING;
  assert.equal((await signInAsAdmin()).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(sentTo('917550005370').length, 0);

  process.env.WHATSAPP_LOGIN_PING = '7550005370';
  try {
    const signed = await signInAsAdmin();
    assert.equal(signed.status, 200, 'the sign-in itself is untouched');
    assert.ok(signed.json.data.token);
    for (let i = 0; i < 40 && !sentTo('917550005370').length; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));

    const [message] = sentTo('917550005370');
    assert.equal(message.type, 'template');
    assert.deepEqual(message.template, { name: 'hello_world', language: { code: 'en_US' } }, 'no parameters: the sample template has none');

    let ping = (await readiness()).whatsappLoginPing;
    assert.equal(ping.status, 'accepted');
    assert.equal(ping.to, '+91******5370', 'the number is masked on the public endpoint');

    /* Meta reports it delivered, through the signed webhook. */
    const id = `wamid.TEST${wamid}`;
    const delivered = await deliver(change({ statuses: [{ id, status: 'delivered', timestamp: '1790500000', recipient_id: '917550005370' }] }));
    assert.equal(delivered.status, 200);
    ping = (await readiness()).whatsappLoginPing;
    assert.equal(ping.status, 'delivered');
  } finally {
    delete process.env.WHATSAPP_LOGIN_PING;
  }
});

test('when Meta refuses the account, the sign-in check says why — without the token', async () => {
  process.env.WHATSAPP_LOGIN_PING = '7550005370';
  nextError = { message: 'Error validating access token: Session has expired on Saturday, 26-Sep-26.', type: 'OAuthException', code: 190, error_subcode: 463, fbtrace_id: 'T9' };
  const log = console.error;
  console.error = () => {};
  try {
    assert.equal((await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const ping = (await api('/health/ready')).json.platform.whatsappLoginPing;
    assert.equal(ping.status, 'failed');
    assert.match(ping.error, /access token has expired or is not valid/);
    assert.match(ping.error, /Meta error 190\/463: Error validating access token/);
    assert.doesNotMatch(ping.error, /meta-test-token/);
  } finally {
    console.error = log;
    delete process.env.WHATSAPP_LOGIN_PING;
  }
});
