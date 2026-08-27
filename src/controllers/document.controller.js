import Attachment from '../models/Attachment.js';
import Customer from '../models/Customer.js';
import Enquiry from '../models/Enquiry.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { ownsRecord } from '../services/ownership.service.js';
import { put, remove } from '../services/storage.service.js';
import { recordChange } from '../services/audit.service.js';

/**
 * Documents on the records that have them [BLUEPRINT §27].
 *
 * The blueprint asks for attachments on every relevant record — the customer's drawing, the
 * print artwork, the sample approval, the PO, the invoice, the LR. Only samples had them, so
 * everything else lived in somebody's email, which is the filing cabinet this replaces.
 *
 * Customers and enquiries are the two that exist now; orders and dispatch add themselves to
 * `OWNERS` when they land, and nothing else here changes.
 *
 * Access is the record's, never the file's. A drawing is exactly as confidential as the
 * customer it belongs to, so every route resolves the owning record first and checks the
 * caller against that — which is also why the attachment names its owner as a real reference
 * rather than a `{ type, id }` pair: the check needs to know which model to ask.
 */
const OWNERS = {
  customers: { model: Customer, field: 'customer', module: 'customers', ownership: 'assignedTo', label: 'Customer' },
  enquiries: { model: Enquiry, field: 'enquiry', module: 'enquiries', ownership: 'assignedTo', label: 'Enquiry' },
};

/** Resolves the record a document hangs off, and refuses anyone who may not open it. */
async function reachableRecord(req) {
  const owner = OWNERS[req.params.collection];
  if (!owner) throw ApiError.notFound('Nothing of that kind carries documents');

  const record = await owner.model.findById(req.params.id);
  if (!record) throw ApiError.notFound('Record not found');
  if (!ownsRecord(req.user, record, owner.ownership)) throw ApiError.notFound('Record not found');

  return { owner, record };
}

export const listDocuments = asyncHandler(async (req, res) => {
  const { owner, record } = await reachableRecord(req);

  const data = await Attachment.find({ [owner.field]: record._id })
    .populate('uploadedBy', 'name')
    .sort('-createdAt');

  res.json({ success: true, data });
});

export const addDocument = asyncHandler(async (req, res) => {
  const { owner, record } = await reachableRecord(req);
  if (!req.file) throw ApiError.badRequest('Attach a file');

  const key = await put({ buffer: req.file.buffer, mimeType: req.file.mimetype });

  let attachment;
  try {
    attachment = await Attachment.create({
      key,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      title: req.body.title?.trim() || undefined,
      uploadedBy: req.user._id,
      [owner.field]: record._id,
    });
  } catch (error) {
    // A file with no row pointing at it is a file nobody can reach or delete.
    await remove(key);
    throw error;
  }

  await recordChange({
    model: owner.label,
    doc: record,
    by: req.user,
    action: 'updated',
    note: `Attached ${attachment.title || attachment.filename}`,
  });

  res.status(201).json({ success: true, data: await attachment.populate('uploadedBy', 'name') });
});

export const removeDocument = asyncHandler(async (req, res) => {
  const { owner, record } = await reachableRecord(req);

  const attachment = await Attachment.findOne({
    _id: req.params.documentId,
    [owner.field]: record._id,
  });
  if (!attachment) throw ApiError.notFound('Document not found');

  /*
   * Only whoever put it there, or an administrator. A document is somebody's evidence, and
   * the person who attached it is the one who knows whether it is still the right version.
   */
  if (String(attachment.uploadedBy) !== String(req.user._id) && req.user.role !== 'admin') {
    throw ApiError.forbidden('Only whoever attached this, or an administrator, can remove it');
  }

  await remove(attachment.key);
  await attachment.deleteOne();

  await recordChange({
    model: owner.label,
    doc: record,
    by: req.user,
    action: 'updated',
    note: `Removed ${attachment.title || attachment.filename}`,
  });

  res.json({ success: true, data: { id: attachment._id } });
});
