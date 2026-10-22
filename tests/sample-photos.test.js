/**
 * The two pictures on each model row of a sample [the sampling audit, items 1 and 2]: the
 * buyer's reference for that model, and the finished piece the bench photographs at Sample Ready.
 *
 *   - Sample Ready is refused without a photo on each row, unless the bench ticks No photo and
 *     says why — and the reason stays on the move.
 *   - The photos travel: the queue row, the enquiry's sample list, the buyer's ready and dispatch
 *     notices (a signed link WhatsApp fetches), the order's approved-sample check, and the mould
 *     register when the tool has no photo of its own.
 *
 *   node --test tests/sample-photos.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'sample-photos-test-secret';
process.env.PUBLIC_API_URL = 'https://plant.example.com/api';

let mongo;
let server;
let baseUrl;
let events;
const token = {};
let customerId;
let mouldId;
let Sample;
let CustomerMessage;

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

/** Multipart by hand, as the browser would post it. */
async function upload(path, { as, method = 'PUT', file = PNG, filename = 'piece.png' }) {
  const boundary = `----npt${Date.now()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, Authorization: `Bearer ${token[as]}` }, body,
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
const soon = (days = 3) => new Date(Date.now() + days * 86400000).toISOString();

/** An enquiry for two models, moved to Sampling, and the request it raised. */
async function requested() {
  const enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: {
      customer: customerId, mould: mouldId,
      items: [{ mould: mouldId, modelNumber: 'NPT-400S', colour: 'White', quantity: 5000 }, { modelNumber: 'NPT-380T', colour: 'Black', quantity: 3000 }],
      nextAction: 'Call', nextFollowUpDate: soon(),
    },
  })).json.data;
  await api(`/api/enquiries/${enquiry._id}/status`, { method: 'POST', as: 'nandhini', body: { status: 'sample_required', nextAction: 'Call', nextFollowUpDate: soon() } });
  await settle();
  const sample = (await api(`/api/samples?enquiry=${enquiry._id}`, { as: 'meera' })).json.data[0];
  assert.ok(sample, 'the enquiry raised a sample');
  assert.equal(sample.items.length, 2, 'both models are in the bag');
  for (const status of ['checking_stock', 'sample_available']) {
    const moved = await api(`/api/samples/${sample._id}/status`, { method: 'POST', as: 'meera', body: { status } });
    assert.equal(moved.status, 200, moved.json.message);
  }
  return { enquiry, sample };
}

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  events = await import('../src/services/events.service.js');
  const { default: app } = await import('../src/app.js');
  ({ default: Sample } = await import('../src/models/Sample.js'));
  ({ default: CustomerMessage } = await import('../src/models/CustomerMessage.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['meera', 'Meera S', 'sampling'], ['priya', 'Priya Orders', 'order_confirmation']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  customerId = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'SCM Garments', mobile: '9876500011', whatsapp: '9876500011', email: 'scm@example.com', assignedTo: me } })).json.data._id;
  mouldId = (await api('/api/moulds', {
    method: 'POST', as: 'admin',
    body: { mouldCode: 'M-NPT-400S', name: 'Shirt Hanger 400mm', category: 'shirt', sizeMm: 400, material: 'plastic', cavities: 4, partWeightGrams: 26, cycleTimeSeconds: 28, moq: 5000 },
  })).json.data._id;
});

test.after(async () => {
  events?.clearListeners();
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('Sample Ready needs a photo of each finished piece — refused without, allowed with No photo and a reason', async () => {
  const { sample } = await requested();
  const bare = await api(`/api/samples/${sample._id}/status`, { method: 'POST', as: 'meera', body: { status: 'sample_ready' } });
  assert.equal(bare.status, 400);
  assert.match(bare.json.message, /photo of each finished piece/);
  assert.match(bare.json.message, /NPT-400S, NPT-380T/, 'names the rows without one');

  const unsaid = await api(`/api/samples/${sample._id}/status`, { method: 'POST', as: 'meera', body: { status: 'sample_ready', noPhoto: true, noPhotoReason: 'ok' } });
  assert.equal(unsaid.status, 400, 'a reason too short to mean anything');

  const excused = await api(`/api/samples/${sample._id}/status`, { method: 'POST', as: 'meera', body: { status: 'sample_ready', noPhoto: true, noPhotoReason: 'Bench phone is dead; pieces already bagged' } });
  assert.equal(excused.status, 200, excused.json.message);
  assert.equal(excused.json.data.status, 'sample_ready');
  assert.equal(excused.json.data.readyWithoutPhoto.reason, 'Bench phone is dead; pieces already bagged');
  assert.equal(excused.json.data.readyWithoutPhoto.by.name, 'Meera S');
  assert.match(excused.json.data.statusHistory.at(-1).note, /No photo: Bench phone is dead/);
});

test('a photo per row: the bench takes the finished piece, marketing adds the reference; each is replaced, not added; a closed sample takes none', async () => {
  const { sample } = await requested();
  const [first, second] = sample.items;

  const notMarketing = await upload(`/api/samples/${sample._id}/items/${first._id}/photo`, { as: 'nandhini' });
  assert.equal(notMarketing.status, 403, 'the finished piece is the bench’s to photograph');

  const taken = await upload(`/api/samples/${sample._id}/items/${first._id}/photo`, { as: 'meera' });
  assert.equal(taken.status, 200, taken.json.message);
  const row = taken.json.data.items.find((item) => item._id === first._id);
  assert.ok(row.photo?.key, 'the row carries its photo');
  assert.equal(row.photoBy.name, 'Meera S');
  assert.ok(row.photoAt);
  assert.ok(!taken.json.data.items.find((item) => item._id === second._id).photo, 'the other row has none');

  const retaken = await upload(`/api/samples/${sample._id}/items/${first._id}/photo`, { as: 'meera', filename: 'retake.png' });
  assert.equal(retaken.status, 200);
  const again = retaken.json.data.items.find((item) => item._id === first._id);
  assert.notEqual(again.photo.key, row.photo.key, 'replaced');
  const { default: Attachment } = await import('../src/models/Attachment.js');
  assert.equal(await Attachment.countDocuments({ sample: sample._id, docType: 'finished_photo' }), 1, 'the old file is gone');

  const reference = await upload(`/api/samples/${sample._id}/items/${second._id}/reference-photo`, { as: 'nandhini' });
  assert.equal(reference.status, 200, reference.json.message);
  assert.ok(reference.json.data.items.find((item) => item._id === second._id).referencePhoto?.key, 'marketing adds the buyer’s reference to a row');

  const wrongRow = await upload(`/api/samples/${sample._id}/items/0123456789abcdef01234567/photo`, { as: 'meera' });
  assert.equal(wrongRow.status, 404);

  /* Still one photo short: Sample Ready names the row without. */
  const short = await api(`/api/samples/${sample._id}/status`, { method: 'POST', as: 'meera', body: { status: 'sample_ready' } });
  assert.equal(short.status, 400);
  assert.match(short.json.message, /NPT-380T has none/);

  const second_ = await upload(`/api/samples/${sample._id}/items/${second._id}/photo`, { as: 'meera' });
  assert.equal(second_.status, 200);
  const ready = await api(`/api/samples/${sample._id}/status`, { method: 'POST', as: 'meera', body: { status: 'sample_ready' } });
  assert.equal(ready.status, 200, ready.json.message);
  assert.equal(ready.json.data.readyWithoutPhoto, undefined, 'no excuse needed');
  assert.equal(ready.json.data.finishedPhotos.length, 2);

  const cleared = await api(`/api/samples/${sample._id}/items/${first._id}/photo`, { method: 'DELETE', as: 'meera' });
  assert.equal(cleared.status, 200);
  assert.ok(!cleared.json.data.items.find((item) => item._id === first._id).photo);

  await api(`/api/samples/${sample._id}/status`, { method: 'POST', as: 'meera', body: { status: 'cancelled', note: 'Buyer dropped it' } });
  const late = await upload(`/api/samples/${sample._id}/items/${second._id}/photo`, { as: 'meera' });
  assert.equal(late.status, 400, 'a cancelled sample takes no more photos');
});

test('the photos travel: the queue row, the enquiry’s samples, a corrected bag, and the buyer’s notices with a signed link', async () => {
  const { enquiry, sample } = await requested();
  const [first, second] = sample.items;
  await upload(`/api/samples/${sample._id}/items/${first._id}/photo`, { as: 'meera' });
  await upload(`/api/samples/${sample._id}/items/${first._id}/reference-photo`, { as: 'nandhini' });

  const row = (await api('/api/samples/queue', { as: 'meera' })).json.data.rows.find((entry) => entry._id === sample._id);
  assert.equal(row.models[0]._id, first._id);
  assert.ok(row.models[0].photo, 'the queue row carries the finished piece');
  assert.ok(row.models[0].referencePhoto);
  assert.equal(row.models[1].photo, null);
  assert.deepEqual(row.photos, { taken: 1, of: 2 });

  const listed = (await api(`/api/samples?enquiry=${enquiry._id}`, { as: 'nandhini' })).json.data[0];
  assert.ok(listed.items[0].photo?.key, 'the enquiry’s sample list carries it too');

  /* A correction to the bag keeps the photos and the row ids. */
  const edited = await api(`/api/samples/${sample._id}`, {
    method: 'PATCH', as: 'meera',
    body: { items: [{ _id: first._id, mould: mouldId, modelNumber: 'NPT-400S', colour: 'Ivory', quantity: 6 }, { _id: second._id, modelNumber: 'NPT-380T', colour: 'Black', quantity: 3 }] },
  });
  assert.equal(edited.status, 200, edited.json.message);
  assert.equal(edited.json.data.items[0]._id, first._id, 'the row keeps its id');
  assert.equal(edited.json.data.items[0].colour, 'Ivory');
  assert.ok(edited.json.data.items[0].photo?.key, 'and its photo');
  assert.ok(edited.json.data.items[0].referencePhoto?.key);

  await upload(`/api/samples/${sample._id}/items/${second._id}/photo`, { as: 'meera' });
  const preview = await api(`/api/samples/${sample._id}/customer-message/preview?event=sample_ready`, { as: 'nandhini' });
  assert.equal(preview.status, 200, preview.json.message);
  assert.deepEqual(preview.json.data.photos.map((photo) => photo.model), ['NPT-400S', 'NPT-380T'], 'the draft says which pictures go');

  const ready = await api(`/api/samples/${sample._id}/status`, { method: 'POST', as: 'meera', body: { status: 'sample_ready' } });
  assert.equal(ready.status, 200, ready.json.message);
  await settle();
  const sent = await CustomerMessage.find({ sample: sample._id, event: 'sample_ready', status: 'sent' }).lean();
  assert.ok(sent.length >= 1, 'the ready notice went');
  assert.ok(sent.every((message) => message.photos === 2), `every channel carried both photos: ${JSON.stringify(sent.map((m) => [m.channel, m.photos]))}`);

  /* The link WhatsApp fetches: signed, and only for a sample's own pictures. */
  const { samplePhotoUrl } = await import('../src/services/customerMessage.service.js');
  const { default: Attachment } = await import('../src/models/Attachment.js');
  const file = await Attachment.findOne({ sample: sample._id, docType: 'finished_photo' });
  const url = samplePhotoUrl(file);
  assert.match(url, /^https:\/\/plant\.example\.com\/api\/public\/sample-photos\//);
  const path = url.replace('https://plant.example.com/api', '/api');
  const fetched = await fetch(`${baseUrl}${path}`);
  assert.equal(fetched.status, 200, 'no session needed — the signature is the permission');
  assert.equal(fetched.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await fetched.arrayBuffer()).length, PNG.length);
  const bent = await fetch(`${baseUrl}${path.replace(/\/([0-9a-f]{64})\//, '/' + '0'.repeat(64) + '/')}`);
  assert.equal(bent.status, 404, 'a forged signature opens nothing');
});

test('the approved sample’s photos sit beside the order’s checks; a mould with no photo wears the latest piece made on it', async () => {
  const { enquiry, sample } = await requested();
  const [first] = sample.items;
  const taken = await upload(`/api/samples/${sample._id}/items/${first._id}/photo`, { as: 'meera' });
  assert.equal(taken.status, 200, taken.json.message);
  assert.ok(taken.json.data.items[0].photo?.key);
  const readied = await api(`/api/samples/${sample._id}/status`, { method: 'POST', as: 'meera', body: { status: 'sample_ready', noPhoto: true, noPhotoReason: 'Second model still drying' } });
  assert.equal(readied.status, 200, readied.json.message);
  assert.ok(readied.json.data.items[0].photo?.key, 'kept through Sample Ready');
  const gone = await api(`/api/samples/${sample._id}/status`, { method: 'POST', as: 'meera', body: { status: 'dispatched', courier: 'Blue Dart', awbNumber: '77213904118', dispatchedQuantity: 5 } });
  assert.equal(gone.status, 200, gone.json.message);
  assert.ok(gone.json.data.items[0].photo?.key, 'kept through dispatch');
  await settle();
  assert.ok((await api(`/api/samples/${sample._id}`, { as: 'meera' })).json.data.items[0].photo?.key, 'kept after the dispatch handovers');
  const approved = await api(`/api/samples/${sample._id}/feedback`, { method: 'POST', as: 'nandhini', body: { outcome: 'approved', note: 'Buyer liked the white' } });
  assert.equal(approved.status, 200, approved.json.message);
  assert.ok(approved.json.data.items[0].photo?.key, 'kept through approval');
  await settle();
  assert.ok((await api(`/api/samples/${sample._id}`, { as: 'meera' })).json.data.items[0].photo?.key, 'kept after the approval handovers');

  const order = await api('/api/orders', {
    method: 'POST', as: 'admin',
    body: { enquiry: enquiry._id, customerPo: { number: 'PO/SP/1' }, lines: [{ modelNumber: 'NPT-400S', quantity: 10000, unitPrice: 2 }] },
  });
  assert.equal(order.status, 201, order.json.message);
  const read = await api(`/api/orders/${order.json.data._id}`, { as: 'admin' });
  assert.equal(read.status, 200);
  assert.equal(read.json.approvedSample.number, sample.number);
  assert.equal(read.json.approvedSample.note, 'Buyer liked the white');
  assert.equal(read.json.approvedSample.items[0].model, 'NPT-400S');
  assert.ok(read.json.approvedSample.items[0].photo, 'the piece the buyer approved, beside the checks');
  assert.equal(read.json.approvedSample.items[1].photo, null);

  /* The register: the tool has no photo of its own, so it wears the sample's, and says so. */
  const mould = await api(`/api/moulds/${mouldId}`, { as: 'admin' });
  assert.equal(mould.status, 200);
  assert.ok(mould.json.data.photo?.key, 'the latest finished piece made on this tool');
  assert.equal(mould.json.data.photo.fromSample, sample.number);
  const listed = (await api('/api/moulds?limit=50', { as: 'admin' })).json.data.find((row) => row._id === mouldId);
  assert.equal(listed.photo?.fromSample, sample.number, 'on the list too');

  /* With its own photo, the register's wins. */
  const own = await upload(`/api/moulds/${mouldId}/photo`, { as: 'admin' });
  assert.equal(own.status, 200, own.json.message);
  const after = await api(`/api/moulds/${mouldId}`, { as: 'admin' });
  assert.equal(after.json.data.photo.fromSample, undefined);
});
