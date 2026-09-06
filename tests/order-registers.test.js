/**
 * An order line, built from the registers [BLUEPRINT §28].
 *
 * An order line is a specification the plant has to work to: which tool, which resin, which
 * hook, which clip, which print. Typed as free text those are strings that agree with nothing —
 * "HIPS Wht" against a register that calls it "HIPS White", a hook the store cannot find
 * because the order does not carry the code they know it by. §13's "correct model" and "correct
 * colour" checks are unanswerable against free text too: there is nothing to be correct
 * *against*.
 *
 * Two things are tested here above everything else.
 *
 * **A part is checked against its own register.** Hooks, clips and print jobs share one
 * collection, so a clip's id fits the hook field perfectly and would save without a murmur. The
 * first person to notice would be whoever walked to the store.
 *
 * **What the registers know is not asked for twice.** Picking "HIPS White" fills the material
 * family and the colour; picking a print job fills what is printed — and a typed answer still
 * beats all of it, because a buyer naming a shade we have to match is ordinary rather than an
 * error.
 *
 *   node --test tests/order-registers.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'order-registers-test-secret';

let mongo;
let server;
let baseUrl;
let admin;
let priya;      // order confirmation — books the order
let nandhini;   // marketing — owns it, and quotes
let customer;
let mould;
let nandhiniId;

/* The registers this file books against. */
let hips;       // HIPS White — a resin with a colour of its own
let retired;    // a grade the plant has stopped buying
let hook;
let clip;
let print;

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

/** An order with one line, as the request describes it. */
const book = (line, token = priya) =>
  api('/api/orders', {
    method: 'POST',
    token,
    body: {
      customer,
      assignedTo: nandhiniId,
      lines: [{ quantity: 10000, unitPrice: 7.5, ...line }],
    },
  });

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

  for (const person of [
    { name: 'Priya Orders', email: 'priya@np.com', password: 'Orders@1234', department: 'order_confirmation' },
    { name: 'Nandhini S', email: 'nandhini@np.com', password: 'Mktg@123456', department: 'marketing' },
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: person });
  }
  priya = await signIn('priya@np.com', 'Orders@1234');
  nandhini = await signIn('nandhini@np.com', 'Mktg@123456');
  nandhiniId = (await api('/api/auth/me', { token: nandhini })).json.data.id;

  mould = (
    await api('/api/moulds', {
      method: 'POST',
      token: admin,
      body: {
        mouldCode: 'M-NH-400', name: 'Shirt hanger 400mm', category: 'shirt', sizeMm: 400,
        material: 'pp', cavities: 4, partWeightGrams: 26, cycleTimeSeconds: 28,
      },
    })
  ).json.data._id;

  hips = (
    await api('/api/materials', {
      method: 'POST', token: admin,
      body: { name: 'HIPS White', code: 'HIPS-W', type: 'hips', colour: 'White', ratePerKg: 92, grammageFactorPercent: 18 },
    })
  ).json.data;

  retired = (
    await api('/api/materials', {
      method: 'POST', token: admin,
      body: { name: 'PS Smoke', code: 'PS-SM', type: 'ps', colour: 'Smoke', ratePerKg: 88, isActive: false },
    })
  ).json.data;

  hook = (
    await api('/api/components', {
      method: 'POST', token: admin,
      body: { kind: 'hook', name: 'Swivel metal hook', code: 'HK-01', ratePerPiece: 1.4 },
    })
  ).json.data;
  clip = (
    await api('/api/components', {
      method: 'POST', token: admin,
      body: { kind: 'clip', name: 'Wooden clip 25mm', code: 'CL-01', ratePerPiece: 0.9 },
    })
  ).json.data;
  print = (
    await api('/api/components', {
      method: 'POST', token: admin,
      body: { kind: 'print', name: '2 colour screen', code: 'PR-02', ratePerPiece: 0.35 },
    })
  ).json.data;

  customer = (
    await api('/api/customers', {
      method: 'POST', token: nandhini,
      body: { name: 'Sri Kumaran Knits', mobile: '9840011223' },
    })
  ).json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------ Picking from them ------------------------------ */

test('a line records the tool, the resin and the three parts it is made of', async () => {
  const { status, json } = await book({
    mould,
    materialRef: hips._id,
    hookRef: hook._id,
    clipRef: clip._id,
    printRef: print._id,
  });

  assert.equal(status, 201, json.message);
  const line = json.data.lines[0];

  /* Populated on the way out, so a screen names them without four more requests. */
  assert.equal(line.materialRef.name, 'HIPS White');
  assert.equal(line.hookRef.name, 'Swivel metal hook');
  assert.equal(line.clipRef.name, 'Wooden clip 25mm');
  assert.equal(line.printRef.name, '2 colour screen');
});

test('the material fills the family and the colour, and the print fills what is printed', async () => {
  const { json } = await book({ mould, materialRef: hips._id, printRef: print._id });
  const line = json.data.lines[0];

  /* Nobody typed either of these. Asking for them again is asking for two answers that disagree. */
  assert.equal(line.material, 'hips');
  assert.equal(line.colour, 'White');
  assert.equal(line.printing, '2 colour screen');
});

test('a typed colour beats the register’s', async () => {
  /* A natural resin coloured with masterbatch, or a buyer naming a shade we have to match.
     The register supplies what nobody has said; it never contradicts somebody who has. */
  const { json } = await book({ materialRef: hips._id, colour: 'Buyer navy 19-4025' });

  assert.equal(json.data.lines[0].colour, 'Buyer navy 19-4025');
  assert.equal(json.data.lines[0].materialRef.name, 'HIPS White');
});

test('the tool names the model where the PO did not', async () => {
  const { json } = await book({ mould });
  const line = json.data.lines[0];

  assert.equal(line.modelNumber, 'M-NH-400');
  /* And the category, which is a fact about the steel rather than a choice on an order. */
  assert.equal(line.category, 'shirt');
});

test('the buyer’s own model number is kept over the tool’s code', async () => {
  const { json } = await book({ mould, modelNumber: 'SKK/HGR/400' });
  assert.equal(json.data.lines[0].modelNumber, 'SKK/HGR/400');
});

/* -------------------------------- The refusals -------------------------------- */

test('a clip cannot be booked as a hook', async () => {
  /*
   * The check this whole thing exists for. Hooks, clips and print jobs are one collection
   * behind three registers, so a clip's id is a structurally perfect hook — it would save
   * silently, and the first person to notice would be whoever walked to the store.
   */
  const { status, json } = await book({ hookRef: clip._id });

  assert.equal(status, 400);
  assert.match(json.message, /Wooden clip 25mm is a clip, not a hook/i);
  assert.match(json.message, /pick it from the hook register/i);
});

test('a hook cannot be booked as a print job', async () => {
  const { status, json } = await book({ printRef: hook._id });

  assert.equal(status, 400);
  assert.match(json.message, /is a hook, not a print job/i);
});

test('a grade the plant has stopped buying is refused', async () => {
  /* Booking against one commits a delivery date to a resin nobody can get — which is
     discovered at the press, weeks later. */
  const { status, json } = await book({ materialRef: retired._id });

  assert.equal(status, 400);
  assert.match(json.message, /PS Smoke is no longer on the active register/i);
});

test('a reference to something that does not exist is refused', async () => {
  const { status, json } = await book({ materialRef: '000000000000000000000000' });

  assert.equal(status, 400);
  assert.match(json.message, /not on the register/i);
});

/* ------------------------- Down the chain from a costing ------------------------- */

test('an order raised from a quotation is made of exactly what was costed', async () => {
  const costing = await api('/api/pricings', {
    method: 'POST',
    token: admin,
    body: { customer, modelNumber: 'NH-400', quantity: 10000 },
  });
  assert.equal(costing.status, 201, costing.json.message);

  /* The registers go on the costing door, because each of them is an *input* to the price —
     see the schema's own note. That is exactly why they are worth inheriting downstream. */
  const built = await api(`/api/pricings/${costing.json.data._id}/cost`, {
    method: 'PATCH',
    token: admin,
    body: {
      mould,
      materialRef: hips._id,
      hookRef: hook._id,
      clipRef: clip._id,
      printRef: print._id,
      cost: { gramWeight: 33, rawMaterialRate: 92 },
      markupPercent: 20,
      approvedSellingPrice: 7.4,
    },
  });
  assert.equal(built.status, 200, built.json.message);

  const quote = await api('/api/quotations', {
    method: 'POST',
    token: nandhini,
    body: {
      customer,
      lines: [{ mould, modelNumber: 'NH-400', pricing: costing.json.data._id, unitPrice: 7.4, moq: 5000 }],
    },
  });
  assert.equal(quote.status, 201, quote.json.message);

  await api(`/api/quotations/${quote.json.data._id}/send`, { method: 'POST', token: nandhini, body: {} });
  const accepted = await api(`/api/quotations/${quote.json.data._id}/response`, {
    method: 'POST', token: nandhini, body: { accepted: true },
  });
  assert.equal(accepted.json.data.status, 'accepted', accepted.json.message);

  const order = await api(`/api/quotations/${quote.json.data._id}/order`, {
    method: 'POST',
    token: priya,
    body: { lines: [{ quotationLine: quote.json.data.lines[0]._id, quantity: 25000 }] },
  });
  assert.equal(order.status, 201, order.json.message);

  /*
   * Nothing was retyped, and that now covers *what will be made* rather than only what it
   * costs. An order booked this way and the costing behind it stop being able to differ.
   */
  const line = order.json.data.lines[0];
  assert.equal(line.materialRef.name, 'HIPS White');
  assert.equal(line.hookRef.name, 'Swivel metal hook');
  assert.equal(line.clipRef.name, 'Wooden clip 25mm');
  assert.equal(line.printRef.name, '2 colour screen');
  assert.equal(line.colour, 'White');
  assert.equal(line.quantity, 25000);
});

/* -------------------------- Samples and enquiries too -------------------------- */

test('a sample request is made of the same register rows an order is', async () => {
  /*
   * The point of this, and it is worth stating: §13 checks an order against an *approved
   * sample*. That check means nothing if the sample said "HIPS Wht" in a box and the order
   * says "HIPS White" in a different box — there is nothing to compare. Both pointing at the
   * same register row is what turns it into an actual check.
   */
  const made = await api('/api/samples', {
    method: 'POST',
    token: nandhini,
    body: {
      customer,
      mould,
      materialRef: hips._id,
      hookRef: hook._id,
      printRef: print._id,
      quantity: 5,
      requiredDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    },
  });

  assert.equal(made.status, 201, made.json.message);
  assert.equal(made.json.data.materialRef.name, 'HIPS White');
  assert.equal(made.json.data.hookRef.name, 'Swivel metal hook');
  /* The resin fills the colour and the family here exactly as it does on an order line. */
  assert.equal(made.json.data.colour, 'White');
  assert.equal(made.json.data.material, 'hips');
  assert.equal(made.json.data.printing, '2 colour screen');
  /* And the sample keeps its own quantity, which is a real figure: pieces in the courier bag. */
  assert.equal(made.json.data.quantity, 5);
});

test('a clip cannot be booked as a hook on a sample either', async () => {
  const made = await api('/api/samples', {
    method: 'POST', token: nandhini, body: { customer, mould, hookRef: clip._id },
  });

  assert.equal(made.status, 400);
  assert.match(made.json.message, /is a clip, not a hook/i);
});

test('an enquiry carries the registers, and no quantity at all', async () => {
  const made = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer,
      mould,
      requirement: { materialRef: hips._id, clipRef: clip._id, quantity: 25000 },
      nextAction: 'Send the quote',
      nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
    },
  });

  assert.equal(made.status, 201, made.json.message);

  const seen = await api(`/api/enquiries/${made.json.data._id}`, { token: nandhini });
  const requirement = seen.json.data.requirement;

  assert.equal(requirement.materialRef.name, 'HIPS White');
  assert.equal(requirement.clipRef.name, 'Wooden clip 25mm');
  assert.equal(requirement.colour, 'White');
  /*
   * The quantity was sent and did not land. Nothing before the purchase order knows how many,
   * and the polite figure a buyer gives on the phone used to travel the whole chain as if it
   * were a commitment — onto a costing, onto a quotation, into every count of pipeline pieces.
   */
  assert.equal(requirement.quantity, undefined);
});

/* --------------------------------- The colours --------------------------------- */

test('the colours on offer come from the material register, not a master of their own', async () => {
  const { status, json } = await api('/api/materials/colours', { token: priya });

  assert.equal(status, 200, json.message);
  assert.ok(json.data.includes('White'));
  /* Inactive grades are not offered: a colour the plant has stopped buying is not one to
     start a new order in. */
  assert.ok(!json.data.includes('Smoke'));
});

/* -------------------------------- Correcting one -------------------------------- */

test('a correction goes through the same registers as the original', async () => {
  const made = await book({ materialRef: hips._id, hookRef: hook._id });
  const order = made.json.data;

  const wrong = await api(`/api/orders/${order._id}`, {
    method: 'PATCH',
    token: priya,
    body: { lines: [{ quantity: 10000, unitPrice: 7.5, hookRef: clip._id }] },
  });

  /* The same refusal, from the other door. A rule enforced on one and not the other is a gap
     with a witness. */
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.message, /is a clip, not a hook/i);

  const right = await api(`/api/orders/${order._id}`, {
    method: 'PATCH',
    token: priya,
    body: { lines: [{ quantity: 12000, unitPrice: 7.5, materialRef: hips._id, clipRef: clip._id }] },
  });
  assert.equal(right.status, 200, right.json.message);
  assert.equal(right.json.data.lines[0].clipRef.name, 'Wooden clip 25mm');
  assert.equal(right.json.data.lines[0].colour, 'White');
});
