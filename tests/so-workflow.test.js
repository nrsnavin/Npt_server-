/**
 * The SO team's own workflow on its task [config/departmentTaskForms.js po_so `statuses`]:
 * SO Waiting → SO Preparing → Needs Clarification (a comment, and a task for the enquiry's
 * marketing person whose answer comes back) → SO Prepared, reached by uploading the sales order
 * as a PDF — which finishes the task and moves the enquiry on to Production.
 *
 *   node --test tests/so-workflow.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'so-workflow-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
let enquiry;
let soTask;
let Todo;
let Enquiry;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const status = (as, value, note) => api(`/api/workspace/todos/${soTask._id}/status`, { method: 'POST', as, body: { status: value, ...(note ? { note } : {}) } });
async function upload(as, { bytes = '%PDF-1.4 so', type = 'application/pdf', name = 'SO-2026-0042.pdf' } = {}) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), name);
  const response = await fetch(`${baseUrl}/api/workspace/todos/${soTask._id}/result`, {
    method: 'POST', headers: { Authorization: `Bearer ${token[as]}` }, body: form,
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  ({ default: Enquiry } = await import('../src/models/Enquiry.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['priya', 'Priya Orders', 'order_confirmation'], ['siva', 'Sivakumar', 'production']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'RR Jain Utjrsh', mobile: '9170875200', assignedTo: me } })).json.data;
  enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id, requirement: { modelNumber: 'UTJRSH-0' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the SO task starts at SO Waiting; the statuses come from the server', async () => {
  const { buttons } = (await api('/api/handoffs', { as: 'priya' })).json.data;
  const form = buttons.find((button) => button.key === 'po_so').form;
  assert.deepEqual(form.statuses.map((entry) => entry.label), ['SO Waiting', 'SO Preparing', 'Needs Clarification', 'SO Prepared']);
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini', body: { kind: 'po_so', note: 'Prepare and send SO', brief: { contactPerson: 'sas', mobile: '917087520007', models: 'UTJRSH-0' } },
  });
  assert.equal(sent.status, 201, sent.json.message);
  soTask = sent.json.data.task;
  assert.equal(soTask.status, 'waiting');
});

test('Preparing; Prepared only by uploading the PDF; another department cannot move it', async () => {
  assert.equal((await status('siva', 'preparing')).status, 403);
  const preparing = await status('priya', 'preparing');
  assert.equal(preparing.status, 200, preparing.json.message);
  assert.equal(preparing.json.data.status, 'preparing');
  const prepared = await status('priya', 'prepared');
  assert.equal(prepared.status, 400);
  assert.match(prepared.json.message, /Upload the PDF to mark it SO Prepared/);
  assert.equal((await status('priya', 'nonsense')).status, 400);
});

test('Needs Clarification asks for a comment and gives the marketing person a task; the answer comes back', async () => {
  const bare = await status('priya', 'clarification');
  assert.equal(bare.status, 400);
  assert.match(bare.json.message, /asks for a comment/);
  const asked = await status('priya', 'clarification', 'Which GSTIN — Tiruppur or Chennai unit?');
  assert.equal(asked.status, 200, asked.json.message);
  assert.equal(asked.json.data.status, 'clarification');

  const nandhini = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  const question = await Todo.findOne({ enquiry: enquiry._id, kind: 'so_clarification', completed: false });
  assert.ok(question, 'a task for the marketing person');
  assert.equal(String(question.user), nandhini);
  assert.equal(String(question.parentTask), soTask._id);
  assert.match(question.notes, /Priya Orders: Which GSTIN/);

  const again = await status('priya', 'preparing');
  assert.equal(again.status, 200, 'the SO team may carry on meanwhile');
  await status('priya', 'clarification', 'And the delivery address?');
  /* At the top of the marketing person's dashboard, to answer there. */
  const mine = (await api('/api/departments/mine/dashboard', { as: 'nandhini' })).json.data.attention;
  assert.ok(mine.questions.some((row) => row._id === String(question._id)), 'the question is at the top for marketing');
  assert.equal(mine.questions.find((row) => row._id === String(question._id)).parentTask.department, 'order_confirmation');
  const answered = await api(`/api/workspace/todos/${question._id}/done`, { method: 'POST', as: 'nandhini', body: { note: 'Tiruppur unit — 33AABCS1429P1ZQ' } });
  assert.equal(answered.status, 200, answered.json.message);
  const back = await Todo.findById(soTask._id);
  assert.equal(back.status, 'preparing', 'back where it was before the question');
  assert.match(back.updates.at(-1).note, /Clarified by Nandhini S: Tiruppur unit/);
  assert.equal(await Todo.countDocuments({ title: /^Done: SO Clarification/ }), 0, 'the answer is on the SO task, not a new to-do');

  /* The answer is at the top of the SO team's dashboard until somebody there acts on it. */
  const theirs = (await api('/api/departments/mine/dashboard', { as: 'priya' })).json.data.attention;
  const reply = theirs.replies.find((row) => row._id === soTask._id);
  assert.ok(reply, 'the reply is highlighted for the SO team');
  assert.match(reply.attention.note, /Tiruppur unit/);
  assert.equal(reply.attention.by.name, 'Nandhini S');
  assert.equal((await api('/api/departments/mine/dashboard', { as: 'nandhini' })).json.data.attention.questions.length, 0, 'answered, so gone from marketing');
  assert.equal((await api(`/api/workspace/todos/${soTask._id}/seen`, { method: 'POST', as: 'siva' })).status, 403);
  const seen = await api(`/api/workspace/todos/${soTask._id}/seen`, { method: 'POST', as: 'priya' });
  assert.equal(seen.status, 200, seen.json.message);
  assert.equal((await api('/api/departments/mine/dashboard', { as: 'priya' })).json.data.attention.replies.length, 0, '"Got it" clears it');
});

test('the SO team corrects the contact details, and only those', async () => {
  const edited = await api(`/api/workspace/todos/${soTask._id}/brief`, {
    method: 'POST', as: 'priya', body: { brief: { contactPerson: 'Sasikumar (accounts)', models: 'something else' } },
  });
  assert.equal(edited.status, 200, edited.json.message);
  assert.equal(edited.json.data.brief.contactPerson, 'Sasikumar (accounts)');
  assert.equal(edited.json.data.brief.models, 'UTJRSH-0', 'not a question the SO team may change');
  assert.match(edited.json.data.updates.at(-1).note, /Corrected: Contact person/);
});

test('uploading the sales order PDF finishes the task and moves the enquiry to Production', async () => {
  const ticked = await api(`/api/workspace/todos/${soTask._id}/done`, { method: 'POST', as: 'priya', body: { note: 'Sent the SO' } });
  assert.equal(ticked.status, 400, 'not ticked off without the sales order');
  assert.match(ticked.json.message, /Upload the PDF to finish this task/);
  const notPdf = await upload('priya', { bytes: 'hello', type: 'text/plain', name: 'so.txt' });
  assert.equal(notPdf.status, 400);
  assert.equal((await upload('siva')).status, 403, 'Production cannot finish Sales / SO’s task');
  const done = await upload('priya');
  assert.equal(done.status, 200, done.json.message);
  assert.equal(done.json.data.status, 'prepared');
  assert.equal(done.json.data.completed, true);
  assert.equal(done.json.data.resultFile.filename, 'SO-2026-0042.pdf');
  assert.equal(done.json.next?.department, 'production', 'Production has its task');
  assert.equal((await Enquiry.findById(enquiry._id)).stage, 'production_edd');
  assert.equal((await upload('priya')).status, 409, 'a finished task takes no second PDF');
});
