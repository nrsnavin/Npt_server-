import Customer from '../models/Customer.js';
import Lead from '../models/Lead.js';
import Enquiry from '../models/Enquiry.js';
import Sample from '../models/Sample.js';
import Mould from '../models/Mould.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { ownsRecord } from '../services/ownership.service.js';
import { canRead } from '../services/access.service.js';
import { historyFor } from '../services/audit.service.js';

/**
 * One record's change history.
 *
 * Gated on the record rather than on the log: reading the history of something is reading
 * something. Anyone who cannot open the customer cannot read who edited it either — a log
 * that answers questions about records you are not allowed to see is a way around the
 * permission system with an innocent name.
 */
const SOURCES = {
  Customer: { model: Customer, module: 'customers', ownership: 'assignedTo' },
  Lead: { model: Lead, module: 'enquiries', ownership: 'assignedTo' },
  Enquiry: { model: Enquiry, module: 'enquiries', ownership: 'assignedTo' },
  Sample: { model: Sample, module: 'samples', ownership: 'requestedBy' },
  // The register is shared, so there is no owner to check — only the grant.
  Mould: { model: Mould, module: 'moulds', ownership: null },
  // A person's own trail — who took their book when they left. Administration's business,
  // so it hangs off the users grant rather than off an owner.
  User: { model: User, module: 'users', ownership: null },
};

export const recordHistory = asyncHandler(async (req, res) => {
  const source = SOURCES[req.params.model];
  if (!source) throw ApiError.notFound('No history is kept for that');

  if (!canRead(req.user, source.module)) {
    throw ApiError.forbidden(`You do not have access to ${source.module}`);
  }

  const record = await source.model.findById(req.params.id);
  if (!record) throw ApiError.notFound('Record not found');
  if (source.ownership && !ownsRecord(req.user, record, source.ownership)) {
    throw ApiError.notFound('Record not found');
  }

  const data = await historyFor(req.params.model, record._id);
  res.json({ success: true, data });
});
