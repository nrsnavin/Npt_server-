/**
 * Folds the costing sheets into the quotations they priced, so each quotation is one record
 * with its costing on its lines [src/models/Quotation.js].
 *
 *   - A quotation line raised from a costing takes that costing line's registers, cost build-up,
 *     markup, minimum and sign-off. Its price stays what was offered.
 *   - A costing nobody quoted becomes a quotation of its own, on its enquiry, priced at the
 *     costing's approved price — a draft (or waiting on Admin, or still to be costed).
 *   - Order lines remember the quotation line their price came from.
 *   - Saved views and task links that pointed at a costing point at its quotation.
 *
 * Nothing is deleted. Each costing sheet is marked `mergedInto`, so running it again skips what
 * is done; the `pricings` collection can be dropped by hand once the screens are checked.
 *
 *   npm run migrate:merge-costing              # show me
 *   npm run migrate:merge-costing -- --confirm # do it
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import Quotation, { rollUp, settleLine } from '../src/models/Quotation.js';
import Enquiry from '../src/models/Enquiry.js';
import Customer from '../src/models/Customer.js';
import Mould from '../src/models/Mould.js';
import { nextQuoteNumber } from '../src/services/numbering.service.js';

const confirm = process.argv.includes('--confirm');

/** The costing line a quotation line was built from: by its id, else its model, else the first. */
function costingLineOf(sheet, { pricingLine, modelNumber }) {
  const lines = sheet?.lines || [];
  if (pricingLine) {
    const named = lines.find((line) => String(line._id) === String(pricingLine));
    if (named) return named;
  }
  if (modelNumber) {
    const matched = lines.filter((line) => line.modelNumber === modelNumber);
    if (matched.length === 1) return matched[0];
  }
  return lines[0];
}

/** The next quote number nobody holds — the year's counter can sit behind numbers already issued. */
async function freeQuoteNumber(quotes, at) {
  for (;;) {
    const number = await nextQuoteNumber(at);
    if (!(await quotes.findOne({ number }, { projection: { _id: 1 } }))) return number;
  }
}

const COSTING_FIELDS = [
  'materialRef', 'hookRef', 'clipRef', 'printRef', 'material', 'procurement', 'printing',
  'cost', 'markupPercent', 'calculatedSellingPrice', 'minimumOverride',
];

/** A costing line's sign-off, carried onto a quotation line offering `price`. */
function signOff(costed, price) {
  const signed = {};
  if (costed.status === 'approved' && costed.approvedBy && costed.approvedSellingPrice != null && price != null && price >= costed.approvedSellingPrice) {
    signed.approvedPrice = costed.approvedSellingPrice;
    signed.approvedBy = costed.approvedBy;
    signed.approvedAt = costed.approvedAt;
  }
  if (costed.status === 'rejected') {
    signed.rejectedPrice = costed.approvedSellingPrice;
    signed.rejectionNote = costed.rejectionNote;
  }
  return signed;
}

export async function mergeCosting({ write = confirm, log = console.log } = {}) {
  const db = mongoose.connection.db;
  const sheets = db.collection('pricings');
  const quotes = db.collection('quotations');
  const report = { quotesUpdated: 0, linesCosted: 0, sheetsQuoted: 0, sheetsAsQuotations: 0, ordersLinked: 0, views: 0, tasks: 0 };

  const sheetCache = new Map();
  const sheetOf = async (id) => {
    const key = String(id);
    if (!sheetCache.has(key)) sheetCache.set(key, await sheets.findOne({ _id: new mongoose.Types.ObjectId(key) }));
    return sheetCache.get(key);
  };

  /* Costing line → quotation line, for the order lines that named the costing. */
  const lineMap = new Map();
  const quotedSheets = new Map();

  /* ---- 1. Quotations raised from costings take their costing onto their lines ---- */
  for await (const raw of quotes.find({ 'lines.pricing': { $exists: true } })) {
    let costed = 0;
    let firstSheet = null;
    const lines = [];
    for (const line of raw.lines || []) {
      const next = { ...line };
      if (line.pricing) {
        const sheet = await sheetOf(line.pricing);
        const source = sheet && costingLineOf(sheet, line);
        if (source) {
          firstSheet = firstSheet || sheet;
          for (const field of COSTING_FIELDS) if (source[field] !== undefined && next[field] === undefined) next[field] = source[field];
          if (!next.mould && source.mould) next.mould = source.mould;
          Object.assign(next, signOff(source, line.unitPrice));
          lineMap.set(`${sheet._id}:${source._id}`, { quotation: raw._id, line: line._id });
          quotedSheets.set(String(sheet._id), raw._id);
          costed += 1;
        }
      }
      delete next.pricing;
      delete next.pricingLine;
      lines.push(next);
    }
    report.quotesUpdated += 1;
    report.linesCosted += costed;
    log(`  ${raw.number.padEnd(16)} takes the costing onto ${costed} line(s)`);
    if (!write) continue;

    const quotation = Quotation.hydrate({ ...raw, lines });
    for (const line of quotation.lines) {
      if (line.unitPrice == null) line.status = 'requested';
      else if (!raw.sentAt) settleLine(line);
      else line.status = line.status && line.status !== 'requested' ? line.status : 'approved';
    }
    const status = rollUp(quotation);
    await quotes.updateOne({ _id: raw._id }, {
      $set: {
        lines: quotation.toObject({ virtuals: false }).lines,
        status: status === 'approved' ? (raw.sentAt ? 'revised' : 'draft') : status,
        requestedBy: raw.requestedBy || firstSheet?.requestedBy,
        requestedAt: raw.requestedAt || firstSheet?.requestedAt || raw.createdAt,
        costedBy: raw.costedBy || firstSheet?.costedBy,
        targetPrice: raw.targetPrice ?? firstSheet?.targetPrice,
      },
    });
  }

  /* ---- 2. A costing nobody quoted becomes a quotation of its own ---- */
  for await (const sheet of sheets.find({ mergedInto: { $exists: false } })) {
    const into = quotedSheets.get(String(sheet._id));
    if (into) {
      report.sheetsQuoted += 1;
      if (write) await sheets.updateOne({ _id: sheet._id }, { $set: { mergedInto: into } });
      continue;
    }

    report.sheetsAsQuotations += 1;
    const enquiry = sheet.enquiry ? await Enquiry.findById(sheet.enquiry).select('assignedTo') : null;
    const customer = await Customer.findById(sheet.customer).select('assignedTo');
    const owner = enquiry?.assignedTo || customer?.assignedTo || sheet.requestedBy;
    log(`  ${String(sheet.number).padEnd(16)} becomes a quotation of its own (${(sheet.lines || []).length} line(s))`);
    if (!write) continue;
    if (!owner) { log(`    skipped: nobody owns ${sheet.number}'s buyer`); continue; }

    const moqs = new Map((await Mould.find({ _id: { $in: (sheet.lines || []).map((line) => line.mould).filter(Boolean) } }).select('moq'))
      .map((mould) => [String(mould._id), mould.moq]));
    const priced = ['approved', 'approval_pending', 'rejected', 'costed'];
    const quotation = new Quotation({
      number: await freeQuoteNumber(quotes, sheet.requestedAt || sheet.createdAt || new Date()),
      customer: sheet.customer,
      enquiry: sheet.enquiry || undefined,
      assignedTo: owner,
      requestedBy: sheet.requestedBy || owner,
      requestedAt: sheet.requestedAt || sheet.createdAt,
      costedBy: sheet.costedBy,
      targetPrice: sheet.targetPrice,
      remarks: sheet.remarks,
      lines: (sheet.lines || []).map((line) => ({
        mould: line.mould,
        modelNumber: line.modelNumber,
        ...Object.fromEntries(COSTING_FIELDS.map((field) => [field, line[field]])),
        moq: line.mould ? moqs.get(String(line.mould)) || 0 : 0,
        unitPrice: priced.includes(line.status) ? line.approvedSellingPrice ?? line.calculatedSellingPrice : undefined,
        ...signOff(line, line.approvedSellingPrice),
      })),
    });
    for (const line of quotation.lines) settleLine(line);
    quotation.statusHistory = [{ to: rollUp(quotation), at: sheet.requestedAt || sheet.createdAt, note: `Merged from costing ${sheet.number}` }];
    quotation.revisions = [{
      revision: 0,
      lines: quotation.lines.map((line) => ({ mould: line.mould, modelNumber: line.modelNumber, moq: line.moq, unitPrice: line.unitPrice })),
      at: sheet.requestedAt || sheet.createdAt,
      by: owner,
    }];
    /* Written raw: the enquiry may be closed by now, which a new quotation through the app refuses. */
    const plain = quotation.toObject({ virtuals: false });
    plain.status = rollUp(quotation);
    plain.createdAt = sheet.createdAt || new Date();
    plain.updatedAt = new Date();
    await quotes.insertOne(plain);
    quotation.lines.forEach((line, index) => lineMap.set(`${sheet._id}:${sheet.lines[index]._id}`, { quotation: quotation._id, line: line._id }));
    await sheets.updateOne({ _id: sheet._id }, { $set: { mergedInto: quotation._id } });
    sheetCache.set(String(sheet._id), { ...sheet, mergedInto: quotation._id });
  }

  /* ---- 3. Order lines remember the quotation line their price came from ---- */
  for await (const order of db.collection('salesorders').find({ 'lines.pricing': { $exists: true } })) {
    let linked = 0;
    const lines = [];
    for (const line of order.lines || []) {
      const next = { ...line };
      if (line.pricing) {
        const sheet = await sheetOf(line.pricing);
        const source = sheet && costingLineOf(sheet, line);
        const target = source && lineMap.get(`${sheet._id}:${source._id}`);
        if (target) { next.quotationLine = target.line; linked += 1; }
        delete next.pricing;
      }
      lines.push(next);
    }
    report.ordersLinked += linked;
    if (write) await db.collection('salesorders').updateOne({ _id: order._id }, { $set: { lines } });
  }

  /* ---- 4. Saved views and task links ---- */
  report.views = await db.collection('savedviews').countDocuments({ page: 'pricings' });
  if (write) await db.collection('savedviews').updateMany({ page: 'pricings' }, { $set: { page: 'quotations' } });

  for await (const task of db.collection('todos').find({ link: /^\/pricings\// })) {
    const id = task.link.split('/')[2];
    const sheet = mongoose.isValidObjectId(id) ? await sheetOf(id) : null;
    const into = sheet?.mergedInto || quotedSheets.get(String(id));
    if (!into) continue;
    report.tasks += 1;
    if (write) await db.collection('todos').updateOne({ _id: task._id }, { $set: { link: `/quotations/${into}` } });
  }

  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await connectDatabase();
  console.log(confirm ? 'Merging costings into quotations…' : 'Dry run — nothing is written. Add --confirm to do it.');
  const report = await mergeCosting();
  console.log(report);
  await disconnectDatabase();
}
