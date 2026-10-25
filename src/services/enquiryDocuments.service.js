import Attachment from '../models/Attachment.js';
import Enquiry from '../models/Enquiry.js';
import Quotation from '../models/Quotation.js';
import Sample from '../models/Sample.js';
import Todo from '../models/Todo.js';
import ApiError from '../utils/ApiError.js';
import { bufferOf } from './storage.service.js';
import { renderEnquiryPdf, renderSamplePdf } from './recordPdf.js';
import { signatureValid, signedPath } from '../utils/signedLink.js';
import { fileSafeNumber } from './numbering.service.js';

/**
 * Every paper an enquiry has — the Documents section on the enquiry [web: EnquiryDocuments], and
 * what its marketing person attaches when writing to the buyer on WhatsApp or email
 * [controllers/enquiryMessage.controller.js]:
 *
 *   Enquiry            its details (drawn by the app), and files attached to it
 *   Samples            each sample's details with how it went (courier and AWB, or handed to whom),
 *                      the buyer's reference photos, the finished-piece photos, the courier copy
 *   Quotation          each quotation once Admin has passed its price
 *   Sales order & PO   the SO the SO team uploaded, the buyer's PO, files on the order
 *   Dispatch & LR      the invoice, dispatch details, each load's LR copy, proof of delivery or
 *                      signed receipt, Reception's LR copy
 *   Sent to the teams  the reference files marketing attached when raising a task — to Sampling,
 *                      Quotation, the SO team or the plant
 *
 * Made by the app are drawn fresh each time, so they are never stale. Every paper is checked
 * against the enquiry before it goes: an id from another enquiry is not on this one's list, so
 * it cannot be sent from here. A file reached two ways is listed once.
 */

export const DOCUMENT_TYPES = [
  'enquiry', 'quotation', 'sample', 'sales_order', 'purchase_order', 'invoice', 'dispatch_details', 'lr_copy',
  'proof_of_delivery', 'collection_receipt', 'courier_copy', 'handover_photo', 'sample_photo', 'reference_photo', 'reference', 'file',
];

export const DOCUMENT_LABELS = {
  enquiry: 'Enquiry details',
  quotation: 'Quotation',
  sample: 'Sample details',
  sales_order: 'Sales order',
  purchase_order: 'Buyer’s PO',
  invoice: 'Invoice',
  dispatch_details: 'Dispatch details',
  lr_copy: 'LR copy',
  proof_of_delivery: 'Proof of delivery',
  collection_receipt: 'Signed receipt',
  courier_copy: 'Courier copy',
  handover_photo: 'Hand-over photo',
  sample_photo: 'Sample photo',
  reference_photo: 'Buyer’s reference photo',
  reference: 'Reference',
  file: 'File',
};

/* The section each paper is read under, in this order. */
export const DOCUMENT_GROUPS = ['Enquiry', 'Samples', 'Quotation', 'Sales order & PO', 'Dispatch & LR', 'Sent to the teams', 'Other papers'];

/* A price still in costing, or waiting on Admin, is not one to send. */
const SENDABLE_QUOTES = ['approved', 'sent', 'revised', 'accepted'];

/* A task's own result file, by the task it finishes: the SO team's sales order, Reception's LR. */
const RESULT_TYPE = { order_confirmation: 'sales_order', lr_copy: 'lr_copy', po_so: 'sales_order' };

/* Where a task's papers are read, by its kind. */
const GROUP_OF_KIND = {
  sample_request: 'Samples', sample_collect: 'Samples',
  create_quotation: 'Quotation', price_negotiation: 'Quotation',
  po_so: 'Sales order & PO', order_confirmation: 'Sales order & PO',
  invoice_dispatch: 'Dispatch & LR', lr_copy: 'Dispatch & LR',
};
const DISPATCH_PAPERS = ['invoice', 'dispatch_details', 'lr_copy', 'proof_of_delivery', 'collection_receipt'];
const SAMPLE_PAPERS = ['courier_copy', 'handover_photo'];

const TEAM_WORDS = {
  sampling: 'Sampling', quotation: 'Quotation', costing: 'Quotation', order_confirmation: 'the SO team', production: 'Production',
  printing: 'Printing', assembling: 'Assembly', despatch: 'Dispatch', reception: 'Reception', quality: 'Quality', accounts: 'Accounts',
};

const enquiryOf = (enquiry) => enquiry?._id || enquiry;
const idOf = (value) => String(value?._id || value || '');

/** Everything on this enquiry, newest first within each section. */
export async function documentsFor(enquiry) {
  const id = enquiryOf(enquiry);
  const number = enquiry.number || (await Enquiry.findById(id).select('number').lean())?.number;
  const { default: SalesOrder } = await import('../models/SalesOrder.js');
  const [quotes, samples, tasks, orders] = await Promise.all([
    Quotation.find({ enquiry: id, status: { $in: SENDABLE_QUOTES } }).select('number revision status updatedAt').sort({ updatedAt: -1 }).lean(),
    Sample.find({ enquiry: id }).select('number status requestedAt deliveryMethod courier awbNumber handedTo dispatchedAt referencePhoto items.modelNumber items.photo items.referencePhoto').sort({ requestedAt: -1 }).lean(),
    Todo.find({ enquiry: id, kind: { $exists: true } }).select('_id kind department title resultFile createdAt').lean(),
    SalesOrder.find({ enquiry: id }).select('number soDocument customerPo createdAt').sort({ createdAt: -1 }).lean(),
  ]);
  const taskOf = new Map(tasks.map((task) => [String(task._id), task]));
  const results = new Set(tasks.map((task) => idOf(task.resultFile)).filter(Boolean));
  /* The photos a sample names on its rows: the buyer's reference, the finished piece. */
  const photoOf = new Map();
  for (const sample of samples) {
    if (sample.referencePhoto) photoOf.set(idOf(sample.referencePhoto), { type: 'reference_photo', sample });
    for (const item of sample.items || []) {
      if (item.referencePhoto) photoOf.set(idOf(item.referencePhoto), { type: 'reference_photo', sample, model: item.modelNumber });
      if (item.photo) photoOf.set(idOf(item.photo), { type: 'sample_photo', sample, model: item.modelNumber });
    }
  }
  const orderPaper = new Map();
  for (const order of orders) {
    if (order.soDocument) orderPaper.set(idOf(order.soDocument), { type: 'sales_order', order });
    if (order.customerPo?.attachment) orderPaper.set(idOf(order.customerPo.attachment), { type: 'purchase_order', order });
  }
  const files = await Attachment.find({
    $or: [
      { enquiry: id },
      ...(tasks.length ? [{ task: { $in: tasks.map((task) => task._id) } }] : []),
      ...(samples.length ? [{ sample: { $in: samples.map((sample) => sample._id) } }] : []),
      ...(orders.length ? [{ salesOrder: { $in: orders.map((order) => order._id) } }] : []),
      ...(photoOf.size || orderPaper.size ? [{ _id: { $in: [...photoOf.keys(), ...orderPaper.keys()] } }] : []),
    ],
  }).select('filename mimeType size task sample salesOrder enquiry docType title createdAt uploadedBy').populate('uploadedBy', 'name').sort({ createdAt: -1 }).lean();

  const uploaded = files.map((file) => {
    const key = String(file._id);
    const base = { id: key, filename: file.filename || 'document', mimeType: file.mimeType || null, size: file.size || null, at: file.createdAt, by: file.uploadedBy?.name || null, uploaded: true };
    const photo = photoOf.get(key);
    if (photo) {
      return { ...base, type: photo.type, group: 'Samples', label: `${DOCUMENT_LABELS[photo.type]}${photo.model ? ` — ${photo.model}` : ''}`, source: photo.sample.number };
    }
    const paper = orderPaper.get(key);
    if (paper) return { ...base, type: paper.type, group: 'Sales order & PO', label: `${DOCUMENT_LABELS[paper.type]}${paper.type === 'purchase_order' && paper.order.customerPo?.number ? ` ${paper.order.customerPo.number}` : ''}`, source: paper.order.number };
    if (file.task) {
      const task = taskOf.get(idOf(file.task));
      /* A typed paper (invoice, LR copy, courier copy), or the file that finished its task (SO, LR). */
      const type = file.docType && DOCUMENT_LABELS[file.docType] ? file.docType : results.has(key) ? RESULT_TYPE[task?.kind] || RESULT_TYPE[task?.department] || 'file' : null;
      if (type) {
        const group = DISPATCH_PAPERS.includes(type) ? 'Dispatch & LR' : SAMPLE_PAPERS.includes(type) ? 'Samples' : type === 'sales_order' ? 'Sales order & PO' : GROUP_OF_KIND[task?.kind] || 'Other papers';
        return { ...base, type, group, label: file.title || DOCUMENT_LABELS[type], source: task?.title || null };
      }
      /* What marketing attached when raising the task: the reference the team worked from. */
      const team = TEAM_WORDS[task?.department] || 'the team';
      return { ...base, type: 'reference', group: 'Sent to the teams', label: `${file.title || file.filename || 'Reference'} — sent to ${team}`, source: task?.title || null };
    }
    if (file.sample) return { ...base, type: 'file', group: 'Samples', label: file.title || 'Sample file', source: samples.find((sample) => idOf(sample._id) === idOf(file.sample))?.number || null };
    if (file.salesOrder) return { ...base, type: 'file', group: 'Sales order & PO', label: file.title || 'Order file', source: orders.find((order) => idOf(order._id) === idOf(file.salesOrder))?.number || null };
    return { ...base, type: 'file', group: 'Enquiry', label: file.title || file.filename || 'File', source: null };
  });

  const sentWords = (sample) => (sample.deliveryMethod === 'direct'
    ? `handed to ${sample.handedTo || 'the buyer'}`
    : sample.courier || sample.awbNumber ? `${sample.courier || 'courier'}${sample.awbNumber ? ` · AWB ${sample.awbNumber}` : ''}` : null);

  return [
    { type: 'enquiry', id: String(id), group: 'Enquiry', label: DOCUMENT_LABELS.enquiry, filename: `${fileSafeNumber(number || 'enquiry')}.pdf`, mimeType: 'application/pdf' },
    ...quotes.map((quote) => ({
      type: 'quotation', id: String(quote._id), group: 'Quotation', label: `${DOCUMENT_LABELS.quotation} ${quote.number}${quote.revision ? ` rev ${quote.revision}` : ''}`,
      filename: `${fileSafeNumber(quote.number)}.pdf`, mimeType: 'application/pdf', at: quote.updatedAt,
    })),
    ...samples.map((sample) => {
      const sent = sentWords(sample);
      return {
        type: 'sample', id: String(sample._id), group: 'Samples', label: `${DOCUMENT_LABELS.sample} ${sample.number}`,
        filename: `${fileSafeNumber(sample.number)}.pdf`, mimeType: 'application/pdf', at: sample.dispatchedAt || sample.requestedAt,
        /* How it went — the courier and AWB, or who it was handed to. */
        ...(sent ? { source: `Sent ${sent}${sample.dispatchedAt ? ` on ${new Date(sample.dispatchedAt).toISOString().slice(0, 10)}` : ''}` } : {}),
      };
    }),
    ...uploaded,
  ];
}

/** One paper's bytes, after checking it is this enquiry's. */
export async function documentFile(enquiry, { type, id }) {
  const listed = (await documentsFor(enquiry)).find((doc) => doc.type === type && doc.id === String(id));
  if (!listed) throw ApiError.badRequest(`${DOCUMENT_LABELS[type] || 'That document'} is not one of this enquiry's`);

  if (type === 'enquiry') {
    const record = await Enquiry.findById(enquiryOf(enquiry))
      .populate([
        { path: 'customer', select: 'name' },
        { path: 'assignedTo', select: 'name phone' },
        { path: 'items.materialRef items.hookRef items.clipRef items.printRef requirement.materialRef requirement.hookRef requirement.clipRef requirement.printRef', select: 'name', strictPopulate: false },
        { path: 'items.mould requirement.mould', select: 'mouldCode', strictPopulate: false },
      ]);
    return { ...listed, mimeType: 'application/pdf', buffer: await renderEnquiryPdf(record) };
  }
  if (type === 'sample') {
    const sample = await Sample.findById(id).populate([
      { path: 'customer', select: 'name' },
      { path: 'enquiry', select: 'number' },
      { path: 'items.materialRef items.hookRef items.clipRef items.printRef materialRef hookRef clipRef printRef', select: 'name', strictPopulate: false },
      { path: 'items.mould mould', select: 'mouldCode', strictPopulate: false },
    ]);
    return { ...listed, mimeType: 'application/pdf', buffer: await renderSamplePdf(sample) };
  }
  if (type === 'quotation') {
    /* The quotation's own document, the same one the Quotations screen shows. */
    const { quotationPdfFile } = await import('../controllers/quotation.controller.js');
    const made = await quotationPdfFile(id);
    if (!made) throw ApiError.notFound('That quotation is gone');
    return { ...listed, mimeType: 'application/pdf', buffer: made.buffer };
  }
  const file = await Attachment.findById(id);
  const buffer = file && (await bufferOf(file.key));
  if (!buffer) throw ApiError.notFound(`The ${listed.label.toLowerCase()} file is missing from storage`);
  return { ...listed, mimeType: file.mimeType, buffer };
}

/* ------------------------- The public link WhatsApp fetches a paper from ------------------------- */

const LINK_KIND = 'enquiry-doc';
const linkId = (enquiry, doc) => `${enquiryOf(enquiry)}.${doc.type}.${doc.id}`;

/** A signed link to one paper, for WhatsApp, which fetches documents by URL. Lapses in 30 days. */
export const documentUrl = (baseUrl, enquiry, doc) => `${baseUrl}/public/documents${signedPath(LINK_KIND, linkId(enquiry, doc), doc.filename)}`;

/** The paper behind a signed link, or nothing — a bent or lapsed link says only that it expired. */
export async function documentFromLink({ id, expires, signature }) {
  if (!signatureValid(LINK_KIND, id, expires, signature)) return null;
  const [enquiryId, type, docId] = String(id).split('.');
  if (!DOCUMENT_TYPES.includes(type)) return null;  // the listing checks the rest [documentFile]
  const enquiry = await Enquiry.findById(enquiryId).select('number').catch(() => null);
  if (!enquiry) return null;
  return documentFile(enquiry, { type, id: docId }).catch(() => null);
}
