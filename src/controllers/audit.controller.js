import Customer from '../models/Customer.js';
import Lead from '../models/Lead.js';
import Enquiry from '../models/Enquiry.js';
import Sample from '../models/Sample.js';
import SalesOrder from '../models/SalesOrder.js';
import Receivable from '../models/Receivable.js';
import Dispatch from '../models/Dispatch.js';
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
  /*
   * Whose order it is, is whose customer it is [§29] — the same rule the enquiry behind it
   * runs on, so reading who ticked which check is gated the same way as reading the order.
   */
  SalesOrder: { model: SalesOrder, module: 'orders', ownership: 'assignedTo' },
  /*
   * Money owed [§20]. The receipts and the judgements are the two things on a receivable that
   * somebody may later have to answer for — "who marked this disputed", "who recorded a
   * payment nobody can find" — and the controller has been writing that trail since the module
   * was built. It was simply unreadable: absent from this list, the history panel on the
   * payment screen answered 404 while the log filled up behind it.
   *
   * Owned the same way the chase list is scoped, so reading who did what to a receivable is
   * gated exactly as reading the receivable is.
   */
  Receivable: { model: Receivable, module: 'payments', ownership: 'assignedTo' },
  /*
   * A consignment [§18–19], and the same story as the receivable above: the controller has
   * written this trail on every paperwork save and every action since the module was built, and
   * nothing could read a line of it — `/history/Dispatch/:id` answered "No history is kept for
   * that" while the log filled up behind it.
   *
   * It is the record with the most to answer for. Three of despatch's gates warn rather than
   * refuse, and each is only defensible because somebody can be asked afterwards: who sent this
   * past a quality warning, who closed it with no proof of delivery, who sent it with no
   * delivery address. The reason and the name are on the consignment, which answers "why" —
   * this answers the harder questions beside it: when the invoice number changed and who
   * changed it, whether the LR was edited after the lorry left.
   *
   * Owned on the consignment's own `assignedTo`, copied from the order it came from, so reading
   * who did what to a consignment is gated exactly as reading the consignment is.
   */
  Dispatch: { model: Dispatch, module: 'dispatch', ownership: 'assignedTo' },
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
