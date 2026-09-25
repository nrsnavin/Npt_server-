import mongoose from 'mongoose';
import Customer from '../models/Customer.js';
import Enquiry from '../models/Enquiry.js';
import Sample from '../models/Sample.js';
import Pricing from '../models/Pricing.js';
import Quotation from '../models/Quotation.js';
import SalesOrder from '../models/SalesOrder.js';
import Dispatch from '../models/Dispatch.js';
import Query, { roomFilter, seesEveryQuery } from '../models/Query.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { ownershipFilter, ownsCustomer, ownsRecord } from '../services/ownership.service.js';
import { canRead } from '../services/access.service.js';

/**
 * One buyer's whole history, newest first — every enquiry, sample, costing, quotation, order,
 * dispatch and question, on one scroll.
 *
 * Each kind is read only if the person may open that module, and questions only where they are
 * in the room, so the timeline never shows more than the separate lists would. Paged by date: the
 * screen asks for what came before the last thing it has, and every source answers the same
 * question, so the merge is exact however the kinds interleave.
 */
const SOURCES = [
  {
    kind: 'enquiry', module: 'enquiries', model: Enquiry, owner: 'assignedTo', select: 'number status requirement.modelNumber createdAt',
    link: (row) => `/enquiries/${row._id}`,
    title: (row) => `Enquiry ${row.number}${row.requirement?.modelNumber ? ` — ${row.requirement.modelNumber}` : ''}`,
  },
  {
    kind: 'sample', module: 'samples', model: Sample, owner: 'requestedBy', select: 'number status modelNumber quantity createdAt',
    link: (row) => `/samples/${row._id}`,
    title: (row) => `Sample ${row.number}${row.modelNumber ? ` — ${row.modelNumber}` : ''}${row.quantity ? ` · ${row.quantity} pcs` : ''}`,
  },
  {
    kind: 'costing', module: 'pricing', model: Pricing, select: 'number lines.modelNumber lines.status createdAt',
    link: (row) => `/pricings/${row._id}`,
    title: (row) => `Costing ${row.number}${row.lines?.length ? ` — ${row.lines.map((line) => line.modelNumber).filter(Boolean).join(', ')}` : ''}`,
    status: (row) => row.lines?.[0]?.status,
  },
  {
    kind: 'quotation', module: 'pricing', model: Quotation, owner: 'assignedTo', select: 'number status createdAt lines.modelNumber',
    link: (row) => `/quotations/${row._id}`,
    title: (row) => `Quotation ${row.number}${row.lines?.length ? ` — ${row.lines.length} model${row.lines.length === 1 ? '' : 's'}` : ''}`,
  },
  {
    kind: 'order', module: 'orders', model: SalesOrder, owner: 'assignedTo', select: 'number status createdAt customerPo.number',
    link: null,
    title: (row) => `Order ${row.number}${row.customerPo?.number ? ` — PO ${row.customerPo.number}` : ''}`,
  },
  {
    kind: 'dispatch', module: 'dispatch', model: Dispatch, owner: 'assignedTo', select: 'number status createdAt',
    link: null,
    title: (row) => `Dispatch ${row.number}`,
  },
];

export const customerTimeline = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Customer not found');
  const customer = await Customer.findById(req.params.id);
  if (!customer || !ownsCustomer(req.user, customer)) throw ApiError.notFound('Customer not found');

  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 50);
  const before = req.query.before ? new Date(req.query.before) : null;
  const when = before && !Number.isNaN(before.getTime()) ? { createdAt: { $lt: before } } : {};
  const base = { customer: customer._id, ...when };

  /*
   * Somebody who reaches this buyer only because a question about them put them in the room sees
   * the questions and nothing else: a query shares the customer record, not the enquiries,
   * samples and prices under it (see `ownership.service.js`). Everybody else sees each kind as its
   * own list would show it — narrowed to what they own where that list is narrowed.
   */
  const throughQueryOnly = !ownsRecord(req.user, customer);
  const sources = throughQueryOnly ? [] : SOURCES.filter((source) => canRead(req.user, source.module));

  const reads = sources.map(async (source) =>
    (await source.model.find({ ...base, ...(source.owner ? ownershipFilter(req.user, source.owner) : {}) }).select(source.select).sort({ createdAt: -1 }).limit(limit).lean()).map((row) => ({
      id: `${source.kind}-${row._id}`,
      kind: source.kind,
      at: row.createdAt,
      title: source.title(row),
      status: source.status ? source.status(row) : row.status,
      link: source.link ? source.link(row) : null,
    }))
  );

  if (canRead(req.user, 'queries')) {
    const scope = seesEveryQuery(req.user) ? {} : roomFilter(req.user);
    reads.push(
      Query.find({ $and: [base, scope] }).select('number subject status createdAt').sort({ createdAt: -1 }).limit(limit).lean()
        .then((rows) => rows.map((row) => ({
          id: `query-${row._id}`, kind: 'query', at: row.createdAt,
          title: `Question ${row.number} — ${row.subject}`, status: row.status, link: `/queries/${row._id}`,
        })))
    );
  }

  const events = (await Promise.all(reads)).flat().sort((a, b) => new Date(b.at) - new Date(a.at));
  const page = events.slice(0, limit);
  res.json({
    success: true,
    data: page,
    next: events.length > limit ? page.at(-1).at : null,
  });
});
