/**
 * Leads from photos: a card sent to the WhatsApp number is read by the model and becomes a lead
 * only when a person says YES — never on the model's word alone.
 *
 * The model is stubbed, and the "Twilio" media URL is a local server.
 *
 *   node --test tests/lead-cards.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'lead-cards-test-secret';
process.env.WHATSAPP_WEBHOOK_TOKEN = 'lead-cards-webhook';
process.env.WHATSAPP_MEDIA_HOSTS = '127.0.0.1';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

/* The model: whatever `cardReply` says, and a record of what it was sent. */
const sent = [];
let cardReply = null;
const sdk = await import('@anthropic-ai/sdk');
Object.defineProperty(sdk.default.prototype, 'messages', {
  configurable: true,
  get: () => ({
    create: async (request) => {
      sent.push(request);
      if (!cardReply) return { stop_reason: 'refusal', content: [] };
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(cardReply) }] };
    },
  }),
  set: () => {},
});

const blank = { readable: true, company: '', contactName: '', designation: '', mobile: '', whatsapp: '', email: '', city: '', state: '', productInterest: '', notes: '' };
const card = (fields) => ({ ...blank, ...fields });

/* What went back to WhatsApp — printed, as no provider is configured here. */
const replies = [];
const log = console.log;
console.log = (...args) => {
  const text = args.join(' ');
  if (text.includes('[whatsapp] to')) replies.push(text);
  else log(...args);
};

/* A PNG, served where "Twilio" keeps media. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let mediaHits = 0;
const media = http.createServer((req, res) => {
  mediaHits += 1;
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length });
  res.end(PNG);
});
await new Promise((resolve) => media.listen(0, '127.0.0.1', resolve));
const photoUrl = `http://127.0.0.1:${media.address().port}/2010-04-01/Media/ME1`;

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let arun;
let Lead;
let seq = 0;

const NANDHINI_PHONE = '+919876500011';
const KAVITHA_PHONE = '+919876500022';

const api = async (path, { method = 'GET', body, token, form } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(form ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(form ? { body: form } : body ? { body: JSON.stringify(body) } : {}),
  });
  const type = response.headers.get('content-type') || '';
  return { status: response.status, type, json: type.includes('json') ? await response.json() : {} };
};

const whatsapp = (from, { body, photo = false, sid } = {}) =>
  api('/api/whatsapp/inbound?token=lead-cards-webhook', {
    method: 'POST',
    body: {
      From: `whatsapp:${from}`,
      Body: body || '',
      MessageSid: sid || `SM${++seq}`,
      NumMedia: photo ? 1 : 0,
      ...(photo ? { MediaUrl0: typeof photo === 'string' ? photo : photoUrl, MediaContentType0: 'image/png' } : {}),
    },
  });

/** The newest card this person can see, once the model has finished with it. */
async function readCardOf(token) {
  for (let i = 0; i < 50; i++) {
    const listed = await api('/api/lead-cards', { token });
    const latest = listed.json.data?.[0];
    if (latest && latest.status !== 'reading') return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the card was never read');
}

const signIn = async (email, password) =>
  (await api('/api/auth/login', { method: 'POST', body: { email, password } })).json.data?.token;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Lead } = await import('../src/models/Lead.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  admin = await signIn('admin@np.com', 'Admin@12345');
  for (const [name, email, department, phone] of [
    ['Nandhini S', 'nandhini@np.com', 'marketing', NANDHINI_PHONE],
    ['Kavitha D', 'kavitha@np.com', 'despatch', KAVITHA_PHONE],
    ['Arun K', 'arun@np.com', 'marketing', '+919876500033'],
  ]) {
    const made = await api('/api/users', { method: 'POST', token: admin, body: { name, email, password: 'Pass@123456', department, phone } });
    assert.equal(made.status, 201, made.json.message);
  }
  nandhini = await signIn('nandhini@np.com', 'Pass@123456');
  arun = await signIn('arun@np.com', 'Pass@123456');
});

test.after(async () => {
  console.log = log;
  server?.close();
  media.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test.beforeEach(() => {
  sent.length = 0;
  replies.length = 0;
  cardReply = null;
});

/* ------------------------------ From WhatsApp ------------------------------ */

test('a card sent by a salesperson is read, and nothing is a lead until they say YES', async () => {
  cardReply = card({ company: 'Sri Murugan Garments', contactName: 'R. Senthil', designation: 'Purchase Manager', mobile: '98400 11223', email: 'senthil@smg.in', city: 'Tiruppur', state: 'Tamil Nadu' });
  const leadsBefore = await Lead.countDocuments();

  const arrived = await whatsapp(NANDHINI_PHONE, { photo: true, body: 'Met at the Tiruppur fair' });
  assert.equal(arrived.json.outcome, 'lead_card');
  const read = await readCardOf(nandhini);

  assert.equal(read.status, 'ready');
  assert.equal(read.reading.mobile, '+919840011223', 'the phone normalised by rule');
  assert.equal(read.sender.name, 'Nandhini S');
  assert.equal(sent[0].messages[0].content[0].type, 'image', 'the photo went to the model');
  assert.match(sent[0].messages[0].content[1].text, /Tiruppur fair/, 'with the caption');
  assert.equal(await Lead.countDocuments(), leadsBefore, 'the reading alone makes no lead');
  assert.match(replies.join('\n'), /Sri Murugan Garments[\s\S]*Reply YES to add it as a lead/);

  replies.length = 0;
  const yes = await whatsapp(NANDHINI_PHONE, { body: 'Yes' });
  assert.equal(yes.json.outcome, 'lead_card_confirmed');
  const lead = await Lead.findOne({ company: 'Sri Murugan Garments' });
  assert.ok(lead, 'YES made the lead');
  assert.equal(lead.mobile, '+919840011223');
  assert.equal(lead.city, 'Tiruppur');
  assert.equal(lead.status, 'new');
  assert.equal(lead.nextActionType, 'call', 'a new lead has its next step');
  assert.match(lead.visitingCardUrl, /\/api\/lead-cards\/[0-9a-f]{24}\/image/);
  assert.match(lead.activities[0].summary, /read by AI and checked by Nandhini S/, 'where it came from is on the record');
  const owner = await mongoose.model('User').findById(lead.assignedTo);
  assert.equal(owner.name, 'Nandhini S', 'the sender keeps the buyer they met');
  assert.match(replies.join('\n'), new RegExp(`Added lead ${lead.number}`));
});

test('NO drops the card and adds nothing', async () => {
  cardReply = card({ company: 'Drop Me Textiles', mobile: '9840099999' });
  await whatsapp(NANDHINI_PHONE, { photo: true });
  await readCardOf(nandhini);
  const no = await whatsapp(NANDHINI_PHONE, { body: 'no' });
  assert.equal(no.json.outcome, 'lead_card_discarded');
  assert.equal(await Lead.countDocuments({ company: 'Drop Me Textiles' }), 0);
});

test('a buyer the plant already has is not added twice', async () => {
  cardReply = card({ company: 'Sri Murugan Garments', contactName: 'Another person', mobile: '+919840011223' });
  await whatsapp(NANDHINI_PHONE, { photo: true });
  const read = await readCardOf(nandhini);
  assert.ok(read.matchedLead, 'the card knows who already has this number');
  assert.match(replies.join('\n'), /already lead LEAD-/);

  const yes = await whatsapp(NANDHINI_PHONE, { body: 'YES' });
  assert.equal(yes.json.outcome, 'lead_card_refused');
  assert.equal(await Lead.countDocuments({ mobile: '+919840011223' }), 1);
});

test('a card from someone outside marketing goes to the marketing rotation', async () => {
  cardReply = card({ company: 'Gate Visitor Exports', mobile: '9840077777' });
  await whatsapp(KAVITHA_PHONE, { photo: true });
  await readCardOf(admin);
  await whatsapp(KAVITHA_PHONE, { body: 'ok' });
  const lead = await Lead.findOne({ company: 'Gate Visitor Exports' });
  assert.ok(lead);
  const owner = await mongoose.model('User').findById(lead.assignedTo);
  assert.equal(owner.department, 'marketing', 'despatch cannot hold a buyer, so marketing does');
});

test('a photo from a customer’s number is a customer message, not a card', async () => {
  cardReply = card({ company: 'Should Not Be Read' });
  const arrived = await whatsapp('+919811100000', { photo: true, body: 'Price for this hanger?' });
  assert.notEqual(arrived.json.outcome, 'lead_card');
  assert.ok(arrived.json.thread, 'it went to the WhatsApp inbox');
  assert.equal(sent.length, 0, 'and was never sent to the model');
});

test('a redelivered webhook reads the card once', async () => {
  cardReply = card({ company: 'Once Only Knits', mobile: '9840066666' });
  await whatsapp(NANDHINI_PHONE, { photo: true, sid: 'SMREPEAT' });
  await whatsapp(NANDHINI_PHONE, { photo: true, sid: 'SMREPEAT' });
  await readCardOf(nandhini);
  const cards = (await api('/api/lead-cards', { token: admin })).json.data.filter((row) => row.reading?.company === 'Once Only Knits');
  assert.equal(cards.length, 1);
});

test('media is only fetched from the provider’s own host', async () => {
  const before = (await api('/api/lead-cards', { token: admin })).json.waiting;
  const hits = mediaHits;
  /* The same server under a name that is not on the list: reachable, and still refused. */
  const arrived = await whatsapp(NANDHINI_PHONE, { photo: `http://localhost:${media.address().port}/anything` });
  assert.equal(mediaHits, hits, 'the address was never called');
  assert.equal(arrived.json.outcome, 'lead_card');
  assert.equal((await api('/api/lead-cards', { token: admin })).json.waiting, before, 'no card from a foreign address');
  assert.match(replies.join('\n'), /could not be fetched/);
});

/* --------------------------------- In the app --------------------------------- */

test('a card the model could not read is typed in from the photo and confirmed', async () => {
  cardReply = null; // the model declines
  await whatsapp(NANDHINI_PHONE, { photo: true });
  const read = await readCardOf(nandhini);
  assert.equal(read.status, 'unreadable');
  assert.ok(read.problem);

  const image = await fetch(`${baseUrl}/api/lead-cards/${read._id}/image`, { headers: { Authorization: `Bearer ${nandhini}` } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');

  const noName = await api(`/api/lead-cards/${read._id}/confirm`, { method: 'POST', token: nandhini, body: { mobile: '9840055555' } });
  assert.equal(noName.status, 400, 'a lead needs a company');
  const noWay = await api(`/api/lead-cards/${read._id}/confirm`, { method: 'POST', token: nandhini, body: { company: 'Handwritten Hangers' } });
  assert.equal(noWay.status, 400, 'and a way to reach them');
  const badPhone = await api(`/api/lead-cards/${read._id}/confirm`, { method: 'POST', token: nandhini, body: { company: 'Handwritten Hangers', mobile: '12' } });
  assert.equal(badPhone.status, 400);

  const done = await api(`/api/lead-cards/${read._id}/confirm`, {
    method: 'POST', token: nandhini, body: { company: 'Handwritten Hangers', mobile: '9840055555', source: 'trade_show' },
  });
  assert.equal(done.status, 200, done.json.message);
  assert.equal(done.json.data.lead.source, 'trade_show');
  assert.match(done.json.data.lead.activities[0].summary, /typed in by Nandhini S/);

  const again = await api(`/api/lead-cards/${read._id}/confirm`, { method: 'POST', token: nandhini, body: { company: 'Handwritten Hangers', mobile: '9840055555' } });
  assert.equal(again.status, 409, 'a card is made a lead once');
});

test('marketing sees the cards they sent; management sees every card', async () => {
  const mine = (await api('/api/lead-cards?status=decided', { token: nandhini })).json.data;
  assert.ok(mine.length > 0);
  assert.ok(mine.every((row) => row.sender.name === 'Nandhini S'));
  const theirs = (await api('/api/lead-cards?status=decided', { token: arun })).json.data;
  assert.equal(theirs.length, 0, 'Arun sent none');
  const refused = await fetch(`${baseUrl}/api/lead-cards/${mine[0]._id}/image`, { headers: { Authorization: `Bearer ${arun}` } });
  assert.equal(refused.status, 404, 'nor may he open her photos');
  const all = (await api('/api/lead-cards?status=decided', { token: admin })).json.data;
  assert.ok(all.some((row) => row.sender.name === 'Kavitha D'));
});

test('a card uploaded in the app is read straight away', async () => {
  cardReply = card({ company: 'Uploaded Apparel', mobile: '9840044444', email: 'not-an-email' });
  const form = new FormData();
  form.append('image', new Blob([PNG], { type: 'image/png' }), 'card.png');
  const made = await api('/api/lead-cards', { method: 'POST', token: arun, form });
  assert.equal(made.status, 201, made.json.message);
  assert.equal(made.json.data.status, 'ready');
  assert.equal(made.json.data.reading.company, 'Uploaded Apparel');
  assert.equal(made.json.data.reading.email, undefined, 'an address that is not an email is dropped, not stored');
});
