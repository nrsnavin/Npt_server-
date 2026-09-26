/**
 * The files posted into a query are read, and what they say goes into the thread's summary.
 *
 * What is held to: a PDF goes to the model as a document, a Word or Excel file as its text; the
 * reading comes back beside the summary, labelled, and is never saved; a file is read once, not
 * on every open; a file that cannot be read says why without a model call; and the list's line
 * picks the reading up once it exists.
 *
 * Anthropic is stubbed on the SDK's prototype — no test here reaches the network.
 *
 *   node --test tests/query-files.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'query-files-test-secret';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

const fileCalls = [];
const summaryCalls = [];
const lineCalls = [];
let fileDelayMs = 0;
const sdk = await import('@anthropic-ai/sdk');
Object.defineProperty(sdk.default.prototype, 'messages', {
  configurable: true,
  get: () => ({
    create: async (request) => {
      const system = String(request.system);
      const reply = (body) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(body) }] });
      if (system.includes('You read one file')) {
        fileCalls.push(request);
        if (fileDelayMs) await new Promise((resolve) => setTimeout(resolve, fileDelayMs));
        const content = request.messages[0].content;
        const name = content.map((block) => block.text || '').join(' ').match(/named "([^"]+)"/)?.[1];
        return reply({ says: `Reading of ${name}` });
      }
      if (system.includes('You summarise an internal thread')) {
        summaryCalls.push(request);
        return reply({ summary: 'Model summary of the thread.', outstanding: true });
      }
      if (system.includes('one line for each internal thread')) {
        lineCalls.push(request);
        const ids = [...request.messages[0].content.matchAll(/<thread id="([a-f0-9]{24})">/g)].map(([, id]) => id);
        return reply({ lines: ids.map((id) => ({ id, summary: `Line for ${id}`, outstanding: true })) });
      }
      return { stop_reason: 'refusal', content: [] };
    },
  }),
  set: () => {},
});

/* ------------------------------ A tiny zip writer ------------------------------ */

/** A real zip archive, deflated — what Word and Excel save. */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8');
    const packed = deflateRawSync(raw);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const docx = () => zip({
  '[Content_Types].xml': '<Types/>',
  'word/document.xml':
    '<w:document><w:body><w:p><w:r><w:t>Purchase Order PO-7781</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>NH-400 &amp; NH-500, 9,000 pcs</w:t></w:r></w:p></w:body></w:document>',
});
const xlsx = () => zip({
  'xl/sharedStrings.xml': '<sst><si><t>Model</t></si><si><t>Qty</t></si><si><t>NH-400</t></si></sst>',
  'xl/worksheets/sheet1.xml':
    '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>9000</v></c></row></sheetData></worksheet>',
});

/* --------------------------------- The harness --------------------------------- */

let mongo;
let server;
let baseUrl;
let nandhini;
let kavitha;
let customerId;
let forgetHeldLines;
let forgetFileReadings;

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
const whoIs = async (token) => (await api('/api/auth/me', { token })).json.data.id;

let seq = 0;
const raise = async () => {
  const { status, json } = await api('/api/queries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      subject: `Short shipment ${++seq}`,
      question: 'The buyer says the September load was short. What did they order?',
      participants: [{ department: 'despatch' }],
    },
  });
  assert.equal(status, 201, json.message);
  return json.data;
};

const post = async (queryId, { name, type, bytes, body = '' }) => {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), name);
  form.append('body', body);
  const response = await fetch(`${baseUrl}/api/queries/${queryId}/files`, {
    method: 'POST', headers: { Authorization: `Bearer ${kavitha}` }, body: form,
  });
  const json = await response.json();
  assert.equal(response.status, 201, json.message);
  return json.data;
};

const open = async (id) => {
  const read = await api(`/api/queries/${id}`, { token: nandhini });
  assert.equal(read.status, 200, read.json.message);
  return read.json.gist;
};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  const { default: app } = await import('../src/app.js');
  ({ forgetHeldLines } = await import('../src/services/querySummary.llm.js'));
  ({ forgetFileReadings } = await import('../src/services/queryFiles.llm.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' },
  });
  const admin = await signIn('admin@np.com', 'Admin@12345');
  for (const [name, email, department] of [
    ['Nandhini S', 'nandhini@np.com', 'marketing'],
    ['Kavitha D', 'kavitha@np.com', 'despatch'],
  ]) {
    const made = await api('/api/users', { method: 'POST', token: admin, body: { name, email, password: 'Pass@123456', department } });
    assert.equal(made.status, 201, made.json.message);
  }
  nandhini = await signIn('nandhini@np.com', 'Pass@123456');
  kavitha = await signIn('kavitha@np.com', 'Pass@123456');
  const customer = await api('/api/customers', {
    method: 'POST', token: nandhini, body: { assignedTo: await whoIs(nandhini), name: 'SCM Garments', mobile: '9876500011' },
  });
  customerId = customer.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test.beforeEach(() => {
  fileCalls.length = 0;
  summaryCalls.length = 0;
  lineCalls.length = 0;
  fileDelayMs = 0;
  delete process.env.QUERY_FILES_WAIT_MS;
  forgetHeldLines();
  forgetFileReadings();
});

/* ---------------------------------- Word and Excel ---------------------------------- */

test('the words inside a Word or Excel file are taken out', async () => {
  const { officeText } = await import('../src/services/officeText.js');
  assert.equal(officeText(docx(), DOCX), 'Purchase Order PO-7781\nNH-400 & NH-500, 9,000 pcs');
  assert.equal(officeText(xlsx(), XLSX), 'Model | Qty\nNH-400 | 9000');
  assert.equal(officeText(Buffer.from('not a zip at all'), XLSX), null, 'junk is refused, not thrown');
  assert.equal(officeText(docx(), 'application/pdf'), null);
});

/* ---------------------------------- The summary ---------------------------------- */

test('a file posted in the thread is read, and the summary says what it says', async () => {
  const query = await raise();
  await post(query._id, { name: 'buyer-po.pdf', type: 'application/pdf', bytes: '%PDF-1.4 the PO', body: 'Their PO' });
  await post(query._id, { name: 'load-sheet.xlsx', type: XLSX, bytes: xlsx() });

  const gist = await open(query._id);

  /* Two messages is under the usual length, but a file nobody can see inside is worth a summary. */
  assert.equal(gist.writtenBy, 'model');
  assert.equal(gist.summary, 'Model summary of the thread.');
  assert.deepEqual(
    gist.files.map(({ filename, says, pending }) => ({ filename, says, pending })),
    [
      { filename: 'load-sheet.xlsx', says: 'Reading of load-sheet.xlsx', pending: false },
      { filename: 'buyer-po.pdf', says: 'Reading of buyer-po.pdf', pending: false },
    ],
    'newest first, each with what it says'
  );

  /* The PDF went as a document, the spreadsheet as its text. */
  const pdfCall = fileCalls.find((call) => call.messages[0].content.some((block) => block.type === 'document'));
  assert.equal(pdfCall.messages[0].content[0].source.media_type, 'application/pdf');
  assert.equal(Buffer.from(pdfCall.messages[0].content[0].source.data, 'base64').toString(), '%PDF-1.4 the PO');
  const sheetCall = fileCalls.find((call) => call !== pdfCall);
  assert.match(sheetCall.messages[0].content.map((block) => block.text).join('\n'), /NH-400 \| 9000/);

  /* And the summary was written with the readings in front of it. */
  assert.match(summaryCalls[0].messages[0].content, /\[file "buyer-po.pdf" says: Reading of buyer-po.pdf\]/);
  assert.match(summaryCalls[0].messages[0].content, /\[file "load-sheet.xlsx" says: Reading of load-sheet.xlsx\]/);
});

test('a file is read once, not every time the thread is opened', async () => {
  const query = await raise();
  await post(query._id, { name: 'po.docx', type: DOCX, bytes: docx() });
  await open(query._id);
  await open(query._id);
  await open(query._id);
  assert.equal(fileCalls.length, 1);
  assert.match(fileCalls[0].messages[0].content.at(-1).text, /Purchase Order PO-7781/);
});

test('the reading is never saved on the query or the file', async () => {
  const query = await raise();
  await post(query._id, { name: 'buyer-po.pdf', type: 'application/pdf', bytes: '%PDF-1.4 the PO' });
  await open(query._id);
  const saved = JSON.stringify(await mongoose.connection.db.collection('queries').findOne({ _id: new mongoose.Types.ObjectId(query._id) }));
  const files = JSON.stringify(await mongoose.connection.db.collection('attachments').find({ query: new mongoose.Types.ObjectId(query._id) }).toArray());
  assert.ok(!saved.includes('Reading of'), 'not on the query');
  assert.ok(!files.includes('Reading of'), 'not on the file');
});

test('a file that cannot be read says why, without asking the model', async () => {
  const query = await raise();
  await post(query._id, { name: 'old-price-list.doc', type: 'application/msword', bytes: 'binary word' });
  const gist = await open(query._id);
  assert.equal(fileCalls.length, 0);
  assert.equal(gist.files[0].says, null);
  assert.match(gist.files[0].problem, /\.doc, \.xls/);
  /* Nothing read, and only one message: the thread is short enough to show in its own words. */
  assert.equal(gist.writtenBy, 'rules');
});

test('a slow file does not hold the thread up; it is there on the next open', async () => {
  process.env.QUERY_FILES_WAIT_MS = '100';
  fileDelayMs = 600;
  const query = await raise();
  await post(query._id, { name: 'buyer-po.pdf', type: 'application/pdf', bytes: '%PDF-1.4 the PO' });

  const first = await open(query._id);
  assert.equal(first.files[0].pending, true, 'still being read');
  assert.equal(first.files[0].says, null);

  await new Promise((resolve) => setTimeout(resolve, 800));
  const second = await open(query._id);
  assert.equal(second.files[0].says, 'Reading of buyer-po.pdf');
  assert.equal(fileCalls.length, 1, 'the first read carried on and was kept');
});

test('the list line picks up what the files say once they are read', async () => {
  const query = await raise();
  await post(query._id, { name: 'buyer-po.pdf', type: 'application/pdf', bytes: '%PDF-1.4 the PO' });

  /* Before anybody has opened it: a short thread, and the list never waits on a file. */
  const before = await api('/api/queries/summaries', { method: 'POST', token: nandhini, body: { ids: [query._id] } });
  assert.equal(before.json.data[query._id].writtenBy, 'rules');
  assert.equal(fileCalls.length, 0);

  await open(query._id);
  const after = await api('/api/queries/summaries', { method: 'POST', token: nandhini, body: { ids: [query._id] } });
  assert.equal(after.json.data[query._id].writtenBy, 'model');
  assert.match(lineCalls.at(-1).messages[0].content, /\[file "buyer-po.pdf" says: Reading of buyer-po.pdf\]/);
});
