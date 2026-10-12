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
 * The papers an enquiry has, to attach when its marketing person writes to the buyer on WhatsApp
 * or email [controllers/enquiryMessage.controller.js].
 *
 *   made by the app      the quotation (once Admin has passed its price), the enquiry's details,
 *                        each sample's details — drawn fresh each time, so they are never stale
 *   uploaded by a team   the sales order (the SO team, on its task), the invoice and dispatch
 *                        details (Dispatch), the LR copy and dispatch details (Reception)
 *
 * Every paper is checked against the enquiry before it goes: an id from another enquiry is not on
 * this one's list, so it cannot be sent from here.
 */

export const DOCUMENT_TYPES = ['enquiry', 'quotation', 'sample', 'sales_order', 'invoice', 'dispatch_details', 'lr_copy'];

export const DOCUMENT_LABELS = {
  enquiry: 'Enquiry details',
  quotation: 'Quotation',
  sample: 'Sample details',
  sales_order: 'Sales order',
  invoice: 'Invoice',
  dispatch_details: 'Dispatch details',
  lr_copy: 'LR copy',
};

/* A price still in costing, or waiting on Admin, is not one to send. */
const SENDABLE_QUOTES = ['approved', 'sent', 'revised', 'accepted'];

/* A task's own result file, by the task it finishes: the SO team's sales order, Reception's LR. */
const RESULT_TYPE = { order_confirmation: 'sales_order', lr_copy: 'lr_copy' };

const enquiryOf = (enquiry) => enquiry?._id || enquiry;

/** Everything attachable on this enquiry, newest first within each kind. */
export async function documentsFor(enquiry) {
  const id = enquiryOf(enquiry);
  const number = enquiry.number || (await Enquiry.findById(id).select('number').lean())?.number;
  const [quotes, samples, tasks] = await Promise.all([
    Quotation.find({ enquiry: id, status: { $in: SENDABLE_QUOTES } }).select('number revision status updatedAt').sort({ updatedAt: -1 }).lean(),
    Sample.find({ enquiry: id }).select('number status requestedAt').sort({ requestedAt: -1 }).lean(),
    Todo.find({ enquiry: id, kind: { $exists: true } }).select('_id kind resultFile').lean(),
  ]);
  const kindOf = new Map(tasks.map((task) => [String(task._id), task.kind]));
  const results = new Set(tasks.map((task) => String(task.resultFile || '')).filter(Boolean));
  const files = tasks.length
    ? await Attachment.find({ task: { $in: tasks.map((task) => task._id) } }).select('filename mimeType task docType createdAt').sort({ createdAt: -1 }).lean()
    : [];

  const uploaded = files.map((file) => {
    /* A typed paper (invoice, dispatch details), or the file that finished its task (SO, LR). A
       briefing PDF marketing attached when raising a task is neither, and is not offered. */
    const type = file.docType || (results.has(String(file._id)) ? RESULT_TYPE[kindOf.get(String(file.task))] : null);
    if (!type || !DOCUMENT_LABELS[type]) return null;
    return { type, id: String(file._id), label: DOCUMENT_LABELS[type], filename: file.filename || `${type}.pdf`, at: file.createdAt, uploaded: true };
  }).filter(Boolean);

  return [
    { type: 'enquiry', id: String(id), label: DOCUMENT_LABELS.enquiry, filename: `${fileSafeNumber(number || 'enquiry')}.pdf` },
    ...quotes.map((quote) => ({
      type: 'quotation', id: String(quote._id), label: `${DOCUMENT_LABELS.quotation} ${quote.number}${quote.revision ? ` rev ${quote.revision}` : ''}`,
      filename: `${fileSafeNumber(quote.number)}.pdf`, at: quote.updatedAt,
    })),
    ...samples.map((sample) => ({
      type: 'sample', id: String(sample._id), label: `${DOCUMENT_LABELS.sample} ${sample.number}`,
      filename: `${fileSafeNumber(sample.number)}.pdf`, at: sample.requestedAt,
    })),
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
  if (!DOCUMENT_TYPES.includes(type)) return null;
  const enquiry = await Enquiry.findById(enquiryId).select('number').catch(() => null);
  if (!enquiry) return null;
  return documentFile(enquiry, { type, id: docId }).catch(() => null);
}
