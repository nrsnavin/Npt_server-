/**
 * The trading master [models/TradedItem.js, controllers/tradedItem.controller.js,
 * services/tradedImport.service.js]: bought-in items and their inward price, kept by hand or
 * from an Excel/CSV upload, and costed onto a quotation line.
 *
 *   node --test tests/trading-master.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'trading-master-test-secret';

let mongo;
let server;
let baseUrl;
let admin;
let quoter;   // Quotation department — keeps the list and sees the price
let nandhini; // marketing — sees the items, not the price
let events;
let customerId;

const api = async (path, { method = 'GET', body, token, form } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(form ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(form ? { body: form } : body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* a CSV */ }
  return { status: response.status, json, text };
};

const signIn = async (email, password) =>
  (await api('/api/auth/login', { method: 'POST', body: { email, password } })).json.data?.token;

const upload = (buffer, name, { commit = false, token = quoter } = {}) => {
  const form = new FormData();
  form.append('file', new Blob([buffer]), name);
  if (commit) form.append('commit', 'true');
  return api('/api/traded-items/import', { method: 'POST', token, form });
};

/** A real .xlsx: a stored (uncompressed) zip with a shared-strings table and one sheet. */
function xlsx(rows) {
  const strings = [];
  const ref = (value) => {
    let at = strings.indexOf(value);
    if (at < 0) at = strings.push(value) - 1;
    return at;
  };
  const letters = (index) => String.fromCharCode(65 + index);
  const sheet = `<?xml version="1.0"?><worksheet><sheetData>${rows.map((row, r) => `<row r="${r + 1}">${row.map((cell, c) => {
    if (cell === null) return '';
    if (typeof cell === 'number') return `<c r="${letters(c)}${r + 1}"><v>${cell}</v></c>`;
    return `<c r="${letters(c)}${r + 1}" t="s"><v>${ref(cell)}</v></c>`;
  }).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const shared = `<?xml version="1.0"?><sst>${strings.map((value) => `<si><t>${value}</t></si>`).join('')}</sst>`;
  const files = [['xl/sharedStrings.xml', shared], ['xl/worksheets/sheet1.xml', sheet]];

  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content);
    const nameBytes = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  events = await import('../src/services/events.service.js');
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
    ['Senthil K', 'senthil@np.com', 'quotation', 'Quote@12345'],
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: { name, email, password, department } });
  }
  nandhini = await signIn('nandhini@np.com', 'Mktg@123456');
  quoter = await signIn('senthil@np.com', 'Quote@12345');

  const me = (await api('/api/auth/me', { token: nandhini })).json.data.id;
  customerId = (await api('/api/customers', {
    method: 'POST', token: nandhini,
    body: { assignedTo: me, name: 'Sri Kumaran Knits', gstin: '33AABCS1429B1ZP', mobile: '9876500011' },
  })).json.data._id;
});

test.after(async () => {
  events?.clearListeners();
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

let ph17;

test('the Quotation department keeps an item; marketing sees it without the price', async () => {
  const made = await api('/api/traded-items', {
    method: 'POST', token: quoter,
    body: { modelNumber: 'PH-17', code: 'tr-001', supplier: 'Sri Balaji Plastics', inwardPrice: 3.4, colour: 'White' },
  });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  ph17 = made.json.data;
  assert.equal(ph17.code, 'TR-001');
  assert.equal(ph17.priceHistory.length, 1);

  const seen = (await api('/api/traded-items', { token: nandhini })).json.data.find((row) => row._id === ph17._id);
  assert.ok(seen, 'marketing can pick it');
  assert.equal(seen.inwardPrice, undefined, 'but not see what we pay');
  assert.equal(seen.priceHidden, true);
  const one = (await api(`/api/traded-items/${ph17._id}`, { token: nandhini })).json.data;
  assert.equal(one.priceHistory, undefined);

  const tried = await api('/api/traded-items', { method: 'POST', token: nandhini, body: { modelNumber: 'X', inwardPrice: 1 } });
  assert.equal(tried.status, 403);
});

test('one row per model, whatever the spacing or case', async () => {
  const again = await api('/api/traded-items', { method: 'POST', token: quoter, body: { modelNumber: ' ph-17 ', inwardPrice: 3 } });
  assert.equal(again.status, 409);
  assert.match(again.json.message, /PH-17 is already/);
});

test('a price change is dated and kept; other edits are not', async () => {
  const moved = await api(`/api/traded-items/${ph17._id}`, {
    method: 'PATCH', token: quoter, body: { inwardPrice: 3.6, priceNote: 'Supplier increase from 1 Nov' },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal(moved.json.data.priceHistory.length, 2);
  assert.equal(moved.json.data.priceHistory[1].from, 3.4);
  assert.equal(moved.json.data.priceHistory[1].note, 'Supplier increase from 1 Nov');

  const renamed = await api(`/api/traded-items/${ph17._id}`, { method: 'PATCH', token: quoter, body: { description: 'Plain 17 inch' } });
  assert.equal(renamed.json.data.priceHistory.length, 2);
});

test('a CSV upload previews first, writes only when confirmed, and names what is wrong', async () => {
  const csv = [
    'Trading master — 26-27',
    '',
    'Model,Code,Supplier,Purchase Rate,Colour,GST %',
    'PH-17,TR-001,Sri Balaji Plastics,"₹ 3.80",White,18%',
    'VH-42,TR-002,Velvet House,12.50,Black,12',
    'WH-10,,Wood Craft,abc,,',
    ',,,,,',
    'vh-42,,Velvet House,13,,',
  ].join('\r\n');

  const preview = await upload(Buffer.from(csv), 'trading.csv');
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  const { summary, plan, committed } = preview.json.data;
  assert.equal(committed, false);
  assert.deepEqual(summary, { create: 1, update: 1, unchanged: 0, error: 2 });
  const update = plan.find((row) => row.action === 'update');
  assert.deepEqual(update.changes.inwardPrice, { from: 3.6, to: 3.8 });
  assert.match(plan.find((row) => row.row === 6).problems[0], /Inward price "abc"/);
  assert.match(plan.find((row) => row.row === 8).problems[0], /on the sheet twice/);
  assert.equal((await api('/api/traded-items', { token: quoter })).json.data.length, 1, 'nothing written yet');

  const done = await upload(Buffer.from(csv), 'trading.csv', { commit: true });
  assert.equal(done.json.data.created, 1);
  assert.equal(done.json.data.updated, 1);
  const items = (await api('/api/traded-items', { token: quoter })).json.data;
  assert.deepEqual(items.map((row) => row.modelNumber).sort(), ['PH-17', 'VH-42']);
  const history = (await api(`/api/traded-items/${ph17._id}`, { token: quoter })).json.data.priceHistory;
  assert.equal(history.at(-1).source, 'upload');
  assert.equal(history.at(-1).price, 3.8);
  assert.equal(items.find((row) => row.modelNumber === 'VH-42').gstPercent, 12);
});

test('an Excel upload reads the same way, header found below a title row', async () => {
  const book = xlsx([
    ['Bought-in hangers', null, null],
    ['Item Name', 'Rate', 'Vendor'],
    ['KH-30', 7.25, 'Kids Hangers Co'],
    ['PH-17', 3.8, 'Balaji Plastics, Tiruppur'],
  ]);
  const preview = await upload(book, 'list.xlsx');
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.deepEqual(preview.json.data.summary, { create: 1, update: 1, unchanged: 0, error: 0 },
    'PH-17 picks up the vendor; the price is the same');
  const done = await upload(book, 'list.xlsx', { commit: true });
  assert.equal(done.json.data.created, 1);
  const kh = (await api('/api/traded-items?search=KH-30', { token: quoter })).json.data[0];
  assert.equal(kh.inwardPrice, 7.25);
});

test('a file that is not a table is refused in words; marketing cannot upload', async () => {
  const noHeader = await upload(Buffer.from('a,b\n1,2\n'), 'x.csv');
  assert.equal(noHeader.status, 400);
  assert.match(noHeader.json.message, /Model column/);
  assert.equal((await upload(Buffer.from('x'), 'x.pdf')).status, 400);
  assert.equal((await upload(Buffer.from('Model,Price\nA,1'), 'x.csv', { token: nandhini })).status, 403);
});

test('the template downloads, and goes straight back in', async () => {
  const template = await api('/api/traded-items/template', { token: quoter });
  assert.equal(template.status, 200);
  assert.match(template.text, /Model,Code,Description.*Inward price/);
  const preview = await upload(Buffer.from(template.text), 'template.csv');
  assert.equal(preview.json.data.summary.error, 0);
});

test('a traded model on an enquiry is costed at its inward price; marketing sees neither', async () => {
  const enquiry = (await api('/api/enquiries', {
    method: 'POST', token: nandhini,
    body: {
      customer: customerId, requirement: { modelNumber: 'VH-42' },
      nextAction: 'Send the price', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString(),
    },
  })).json.data;

  const raised = await api('/api/quotations', { method: 'POST', token: nandhini, body: { enquiry: enquiry._id } });
  assert.equal(raised.status, 201, JSON.stringify(raised.json));
  const id = raised.json.data._id;

  const full = (await api(`/api/quotations/${id}`, { token: quoter })).json.data;
  const [line] = full.lines;
  assert.ok(line.tradedItem, JSON.stringify(line));
  assert.equal(line.procurement, 'trade');
  assert.equal(line.tradedItem.modelNumber, 'VH-42');
  assert.equal(line.cost.inwardPrice, 12.5, 'the price on the master when the line was made');
  assert.equal(line.totalCost, 12.5);

  const marketing = (await api(`/api/quotations/${id}`, { token: nandhini })).json.data;
  assert.equal(marketing.lines[0].cost, undefined);
  assert.equal(marketing.lines[0].tradedItem.inwardPrice, undefined);
  assert.equal(marketing.lines[0].tradedItem.modelNumber, 'VH-42');
});

test('picking an item while costing takes its price; a later move does not reach back but is flagged', async () => {
  const enquiry = (await api('/api/enquiries', {
    method: 'POST', token: nandhini,
    body: {
      customer: customerId, requirement: { modelNumber: 'Special velvet' },
      nextAction: 'Send the price', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString(),
    },
  })).json.data;
  const quotation = (await api('/api/quotations', { method: 'POST', token: nandhini, body: { enquiry: enquiry._id } })).json.data;
  const lineId = quotation.lines[0]._id;
  assert.equal(quotation.lines[0].tradedItem, undefined, 'no item by that name');

  const costed = await api(`/api/quotations/${quotation._id}/lines/${lineId}/cost`, {
    method: 'PATCH', token: quoter, body: { tradedItem: ph17._id, cost: { packingCost: 0.2 }, markupPercent: 20 },
  });
  assert.equal(costed.status, 200, JSON.stringify(costed.json));
  const line = costed.json.data.lines[0];
  assert.equal(line.cost.inwardPrice, 3.8);
  assert.equal(line.procurement, 'trade');
  assert.ok(Math.abs(line.totalCost - 4.0) < 1e-9, `cost is inward price plus packing, got ${line.totalCost}`);

  const bumped = await api(`/api/traded-items/${ph17._id}`, { method: 'PATCH', token: quoter, body: { inwardPrice: 4.1 } });
  assert.equal(bumped.status, 200, JSON.stringify(bumped.json));
  const after = (await api(`/api/quotations/${quotation._id}`, { token: quoter })).json.data.lines[0];
  assert.equal(after.cost.inwardPrice, 3.8, 'the quote keeps the price it was costed on');
  const usage = (await api(`/api/traded-items/${ph17._id}/quotations`, { token: quoter })).json;
  assert.equal(usage.data.length, 1);
  assert.equal(usage.stale, 1, 'and the master says which quotes the increase touches');

  const cleared = await api(`/api/quotations/${quotation._id}/lines/${lineId}/cost`, {
    method: 'PATCH', token: quoter, body: { tradedItem: null },
  });
  assert.equal(cleared.json.data.lines[0].cost.inwardPrice, undefined);
});
