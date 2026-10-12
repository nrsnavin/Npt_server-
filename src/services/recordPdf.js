import PDFDocument from 'pdfkit';
import company from '../config/company.js';

/**
 * The enquiry and the sample as a page the buyer can keep — attached from the enquiry's message
 * panel [services/enquiryDocuments.service.js]. Plain on purpose: the letterhead, what was asked
 * for, and nothing the buyer should not see (no costs, no internal notes, no owner's remarks to
 * the bench).
 */

const MARGIN = 42;
const WIDTH = 595.28 - MARGIN * 2;
const INK = '#111111';
const MUTED = '#555555';
const RULE = '#BBBBBB';

const day = (value) => (value ? new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : null);
const titleCase = (value) => (value ? String(value).replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) : null);

function render(draw) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, info: { Producer: company.name, Creator: company.name } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    draw(doc);
    doc.end();
  });
}

function letterhead(doc, title, reference) {
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(16).text(company.name, MARGIN, MARGIN);
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
  const lines = [company.tagline, ...(company.addressLines || []), [company.phone, company.email].filter(Boolean).join('  ·  '), company.gstin && `GSTIN ${company.gstin}`];
  for (const line of lines.filter(Boolean)) doc.text(line);
  doc.moveDown(0.6);
  doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + WIDTH, doc.y).strokeColor(RULE).lineWidth(0.75).stroke();
  doc.moveDown(0.8);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(13).text(title, MARGIN, doc.y, { continued: Boolean(reference) });
  if (reference) doc.font('Helvetica').fontSize(11).fillColor(MUTED).text(`   ${reference}`);
  doc.moveDown(0.6);
}

/** Label and value rows, two columns; empty values are left out rather than printed as dashes. */
function facts(doc, rows) {
  const labelWidth = 130;
  for (const [label, value] of rows) {
    if (value === undefined || value === null || value === '') continue;
    const y = doc.y;
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(label, MARGIN, y, { width: labelWidth });
    doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(String(value), MARGIN + labelWidth, y, { width: WIDTH - labelWidth });
    doc.moveDown(0.35);
  }
}

function heading(doc, text) {
  doc.moveDown(0.5);
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK).text(text, MARGIN, doc.y);
  doc.moveDown(0.3);
}

/** One model as the buyer described it — the same fields an enquiry and a sample share. */
function itemRows(item) {
  return [
    ['Model', item.modelNumber || item.mould?.mouldCode || 'To be decided'],
    ['Category', titleCase(item.category)],
    ['Size', item.sizeMm ? `${item.sizeMm} mm` : null],
    ['Material', item.materialRef?.name || (item.material ? String(item.material).toUpperCase() : null)],
    ['Colour', item.colour ? `${item.colour}${item.colourMandatory ? ' (exact colour)' : ''}` : null],
    ['Hook', item.hookRef?.name || titleCase(item.hookType)],
    ['Clip', item.clipRef?.name],
    ['Printing', item.printRef?.name || item.printing],
    ['Packing', item.packing],
    ['Quantity', item.quantity ? `${Number(item.quantity).toLocaleString('en-IN')} pcs` : null],
  ];
}

function footer(doc) {
  doc.moveDown(1.2);
  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
    .text(`Prepared by ${company.name} on ${day(new Date())}. ${company.website || ''}`.trim(), MARGIN, doc.y, { width: WIDTH });
}

/** The enquiry as the buyer asked it: every model, the date they need it by and the price they named. */
export function renderEnquiryPdf(enquiry) {
  return render((doc) => {
    letterhead(doc, 'Enquiry details', enquiry.number);
    facts(doc, [
      ['Customer', enquiry.customer?.name],
      ['Enquiry date', day(enquiry.enquiryDate || enquiry.createdAt)],
      ['Required by', day(enquiry.requiredDeliveryDate)],
      ['Target price', enquiry.targetPrice ? `Rs. ${Number(enquiry.targetPrice).toFixed(2)} per piece` : null], /* Helvetica has no ₹ glyph — the quotation prints figures the same way. */
      ['Account manager', [enquiry.assignedTo?.name, enquiry.assignedTo?.phone].filter(Boolean).join(' · ')],
    ]);
    const items = enquiry.items?.length ? enquiry.items : [enquiry.requirement || {}];
    items.forEach((item, index) => {
      heading(doc, items.length > 1 ? `Item ${index + 1}` : 'What was asked for');
      facts(doc, itemRows(item));
    });
    footer(doc);
  });
}

/** The sample: what was made, and how and when it went. */
export function renderSamplePdf(sample) {
  return render((doc) => {
    letterhead(doc, 'Sample details', sample.number);
    facts(doc, [
      ['Customer', sample.customer?.name],
      ['Enquiry', sample.enquiry?.number],
      ['Requested', day(sample.requestedAt)],
      ['Required by', day(sample.requiredDate)],
      ['Status', titleCase(sample.status)],
    ]);
    const items = sample.items?.length ? sample.items : [sample];
    items.forEach((item, index) => {
      heading(doc, items.length > 1 ? `Item ${index + 1}` : 'The sample');
      facts(doc, itemRows(item));
    });
    if (sample.dispatchedAt || sample.courier || sample.handedTo) {
      heading(doc, 'Despatch');
      facts(doc, [
        ['Sent on', day(sample.dispatchedAt)],
        ['How', sample.deliveryMethod === 'direct' ? `Handed over to ${sample.handedTo || 'the buyer'}` : sample.courier],
        ['AWB / docket', sample.awbNumber],
        ['Pieces sent', sample.dispatchedQuantity],
        ['Colour sent', sample.dispatchedColour],
        ['Delivered', day(sample.deliveredAt)],
      ]);
    }
    footer(doc);
  });
}
