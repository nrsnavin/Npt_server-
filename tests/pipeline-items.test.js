/**
 * Several things on one lead and one enquiry [§2, §3].
 *
 * A buyer rings about shirt hangers *and* trouser hangers on the same call. Recording that as
 * two enquiries splits one conversation into two follow-up dates, two next actions and two
 * places to look for what was said — so both records carry a list.
 *
 * **The whole of the risk is in one rule**: `requirement` and `items[0]` are the same fact, and
 * a great deal already reads `requirement` — the sample §6 raises automatically, the costing,
 * the export, the boards, the customer timeline. Keeping the two in step is what let all of
 * that stay as it was; getting the rule wrong silently loses an edit, which is exactly what the
 * first version of it did. That is what most of this file is about.
 *
 *   node --test tests/pipeline-items.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'pipeline-items-test-secret';

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let nandhiniId;
let customerId;

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

const signIn = async (email, password) => {
  const { json } = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  return json.data?.token;
};

const inDays = (days) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
};

/** Enough for an enquiry to be accepted: a next action and a date. */
const followUp = { nextAction: 'Send the quote', nextFollowUpDate: inDays(3) };

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' },
  });
  admin = await signIn('admin@np.com', 'Admin@12345');

  const made = await api('/api/users', {
    method: 'POST',
    token: admin,
    body: { name: 'Nandhini S', email: 'nandhini@np.com', password: 'Pass@123456', department: 'marketing' },
  });
  assert.equal(made.status, 201, made.json.message);
  nandhini = await signIn('nandhini@np.com', 'Pass@123456');
  nandhiniId = (await api('/api/auth/me', { token: nandhini })).json.data.id;

  const customer = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { assignedTo: nandhiniId, name: 'SCM Garments', mobile: '9876500011' },
  });
  assert.equal(customer.status, 201, customer.json.message);
  customerId = customer.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------- An enquiry's list ------------------------------- */

test('an enquiry can be raised with several items', async () => {
  const { status, json } = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      items: [
        { modelNumber: 'NPT-400S', colour: 'White' },
        { modelNumber: 'NPT-700T', colour: 'Black' },
        { modelNumber: 'NPT-250K' },
      ],
      ...followUp,
    },
  });

  assert.equal(status, 201, json.message);
  assert.equal(json.data.items.length, 3);
  assert.deepEqual(json.data.items.map((item) => item.modelNumber),
    ['NPT-400S', 'NPT-700T', 'NPT-250K']);
});

test('the first item and the requirement are one fact', async () => {
  /*
   * The rule everything else in this module rests on. A great deal reads `requirement` — the
   * sample §6 raises, the costing, the export, the timeline — and every one of those is right
   * for the first item and would be a guess for the rest. So the two cannot be allowed to
   * differ, and nothing had to be rewritten to read a list.
   */
  const { json } = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      items: [{ modelNumber: 'NPT-401S', colour: 'Grey' }, { modelNumber: 'NPT-702T' }],
      ...followUp,
    },
  });

  assert.equal(json.data.requirement.modelNumber, 'NPT-401S');
  assert.equal(json.data.requirement.colour, 'Grey');
});

test('an enquiry raised the old way still answers as a list', async () => {
  /*
   * Every enquiry already on the system, and every caller that has not been changed — the
   * WhatsApp conversion, the lead conversion, an integration. They send a requirement and no
   * list, and they have to come back with one, or a screen reading `items` shows an enquiry
   * with nothing in it.
   */
  const { json } = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      requirement: { modelNumber: 'NPT-500S', colour: 'Navy' },
      ...followUp,
    },
  });

  assert.equal(json.data.items.length, 1, 'seeded from the requirement');
  assert.equal(json.data.items[0].modelNumber, 'NPT-500S');
  assert.equal(json.data.items[0].colour, 'Navy');
});

test('correcting the requirement alone is not reverted', async () => {
  /*
   * The bug the first version of the mirror had, and the reason the rule is about *which side
   * was written* rather than about which field is senior.
   *
   * The list was copied over the requirement unconditionally on every save, so a correction
   * that touched only `requirement.colour` was undone on the way to the database: the screen
   * said the colour had changed, the record said it had not, and the audit trail — the one
   * place somebody would look — had nothing in it either.
   */
  const created = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: { customer: customerId, requirement: { modelNumber: 'NPT-600S', colour: 'White' }, ...followUp },
  });
  const enquiry = created.json.data;

  const patched = await api(`/api/enquiries/${enquiry._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { requirement: { modelNumber: 'NPT-600S', colour: 'Black' } },
  });

  assert.equal(patched.status, 200, patched.json.message);
  assert.equal(patched.json.data.requirement.colour, 'Black', 'the correction stands');
  assert.equal(patched.json.data.items[0].colour, 'Black', 'and the first row followed it');
});

test('sending a list replaces the list, so a row can be removed', async () => {
  /*
   * Not merged row by row: somebody editing items is adding, removing and reordering them, and
   * "the third one" is not the same row it was before a deletion. A partial merge cannot
   * express a removal at all, so the form sends what the enquiry should now say.
   */
  const created = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      items: [{ modelNumber: 'NPT-A' }, { modelNumber: 'NPT-B' }, { modelNumber: 'NPT-C' }],
      ...followUp,
    },
  });

  const patched = await api(`/api/enquiries/${created.json.data._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { items: [{ modelNumber: 'NPT-C' }, { modelNumber: 'NPT-A' }] },
  });

  assert.equal(patched.status, 200, patched.json.message);
  assert.deepEqual(patched.json.data.items.map((item) => item.modelNumber), ['NPT-C', 'NPT-A']);
  assert.equal(patched.json.data.requirement.modelNumber, 'NPT-C', 'the new first row leads');
});

test('an enquiry cannot be emptied of everything it was about', async () => {
  const created = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: { customer: customerId, items: [{ modelNumber: 'NPT-D' }], ...followUp },
  });

  const emptied = await api(`/api/enquiries/${created.json.data._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { items: [{}, {}] },
  });

  assert.equal(emptied.status, 400);
  assert.match(emptied.json.message, /keep a row|asked about/i);
});

test('a row somebody tabbed past is dropped, not refused', async () => {
  /* Empty rows are what a form leaves behind. Refusing a save over one is a refusal about
     nothing, and the person has to find which of five rows is blank. */
  const { status, json } = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      items: [{ modelNumber: 'NPT-E' }, {}, { modelNumber: 'NPT-F' }, {}],
      ...followUp,
    },
  });

  assert.equal(status, 201, json.message);
  assert.deepEqual(json.data.items.map((item) => item.modelNumber), ['NPT-E', 'NPT-F']);
});

test('a list is capped, because past a dozen it is a price list', async () => {
  const many = Array.from({ length: 13 }, (_, index) => ({ modelNumber: `NPT-${index}` }));
  const { status } = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: { customer: customerId, items: many, ...followUp },
  });

  assert.equal(status, 400);
});

/* ------------------------------- A lead's list ------------------------------- */

test('a lead can record what they asked about, and it survives conversion', async () => {
  /*
   * The point of giving a lead the same shape as an enquiry: conversion is a copy rather than a
   * re-interview. Whatever was learned on the call arrives pointing at the same register rows,
   * instead of being retyped by somebody who was not on it.
   */
  const lead = await api('/api/leads', {
    method: 'POST',
    token: nandhini,
    body: {
      company: 'Trendline Apparels',
      assignedTo: nandhiniId,
      mobile: '9876512345',
      items: [{ modelNumber: 'NPT-800S', colour: 'Red' }, { modelNumber: 'NPT-900T' }],
      ...followUp,
    },
  });
  assert.equal(lead.status, 201, lead.json.message);
  assert.equal(lead.json.data.items.length, 2);

  const converted = await api(`/api/leads/${lead.json.data._id}/convert`, {
    method: 'POST',
    token: nandhini,
    body: { enquiry: { ...followUp } },
  });

  assert.equal(converted.status, 201, converted.json.message);
  const enquiry = converted.json.data.enquiry;
  assert.deepEqual(enquiry.items.map((item) => item.modelNumber), ['NPT-800S', 'NPT-900T']);
  assert.equal(enquiry.requirement.modelNumber, 'NPT-800S', 'and the first one leads, as always');
  assert.equal(enquiry.requirement.colour, 'Red');
});

test('what the conversion form says beats what the lead recorded', async () => {
  /*
   * Whoever is converting has the newer information — they are on the call now. The lead's rows
   * are a fallback for the common case where the conversion form says nothing about models, not
   * a record that overrides the person doing the work.
   */
  const lead = await api('/api/leads', {
    method: 'POST',
    token: nandhini,
    body: {
      company: 'Yorker Knits',
      assignedTo: nandhiniId,
      mobile: '9876554321',
      items: [{ modelNumber: 'NPT-OLD' }],
      ...followUp,
    },
  });

  const converted = await api(`/api/leads/${lead.json.data._id}/convert`, {
    method: 'POST',
    token: nandhini,
    body: { enquiry: { items: [{ modelNumber: 'NPT-NEW' }], ...followUp } },
  });

  assert.equal(converted.status, 201, converted.json.message);
  assert.deepEqual(converted.json.data.enquiry.items.map((i) => i.modelNumber), ['NPT-NEW']);
});

test('an item carries no quantity, on a lead any more than on an enquiry', async () => {
  /*
   * The rule that was nearly reopened one row at a time. Nothing before the purchase order
   * knows how many, and the polite figure a buyer gives on the phone used to travel the whole
   * chain as though somebody had agreed to it.
   */
  const { json } = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      items: [{ modelNumber: 'NPT-Q', quantity: 25000 }],
      ...followUp,
    },
  });

  assert.equal(json.data.items[0].quantity, undefined, 'stripped, not stored');
  assert.equal(json.data.requirement.quantity, undefined);
});

/**
 * The sample §6 raises, once it exists.
 *
 * The enquiry's status door publishes and returns; the subscriber writes the request a tick
 * later. Reading the list straight afterwards passes on a slow machine and fails on a fast one,
 * which is the worst kind of test — so this waits for the record rather than assuming it.
 */
const sampleFor = async (enquiryId) => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { json } = await api(`/api/samples?enquiry=${enquiryId}`, { token: nandhini });
    if (json.data?.length) return json.data[0];
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
};

/* -------------------------------- A sample's bag -------------------------------- */

/*
 * A sample is the same list one step further on, and the one place the shape genuinely
 * differs: a bag of pieces rather than a description of a job. So each row carries the tool it
 * runs on — three models is three tools — and a quantity that is a real instruction rather than
 * a guess at an order.
 */

test('a sample can be raised for several models at once', async () => {
  const { status, json } = await api('/api/samples', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      items: [
        { modelNumber: 'NPT-400S', colour: 'White', quantity: 5 },
        { modelNumber: 'NPT-700T', colour: 'Black', quantity: 3 },
        { modelNumber: 'NPT-250K', quantity: 2 },
      ],
      requiredDate: inDays(5),
    },
  });

  assert.equal(status, 201, json.message);
  assert.equal(json.data.items.length, 3);
  assert.deepEqual(json.data.items.map((item) => item.modelNumber),
    ['NPT-400S', 'NPT-700T', 'NPT-250K']);
  /* What the bench actually has to make, which is not any one row. */
  assert.equal(json.data.piecesToMake, 10);
});

test('the sample’s top line and its first row are one fact', async () => {
  /*
   * The same rule the enquiry keeps, and it matters more here: §13 checks an order against the
   * *approved sample's* model and colour, the bench reads `colourRule`, and the dispatch gate
   * reads the quantity. All of them read the top line, so a list that could drift from it
   * would be two descriptions of one bag.
   */
  const { json } = await api('/api/samples', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      items: [{ modelNumber: 'NPT-400S', colour: 'Ivory', colourMandatory: true, quantity: 4 }],
      requiredDate: inDays(5),
    },
  });

  assert.equal(json.data.modelNumber, 'NPT-400S');
  assert.equal(json.data.colour, 'Ivory');
  assert.equal(json.data.quantity, 4);
  assert.match(json.data.colourRule, /Must be Ivory/);
});

test('a sample raised the old way still answers as a list', async () => {
  const { json } = await api('/api/samples', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      modelNumber: 'NPT-380S',
      colour: 'White',
      quantity: 6,
      requiredDate: inDays(5),
    },
  });

  assert.equal(json.data.items.length, 1, 'the top line became the first row');
  assert.equal(json.data.items[0].modelNumber, 'NPT-380S');
  assert.equal(json.data.items[0].quantity, 6);
});

test('correcting the sample’s top line alone is not reverted', async () => {
  /*
   * Proved by revert on the enquiry and worth proving again here, because it is the failure
   * that leaves no trace: the screen says the colour changed, the record says it did not, and
   * the audit trail is empty.
   */
  const raised = await api('/api/samples', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      items: [{ modelNumber: 'NPT-400S', colour: 'White', quantity: 5 }],
      requiredDate: inDays(5),
    },
  });

  /* Corrected by somebody who may: `samples: write` is the bench's, not marketing's. */
  const fixed = await api(`/api/samples/${raised.json.data._id}`, {
    method: 'PATCH',
    token: admin,
    body: { colour: 'Ivory' },
  });

  assert.equal(fixed.status, 200, fixed.json.message);
  assert.equal(fixed.json.data.colour, 'Ivory');
  assert.equal(fixed.json.data.items[0].colour, 'Ivory', 'the row followed the correction');
  assert.equal(fixed.json.data.items[0].quantity, 5, 'and nothing else on the row moved');
});

test('a sample raised off an enquiry carries every model it asked about', async () => {
  const enquiry = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      items: [
        { modelNumber: 'NPT-400S', colour: 'White' },
        { modelNumber: 'NPT-700T', colour: 'Black' },
      ],
      ...followUp,
    },
  });
  assert.equal(enquiry.status, 201, enquiry.json.message);

  /* §6: moving the enquiry to sample required raises the request by itself. */
  const moved = await api(`/api/enquiries/${enquiry.json.data._id}/status`, {
    method: 'POST',
    token: nandhini,
    body: { status: 'sample_required' },
  });
  assert.equal(moved.status, 200, moved.json.message);

  const sample = await sampleFor(enquiry.json.data._id);
  assert.ok(sample, 'the enquiry raised one');

  /*
   * Both models, not just the first. Taking only the first would send one hanger against a
   * conversation about two, and the second would be noticed by the buyer opening the envelope.
   */
  assert.equal(sample.items.length, 2);
  assert.deepEqual(sample.items.map((item) => item.modelNumber), ['NPT-400S', 'NPT-700T']);
});

test('an enquiry’s quantity does not become a bench instruction', async () => {
  /*
   * The two records mean opposite things by the word. On an enquiry it is a guess at how big
   * the order might be; on a sample it is how many pieces go in the courier bag. Carried
   * across, a buyer's speculative 25,000 would be what the bench made.
   *
   * **Written straight into the database, because the enquiry door will not accept one.** The
   * quantity was taken off that form deliberately — and the field is still on the shape, so
   * every enquiry raised before that day still carries whatever was typed then. Those are the
   * records this guard exists for, and a test that went through the door would be testing the
   * door's strip rather than this: it passed with this fix reverted, which is how it was found.
   */
  const enquiry = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: { customer: customerId, items: [{ modelNumber: 'NPT-VOL' }], ...followUp },
  });
  assert.equal(enquiry.status, 201, enquiry.json.message);

  const { default: Enquiry } = await import('../src/models/Enquiry.js');
  await Enquiry.updateOne(
    { _id: enquiry.json.data._id },
    { $set: { 'items.0.quantity': 25000, 'requirement.quantity': 25000 } }
  );

  await api(`/api/enquiries/${enquiry.json.data._id}/status`, {
    method: 'POST',
    token: nandhini,
    body: { status: 'sample_required' },
  });

  const sample = await sampleFor(enquiry.json.data._id);
  assert.ok(sample, 'the enquiry raised one');

  assert.equal(sample.items[0].quantity, 1, 'one piece until somebody says otherwise');
  assert.equal(sample.quantity, 1);
});

test('a bag is capped at a dozen models, like the costing sheet', async () => {
  const { status, json } = await api('/api/samples', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      items: Array.from({ length: 13 }, (_, index) => ({ modelNumber: `NPT-${index}` })),
      requiredDate: inDays(5),
    },
  });

  assert.equal(status, 400, json.message);
});

test('a re-sample is the same bag, with what the bench changed', async () => {
  /*
   * "Change one part and send it again" is about the envelope that went out. A three-model
   * attempt re-sampled as one model is two hangers the buyer was looking at and will not get
   * back — and the override the bench typed has to reach the row as well as the top line, or
   * the request says three pieces and the bench is told to make one.
   */
  const raised = await api('/api/samples', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      items: [
        { modelNumber: 'NPT-400S', colour: 'White', quantity: 5 },
        { modelNumber: 'NPT-700T', colour: 'Black', quantity: 2 },
      ],
      requiredDate: inDays(5),
    },
  });
  const sample = raised.json.data;

  for (const status of ['sample_ready', 'dispatched']) {
    const moved = await api(`/api/samples/${sample._id}/status`, {
      method: 'POST',
      token: admin,
      body: status === 'dispatched'
        ? { status, courier: 'Professional', awbNumber: 'PC-778', dispatchedQuantity: 7 }
        : { status },
    });
    assert.equal(moved.status, 200, moved.json.message);
  }

  const said = await api(`/api/samples/${sample._id}/feedback`, {
    method: 'POST',
    token: nandhini,
    body: { outcome: 'modification_required', note: 'Shoulder 5mm wider on the 400' },
  });
  assert.equal(said.status, 200, said.json.message);

  const again = await api(`/api/samples/${sample._id}/resample`, {
    method: 'POST',
    token: admin,
    body: { quantity: 3 },
  });
  assert.equal(again.status, 201, again.json.message);

  const next = again.json.data.sample;
  assert.equal(next.items.length, 2, 'both models go again');
  assert.deepEqual(next.items.map((item) => item.modelNumber), ['NPT-400S', 'NPT-700T']);
  /* The override lands on the row it belongs to, and nowhere else. */
  assert.equal(next.quantity, 3);
  assert.equal(next.items[0].quantity, 3);
  assert.equal(next.items[1].quantity, 2, 'the second model keeps what it had');
  /* And the rows are its own, not the previous attempt's. */
  assert.notEqual(String(next.items[0]._id), String(sample.items[0]._id));
});

/* ------------------------- A row names its own tool ------------------------- */

/*
 * The thing that made every model after the first a lesser record.
 *
 * One mould was named on the enquiry and belonged to item one by convention, so rows two
 * onward could describe a hanger but never point at the steel that makes it [§28] — which is
 * what a costing line, a bench instruction and a quotation all key off. A buyer ringing about
 * three hangers is describing three real models, and each of them either runs on a tool the
 * plant owns, is bought in, or is a development nobody has cut yet.
 */

/** A tool on the register, for the rows below to name. */
const registerMould = async (code, name) => {
  const { status, json } = await api('/api/moulds', {
    method: 'POST',
    token: admin,
    body: {
      mouldCode: code,
      name,
      category: 'shirt',
      sizeMm: 380,
      material: 'pp',
      cavities: 8,
      partWeightGrams: 14,
      cycleTimeSeconds: 24,
    },
  });
  assert.equal(status, 201, json.message);
  return json.data._id;
};

test('every item names its own tool, not just the first', async () => {
  const first = await registerMould('M-380A', 'Top hanger 380mm');
  const second = await registerMould('M-410A', 'Top hanger 410mm');

  const { status, json } = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      items: [
        { mould: first, modelNumber: 'NPT-380', colour: 'White' },
        { mould: second, modelNumber: 'NPT-410', colour: 'Black' },
      ],
      ...followUp,
    },
  });

  assert.equal(status, 201, json.message);
  assert.equal(String(json.data.items[0].mould?._id ?? json.data.items[0].mould), first);
  assert.equal(String(json.data.items[1].mould?._id ?? json.data.items[1].mould), second,
    'the second model is made on its own steel, not on the first one’s');

  /* And the enquiry's own field follows row one, so everything reading the flat shape is right. */
  assert.equal(String(json.data.mould?._id ?? json.data.mould), first);
});

test('an enquiry described only by its rows is not refused for naming no tool', async () => {
  /*
   * The check that an enquiry says *what* was asked for runs before the model lifts row one's
   * tool up onto the document. Judging it on the enquiry's own `mould` alone would refuse a
   * perfectly well-described enquiry for the crime of naming its tools one row at a time.
   */
  const only = await registerMould('M-390A', 'Top hanger 390mm');

  const { status, json } = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    /* No modelNumber anywhere, no new-development tick, no enquiry-level mould: the row is the
       only thing that says what this is about. */
    body: { customer: customerId, items: [{ mould: only }], ...followUp },
  });

  assert.equal(status, 201, json.message);
  assert.equal(String(json.data.mould?._id ?? json.data.mould), only);
});

test('a row that says nothing but names a tool is kept, not dropped', async () => {
  const kept = await registerMould('M-420A', 'Top hanger 420mm');

  const { json } = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      items: [{ modelNumber: 'NPT-400', colour: 'White' }, { mould: kept }],
      ...followUp,
    },
  });

  assert.equal(json.data.items.length, 2, '"the 420, same as last time" is a complete answer');
  assert.equal(String(json.data.items[1].mould?._id ?? json.data.items[1].mould), kept);
});

test('editing the list does not quietly clear a tool the row never mentioned', async () => {
  /*
   * The failure this guards is silent and expensive. Every enquiry written before a row carried
   * a tool has one on the enquiry and a first row that does not mention it. The model takes the
   * list as the truth when somebody edits it — so without a fallback, the first correction made
   * through the new form would read "row one names no tool" and clear a live record's mould.
   */
  const tool = await registerMould('M-430A', 'Top hanger 430mm');

  const raised = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: { customer: customerId, mould: tool, requirement: { colour: 'White' }, ...followUp },
  });
  assert.equal(raised.status, 201, raised.json.message);

  /* A correction that says nothing about the tool — exactly what an old record's row looks. */
  const edited = await api(`/api/enquiries/${raised.json.data._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { items: [{ colour: 'Grey' }] },
  });

  assert.equal(edited.status, 200, edited.json.message);
  assert.equal(edited.json.data.items[0].colour, 'Grey');
  assert.equal(String(edited.json.data.mould?._id ?? edited.json.data.mould), tool,
    'the tool is still there');
});

test('a sample raised off the enquiry gets each model’s own tool', async () => {
  const first = await registerMould('M-440A', 'Top hanger 440mm');
  const second = await registerMould('M-450A', 'Top hanger 450mm');

  const enquiry = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      items: [
        { mould: first, modelNumber: 'NPT-440' },
        { mould: second, modelNumber: 'NPT-450' },
      ],
      ...followUp,
    },
  });
  assert.equal(enquiry.status, 201, enquiry.json.message);

  const sample = await api('/api/samples', {
    method: 'POST',
    token: admin,
    body: { enquiry: enquiry.json.data._id, customer: customerId },
  });
  assert.equal(sample.status, 201, sample.json.message);

  const bag = sample.json.data.items;
  assert.equal(bag.length, 2);
  assert.equal(String(bag[0].mould?._id ?? bag[0].mould), first);
  assert.equal(String(bag[1].mould?._id ?? bag[1].mould), second,
    'the bench is told what makes the second hanger too');
});
