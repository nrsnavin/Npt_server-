/**
 * The model's three readings of a sample's pictures, suggest only [services/sampleVision.llm.js;
 * the sampling audit, items 3, 4 and 9]: the courier slip into the dispatch fields, a buyer's
 * photo against the mould register, the finished piece against the reference. The model is
 * stubbed; the readings are kept on the picture so a second look never re-reads.
 *
 *   node --test tests/sample-vision.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'sample-vision-test-secret';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

/* The model: whatever `reply` says next, and a record of what it was sent. */
const sent = [];
let reply = null;
const sdk = await import('@anthropic-ai/sdk');
Object.defineProperty(sdk.default.prototype, 'messages', {
  configurable: true,
  get: () => ({
    create: async (request) => {
      sent.push(request);
      const answer = typeof reply === 'function' ? reply(request) : Array.isArray(reply) ? reply.shift() : reply;
      if (!answer) return { stop_reason: 'refusal', content: [] };
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }] };
    },
  }),
  set: () => {},
});

let mongo;
let server;
let baseUrl;
let events;
const token = {};
let customerId;
const moulds = {};
let Attachment;

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const NO_PHOTO = { noPhoto: true, noPhotoReason: 'No camera on the test bench' };

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
async function upload(path, { as, method = 'PUT', file = PNG, filename = 'piece.png' }) {
  const boundary = `----npt${Date.now()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, Authorization: `Bearer ${token[as]}` }, body });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
const soon = (days = 3) => new Date(Date.now() + days * 86400000).toISOString();

/** An enquiry for one model, moved to Sampling; the request at Sample available. */
async function requested(requirement = { modelNumber: 'NPT-400S', colour: 'Ivory', colourMandatory: true }, extra = {}) {
  const raised = await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { customer: customerId, requirement, nextAction: 'Call', nextFollowUpDate: soon(), ...extra } });
  assert.equal(raised.status, 201, raised.json.message);
  const enquiry = raised.json.data;
  await api(`/api/enquiries/${enquiry._id}/status`, { method: 'POST', as: 'nandhini', body: { status: 'sample_required', nextAction: 'Call', nextFollowUpDate: soon() } });
  await settle();
  const sample = (await api(`/api/samples?enquiry=${enquiry._id}`, { as: 'meera' })).json.data[0];
  for (const status of ['checking_stock', 'sample_available']) await api(`/api/samples/${sample._id}/status`, { method: 'POST', as: 'meera', body: { status } });
  return { enquiry, sample };
}

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  events = await import('../src/services/events.service.js');
  const { default: app } = await import('../src/app.js');
  ({ default: Attachment } = await import('../src/models/Attachment.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['meera', 'Meera S', 'sampling']]) {
    await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  customerId = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'SCM Garments', mobile: '9876500011', assignedTo: me } })).json.data._id;
  for (const [code, name, category, sizeMm] of [['NPT-400S', 'Shirt Hanger 400mm', 'shirt', 400], ['NPT-380T', 'Trouser Hanger 380mm', 'trouser', 380], ['NPT-300K', 'Kids Hanger 300mm', 'kids', 300]]) {
    const made = await api('/api/moulds', { method: 'POST', as: 'admin', body: { mouldCode: code, name, category, sizeMm, material: 'plastic', cavities: 4, partWeightGrams: 20, cycleTimeSeconds: 25, moq: 5000 } });
    assert.equal(made.status, 201, `${code}: ${made.json.message}`);
    moulds[code] = made.json.data._id;
  }
});

test.after(async () => {
  events?.clearListeners();
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the courier and AWB are read off the courier copy — a suggestion, tidied: a known courier by name, the AWB without spaces', async () => {
  reply = { courier: 'BLUE DART EXPRESS LTD', awbNumber: '7721 3904 118', confidence: 0.93 };
  const read = await upload('/api/samples/read-courier-copy', { as: 'meera', method: 'POST', filename: 'slip.png' });
  assert.equal(read.status, 200, read.json.message);
  assert.deepEqual(read.json.data, { courier: 'Blue Dart', awbNumber: '77213904118', confidence: 0.93, problem: null });
  assert.ok(sent.at(-1).messages[0].content.some((block) => block.type === 'image'), 'the picture went to the model');

  reply = { courier: '', awbNumber: '', confidence: 0 };
  const blank = await upload('/api/samples/read-courier-copy', { as: 'meera', method: 'POST', filename: 'slip.png' });
  assert.equal(blank.status, 200);
  assert.match(blank.json.data.problem, /No courier or AWB number could be read/);

  reply = null;
  const down = await upload('/api/samples/read-courier-copy', { as: 'meera', method: 'POST', filename: 'slip.png' });
  assert.match(down.json.data.problem, /could not be read just now/, 'a refusal is a reading that did not happen');

  const marketing = await upload('/api/samples/read-courier-copy', { as: 'nandhini', method: 'POST', filename: 'slip.png' });
  assert.equal(marketing.status, 403, 'the bench dispatches');
});

test('a buyer’s photo is matched to the register: three nearest with a confidence, kept on the picture, and a person picks one', async () => {
  const { sample } = await requested({ category: 'shirt', sizeMm: 380, colour: 'White' }, { isNewDevelopment: true, remarks: 'Buyer sent a photo of a hanger' });
  const [row] = sample.items;
  assert.ok(row, 'a row to match');
  const unmatched = await api(`/api/samples/${sample._id}/items/${row._id}/match`, { method: 'POST', as: 'nandhini' });
  assert.equal(unmatched.status, 400, 'nothing to match without a reference photo');
  assert.match(unmatched.json.message, /buyer's photo/);

  assert.equal((await upload(`/api/samples/${sample._id}/items/${row._id}/reference-photo`, { as: 'nandhini' })).status, 200);
  sent.length = 0;
  reply = (request) => {
    const text = request.messages[0].content.find((block) => block.type === 'text').text;
    assert.match(text, /Register:/);
    assert.match(text, /NPT-400S/);
    const refs = JSON.parse(text.split('Register:\n')[1]).map((entry) => entry.ref);
    return { candidates: [{ ref: refs[1], confidence: 0.82 }, { ref: refs[0], confidence: 0.4 }, { ref: refs[2], confidence: 0.1 }], none: false, seen: { shape: 'top hanger with notches', size: '380', hook: 'swivel metal', print: 'none', colour: 'white' } };
  };
  const matched = await api(`/api/samples/${sample._id}/items/${row._id}/match`, { method: 'POST', as: 'nandhini' });
  assert.equal(matched.status, 200, matched.json.message);
  const { match } = matched.json.data.items[0];
  assert.deepEqual(match.candidates.map((entry) => [entry.code, entry.confidence, entry.sure]), [['NPT-380T', 0.82, true], ['NPT-400S', 0.4, false], ['NPT-300K', 0.1, false]]);
  assert.equal(match.none, false);
  assert.equal(match.seen.shape, 'top hanger with notches');
  assert.equal(sent.length, 1);
  assert.ok(!matched.json.data.items[0].mould, 'nothing filled in by itself');

  /* Kept on the picture: the next look costs nothing. */
  const again = await api(`/api/samples/${sample._id}/items/${row._id}/match`, { method: 'POST', as: 'nandhini' });
  assert.equal(again.status, 200);
  assert.equal(sent.length, 1, 'read once');
  const kept = await Attachment.findById(again.json.data.items[0].referencePhoto._id);
  assert.equal(kept.readings.match.result.candidates[0].code, 'NPT-380T');

  const wrong = await api(`/api/samples/${sample._id}/items/${row._id}/pick-model`, { method: 'POST', as: 'nandhini', body: { ref: 'mnotarow' } });
  assert.equal(wrong.status, 400, 'only one of the matched models');
  const picked = await api(`/api/samples/${sample._id}/items/${row._id}/pick-model`, { method: 'POST', as: 'nandhini', body: { ref: match.candidates[0].ref } });
  assert.equal(picked.status, 200, picked.json.message);
  assert.equal(picked.json.data.items[0].modelNumber, 'NPT-380T');
  assert.equal(picked.json.data.items[0].mould.mouldCode, 'NPT-380T');
  assert.equal(picked.json.data.items[0].category, 'trouser');
  assert.equal(picked.json.data.modelNumber, 'NPT-380T', 'the top line follows the first row');
  assert.match(picked.json.data.statusHistory.at(-1).note, /NPT-380T picked from the buyer's photo \(matched at 82%\)/);

  /* "Not one of ours": low confidence everywhere shows as unsure, with what was seen. */
  const { sample: other } = await requested({ category: 'suit', sizeMm: 450, colour: 'Black' }, { isNewDevelopment: true, remarks: 'Buyer sent a photo of a wooden hanger' });
  await upload(`/api/samples/${other._id}/items/${other.items[0]._id}/reference-photo`, { as: 'nandhini', filename: 'odd.png' });
  reply = (request) => {
    const refs = JSON.parse(request.messages[0].content.find((block) => block.type === 'text').text.split('Register:\n')[1]).map((entry) => entry.ref);
    return { candidates: [{ ref: refs[0], confidence: 0.2 }], none: true, seen: { shape: 'wooden suit hanger', size: '450', hook: 'brass', print: 'none', colour: 'walnut' } };
  };
  const nobody = await api(`/api/samples/${other._id}/items/${other.items[0]._id}/match`, { method: 'POST', as: 'nandhini' });
  assert.equal(nobody.json.data.items[0].match.none, true);
  assert.equal(nobody.json.data.items[0].match.candidates[0].sure, false);
});

test('the finished piece is checked against the reference as it lands; a difference is stepped past out loud at Sample Ready', async () => {
  const { sample } = await requested();
  const [row] = sample.items;
  assert.equal((await upload(`/api/samples/${sample._id}/items/${row._id}/reference-photo`, { as: 'nandhini' })).status, 200);

  sent.length = 0;
  reply = { verdict: 'differs', findings: ['colour darker than the reference', 'hook is plain plastic, reference has a swivel metal hook'], summary: 'Darker than the reference and the wrong hook.' };
  const taken = await upload(`/api/samples/${sample._id}/items/${row._id}/photo`, { as: 'meera' });
  assert.equal(taken.status, 200, taken.json.message);
  const checked = taken.json.data.items[0].check;
  assert.equal(checked.verdict, 'differs');
  assert.deepEqual(checked.findings, ['colour darker than the reference', 'hook is plain plastic, reference has a swivel metal hook']);
  assert.equal(checked.summary, 'Darker than the reference and the wrong hook.');
  assert.equal(sent.length, 1, 'checked once, as the photo landed');
  const request = sent[0];
  assert.equal(request.messages[0].content.filter((block) => block.type === 'image').length, 2, 'the finished piece and the reference');
  assert.match(request.messages[0].content.at(-1).text, /colour Ivory \(exact — must match the shade\)/, 'the spec rides along, with the colour rule');

  /* The draft marketing reads carries the finding. */
  const preview = await api(`/api/samples/${sample._id}/customer-message/preview?event=sample_ready`, { as: 'nandhini' });
  assert.equal(preview.json.data.checks[0].verdict, 'differs');

  const held = await api(`/api/samples/${sample._id}/status`, { method: 'POST', as: 'meera', body: { status: 'sample_ready' } });
  assert.equal(held.status, 400);
  assert.match(held.json.message, /The check found a difference on NPT-400S — Darker than the reference/);
  assert.match(held.json.message, /tick Checked and say why/);

  const ready = await api(`/api/samples/${sample._id}/status`, { method: 'POST', as: 'meera', body: { status: 'sample_ready', checkOverride: true, checkOverrideReason: 'Buyer wants the darker shade; hook agreed on the phone' } });
  assert.equal(ready.status, 200, ready.json.message);
  assert.equal(ready.json.data.items[0].checkAccepted.reason, 'Buyer wants the darker shade; hook agreed on the phone');
  assert.match(ready.json.data.statusHistory.at(-1).note, /Checked past the difference on NPT-400S: Buyer wants the darker shade/);

  /* A matching piece needs nothing; a retake clears the old finding and is checked afresh. */
  const { sample: fine } = await requested();
  reply = { verdict: 'matches', findings: [], summary: 'Looks right.' };
  await upload(`/api/samples/${fine._id}/items/${fine.items[0]._id}/reference-photo`, { as: 'nandhini' });
  const ok = await upload(`/api/samples/${fine._id}/items/${fine.items[0]._id}/photo`, { as: 'meera' });
  assert.equal(ok.json.data.items[0].check.verdict, 'matches');
  const readyToo = await api(`/api/samples/${fine._id}/status`, { method: 'POST', as: 'meera', body: { status: 'sample_ready' } });
  assert.equal(readyToo.status, 200, readyToo.json.message);

  /* With the model down, the photo still lands and nothing is held. */
  const { sample: quiet } = await requested();
  reply = null;
  const landed = await upload(`/api/samples/${quiet._id}/items/${quiet.items[0]._id}/photo`, { as: 'meera' });
  assert.equal(landed.status, 200);
  assert.equal(landed.json.data.items[0].check, undefined);
  assert.equal((await api(`/api/samples/${quiet._id}/status`, { method: 'POST', as: 'meera', body: { status: 'sample_ready' } })).status, 200);
});
