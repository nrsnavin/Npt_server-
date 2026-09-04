/**
 * Outbound customer notifications [BLUEPRINT §42]: the automatic sends on sample ready and
 * sample dispatched, what may appear in them, and the audit trail behind both.
 *
 *   node --test tests/customer-messages.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'customer-message-test-secret';
// A WhatsApp sender, so the provider path is taken rather than the development fallback.
process.env.TWILIO_ACCOUNT_SID = 'AC00000000000000000000000000000000';
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
process.env.TWILIO_WHATSAPP_FROM = 'whatsapp:+14155238886';

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;   // marketing — owns the customer, holds customer_comms
let meera;      // sampling — makes samples, must not be able to message a buyer
let mouldId;
let CustomerMessage;

/** Twilio calls are intercepted, so no test ever costs a message or needs the network. */
const sent = [];
let nextResponse = () => ({ ok: true, sid: 'SM-test', status: 'queued' });
const realFetch = globalThis.fetch;

globalThis.fetch = async (url, options) => {
  if (!String(url).includes('api.twilio.com')) return realFetch(url, options);

  const params = Object.fromEntries(new URLSearchParams(options.body));
  sent.push(params);

  const outcome = nextResponse(params);
  return {
    ok: outcome.ok,
    status: outcome.ok ? 201 : outcome.status || 400,
    json: async () => (outcome.ok ? { sid: outcome.sid, status: outcome.status } : outcome.payload),
  };
};

const api = async (path, { method = 'GET', body, token } = {}) => {
  const response = await realFetch(`${baseUrl}${path}`, {
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

const soon = (days = 3) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
};

const followUp = { nextAction: 'Call the buyer', nextFollowUpDate: soon() };
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

let sequence = 0;

/** A customer, an enquiry and the sample the automation raises from it. */
async function pipelineTo(status, { customer: customerOverrides = {}, sample: sampleOverrides = {} } = {}) {
  sequence += 1;

  const customer = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: {
      name: `Buyer ${sequence}`,
      mobile: `98400${String(100000 + sequence).slice(-5)}`,
      email: `buyer${sequence}@example.com`,
      ...customerOverrides,
    },
  });

  const enquiry = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customer.json.data._id,
      mould: mouldId,
      requirement: { modelNumber: 'NPT-400S', colour: 'White', quantity: 5000 },
      remarks: 'INTERNAL: margin is thin, do not discount below 4.80',
      ...followUp,
    },
  });

  await api(`/api/enquiries/${enquiry.json.data._id}/status`, {
    method: 'POST',
    token: nandhini,
    body: { status: 'sample_required', ...followUp },
  });
  await settle();

  const list = await api(`/api/samples?enquiry=${enquiry.json.data._id}`, { token: meera });
  const sample = list.json.data[0];

  if (Object.keys(sampleOverrides).length) {
    await api(`/api/samples/${sample._id}`, { method: 'PATCH', token: meera, body: sampleOverrides });
  }

  for (const step of ['checking_stock', 'sample_available', 'sample_ready']) {
    if (status === 'request_received') break;
    await api(`/api/samples/${sample._id}/status`, { method: 'POST', token: meera, body: { status: step } });
    if (step === status) break;
  }

  if (status === 'dispatched') {
    await api(`/api/samples/${sample._id}/status`, {
      method: 'POST',
      token: meera,
      body: {
        status: 'dispatched',
        courier: 'Blue Dart',
        awbNumber: '77213904118',
        dispatchedQuantity: 5,
      },
    });
  }

  await settle();
  return { customer: customer.json.data, enquiry: enquiry.json.data, sample };
}

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  CustomerMessage = (await import('../src/models/CustomerMessage.js')).default;
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
    ['Meera S', 'meera@np.com', 'sampling', 'Samp@123456'],
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: { name, email, password, department } });
  }

  nandhini = await signIn('nandhini@np.com', 'Mktg@123456');
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

test.afterEach(() => {
  sent.length = 0;
  nextResponse = () => ({ ok: true, sid: 'SM-test', status: 'queued' });
});

test.after(async () => {
  globalThis.fetch = realFetch;
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------ The automatic sends ------------------------------ */

test('a ready sample tells the customer, on both channels, without anyone asking', async () => {
  const { sample } = await pipelineTo('sample_ready');

  const messages = await CustomerMessage.find({ sample: sample._id, event: 'sample_ready' });
  assert.equal(messages.length, 2, 'one record per channel');

  const whatsapp = messages.find((message) => message.channel === 'whatsapp');
  const email = messages.find((message) => message.channel === 'email');

  assert.equal(whatsapp.status, 'sent');
  assert.equal(email.status, 'sent');
  // Nobody pressed send, and the log says so rather than crediting a person.
  assert.equal(whatsapp.automatic, true);
  assert.equal(whatsapp.sentBy, undefined);
  assert.match(whatsapp.body, /is ready/);
  assert.match(email.subject, /is ready/);

  // It really went to Twilio, addressed the way WhatsApp needs.
  const call = sent.find((params) => params.To?.startsWith('whatsapp:'));
  assert.ok(call, 'a WhatsApp message should have been posted');
  assert.match(call.From, /^whatsapp:/);
});

test('dispatching tells the customer how it is coming', async () => {
  const { sample } = await pipelineTo('dispatched');

  const messages = await CustomerMessage.find({ sample: sample._id, event: 'sample_dispatched' });
  assert.equal(messages.length, 2);

  const whatsapp = messages.find((message) => message.channel === 'whatsapp');
  assert.equal(whatsapp.status, 'sent');
  assert.match(whatsapp.body, /Blue Dart/);
  assert.match(whatsapp.body, /77213904118/);

  // Both stages sent, so the customer heard twice about two different things.
  const all = await CustomerMessage.find({ sample: sample._id, status: 'sent' });
  assert.equal(all.length, 4);
});

/* --------------------------- What may reach a customer --------------------------- */

test('internal notes never reach the customer', async () => {
  const { sample } = await pipelineTo('dispatched', {
    sample: { remarks: 'Mould M-101 cracked, running the spare — do not tell the buyer' },
  });

  const messages = await CustomerMessage.find({ sample: sample._id });
  for (const message of messages) {
    const text = `${message.subject || ''} ${message.body || ''}`;
    assert.ok(!text.includes('Mould'), 'a sample remark is internal');
    assert.ok(!text.includes('margin'), 'an enquiry remark is internal');
    assert.ok(!text.toLowerCase().includes('do not tell'));
  }
});

/* --------------------------- Courier details, when known --------------------------- */

test('courier details arranged in advance reach the ready message', async () => {
  const { sample } = await pipelineTo('sample_available');

  await api(`/api/samples/${sample._id}/dispatch-details`, {
    method: 'PATCH',
    token: meera,
    body: { courier: 'Blue Dart', awbNumber: '77213904118' },
  });

  await api(`/api/samples/${sample._id}/status`, {
    method: 'POST',
    token: meera,
    body: { status: 'sample_ready' },
  });
  await settle();

  const message = await CustomerMessage.findOne({
    sample: sample._id,
    event: 'sample_ready',
    channel: 'email',
  });

  assert.match(message.body, /Blue Dart/);
  assert.match(message.body, /77213904118/);
  assert.ok(!message.body.includes('confirm the courier details'), 'we already know them');
});

test('an unknown courier still reads as a sentence, not a gap', async () => {
  const { sample } = await pipelineTo('sample_ready');

  const message = await CustomerMessage.findOne({
    sample: sample._id,
    event: 'sample_ready',
    channel: 'email',
  });
  assert.match(message.body, /confirm the courier details shortly/);

  // The WhatsApp template has a fixed shape, so the slot is filled either way.
  const call = sent.find((params) => params.To?.startsWith('whatsapp:'));
  assert.ok(call, 'a WhatsApp message went');
});

test('details entered in advance do not have to be typed again to dispatch', async () => {
  const { sample } = await pipelineTo('sample_ready');

  await api(`/api/samples/${sample._id}/dispatch-details`, {
    method: 'PATCH',
    token: meera,
    body: { courier: 'Professional Couriers', awbNumber: '55910233741', dispatchedQuantity: 5 },
  });

  const { status, json } = await api(`/api/samples/${sample._id}/status`, {
    method: 'POST',
    token: meera,
    body: { status: 'dispatched' },
  });

  assert.equal(status, 200, 'the move should accept what was already arranged');
  assert.equal(json.data.courier, 'Professional Couriers');
  assert.ok(json.data.dispatchedAt);
});

test('a tracking number typed wrong can be corrected after dispatch', async () => {
  const { sample } = await pipelineTo('dispatched');

  const { status, json } = await api(`/api/samples/${sample._id}/dispatch-details`, {
    method: 'PATCH',
    token: meera,
    body: { awbNumber: '99999999999' },
  });

  assert.equal(status, 200);
  assert.equal(json.data.awbNumber, '99999999999');
  assert.equal(json.data.courier, 'Blue Dart', 'correcting one field leaves the others');

  // Correcting the record does not message the customer on its own — that stays a decision.
  const messages = await CustomerMessage.find({ sample: sample._id, event: 'sample_dispatched' });
  assert.equal(messages.filter((message) => message.status === 'sent').length, 2);

  // Re-sending it is what puts the correction in front of them, and says the new number.
  const resent = await api(`/api/samples/${sample._id}/customer-message`, {
    method: 'POST',
    token: nandhini,
    body: { event: 'sample_dispatched', channels: ['email'], force: true },
  });
  assert.match(resent.json.data[0].body, /99999999999/);
});

test('a re-sample does not inherit the last attempt’s tracking number', async () => {
  const { sample } = await pipelineTo('dispatched');

  await api(`/api/samples/${sample._id}/feedback`, {
    method: 'POST',
    token: nandhini,
    body: { outcome: 'modification_required', note: 'Shoulder 5mm wider' },
  });

  const { json } = await api(`/api/samples/${sample._id}/resample`, {
    method: 'POST',
    token: meera,
    body: {},
  });

  assert.equal(json.data.sample.courier, undefined, 'a new attempt travels on its own journey');
  assert.equal(json.data.sample.awbNumber, undefined);
});

/* ------------------------------ Consent and silence ------------------------------ */

test('a customer who has opted out of a channel is not messaged on it', async () => {
  const { sample } = await pipelineTo('sample_ready', {
    customer: { notifications: { whatsapp: false, email: true } },
  });

  const messages = await CustomerMessage.find({ sample: sample._id, event: 'sample_ready' });
  const whatsapp = messages.find((message) => message.channel === 'whatsapp');
  const email = messages.find((message) => message.channel === 'email');

  assert.equal(whatsapp.status, 'skipped');
  assert.equal(whatsapp.skipReason, 'opted_out');
  assert.equal(email.status, 'sent');

  assert.ok(!sent.some((params) => params.To?.startsWith('whatsapp:')), 'nothing left the building');
});

test('a missing address is recorded, not silently ignored', async () => {
  const { sample } = await pipelineTo('sample_ready', { customer: { email: undefined } });

  const email = await CustomerMessage.findOne({ sample: sample._id, channel: 'email' });
  assert.equal(email.status, 'skipped');
  assert.equal(email.skipReason, 'no_address');
});

/* --------------------------------- Failures --------------------------------- */

test('a provider failure is logged against the sample, and changes nothing else', async () => {
  nextResponse = (params) =>
    params.To?.startsWith('whatsapp:')
      ? { ok: false, status: 400, payload: { code: 63016, message: 'outside the window' } }
      : { ok: true, sid: 'SM-ok', status: 'queued' };

  const { sample } = await pipelineTo('sample_ready');

  const whatsapp = await CustomerMessage.findOne({ sample: sample._id, channel: 'whatsapp' });
  assert.equal(whatsapp.status, 'failed');
  assert.ok(whatsapp.error, 'the reason is kept so it can be re-sent');

  // The sample still moved: telling the customer is a consequence of the work, not a gate.
  const after = await api(`/api/samples/${sample._id}`, { token: meera });
  assert.equal(after.json.data.status, 'sample_ready');

  const email = await CustomerMessage.findOne({ sample: sample._id, channel: 'email' });
  assert.equal(email.status, 'sent', 'one channel failing must not stop the other');
});

/* ------------------------------ Telling them twice ------------------------------ */

test('the same update is not sent twice', async () => {
  const { sample } = await pipelineTo('sample_ready');
  sent.length = 0;

  const again = await api(`/api/samples/${sample._id}/customer-message`, {
    method: 'POST',
    token: nandhini,
    body: { event: 'sample_ready' },
  });

  assert.equal(again.status, 201);
  assert.ok(again.json.data.every((message) => message.status === 'skipped'));
  assert.ok(again.json.data.every((message) => message.skipReason === 'already_sent'));
  assert.equal(sent.length, 0);

  // Overriding it is possible, and is itself recorded.
  const forced = await api(`/api/samples/${sample._id}/customer-message`, {
    method: 'POST',
    token: nandhini,
    body: { event: 'sample_ready', channels: ['whatsapp'], force: true },
  });
  assert.equal(forced.json.data[0].status, 'sent');
  assert.equal(forced.json.data[0].automatic, false);
});

/* ------------------------------ Preview, edit, send ------------------------------ */

test('a person can preview a draft, edit it, and send that', async () => {
  const { sample } = await pipelineTo('sample_available');

  const preview = await api(`/api/samples/${sample._id}/customer-message/preview?event=sample_ready`, {
    token: nandhini,
  });
  assert.equal(preview.status, 200);
  assert.match(preview.json.data.body, /is ready/);
  assert.equal(preview.json.data.alreadySent.length, 0);
  assert.ok(preview.json.data.channels.some((channel) => channel.channel === 'whatsapp'));

  const send = await api(`/api/samples/${sample._id}/customer-message`, {
    method: 'POST',
    token: nandhini,
    body: {
      event: 'sample_ready',
      channels: ['email'],
      subject: 'Your sample is ready',
      body: 'Hello — your sample is ready and we will courier it tomorrow.',
    },
  });

  assert.equal(send.status, 201);
  const [message] = send.json.data;
  assert.equal(message.status, 'sent');
  assert.equal(message.body, 'Hello — your sample is ready and we will courier it tomorrow.');
  assert.equal(message.edited, true, 'an edited draft is marked as edited');
  assert.equal(message.automatic, false);
});

test('the audit trail answers who told the customer what, and when', async () => {
  const { sample } = await pipelineTo('dispatched');

  const { status, json } = await api(`/api/samples/${sample._id}/customer-messages`, {
    token: nandhini,
  });

  assert.equal(status, 200);
  assert.equal(json.data.length, 4);
  for (const message of json.data) {
    assert.ok(message.event);
    assert.ok(message.channel);
    assert.ok(message.recipient, 'the address as used');
    assert.ok(message.sentAt);
  }
});

/* --------------------------------- Who may send --------------------------------- */

test('the sample team cannot message a buyer', async () => {
  const { sample } = await pipelineTo('sample_available');

  const { status } = await api(`/api/samples/${sample._id}/customer-message`, {
    method: 'POST',
    token: meera,
    body: { event: 'sample_ready' },
  });

  // Sampling updates internal status; the customer relationship is marketing's [§42.4].
  assert.equal(status, 403);
});
