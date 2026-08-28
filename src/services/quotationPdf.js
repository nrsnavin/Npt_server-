import PDFDocument from 'pdfkit';
import company from '../config/company.js';
import { FREIGHT_TERMS } from '../models/Quotation.js';

/**
 * The quotation as a document a customer receives [BLUEPRINT §10].
 *
 * Laid out the way SAP's SD quotation print output is, because that shape is not decoration —
 * it is what a buyer's purchase department already knows how to read. Three conventions do the
 * work:
 *
 *   **A document header block, not a letter.** Quotation number, date, validity, customer
 *   number and enquiry reference sit in a labelled grid at the top right. A buyer looking for
 *   "which quote is this against my enquiry" finds it in the same place every time.
 *
 *   **Positional line items.** Every line has an item number (10, 20, 30 — SAP's increments,
 *   which leave room to insert), a material code, a description, a quantity with its unit, a
 *   unit price and a net value. Purchase departments quote item numbers back at you.
 *
 *   **Values right-aligned on a fixed grid, totals stepped underneath.** Numbers that share a
 *   decimal column can be checked by eye; numbers that wander cannot.
 *
 * Generated per request rather than stored. A quotation's price changes with every revision
 * [§10] and a stored PDF is a copy that stops agreeing with the record it came from — the
 * document is a *view* of the quotation, and the quotation is the truth.
 */

/* The page grid, in points. A4 is 595.28 × 841.89. */
const PAGE = { size: 'A4', margin: 42 };
const LEFT = PAGE.margin;
const RIGHT = 595.28 - PAGE.margin;
const WIDTH = RIGHT - LEFT;

/* Type scale. SAP prints small: labels well under the values they caption. */
const LABEL = 6.5;
const BODY = 9;
const RULE = 0.6;

const INK = '#111111';
const MUTED = '#6b6b6b';
const HAIRLINE = '#b8b8b8';
const BAND = '#eceff1';

const FREIGHT_LABELS = {
  ex_factory: 'Ex-factory',
  fob: 'FOB',
  cif: 'CIF',
  door_delivery: 'Door delivery',
};

/**
 * Amounts carry a currency *code*, never the ₹ glyph.
 *
 * Two reasons, and they point the same way. PDF's built-in Helvetica is WinAnsi-encoded and has
 * no U+20B9 at all — pdfkit silently substitutes, and the first draft of this document printed
 * a superscript "1" where every rupee sign should have been. And a code is what SAP prints
 * anyway: the buyer's own ERP keys on `INR`, and an export quote priced in dollars needs the
 * document to say which currency without anyone squinting at a symbol.
 */
const CURRENCY = 'INR';

const money = (value) =>
  (Number(value) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** An amount with its code, for the totals block where the number stands alone. */
const amount = (value) => `${CURRENCY} ${money(value)}`;

const qty = (value) => (Number(value) || 0).toLocaleString('en-IN');

const day = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';

/* -------------------------------------------------------------------------- */

/** A caption over a value, which is the whole vocabulary of an SAP header block. */
function labelled(doc, label, value, x, y, width) {
  doc
    .font('Helvetica')
    .fontSize(LABEL)
    .fillColor(MUTED)
    .text(String(label).toUpperCase(), x, y, { width, characterSpacing: 0.6 });
  doc
    .font('Helvetica-Bold')
    .fontSize(BODY)
    .fillColor(INK)
    .text(value ?? '—', x, y + 8, { width });
}

function rule(doc, y, { colour = HAIRLINE, weight = RULE } = {}) {
  doc.save().lineWidth(weight).strokeColor(colour).moveTo(LEFT, y).lineTo(RIGHT, y).stroke().restore();
}

/**
 * The letterhead and the document's own identity.
 *
 * The seller's block is deliberately quieter than the document title: the recipient knows who
 * sent it, and what they are looking for is which document this is.
 */
function header(doc, quotation) {
  let y = PAGE.margin;

  doc.font('Helvetica-Bold').fontSize(15).fillColor(INK).text(company.name, LEFT, y);
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(company.tagline, LEFT, y + 18);

  const senderLines = [
    ...company.addressLines,
    `GSTIN ${company.gstin}`,
    `${company.phone}  ·  ${company.email}`,
  ];
  doc.fontSize(7.5).fillColor(MUTED).text(senderLines.join('\n'), LEFT, y + 30, { width: 240, lineGap: 1.5 });

  /* The document's identity, boxed at the right — SAP's "document type" corner. */
  const boxWidth = 232;
  const boxX = RIGHT - boxWidth;
  doc
    .save()
    .lineWidth(RULE)
    .strokeColor(HAIRLINE)
    .rect(boxX, y, boxWidth, 84)
    .stroke()
    .restore();

  doc
    .font('Helvetica-Bold')
    .fontSize(13)
    .fillColor(INK)
    .text('QUOTATION', boxX + 10, y + 9, { width: boxWidth - 20, characterSpacing: 1.4 });

  const half = (boxWidth - 30) / 2;
  labelled(doc, 'Quotation no.', quotation.number, boxX + 10, y + 31, half);
  labelled(doc, 'Date', day(quotation.sentAt || quotation.createdAt), boxX + 20 + half, y + 31, half);
  labelled(doc, 'Revision', String(quotation.revision ?? 0), boxX + 10, y + 56, half);
  labelled(doc, 'Valid until', day(quotation.validUntil), boxX + 20 + half, y + 56, half);

  y += 100;
  rule(doc, y, { colour: INK, weight: 1 });
  return y + 12;
}

/** Sold-to party, and the references that tie the document to the buyer's own paperwork. */
function parties(doc, quotation, y) {
  const customer = quotation.customer || {};
  const column = (WIDTH - 24) / 2;

  doc
    .font('Helvetica')
    .fontSize(LABEL)
    .fillColor(MUTED)
    .text('SOLD-TO PARTY', LEFT, y, { characterSpacing: 0.6 });

  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK).text(customer.name || '—', LEFT, y + 10, { width: column });

  const address = [
    customer.address,
    [customer.city, customer.state].filter(Boolean).join(', '),
    customer.gstin ? `GSTIN ${customer.gstin}` : null,
    [customer.mobile, customer.email].filter(Boolean).join('  ·  '),
  ]
    .filter(Boolean)
    .join('\n');

  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(address || '—', LEFT, y + 25, { width: column, lineGap: 1.5 });

  /* References, right column: the buyer's number for this job, and ours. */
  const refX = LEFT + column + 24;
  const refHalf = (column - 14) / 2;
  labelled(doc, 'Customer no.', customer.code, refX, y, refHalf);
  labelled(doc, 'Your enquiry', quotation.enquiry?.number, refX + refHalf + 14, y, refHalf);
  labelled(doc, 'Contact', quotation.assignedTo?.name, refX, y + 26, refHalf);
  labelled(
    doc,
    'Currency',
    quotation.isExport ? `${CURRENCY} (export)` : CURRENCY,
    refX + refHalf + 14,
    y + 26,
    refHalf
  );

  return Math.max(y + 25 + doc.heightOfString(address || '—', { width: column, lineGap: 1.5 }), y + 52) + 16;
}

/**
 * The item table.
 *
 * One line today, because a quotation covers one model [§10]. The table is built as a table
 * regardless — the columns, the ruled band, the item number — so a multi-line quote is a loop
 * over rows rather than a rewrite of the layout.
 */
function items(doc, quotation, y) {
  const columns = [
    { key: 'item', label: 'Item', x: LEFT, width: 30, align: 'left' },
    { key: 'material', label: 'Material', x: LEFT + 32, width: 96, align: 'left' },
    { key: 'description', label: 'Description', x: LEFT + 132, width: 150, align: 'left' },
    { key: 'quantity', label: 'Quantity', x: LEFT + 286, width: 62, align: 'right' },
    { key: 'unit', label: 'Un', x: LEFT + 352, width: 22, align: 'left' },
    { key: 'rate', label: 'Unit price', x: LEFT + 376, width: 62, align: 'right' },
    { key: 'value', label: 'Net value', x: LEFT + 442, width: WIDTH - 442 + LEFT - LEFT, align: 'right' },
  ];
  // The last column runs to the right margin whatever the page width is.
  columns[columns.length - 1].width = RIGHT - columns[columns.length - 1].x;

  doc.save().fillColor(BAND).rect(LEFT, y, WIDTH, 16).fill().restore();
  doc.font('Helvetica-Bold').fontSize(LABEL).fillColor(INK);
  for (const column of columns) {
    doc.text(column.label.toUpperCase(), column.x + (column.align === 'right' ? 0 : 3), y + 5, {
      width: column.width - 3,
      align: column.align,
      characterSpacing: 0.6,
    });
  }
  y += 16;

  const description = [
    quotation.product?.name,
    quotation.product?.sizeMm ? `${quotation.product.sizeMm} mm` : null,
    // Material codes are codes: `pp` in the master is PP on a document a buyer files.
    quotation.product?.material?.toUpperCase(),
  ]
    .filter(Boolean)
    .join(' · ');

  const rows = [
    {
      item: '10',
      material: quotation.modelNumber || quotation.product?.modelCode || '—',
      description: description || 'As per enquiry',
      quantity: qty(quotation.quantity),
      unit: 'PC',
      rate: money(quotation.unitPrice),
      value: money(quotation.lineValue),
    },
  ];

  doc.font('Helvetica').fontSize(BODY).fillColor(INK);
  for (const row of rows) {
    const height = Math.max(
      ...columns.map((column) =>
        doc.heightOfString(String(row[column.key] ?? ''), { width: column.width - 3 })
      ),
      12
    );
    for (const column of columns) {
      doc.text(String(row[column.key] ?? ''), column.x + (column.align === 'right' ? 0 : 3), y + 6, {
        width: column.width - 3,
        align: column.align,
      });
    }
    y += height + 12;
    rule(doc, y);
  }

  /* MOQ, where it belongs on the document: a term of the offer, next to the price. */
  if (quotation.moq) {
    doc
      .font('Helvetica-Oblique')
      .fontSize(7.5)
      .fillColor(MUTED)
      .text(
        `Minimum order quantity for this price: ${qty(quotation.moq)} pieces.`,
        LEFT + 32,
        y + 5,
        { width: WIDTH - 32 }
      );
    y += 16;
  }

  return y + 6;
}

/** Net, tax, and what the buyer actually owes — stepped into the right-hand column. */
function totals(doc, quotation, y) {
  const boxWidth = 236;
  const x = RIGHT - boxWidth;
  const labelWidth = boxWidth - 96;

  const line = (label, value, { bold = false, gap = 15 } = {}) => {
    doc
      .font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(bold ? 10 : BODY)
      .fillColor(bold ? INK : MUTED)
      .text(label, x, y, { width: labelWidth });
    doc
      .font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .fillColor(INK)
      .text(value, x + labelWidth, y, { width: 96, align: 'right' });
    y += gap;
  };

  line('Net value', amount(quotation.lineValue));

  /*
   * Export is not GST at zero — it is a different basis [§10]. Printing "GST 0.00" on an
   * export quote invites the buyer to wonder whether the rate was forgotten, and invites our
   * own accounts to book it as a domestic sale.
   */
  if (quotation.isExport) {
    line('GST', 'Export — not applicable');
  } else if (quotation.gstPercent) {
    const tax = quotation.totalValue - quotation.lineValue;
    line(`GST @ ${quotation.gstPercent}%`, amount(tax));
  } else {
    line('GST', 'Extra as applicable');
  }

  y += 2;
  doc.save().lineWidth(RULE).strokeColor(INK).moveTo(x, y).lineTo(RIGHT, y).stroke().restore();
  y += 6;
  line('Total', amount(quotation.totalValue), { bold: true, gap: 18 });

  return y;
}

/** The commercial terms — the half of a quotation that is not the number. */
function terms(doc, quotation, y) {
  const pairs = [
    ['Payment terms', quotation.paymentTerms],
    ['Delivery', quotation.deliveryTerms],
    ['Freight', FREIGHT_LABELS[quotation.freightTerms] || quotation.freightTerms],
    ['Packing', quotation.packing],
  ].filter(([, value]) => value);

  if (pairs.length) {
    const column = (WIDTH - 18) / 2;
    let row = y;
    pairs.forEach(([label, value], index) => {
      const x = index % 2 === 0 ? LEFT : LEFT + column + 18;
      labelled(doc, label, value, x, row, column);
      if (index % 2 === 1) row += 30;
    });
    y = row + (pairs.length % 2 === 1 ? 30 : 0) + 8;
  }

  if (quotation.remarks) {
    labelled(doc, 'Remarks', quotation.remarks, LEFT, y, WIDTH);
    y += 14 + doc.heightOfString(quotation.remarks, { width: WIDTH });
  }

  rule(doc, y);
  y += 10;

  doc
    .font('Helvetica')
    .fontSize(LABEL)
    .fillColor(MUTED)
    .text('TERMS AND CONDITIONS', LEFT, y, { characterSpacing: 0.6 });
  y += 10;

  doc.font('Helvetica').fontSize(7.5).fillColor(INK);
  company.standardTerms.forEach((term, index) => {
    doc.text(`${index + 1}.`, LEFT, y, { width: 14 });
    doc.text(term, LEFT + 14, y, { width: WIDTH - 14, lineGap: 1 });
    y += doc.heightOfString(term, { width: WIDTH - 14, lineGap: 1 }) + 3;
  });

  return y + 10;
}

/**
 * What has already been offered [§10].
 *
 * Printed only from Rev 1, and only ever on our own copy of the story: the buyer knows what
 * they were quoted before, and a document that reminds them of a higher price they already
 * refused is not a document that helps close.
 */
function revisionNote(doc, quotation, y) {
  if (!quotation.revision) return y;
  doc
    .font('Helvetica-Oblique')
    .fontSize(7.5)
    .fillColor(MUTED)
    .text(
      `This is revision ${quotation.revision} of ${quotation.number} and supersedes all earlier revisions.`,
      LEFT,
      y,
      { width: WIDTH }
    );
  return y + 14;
}

/** Signature block, then the page furniture. */
function signature(doc, y) {
  const boxWidth = 200;
  const x = RIGHT - boxWidth;
  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(`For ${company.name}`, x, y, { width: boxWidth });
  doc
    .save()
    .lineWidth(RULE)
    .strokeColor(HAIRLINE)
    .moveTo(x, y + 44)
    .lineTo(RIGHT, y + 44)
    .stroke()
    .restore();
  doc.fontSize(7.5).fillColor(MUTED).text('Authorised signatory', x, y + 48, { width: boxWidth });
  return y + 64;
}

/** Page x of y, added after the fact because y is not known until the last page exists. */
function paginate(doc) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);
    const y = 841.89 - PAGE.margin + 6;
    doc.save().lineWidth(RULE).strokeColor(HAIRLINE).moveTo(LEFT, y - 8).lineTo(RIGHT, y - 8).stroke().restore();
    doc.font('Helvetica').fontSize(7).fillColor(MUTED);
    doc.text(`${company.name}  ·  ${company.website}`, LEFT, y, { width: WIDTH / 2, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, LEFT + WIDTH / 2, y, {
      width: WIDTH / 2,
      align: 'right',
      lineBreak: false,
    });
  }
}

/**
 * Renders the quotation and resolves to the finished PDF.
 *
 * A buffer rather than a stream piped at the response: it is a one-page document, and holding
 * it lets the route set `Content-Length` and fail cleanly — a stream that throws half way has
 * already sent a 200 and a broken file.
 */
export function renderQuotationPdf(quotation) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ ...PAGE, bufferPages: true, info: {
      Title: `Quotation ${quotation.number}`,
      Author: company.name,
      Subject: `Quotation for ${quotation.customer?.name || 'customer'}`,
    } });

    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      let y = header(doc, quotation);
      y = parties(doc, quotation, y);
      y = items(doc, quotation, y);
      y = totals(doc, quotation, y);
      y = revisionNote(doc, quotation, y + 4);
      y = terms(doc, quotation, y);
      signature(doc, y);
      paginate(doc);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

export { FREIGHT_LABELS, FREIGHT_TERMS };
