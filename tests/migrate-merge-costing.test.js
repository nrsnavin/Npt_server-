/**
 * Folding the costing sheets into their quotations [scripts/migrate-merge-costing.js].
 *
 *   node --test tests/migrate-merge-costing.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'merge-costing-test-secret';

let mongo;
let db;
let ids;

const oid = () => new mongoose.Types.ObjectId();
const COST = { gramWeight: 22, rawMaterialRate: 95, jobWorkCost: 1.1, packingCost: 0.4 };

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  db = mongoose.connection.db;
  await import('../src/models/Quotation.js');

  const owner = oid();
  await db.collection('users').insertOne({ _id: owner, name: 'Nandhini S', email: 'n@np.com', department: 'marketing', isActive: true });
  const customer = oid();
  await db.collection('customers').insertOne({ _id: customer, code: 'C1', name: 'Sri Kumaran Knits', assignedTo: owner });
  const enquiry = oid();
  await db.collection('enquiries').insertOne({ _id: enquiry, number: 'ENQ-1', customer, assignedTo: owner, stage: 'pricing_quote', status: 'pricing_required', requirement: {} });

  const quotedLine = oid();
  const quoted = oid();
  const unquotedLine = oid();
  const unquoted = oid();
  await db.collection('pricings').insertMany([
    {
      _id: quoted, number: 'PRC-1', customer, enquiry, requestedBy: owner, status: 'approved', createdAt: new Date(),
      lines: [{ _id: quotedLine, modelNumber: 'NH-400', cost: COST, markupPercent: 20, calculatedSellingPrice: 4.35, approvedSellingPrice: 4.35, status: 'approved' }],
    },
    {
      _id: unquoted, number: 'PRC-2', customer, enquiry, requestedBy: owner, status: 'approved', targetPrice: 4, createdAt: new Date(),
      lines: [{ _id: unquotedLine, modelNumber: 'NH-500', cost: COST, markupPercent: 20, calculatedSellingPrice: 4.35, approvedSellingPrice: 4.35, status: 'approved' }],
    },
  ]);

  const quotationLine = oid();
  const quotation = oid();
  await db.collection('quotations').insertOne({
    _id: quotation, number: 'NP/26-27/001', customer, enquiry, assignedTo: owner, status: 'sent', sentAt: new Date(), revision: 0,
    lines: [{ _id: quotationLine, modelNumber: 'NH-400', unitPrice: 4.5, moq: 5000, pricing: quoted, pricingLine: quotedLine }],
    revisions: [], statusHistory: [], createdAt: new Date(),
  });
  await db.collection('salesorders').insertOne({
    _id: oid(), number: 'SO-1', customer, quotation, lines: [{ _id: oid(), modelNumber: 'NH-400', quantity: 1000, unitPrice: 4.5, pricing: quoted }],
  });
  await db.collection('savedviews').insertOne({ _id: oid(), page: 'pricings', name: 'Mine', user: owner });
  await db.collection('todos').insertOne({ _id: oid(), title: 'Price ready', department: 'marketing', link: `/pricings/${unquoted}` });

  ids = { quotation, quotationLine, quoted, unquoted };
});

test.after(async () => {
  await mongoose.connection.close();
  await mongo?.stop();
});

test('a dry run says what it would do and writes nothing', async () => {
  const { mergeCosting } = await import('../scripts/migrate-merge-costing.js');
  const report = await mergeCosting({ write: false, log: () => {} });
  assert.equal(report.quotesUpdated, 1);
  assert.equal(report.sheetsAsQuotations, 1);
  assert.equal(await db.collection('quotations').countDocuments(), 1, 'nothing written');
  assert.ok((await db.collection('quotations').findOne({ _id: ids.quotation })).lines[0].pricing);
});

test('the costing lands on the quotation it priced, and an unquoted costing becomes a quotation', async () => {
  const { mergeCosting } = await import('../scripts/migrate-merge-costing.js');
  await mergeCosting({ write: true, log: () => {} });

  const quoted = await db.collection('quotations').findOne({ _id: ids.quotation });
  const [line] = quoted.lines;
  assert.equal(line.cost.rawMaterialRate, 95, 'the cost came across');
  assert.equal(line.markupPercent, 20);
  assert.equal(line.unitPrice, 4.5, 'and the price offered stayed');
  assert.equal(line.pricing, undefined, 'no pointer left to a sheet');
  assert.equal(quoted.status, 'sent', 'still with the buyer');

  const fresh = await db.collection('quotations').findOne({ 'lines.modelNumber': 'NH-500' });
  assert.ok(fresh, 'the unquoted costing is a quotation now');
  assert.match(fresh.number, /^NP\//);
  assert.equal(fresh.lines[0].unitPrice, 4.35, 'priced at what was approved');
  assert.equal(fresh.status, 'draft', 'ready to send, never sent');
  assert.equal(fresh.targetPrice, 4);

  const sheet = await db.collection('pricings').findOne({ _id: ids.unquoted });
  assert.equal(String(sheet.mergedInto), String(fresh._id), 'and the sheet says where it went');

  const order = await db.collection('salesorders').findOne({ number: 'SO-1' });
  assert.equal(String(order.lines[0].quotationLine), String(ids.quotationLine), 'the order line knows its quotation line');
  assert.equal(order.lines[0].pricing, undefined);

  assert.equal((await db.collection('savedviews').findOne({ name: 'Mine' })).page, 'quotations');
  assert.equal((await db.collection('todos').findOne({ title: 'Price ready' })).link, `/quotations/${fresh._id}`);
});

test('running it again changes nothing', async () => {
  const { mergeCosting } = await import('../scripts/migrate-merge-costing.js');
  const before = await db.collection('quotations').countDocuments();
  const report = await mergeCosting({ write: true, log: () => {} });
  assert.equal(report.quotesUpdated, 0);
  assert.equal(report.sheetsAsQuotations, 0);
  assert.equal(await db.collection('quotations').countDocuments(), before);
});
