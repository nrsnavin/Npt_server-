import Product from '../models/Product.js';
import Customer from '../models/Customer.js';
import Pricing from '../models/Pricing.js';
import Quotation from '../models/Quotation.js';
import { nextNumber } from '../services/numbering.service.js';
import { QUOTE_SHEET, SHEET_PRODUCTS } from './quoteSheet.js';

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

export async function seedPricing({ admin, nandhini }) {
  await Promise.all([Pricing.deleteMany({}), Quotation.deleteMany({})]);

  /* ------------------------------- The catalogue ------------------------------- */

  const existing = await Product.find().select('modelCode');
  const known = new Set(existing.map((product) => product.modelCode));

  const added = await Product.create(
    SHEET_PRODUCTS.filter((row) => !known.has(row.modelCode)).map((row) => ({
      modelCode: row.modelCode,
      /*
       * The description only. Screens render "<code> — <name>", so repeating the code here
       * produces "MAU-35 WB — MAU-35 WB — 350mm PP" wherever a product is named in full.
       */
      name: `${row.sizeMm ? `${row.sizeMm}mm ` : ''}${row.material.toUpperCase()} ${row.category} hanger`,
      category: row.category,
      sizeMm: row.sizeMm || 1,
      material: row.material,
      standardWeightGrams: row.standardWeightGrams,
      availableColours: [row.colour],
      /*
       * A traded model has no mould of ours by definition — that is what makes it traded — so
       * seeding one as moulded here would put a fiction in the master that the plant would have
       * to notice and correct.
       */
      mouldAvailable: row.procurement === 'manufacture',
      moq: 5000,
      packingQty: 200,
      isActive: true,
    }))
  );

  const products = Object.fromEntries(
    (await Product.find().select('modelCode')).map((product) => [product.modelCode, product])
  );

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

  /* ------------------------------- The costings -------------------------------- */

  const pricings = [];
  const quotations = [];
  /** Every costed row with what it needs to become a quotation line further down. */
  const costed = [];

  for (const row of QUOTE_SHEET) {
    const customer = parties[row.party];
    if (!customer) continue;

    const product = products[row.model];
    const at = sheetDate(row.date);

    const pricing = new Pricing({
      number: await nextNumber('PRC'),
      customer: customer._id,
      product: product?._id,
      modelNumber: row.model,
      material: product?.material,
      procurement: row.procurement || 'manufacture',
      printing: row.printing || undefined,
      /*
       * The sheet prices per piece and does not carry a lot size, so the quantity here is a
       * plausible one rather than a transcribed one — it is the only invented number on the
       * costing, and nothing downstream computes from it.
       */
      quantity: 20000,
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
      requestedBy: nandhini._id,
      requestedAt: at,
      costedBy: admin._id,
    });

    /*
     * The approved price is what was actually quoted, where the sheet quoted one. That is what
     * puts three genuinely below-floor costings into the database — and those are the rows §9
     * exists for, so seeding only the comfortable ones would leave its whole route unexercised.
     */
    pricing.calculatedSellingPrice = pricing.tiers[10];
    pricing.approvedSellingPrice = row.quoted ?? pricing.tiers[10];

    const settled = pricing.belowMinimum ? 'approval_pending' : 'approved';
    pricing.status = settled;
    pricing.statusHistory = [
      { to: 'requested', at, by: nandhini._id },
      { from: 'requested', to: 'costed', at, by: admin._id },
      { from: 'costed', to: settled, at, by: admin._id },
    ];
    if (settled === 'approved') {
      pricing.approvedBy = admin._id;
      pricing.approvedAt = at;
    }

    await pricing.save();
    pricings.push(pricing);

    /* Kept for the grouping below: a quotation is a document, and the sheet says which. */
    costed.push({ row, pricing, product, customer, at });
  }

  /* ------------------------------ The quotations ------------------------------ */

  /*
   * **Grouped by the sheet's own quote reference, because that is what a quotation is.**
   *
   * The sheet has two of them. `NP/26-27/1` covers sixteen models for Yorker knit — eight of
   * them priced — under one number, one validity and one set of payment terms; `NP/26-27/2`
   * covers nine for Samara Exports, six priced. This seed used to produce fourteen quotations,
   * one per priced row, which gave the buyer fourteen reference numbers for one conversation
   * and made "what did we quote Yorker knit?" a question with fourteen answers and no total.
   *
   * The rows with no price are costed and left off the document, which is exactly what the
   * sheet does with them: a rate has been worked out and nothing has been offered yet.
   */
  const documents = new Map();
  for (const entry of costed) {
    if (entry.row.quoted == null) continue;
    const key = entry.row.quote;
    if (!documents.has(key)) documents.set(key, []);
    documents.get(key).push(entry);
  }

  for (const [reference, entries] of documents) {
    const { customer, at, row } = entries[0];

    const quotation = new Quotation({
      number: await nextNumber('QTN'),
      customer: customer._id,
      assignedTo: nandhini._id,
      lines: entries.map((entry) => ({
        pricing: entry.pricing._id,
        product: entry.product?._id,
        modelNumber: entry.row.model,
        quantity: 20000,
        moq: 5000,
        unitPrice: entry.row.quoted,
      })),
      gstPercent: 18,
      paymentTerms: PARTY_DETAIL[row.party].paymentTerms,
      deliveryTerms: '4 weeks from receipt of confirmed PO',
      freightTerms: 'ex_factory',
      packing: '200 pcs per carton',
      validUntil: new Date(at.getTime() + 30 * 24 * 60 * 60 * 1000),
      /*
       * The sheet's own quote reference kept as a remark, so a document here can be traced back
       * to the spreadsheet it came from while both are still in use.
       */
      remarks: `Against ${reference}`,
      statusHistory: [{ to: 'draft', at, by: nandhini._id }],
    });

    /*
     * One line under its floor holds the whole document, which is the rule a multi-line
     * quotation makes real — and `NP/26-27/1` is the case: seven of its eight prices are fine
     * and MAU-35 WB at ₹3.60 against a ₹7.65 floor is not, so nothing on it goes out until
     * somebody signs. On a freshly seeded database that gives §9 a document to refuse rather
     * than only a test.
     */
    const blocked = entries.some((entry) => entry.pricing.belowMinimum);
    quotation.status = blocked ? 'approval_pending' : 'sent';
    quotation.sentAt = blocked ? undefined : at;

    quotation.revisions = [
      {
        revision: 0,
        lines: quotation.lines.map((line) => {
          const plain = line.toObject();
          delete plain._id;
          return plain;
        }),
        validUntil: quotation.validUntil,
        paymentTerms: quotation.paymentTerms,
        deliveryTerms: quotation.deliveryTerms,
        freightTerms: quotation.freightTerms,
        packing: quotation.packing,
        at,
        by: nandhini._id,
        sentAt: quotation.sentAt,
      },
    ];

    await quotation.save();
    quotations.push(quotation);
  }

  return {
    productsAdded: added.length,
    parties: Object.keys(parties).length,
    pricings: pricings.length,
    quotations: quotations.length,
    quotedLines: quotations.reduce((sum, quotation) => sum + quotation.lines.length, 0),
    heldForApproval: quotations.filter((q) => q.status === 'approval_pending').length,
    belowFloor: pricings.filter((p) => p.belowMinimum).length,
  };
}
