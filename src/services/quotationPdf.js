import PDFDocument from 'pdfkit';
import company from '../config/company.js';
import { FREIGHT_TERMS } from '../models/Quotation.js';

/**
 * The price quote as this plant has always sent it [BLUEPRINT §10].
 *
 * Laid out to match the sheet the office has been filling in by hand: a ruled form with a
 * `PRICE QUOTE` banner, the sender on the left, a grid of document facts on the right, and a
 * table of models with a **photograph of each part** beside its rate.
 *
 * It replaces an SAP-style print-out that was a perfectly good quotation and the wrong document.
 * Two reasons, and the second is the one that matters:
 *
 *   **The buyers already know this form.** Every quote they have had from here looks like this,
 *   and a purchase department that has to re-learn where the rate lives is a purchase department
 *   that rings up to ask.
 *
 *   **A hanger is bought by its shape.** The old layout had a material code and a description,
 *   which is how you quote a bearing. Six near-identical codes with no picture is how a buyer
 *   orders NCP-27 and means NCP-30 — and the plant's own sheet has carried the photographs for
 *   years precisely because of it.
 *
 * The picture is why this file takes a second argument. pdfkit embeds an image from a buffer, so
 * the bytes have to be in hand before any of it is drawn; the caller loads them and passes a map
 * keyed by attachment key. A photo that is missing, unreadable, or in a format pdfkit cannot
 * embed leaves an empty cell — a quotation still prints, which is the right failure for a
 * document somebody is waiting to send.
 *
 * Generated per request rather than stored. A quotation's price changes with every revision
 * [§10] and a stored PDF is a copy that stops agreeing with the record it came from — the
 * document is a *view* of the quotation, and the quotation is the truth.
 */

/* The page grid, in points. A4 is 595.28 × 841.89. */
const PAGE = { size: 'A4', margin: 36 };
const LEFT = PAGE.margin;
const RIGHT = 595.28 - PAGE.margin;
const WIDTH = RIGHT - LEFT;
const PAGE_HEIGHT = 841.89;
const BOTTOM = PAGE_HEIGHT - PAGE.margin;

/**
 * The palette, taken from the sheet rather than invented.
 *
 * The labels are blue and the banner is a pale lavender because that is what the office prints;
 * it is not decoration to be improved. The rules are near-black hairlines — a form is read by
 * its boxes, and grey rules on a photocopy disappear.
 */
const INK = '#000000';
const LABEL_BLUE = '#1F6FC0';
const BANNER = '#D9D2E9';
const RULE_COLOUR = '#000000';
const RULE = 0.75;

/** Type scale. A form prints small: the captions well under the values they caption. */
const CAPTION = 7;
const BODY = 9;
const TITLE = 15;

/* The table's columns, as fractions of the width — see `columns()`. */
const COLUMN_WEIGHTS = {
  sl: 0.075,
  model: 0.245,
  spec: 0.235,
  image: 0.155,
  hsn: 0.125,
  rate: 0.165,
};

/** One row of the item table. Tall enough for a photograph to be worth printing. */
const ROW_HEIGHT = 46;

/** The left edge of each column and its width, resolved once. */
function columns() {
  const out = {};
  let x = LEFT;
  for (const [key, weight] of Object.entries(COLUMN_WEIGHTS)) {
    const width = WIDTH * weight;
    out[key] = { x, width };
    x += width;
  }
  /* The last column absorbs the rounding, or the right edge misses the border by a hair and
     the form looks as though it did not print straight. */
  out.rate.width = RIGHT - out.rate.x;
  return out;
}

const COL = columns();

const money = (value) =>
  value === undefined || value === null ? '' : Number(value).toFixed(2);

const asDate = (value) => {
  if (!value) return '';
  const date = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  /* dd/mm/yyyy — the form's own convention, and the one the office writes by hand. */
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
};

const FREIGHT_LABELS = {
  ex_factory: 'EX-Factory',
  fob: 'FOB',
  cif: 'CIF',
  door_delivery: 'Door delivery',
};

/* ------------------------------ Drawing helpers ------------------------------ */

/** A rectangle's outline, on the hairline grid the whole form is built from. */
function box(doc, x, y, width, height) {
  doc.lineWidth(RULE).strokeColor(RULE_COLOUR).rect(x, y, width, height).stroke();
}

/** A filled rectangle with an outline — the banner and the table's head. */
function filled(doc, x, y, width, height, colour) {
  doc.rect(x, y, width, height).fillColor(colour).fill();
  box(doc, x, y, width, height);
}

/**
 * A small blue caption inside a cell, in the top-left corner where the form puts them.
 *
 * Drawn separately from the value rather than as one string, because the caption is the
 * printed part of the form and the value is what somebody filled in — they are different
 * sizes, different colours, and on a blank quotation only one of them is there.
 */
function caption(doc, text, x, y, width) {
  doc.font('Helvetica-Bold').fontSize(CAPTION).fillColor(LABEL_BLUE);
  doc.text(text, x + 3, y + 2.5, { width: width - 6, lineBreak: false });
}

/** A value inside a cell, under its caption. */
function value(doc, text, x, y, width, { bold = true, size = BODY, align = 'left' } = {}) {
  if (!text) return;
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(INK);
  doc.text(String(text), x + 4, y, { width: width - 8, align, lineBreak: false });
}

/* --------------------------------- The head --------------------------------- */

/** The banner. One line, centred, in the blue the form has always used. */
function banner(doc, y) {
  const height = 22;
  filled(doc, LEFT, y, WIDTH, height, BANNER);
  doc.font('Helvetica-Bold').fontSize(TITLE).fillColor(LABEL_BLUE);
  doc.text('PRICE QUOTE', LEFT, y + 4.5, { width: WIDTH, align: 'center' });
  return y + height;
}

/**
 * Who it is from, who it is to, and the facts about the document.
 *
 * The left half is the sender and then the buyer; the right half is a stack of labelled boxes.
 * They are drawn as one block with a shared height so the outer rules meet — a form whose two
 * halves end at different heights reads as broken before anybody has read a word of it.
 */
function parties(doc, quotation, y) {
  const half = WIDTH * 0.52;
  const rightX = LEFT + half;
  const rightWidth = WIDTH - half;

  const customer = quotation.customer || {};
  const address = [customer.address, [customer.city, customer.state].filter(Boolean).join(', ')]
    .filter(Boolean);

  /* ---- right: the document's own facts, two columns then full-width rows ---- */
  /*
   * The right-hand boxes, top to bottom. Their total is also the left half's height — the two
   * columns have to end level or the outer border does not close, which is the first thing the
   * eye catches on a ruled form.
   */
  const rows = [26, 26, 26, 26, 18];
  const rightHeight = rows.reduce((sum, height) => sum + height, 0);

  let ry = y;
  const splitWidth = rightWidth / 2;

  /* Quote number and date. */
  box(doc, rightX, ry, splitWidth, rows[0]);
  box(doc, rightX + splitWidth, ry, splitWidth, rows[0]);
  caption(doc, 'Quote No.', rightX, ry, splitWidth);
  caption(doc, 'Dated', rightX + splitWidth, ry, splitWidth);
  value(doc, quotation.number, rightX, ry + 11, splitWidth);
  value(doc, asDate(quotation.quotedOn || quotation.createdAt), rightX + splitWidth, ry + 11, splitWidth);
  ry += rows[0];

  /* Payment terms, full width. */
  box(doc, rightX, ry, rightWidth, rows[1]);
  caption(doc, 'Mode/Terms of Payment', rightX, ry, rightWidth);
  value(doc, quotation.paymentTerms, rightX, ry + 10, rightWidth, { bold: false, size: 8 });
  ry += rows[1];

  /* The buyer's own reference, and how the goods are priced to travel. */
  box(doc, rightX, ry, splitWidth, rows[2]);
  box(doc, rightX + splitWidth, ry, splitWidth, rows[2]);
  caption(doc, "Buyer's Ref./Order No.", rightX, ry, splitWidth);
  value(doc, quotation.enquiry?.number, rightX, ry + 11, splitWidth, { bold: false, size: 8 });
  value(doc, FREIGHT_LABELS[quotation.freightTerms] || '', rightX + splitWidth, ry + 8, splitWidth, {
    bold: false,
  });
  ry += rows[2];

  /* Despatch and destination. Despatch is not a fact a quotation knows — the box is printed
     on the form and left for whoever fills it in, which is what the plant does today. */
  box(doc, rightX, ry, splitWidth, rows[3]);
  box(doc, rightX + splitWidth, ry, splitWidth, rows[3]);
  caption(doc, 'Despatch through', rightX, ry, splitWidth);
  caption(doc, 'Destination', rightX + splitWidth, ry, splitWidth);
  value(doc, customer.city, rightX + splitWidth, ry + 11, splitWidth, { bold: false, size: 8 });
  ry += rows[3];

  /* Delivery terms. */
  box(doc, rightX, ry, rightWidth, rows[4]);
  caption(
    doc,
    `Terms of Delivery${quotation.deliveryTerms ? ` — ${quotation.deliveryTerms}` : '-Ex-factory'}`,
    rightX,
    ry,
    rightWidth
  );

  /*
   * ---- left: the sender, then the buyer, sharing the right half's height ----
   *
   * The split is chosen for the *content*, not to line up with a box on the right. The sender
   * is a name and four lines of address; sized to the row above it, the last line ran straight
   * through the "Quote to" caption underneath. Nothing requires the two halves to agree
   * internally — only that they end together.
   */
  const senderHeight = 64;
  box(doc, LEFT, y, half, senderHeight);

  doc.font('Helvetica-Bold').fontSize(10).fillColor(LABEL_BLUE);
  doc.text(company.name.toUpperCase(), LEFT + 6, y + 5, { width: half - 12, lineBreak: false });

  doc.font('Helvetica').fontSize(7.5).fillColor(INK);
  const senderLines = [
    ...company.addressLines,
    [company.phone && `Ph: ${company.phone}`, company.email].filter(Boolean).join('  /  '),
  ].filter(Boolean);
  doc.text(senderLines.join('\n'), LEFT + 6, y + 18, { width: half - 12, lineGap: 1.5 });

  /* The buyer. `M/s` is printed on the form, so it is drawn as part of the form. */
  const toY = y + senderHeight;
  const toHeight = rightHeight - senderHeight;
  box(doc, LEFT, toY, half, toHeight);
  caption(doc, 'Quote to', LEFT, toY, half);

  doc.font('Helvetica-Bold').fontSize(BODY).fillColor(INK);
  doc.text('M/s', LEFT + 6, toY + 12, { width: 26, lineBreak: false });
  doc.text(customer.name || '', LEFT + 40, toY + 12, { width: half - 48, lineBreak: false });

  if (address.length) {
    doc.font('Helvetica').fontSize(7.5).fillColor(INK);
    doc.text(address.join('\n'), LEFT + 40, toY + 24, { width: half - 48, lineGap: 1.5 });
  }

  /* The buyer's GST number, at the foot of their block where the form prints it. */
  doc.font('Helvetica-Bold').fontSize(CAPTION).fillColor(INK);
  doc.text(
    `GSTIN/UIN:${customer.gstin ? ` ${customer.gstin}` : ''}`,
    LEFT + 6,
    toY + toHeight - 11,
    { width: half - 12, lineBreak: false }
  );

  return y + rightHeight;
}

/* -------------------------------- The table -------------------------------- */

/**
 * The table's two-row head.
 *
 * `Description of Goods` spans the three columns that describe the piece, because that is what
 * the form says and because it is true: a model name, what it is made of, and a picture of it
 * are three halves of one description. `HSN/SAC` and `Rate` span both rows — they are single
 * facts, and stacking a blank cell above them would invite somebody to write in it.
 */
function tableHead(doc, y) {
  const top = 16;
  const lower = 15;
  const height = top + lower;

  const descX = COL.model.x;
  const descWidth = COL.model.width + COL.spec.width + COL.image.width;

  filled(doc, LEFT, y, WIDTH, height, BANNER);

  /* The vertical rules. Sl, description block, HSN and Rate run the full height; the three
     description columns are divided only on the lower row. */
  doc.lineWidth(RULE).strokeColor(RULE_COLOUR);
  for (const x of [COL.model.x, COL.hsn.x, COL.rate.x]) {
    doc.moveTo(x, y).lineTo(x, y + height).stroke();
  }
  doc.moveTo(LEFT, y + top).lineTo(descX + descWidth, y + top).stroke();
  for (const x of [COL.spec.x, COL.image.x]) {
    doc.moveTo(x, y + top).lineTo(x, y + height).stroke();
  }

  const head = (text, x, width, cy) => {
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(LABEL_BLUE);
    doc.text(text, x + 2, cy, { width: width - 4, align: 'center', lineBreak: false });
  };

  head('Sl', COL.sl.x, COL.sl.width, y + 4.5);
  head('No.', COL.sl.x, COL.sl.width, y + top + 4);
  head('Description of Goods', descX, descWidth, y + 4.5);
  head('MODEL NAME', COL.model.x, COL.model.width, y + top + 4);
  head('MATERIAL & COLOUR', COL.spec.x, COL.spec.width, y + top + 4);
  head('IMAGE', COL.image.x, COL.image.width, y + top + 4);
  head('HSN/SAC', COL.hsn.x, COL.hsn.width, y + 11);
  head('Rate/ Nos', COL.rate.x, COL.rate.width, y + 11);

  return y + height;
}

/** The vertical rules down one row, drawn for every row including the empty ones. */
function rowRules(doc, y, height) {
  doc.lineWidth(RULE).strokeColor(RULE_COLOUR);
  for (const key of ['model', 'spec', 'image', 'hsn', 'rate']) {
    doc.moveTo(COL[key].x, y).lineTo(COL[key].x, y + height).stroke();
  }
  doc.moveTo(LEFT, y).lineTo(LEFT, y + height).stroke();
  doc.moveTo(RIGHT, y).lineTo(RIGHT, y + height).stroke();
}

/**
 * One model: its number, what it is made of, its picture and its rate.
 *
 * The photograph is fitted rather than filled. A hanger is a thin outline on a plain ground, and
 * cropping one to fill a cell cuts the hook off — which is the half a buyer recognises.
 */
function itemRow(doc, line, index, y, photos, resins) {
  const height = ROW_HEIGHT;
  rowRules(doc, y, height);
  doc.moveTo(LEFT, y + height).lineTo(RIGHT, y + height).stroke();

  const middle = y + height / 2 - 5;

  value(doc, String(index + 1), COL.sl.x, middle, COL.sl.width, { align: 'center' });
  value(doc, line.modelNumber || line.mould?.mouldCode || '', COL.model.x, middle, COL.model.width);

  /* "HIPS NATURAL : WHITE" — the resin and the shade the rate is offered in.

     The resin is the one the model was *costed* in, which is the one the price was built on.
     It used to be the mould's own resin, so a tool set up for PP printed "PP" on every quote
     raised off it — including one costed and priced in HIPS, which is a quote promising the
     cheaper material at the dearer material's price. The tool's resin is the fallback only for
     a line typed by hand, with no costing behind it. */
  const resin = (resins.get(String(line._id)) || line.mould?.material || '').replace(/_/g, ' ').toUpperCase();
  const shade = (line.colour || '').toUpperCase();
  const spec = [resin, shade].filter(Boolean).join(' : ');
  value(doc, spec, COL.spec.x, middle, COL.spec.width, { align: 'center' });

  value(doc, company.hsnCode, COL.hsn.x, middle, COL.hsn.width, { align: 'center' });
  value(doc, money(line.unitPrice), COL.rate.x, middle, COL.rate.width, { align: 'center' });

  const photo = line.mould?.photo?.key ? photos.get(line.mould.photo.key) : null;
  if (photo) {
    const pad = 3;
    try {
      doc.image(photo, COL.image.x + pad, y + pad, {
        fit: [COL.image.width - pad * 2, height - pad * 2],
        align: 'center',
        valign: 'center',
      });
    } catch {
      /* A file that is not a JPEG or a PNG — pdfkit embeds no other format. The cell stays
         empty rather than taking the document down: a quote with a missing picture is worth
         sending, and a quote that will not render is not. */
    }
  }

  return y + height;
}

/**
 * The table: the models, then the empty ruled space the form always carries, then the tax note.
 *
 * The blank rows are not padding. The sheet is a form, and a form whose table stops halfway
 * down the page with an open bottom edge looks truncated — as though a second page went
 * missing. Ruling it to the foot is what makes the document look complete.
 */
function table(doc, quotation, y, photos, resins) {
  let cursor = tableHead(doc, y);

  const lines = quotation.lines || [];
  const noteHeight = 26;

  for (const [index, line] of lines.entries()) {
    /* A row that will not fit whole starts a page of its own, with the head repeated — half a
       photograph across a page break is worse than a shorter first page. */
    if (cursor + ROW_HEIGHT + noteHeight > BOTTOM - 60) {
      doc.addPage();
      cursor = tableHead(doc, PAGE.margin);
    }
    cursor = itemRow(doc, line, index, cursor, photos, resins);
  }

  /* The blank remainder, ruled the same way. */
  const blankTo = BOTTOM - 60 - noteHeight;
  if (blankTo > cursor) {
    rowRules(doc, cursor, blankTo - cursor);
    doc.moveTo(LEFT, blankTo).lineTo(RIGHT, blankTo).stroke();
    cursor = blankTo;
  }

  /* The tax note, centred under the description columns where the form prints it. */
  const descX = COL.model.x;
  const descWidth = COL.model.width + COL.spec.width + COL.image.width;
  rowRules(doc, cursor, noteHeight);
  doc.moveTo(LEFT, cursor + noteHeight).lineTo(RIGHT, cursor + noteHeight).stroke();
  doc.rect(descX, cursor, descWidth, noteHeight).fillColor(BANNER).fill();
  box(doc, descX, cursor, descWidth, noteHeight);
  doc.font('Helvetica-BoldOblique').fontSize(11).fillColor(LABEL_BLUE);
  doc.text(company.gstNote, descX, cursor + 7, { width: descWidth, align: 'center' });

  return cursor + noteHeight;
}

/* -------------------------------- The foot -------------------------------- */

/**
 * Remarks on the left, the signature on the right.
 *
 * `E. & O.E` is printed on the form — errors and omissions excepted — and it belongs above the
 * signature rather than buried in a paragraph of terms, because it qualifies what is being
 * signed.
 */
function foot(doc, quotation, y) {
  const labelHeight = 14;
  const bodyHeight = 46;
  const split = LEFT + WIDTH * 0.63;
  const rightWidth = RIGHT - split;

  box(doc, LEFT, y, split - LEFT, labelHeight);
  box(doc, split, y, rightWidth, labelHeight);
  caption(doc, 'Remarks:', LEFT, y, split - LEFT);
  caption(doc, 'E. & O.E', split, y, rightWidth);

  const bodyY = y + labelHeight;
  /* The cream box the office writes in. Drawn even when there is nothing to say, because it is
     part of the form rather than a container that appears when it has contents. */
  doc.rect(LEFT, bodyY, split - LEFT, bodyHeight).fillColor('#FDF6E3').fill();
  box(doc, LEFT, bodyY, split - LEFT, bodyHeight);
  box(doc, split, bodyY, rightWidth, bodyHeight);

  const remarks = [quotation.remarks, quotation.packing && `Packing: ${quotation.packing}`]
    .filter(Boolean)
    .join('\n');
  if (remarks) {
    doc.font('Helvetica').fontSize(8).fillColor(INK);
    doc.text(remarks, LEFT + 5, bodyY + 5, { width: split - LEFT - 10, lineGap: 1.5 });
  }

  doc.font('Helvetica-BoldOblique').fontSize(8).fillColor(LABEL_BLUE);
  doc.text('Authorized Signature', split, bodyY + 4, { width: rightWidth, align: 'center' });

  /* Who to ask about it. A quotation signed by nobody is one the buyer rings the switchboard
     about; the person who priced it is the person who can answer. */
  if (quotation.assignedTo?.name) {
    doc.font('Helvetica').fontSize(7).fillColor(INK);
    doc.text(`For ${company.name} — ${quotation.assignedTo.name}`, split, bodyY + bodyHeight - 12, {
      width: rightWidth,
      align: 'center',
    });
  }

  return bodyY + bodyHeight;
}

/* ------------------------------- The document ------------------------------- */

/**
 * Renders the quotation and resolves to the finished PDF.
 *
 * A buffer rather than a stream piped at the response: it is a short document, and holding it
 * lets the route set `Content-Length` and fail cleanly — a stream that throws half way has
 * already sent a 200 and a broken file.
 *
 * `photos` is a Map of attachment key to image bytes, loaded by the caller. See the note at the
 * top of the file for why the images cannot be fetched from in here.
 */
/**
 * `resins` maps a line's id to the material its costing was built in — see `costedResins` in the
 * quotation controller. Absent for a line with no costing, which prints the tool's own resin.
 */
export function renderQuotationPdf(quotation, photos = new Map(), resins = new Map()) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      ...PAGE,
      bufferPages: true,
      info: {
        Title: `Price quote ${quotation.number}`,
        Author: company.name,
        Subject: `Price quote for ${quotation.customer?.name || 'customer'}`,
      },
    });

    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      let y = banner(doc, PAGE.margin);
      y = parties(doc, quotation, y);
      y = table(doc, quotation, y, photos, resins);
      foot(doc, quotation, y);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

export { FREIGHT_LABELS, FREIGHT_TERMS };
