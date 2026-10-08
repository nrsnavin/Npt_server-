import Customer from '../models/Customer.js';
import Quotation, { settleLine } from '../models/Quotation.js';
import { nextNumber, nextQuoteNumber } from '../services/numbering.service.js';
import { priceAt } from '../services/pricing.service.js';
import { QUOTE_SHEET, SHEET_PRODUCTS } from './quoteSheet.js';
import { FULL } from './size.js';
import { enquiryFor } from './enquiryFor.js';

/**
 * Seeds the pricing and quotation modules from the plant's real 26-27 sheet.
 *
 * Real rows rather than invented ones, because invented costings are all reasonable: they round
 * to sensible numbers, they all clear their floor, and they never contain the row that actually
 * matters — MAU-35 WB quoted at ₹3.60 against a ₹7.65 minimum, which is less than half. A
 * system tested only on the reasonable case looks finished right up until it meets the plant.
 *
 * What this produces:
 *
 *   25 costings   every model on the sheet, with its own cost lines, approved and quotable
 *    2 quotations the sheet's own two documents, NP/26-27/1 and /2, each carrying every model
 *                 quoted to that party — 8 lines and 6 — at the prices actually quoted
 *   11 costed-only the rows with no quote yet — a real and untested state before this
 *
 * Three costings sit below their own minimum, and because one of them is a line on `NP/26-27/1`
 * that whole document is held: §9's approval route then has a real quotation to refuse on a
 * freshly seeded database rather than only in a test, and it is the case a single-line model
 * could never produce — seven prices that are perfectly fine, held by an eighth that is not.
 */

/** The sheet's date column, as a Date. `01-Apr-2026`. */
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function sheetDate(text) {
  const [day, month, year] = String(text || '').split('-');
  const at = new Date(Number(year), MONTHS[month] ?? 3, Number(day) || 1, 11, 0, 0, 0);
  return Number.isNaN(at.getTime()) ? new Date() : at;
}

/**
 * The parties on the sheet, as customers.
 *
 * Contact details are invented — the sheet carries only a name — and are marked as such in the
 * remarks so nobody rings a number that was never real.
 */
const PARTY_DETAIL = {
  'Yorker knit': {
    customerType: 'garment_factory',
    city: 'Tiruppur',
    state: 'Tamil Nadu',
    mobile: '9840077001',
    email: 'purchase@yorkerknit.example',
    rating: 'A',
    creditTermsDays: 45,
    paymentTerms: '45 days from invoice',
  },
  'Samara Exports': {
    customerType: 'exporter',
    city: 'Tiruppur',
    state: 'Tamil Nadu',
    mobile: '9840077002',
    email: 'buying@samaraexports.example',
    rating: 'B',
    creditTermsDays: 30,
    paymentTerms: '30 days from invoice',
  },
};

/**
 * The sheet's rows, trimmed per quotation rather than across the lot.
 *
 * A flat first-four would take four lines off `NP/26-27/1` and leave `NP/26-27/2` with none,
 * so the second document — and with it the whole idea that a quotation carries several models —
 * would simply not exist on a small seed.
 *
 * The row that has to survive is the first of the first quote: MAU-35 WB, quoted at ₹3.60
 * against a floor of ₹7.65. That single row is what puts a real quotation in front of §9's
 * approval route on a freshly seeded database, and it is the case an invented costing never
 * produces, because invented costings all clear their floor.
 */
function sheetRows() {
  if (FULL) return QUOTE_SHEET;

  const perQuote = {};
  return QUOTE_SHEET.filter((row) => {
    perQuote[row.quote] = (perQuote[row.quote] || 0) + 1;
    return perQuote[row.quote] <= 2;
  });
}

export async function seedPricing({ admin, nandhini }) {
  await Quotation.deleteMany({});

  const rows = sheetRows();
  const sheetModels = Object.fromEntries(SHEET_PRODUCTS.map((row) => [row.modelCode, row]));

  /* -------------------------------- The parties -------------------------------- */

  const parties = {};
  for (const [name, detail] of Object.entries(PARTY_DETAIL)) {
    parties[name] =
      (await Customer.findOne({ name })) ||
      (await Customer.create({
        ...detail,
        name,
        code: await nextNumber('CUST'),
        whatsapp: detail.mobile,
        assignedTo: nandhini._id,
        source: 'referral',
        contacts: [{ name: 'Purchase', mobile: detail.mobile, isPrimary: true }],
        remarks: 'Seeded from the 26-27 quotation sheet. Contact details are placeholders.',
      }));
  }

  /* ------------------------------ The quotations ------------------------------ */

  /*
   * One quotation per quote reference on the sheet, because that is what a quotation is:
   * `NP/26-27/1` is eight priced models for Yorker knit under one number. Each line carries its
   * costing — transcribed figures, so none names a tool — and the price the sheet quoted.
   *
   * The rows the sheet costed but never quoted become one draft per party, priced at the 10%
   * tier: a rate worked out and nothing offered yet, which is what the sheet says of them.
   */
  const lineFor = (row) => {
    const spec = sheetModels[row.model];
    return {
      modelNumber: row.model,
      material: spec?.material,
      procurement: row.procurement || 'manufacture',
      printing: row.printing || undefined,
      cost: {
        gramWeight: row.gram,
        rawMaterialRate: row.rate,
        jobWorkCost: row.jobWork || 0,
        hookCost: row.hook || 0,
        metalClipsCost: row.clips || 0,
        printingCost: row.printPrice || 0,
        packingCost: row.packing || 0,
      },
      markupPercent: 10,
      moq: 5000,
    };
  };

  const documents = new Map();
  for (const row of rows) {
    if (!parties[row.party]) continue;
    const key = row.quoted == null ? `unquoted:${row.party}` : row.quote;
    if (!documents.has(key)) documents.set(key, []);
    documents.get(key).push(row);
  }

  const quotations = [];
  for (const [reference, entries] of documents) {
    const first = entries[0];
    const customer = parties[first.party];
    const at = sheetDate(first.date);
    const quoted = !reference.startsWith('unquoted:');

    /* Every quotation is on an enquiry [seed/enquiryFor.js]. */
    const asked = await enquiryFor({
      customer, owner: nandhini, modelNumber: first.model, status: quoted ? 'quote_submitted' : 'pricing_required', at,
    });

    const quotation = new Quotation({
      number: await nextQuoteNumber(at),
      customer: customer._id,
      enquiry: asked._id,
      assignedTo: nandhini._id,
      requestedBy: nandhini._id,
      requestedAt: at,
      costedBy: admin._id,
      lines: entries.map(lineFor),
      gstPercent: 18,
      paymentTerms: PARTY_DETAIL[first.party].paymentTerms,
      deliveryTerms: '4 weeks from receipt of confirmed PO',
      freightTerms: 'ex_factory',
      packing: '200 pcs per carton',
      validUntil: new Date(at.getTime() + 30 * 24 * 60 * 60 * 1000),
      remarks: quoted ? `Against ${reference}` : 'Costed off the 26-27 sheet; not yet quoted',
    });

    quotation.lines.forEach((line, index) => {
      line.calculatedSellingPrice = priceAt(line.totalCost, 10);
      line.unitPrice = entries[index].quoted ?? line.calculatedSellingPrice;
      settleLine(line);
    });

    /*
     * `NP/26-27/1` holds MAU-35 WB at ₹3.60 against a ₹7.65 floor, so nothing on it goes out
     * until Admin signs — a document for §9 to refuse on a freshly seeded database.
     */
    const blocked = quotation.lines.some((line) => line.status === 'approval_pending');
    if (quoted && !blocked) {
      quotation.status = 'sent';
      quotation.sentAt = at;
    }
    quotation.statusHistory = [{ to: 'costing', at, by: nandhini._id }];

    quotation.revisions = [{
      revision: 0,
      lines: quotation.lines.map((line) => ({ modelNumber: line.modelNumber, moq: line.moq, unitPrice: line.unitPrice })),
      validUntil: quotation.validUntil,
      paymentTerms: quotation.paymentTerms,
      deliveryTerms: quotation.deliveryTerms,
      freightTerms: quotation.freightTerms,
      packing: quotation.packing,
      at,
      by: nandhini._id,
      sentAt: quotation.sentAt,
    }];

    await quotation.save();
    quotations.push(quotation);
  }

  const lines = quotations.flatMap((quotation) => quotation.lines);
  return {
    sheetModels: new Set(lines.map((line) => line.modelNumber)).size,
    parties: Object.keys(parties).length,
    costedLines: lines.length,
    quotations: quotations.length,
    sent: quotations.filter((q) => q.sentAt).length,
    heldForApproval: quotations.filter((q) => q.status === 'approval_pending').length,
    belowFloor: lines.filter((line) => line.belowMinimum).length,
  };
}
