/**
 * Draft leads from pictures: a card or chat screenshot sent to the WhatsApp number is read into a
 * draft holding only what the picture shows. The rest is the salesperson's to fill in, and the
 * draft becomes a lead only when they do — never on the model's word alone.
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
      const answer = Array.isArray(cardReply) ? cardReply.shift() : cardReply;
      if (!answer) return { stop_reason: 'refusal', content: [] };
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }] };
    },
  }),
  set: () => {},
});

const blank = { kind: 'card', company: '', contactName: '', designation: '', mobile: '', whatsapp: '', email: '', city: '', state: '', productInterest: '', quantity: '', notes: '' };
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

const DAY = 86400000;
const inDays = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
/** What only the salesperson can say: the next step, when, and how they met them. */
const theRest = { nextAction: 'Send the 400mm rate card', nextFollowUpDate: inDays(2), source: 'trade_show' };
const finish = (id, fields, token = nandhini) => api(`/api/lead-cards/${id}/confirm`, { method: 'POST', token, body: fields });
const latestReply = () => replies.at(-1) || '';

test('a card sent on WhatsApp is saved as a draft with only what it shows', async () => {
  cardReply = card({ company: 'Sri Murugan Garments', contactName: 'R. Senthil', designation: 'Purchase Manager', mobile: '98400 11223', email: 'senthil@smg.in', city: 'Tiruppur', state: 'Tamil Nadu' });
  const leadsBefore = await Lead.countDocuments();

  const arrived = await whatsapp(NANDHINI_PHONE, { photo: true, body: 'Met at the Tiruppur fair' });
  assert.equal(arrived.json.outcome, 'lead_card');
  const draft = await readCardOf(nandhini);

  assert.equal(draft.status, 'ready');
  assert.equal(draft.reading.mobile, '+919840011223', 'the phone normalised by rule');
  assert.equal(draft.reading.nextAction, undefined, 'nothing the picture did not show');
  assert.equal(sent[0].messages[0].content[0].type, 'image', 'the photo went to the model');
  assert.match(sent[0].messages[0].content[1].text, /Tiruppur fair/, 'with the caption');
  assert.equal(await Lead.countDocuments(), leadsBefore, 'a draft is not a lead');
  assert.match(latestReply(), /Saved as a draft lead from this card:[\s\S]*Sri Murugan Garments[\s\S]*Finish it in the app/);
  assert.doesNotMatch(latestReply(), /Reply YES/);
});

test('a reply on WhatsApp does not make the draft a lead — finishing it is done in the app', async () => {
  const draft = await readCardOf(nandhini);
  const yes = await whatsapp(NANDHINI_PHONE, { body: 'yes' });
  assert.notEqual(yes.json.outcome, 'lead_card_confirmed');
  assert.equal(await Lead.countDocuments({ company: 'Sri Murugan Garments' }), 0);
  assert.equal((await readCardOf(nandhini))._id, draft._id, 'still a draft');
});

test('the salesperson must give the next step, when, and how they met them', async () => {
  const draft = await readCardOf(nandhini);
  const cases = [
    [{}, /next step/],
    [{ nextAction: 'Call him' }, /when to follow up/],
    [{ nextAction: 'Call him', nextFollowUpDate: inDays(-1) }, /cannot be in the past/],
    [{ nextAction: 'Call him', nextFollowUpDate: inDays(1) }, /how we met them/],
  ];
  for (const [fields, why] of cases) {
    const tried = await finish(draft._id, fields);
    assert.equal(tried.status, 400, JSON.stringify(fields));
    assert.match(tried.json.message, why);
  }

  const done = await finish(draft._id, { ...theRest, estimatedValue: 45000 });
  assert.equal(done.status, 200, done.json.message);
  const lead = await Lead.findById(done.json.data.lead._id);
  assert.equal(lead.company, 'Sri Murugan Garments');
  assert.equal(lead.mobile, '+919840011223');
  assert.equal(lead.nextAction, 'Send the 400mm rate card', 'their next step, not one the app made up');
  assert.equal(lead.nextFollowUpDate.toISOString().slice(0, 10), theRest.nextFollowUpDate);
  assert.equal(lead.source, 'trade_show');
  assert.equal(lead.estimatedValue, 45000);
  assert.match(lead.visitingCardUrl, /\/api\/lead-cards\/[0-9a-f]{24}\/image/);
  assert.match(lead.activities[0].summary, /read by AI, checked and completed by Nandhini S/);
  const owner = await mongoose.model('User').findById(lead.assignedTo);
  assert.equal(owner.name, 'Nandhini S', 'the sender keeps the buyer they met');
});

test('a draft can be dropped', async () => {
  cardReply = card({ company: 'Drop Me Textiles', mobile: '9840099999' });
  await whatsapp(NANDHINI_PHONE, { photo: true });
  const draft = await readCardOf(nandhini);
  const dropped = await api(`/api/lead-cards/${draft._id}/discard`, { method: 'POST', token: nandhini });
  assert.equal(dropped.status, 200);
  assert.equal(await Lead.countDocuments({ company: 'Drop Me Textiles' }), 0);
});

test('a buyer the plant already has is flagged on the draft and not added twice', async () => {
  cardReply = card({ company: 'Sri Murugan Garments', contactName: 'Another person', mobile: '+919840011223' });
  await whatsapp(NANDHINI_PHONE, { photo: true });
  const draft = await readCardOf(nandhini);
  assert.ok(draft.matchedLead, 'the draft knows who already has this number');
  assert.match(latestReply(), /Note: this buyer is already lead LEAD-/);
  const tried = await finish(draft._id, theRest);
  assert.equal(tried.status, 409);
  assert.equal(await Lead.countDocuments({ mobile: '+919840011223' }), 1);
  await api(`/api/lead-cards/${draft._id}/discard`, { method: 'POST', token: nandhini });
});

test('a draft from someone outside marketing goes to the marketing rotation when finished', async () => {
  cardReply = card({ company: 'Gate Visitor Exports', mobile: '9840077777' });
  await whatsapp(KAVITHA_PHONE, { photo: true });
  const draft = await readCardOf(admin);
  const done = await finish(draft._id, { ...theRest, source: 'walk_in' }, admin);
  assert.equal(done.status, 200, done.json.message);
  const owner = await mongoose.model('User').findById(done.json.data.lead.assignedTo);
  assert.equal(owner.department, 'marketing', 'despatch cannot hold a buyer, so marketing does');
});

test('a photo from a customer’s number is a customer message, not a draft', async () => {
  cardReply = card({ company: 'Should Not Be Read' });
  const arrived = await whatsapp('+919811100000', { photo: true, body: 'Price for this hanger?' });
  assert.notEqual(arrived.json.outcome, 'lead_card');
  assert.ok(arrived.json.thread, 'it went to the WhatsApp inbox');
  assert.equal(sent.length, 0, 'and was never sent to the model');
});

test('a redelivered webhook reads the picture once', async () => {
  cardReply = card({ company: 'Once Only Knits', mobile: '9840066666' });
  await whatsapp(NANDHINI_PHONE, { photo: true, sid: 'SMREPEAT' });
  await whatsapp(NANDHINI_PHONE, { photo: true, sid: 'SMREPEAT' });
  await readCardOf(nandhini);
  const drafts = (await api('/api/lead-cards', { token: admin })).json.data.filter((row) => row.reading?.company === 'Once Only Knits');
  assert.equal(drafts.length, 1);
});

test('media is only fetched from the provider’s own host', async () => {
  const before = (await api('/api/lead-cards', { token: admin })).json.waiting;
  const hits = mediaHits;
  /* The same server under a name that is not on the list: reachable, and still refused. */
  const arrived = await whatsapp(NANDHINI_PHONE, { photo: `http://localhost:${media.address().port}/anything` });
  assert.equal(mediaHits, hits, 'the address was never called');
  assert.equal(arrived.json.outcome, 'lead_card');
  assert.equal((await api('/api/lead-cards', { token: admin })).json.waiting, before, 'no draft from a foreign address');
  assert.match(replies.join('\n'), /could not be fetched/);
});

/* --------------------------------- In the app --------------------------------- */

test('a picture the model could not read is typed in from the photo and finished', async () => {
  cardReply = null; // the model declines
  await whatsapp(NANDHINI_PHONE, { photo: true });
  const draft = await readCardOf(nandhini);
  assert.equal(draft.status, 'unreadable');
  assert.ok(draft.problem);
  assert.match(latestReply(), /Saved as a draft lead, but/);

  const image = await fetch(`${baseUrl}/api/lead-cards/${draft._id}/image`, { headers: { Authorization: `Bearer ${nandhini}` } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');

  assert.equal((await finish(draft._id, { ...theRest, mobile: '9840055555' })).status, 400, 'a lead needs a company');
  assert.equal((await finish(draft._id, { ...theRest, company: 'Handwritten Hangers' })).status, 400, 'and a way to reach them');
  assert.equal((await finish(draft._id, { ...theRest, company: 'Handwritten Hangers', mobile: '12' })).status, 400);

  const done = await finish(draft._id, { ...theRest, company: 'Handwritten Hangers', mobile: '9840055555' });
  assert.equal(done.status, 200, done.json.message);
  assert.match(done.json.data.lead.activities[0].summary, /typed in by Nandhini S/);
  assert.equal((await finish(draft._id, { ...theRest, company: 'Handwritten Hangers', mobile: '9840055555' })).status, 409, 'a draft is finished once');
});

test('marketing sees the drafts they sent; management sees every draft', async () => {
  const mine = (await api('/api/lead-cards?status=decided', { token: nandhini })).json.data;
  assert.ok(mine.length > 0);
  assert.ok(mine.every((row) => row.sender.name === 'Nandhini S'));
  const theirs = (await api('/api/lead-cards?status=decided', { token: arun })).json.data;
  assert.equal(theirs.length, 0, 'Arun sent none');
  const refused = await fetch(`${baseUrl}/api/lead-cards/${mine[0]._id}/image`, { headers: { Authorization: `Bearer ${arun}` } });
  assert.equal(refused.status, 404, 'nor may he open her pictures');
  const all = (await api('/api/lead-cards?status=decided', { token: admin })).json.data;
  assert.ok(all.some((row) => row.sender.name === 'Kavitha D'));
});

test('a picture uploaded in the app is read straight away', async () => {
  cardReply = card({ company: 'Uploaded Apparel', mobile: '9840044444', email: 'not-an-email' });
  const form = new FormData();
  form.append('image', new Blob([PNG], { type: 'image/png' }), 'card.png');
  const made = await api('/api/lead-cards', { method: 'POST', token: arun, form });
  assert.equal(made.status, 201, made.json.message);
  assert.equal(made.json.data.status, 'ready');
  assert.equal(made.json.data.reading.company, 'Uploaded Apparel');
  assert.equal(made.json.data.reading.email, undefined, 'an address that is not an email is dropped, not stored');
});

/* ------------------------------ Chat screenshots ------------------------------ */

const chat = (fields) => ({ ...blank, kind: 'chat', ...fields });

test('a chat screenshot is drafted with what the buyer asked for, and finished by the salesperson', async () => {
  cardReply = chat({
    company: 'Velan Textiles', contactName: 'Karthik', mobile: '+91 97890 12345',
    productInterest: '400mm black shirt hangers', quantity: '5k pcs',
    notes: 'Wants 5,000 black shirt hangers by the 20th; asked for a rate and a sample.',
  });
  await whatsapp(NANDHINI_PHONE, { photo: true });
  const draft = await readCardOf(nandhini);
  assert.equal(draft.kind, 'chat');
  assert.equal(draft.reading.estimatedQuantity, 5000, '"5k pcs" is 5,000 pieces');
  assert.match(latestReply(), /Saved as a draft lead from this chat:[\s\S]*Quantity: 5,000 pcs/);

  const done = await finish(draft._id, { ...theRest, source: 'whatsapp', nextAction: 'Send rate and sample' });
  assert.equal(done.status, 200, done.json.message);
  const lead = await Lead.findById(done.json.data.lead._id);
  assert.equal(lead.estimatedQuantity, 5000);
  assert.equal(lead.productInterest, '400mm black shirt hangers');
  assert.equal(lead.nextAction, 'Send rate and sample');
  assert.match(lead.activities[0].summary, /WhatsApp chat screenshot[\s\S]*The conversation: Wants 5,000 black shirt hangers/);
});

test('a chat with only a saved name: the person stands in for the company, and the number is left to fill in', async () => {
  cardReply = chat({ contactName: 'Ramesh Tiruppur', productInterest: 'suit hangers' });
  await whatsapp(NANDHINI_PHONE, { photo: true });
  const draft = await readCardOf(nandhini);
  assert.equal(draft.reading.company, 'Ramesh Tiruppur');
  assert.equal(draft.companyFromName, true);
  assert.match(latestReply(), /the person's name — no business was named/, 'said before anybody confirms');
  assert.equal(draft.reading.mobile, undefined);

  const noNumber = await finish(draft._id, theRest);
  assert.equal(noNumber.status, 400);
  const done = await finish(draft._id, { ...theRest, mobile: '97900 12345' });
  assert.equal(done.status, 200, done.json.message);
  assert.equal(done.json.data.lead.mobile, '+919790012345');
});

test('the rest of a long chat joins the screenshot that showed who it was with', async () => {
  cardReply = [
    chat({ contactName: 'Selvi', company: 'Selvi Fashions', mobile: '9790055555', notes: 'Asked about suit hangers.' }),
    chat({ productInterest: 'wooden suit hangers', quantity: '2000', notes: 'Wants samples by Friday.' }),
  ];
  await whatsapp(NANDHINI_PHONE, { photo: true });
  const first = await readCardOf(nandhini);
  await whatsapp(NANDHINI_PHONE, { photo: true });
  await new Promise((resolve) => setTimeout(resolve, 400));

  const open = (await api('/api/lead-cards', { token: nandhini })).json.data.filter((row) => row.reading?.company === 'Selvi Fashions' || !row.reading?.company);
  assert.equal(open.length, 1, 'one chat, not two drafts');
  const merged = open[0];
  assert.equal(merged._id, first._id);
  assert.equal(merged.moreImages.length, 1, 'the second screenshot is kept with the first');
  assert.equal(merged.reading.productInterest, 'wooden suit hangers');
  assert.equal(merged.reading.estimatedQuantity, 2000);
  assert.match(merged.reading.notes, /Asked about suit hangers\. Wants samples by Friday\./);
  const second = await fetch(`${baseUrl}/api/lead-cards/${merged._id}/image?n=1`, { headers: { Authorization: `Bearer ${nandhini}` } });
  assert.equal(second.status, 200);
  await api(`/api/lead-cards/${merged._id}/discard`, { method: 'POST', token: nandhini });
});

test('a picture that is neither a card nor a chat says so and adds nothing', async () => {
  cardReply = { ...blank, kind: 'other' };
  await whatsapp(NANDHINI_PHONE, { photo: true });
  const draft = await readCardOf(nandhini);
  assert.equal(draft.status, 'unreadable');
  assert.match(latestReply(), /does not look like a card, an enquiry slip or a chat/);
  await api(`/api/lead-cards/${draft._id}/discard`, { method: 'POST', token: nandhini });
});

test('quantities are read the way people write them', async () => {
  const { parseQuantity } = await import('../src/services/leadCard.llm.js');
  assert.equal(parseQuantity('5000 pcs'), 5000);
  assert.equal(parseQuantity('5,000'), 5000);
  assert.equal(parseQuantity('5k'), 5000);
  assert.equal(parseQuantity('1.5 lakh'), 150000);
  assert.equal(parseQuantity('2 lacs'), 200000);
  assert.equal(parseQuantity(''), null);
  assert.equal(parseQuantity('a few thousand'), null);
});
