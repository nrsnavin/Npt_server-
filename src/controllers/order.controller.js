import SalesOrder, {
  CLOSED_ORDER_STATUSES,
  ORDER_STATUSES,
  PRE_RELEASE_STATUSES,
  VERIFICATION_CHECKS,
  VERIFICATION_KEYS,
} from '../models/SalesOrder.js';
import Quotation from '../models/Quotation.js';
import Customer from '../models/Customer.js';
import Attachment from '../models/Attachment.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { nextNumber } from '../services/numbering.service.js';
import { listParams, paginated } from '../utils/query.js';
import { expectVersion, withoutVersion } from '../utils/concurrency.js';
import { recordChange, snapshot } from '../services/audit.service.js';
import { narrowToOwner, ownershipFilter, ownsRecord } from '../services/ownership.service.js';
import { allOrdersVisibleTo, orderVisibleTo } from '../services/pricingVisibility.js';
import { buildBoard, perColumnFrom } from '../services/board.service.js';
import { ORDER_ACTIONS, orderActionsFrom } from '../services/orderActions.js';
import { assertAssignable } from '../services/assignment.service.js';
import { put, remove } from '../services/storage.service.js';
import { sendCsv } from '../utils/csv.js';

/**
 * Sales orders [BLUEPRINT §12–13], and the release gate in front of production.
 *
 * An order is a customer relationship that has turned into a commitment, so it is
 * ownership-scoped like the enquiry and quotation behind it [§29]: a marketing person sees
 * their own. Production and despatch see everything, because they are not competing for the
 * same customers — that rule lives in `ownership.service.js` and needs nothing added here.
 *
 * Two things do the work in this file.
 *
 * **Nothing reaches production without the eight checks.** §13 lists them, the model holds them
 * with a name and a time against each, and `release` is the only door into
 * `approved_for_production`. The refusal names what is outstanding rather than saying "not
 * verified", because the second tells somebody nothing they did not already know.
 *
 * **The order is built from the quotation, not retyped.** Every line, price, mould and model
 * number comes across from the accepted quote. Retyping is how an order comes to be for a
 * different quantity than the one that was priced, and neither document says which is wrong.
 */

const POPULATE = [
  { path: 'customer', select: 'code name city state gstin mobile email' },
  { path: 'quotation', select: 'number status revision' },
  { path: 'enquiry', select: 'number status' },
  { path: 'assignedTo', select: 'name' },
  { path: 'lines.mould', select: 'mouldCode name category sizeMm hookType material packingQty' },
  { path: 'customerPo.attachment', select: 'key filename mimeType size' },
];

const EXPORT_LIMIT = 5000;

/* ------------------------------- Reading them ------------------------------- */

/**
 * What the orders list understands, in one function.
 *
 * Shared by the list, the board and the export for the reason every other module shares it:
 * three copies of a filter block start agreeing and stop without anybody noticing, and the
 * promise of a download is that the file is what was on the screen.
 *
 * `withStatus: false` is the board's escape hatch — the columns *are* the status filter, so a
 * board that also carried one would draw one column and call it a pipeline.
 */
async function orderFilters(req, { withStatus = true } = {}) {
  const { page, limit, sort, filter } = listParams(req.query, {
    /* Model numbers live on the lines, so searching for one has to look inside them. */
    searchFields: ['number', 'customerPo.number', 'lines.modelNumber'],
    defaultSort: '-orderDate',
  });

  const scope = ownershipFilter(req.user);
  Object.assign(filter, scope);

  const owner = narrowToOwner(scope, req.query.assignedTo);
  if (owner !== undefined) filter.assignedTo = owner;

  if (withStatus && req.query.status) {
    filter.status = { $in: String(req.query.status).split(',') };
  }
  if (withStatus && req.query.open === 'true') {
    filter.status = { $nin: CLOSED_ORDER_STATUSES };
  }
  if (req.query.customer) filter.customer = req.query.customer;
  if (req.query.quotation) filter.quotation = req.query.quotation;
  if (req.query.enquiry) filter.enquiry = req.query.enquiry;
  if (req.query.mould) filter['lines.mould'] = req.query.mould;

  /**
   * The queue the gate creates: released, or still waiting on a check.
   *
   * Expressed as a status filter rather than as a query on the eight fields, because "not yet
   * released" is a fact about where the order is and the checks are how it gets there. A
   * filter on the checks would also match a cancelled order that happened to be half-ticked.
   */
  if (req.query.awaitingRelease === 'true') filter.status = { $in: PRE_RELEASE_STATUSES };

  return { page, limit, sort, filter, scope };
}

export const listOrders = asyncHandler(async (req, res) => {
  const { page, limit, sort, filter, scope } = await orderFilters(req);

  const [data, total, stages] = await Promise.all([
    SalesOrder.find(filter).populate(POPULATE).sort(sort).skip((page - 1) * limit).limit(limit),
    SalesOrder.countDocuments(filter),
    /*
     * Value per stage, summed over the lines inside the pipeline. The same shape the quotation
     * board uses, and for the same reason: an order's value is the sum of its lines, and there
     * is no document-level price to multiply.
     */
    SalesOrder.aggregate([
      { $match: scope },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          value: {
            $sum: {
              $reduce: {
                input: { $ifNull: ['$lines', []] },
                initialValue: 0,
                in: {
                  $add: [
                    '$$value',
                    {
                      $multiply: [
                        { $ifNull: ['$$this.unitPrice', 0] },
                        { $ifNull: ['$$this.quantity', 0] },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },
    ]),
  ]);

  paginated(res, allOrdersVisibleTo(data, req.user), { page, limit, total }, { stages });
});

/** The §12 ladder as columns you can work in, rather than a strip of counts you can only read. */
export const orderBoard = asyncHandler(async (req, res) => {
  const { sort } = await orderFilters(req);

  const columns = await buildBoard({
    Model: SalesOrder,
    filter: (await orderFilters(req, { withStatus: false })).filter,
    statuses: ORDER_STATUSES,
    sort,
    perColumn: perColumnFrom(req.query),
    select:
      'number customer quotation assignedTo status orderDate customerPo lines verification ' +
      'statusHistory.from statusHistory.to statusHistory.at createdAt',
    populate: [
      { path: 'customer', select: 'code name' },
      { path: 'assignedTo', select: 'name' },
    ],
  });

  /*
   * Redacted per card, not per query. A board is the one screen where a price would be read
   * off in passing rather than looked up, and the cards go through the same allow-list as
   * everything else.
   */
  for (const column of columns) {
    column.cards = allOrdersVisibleTo(column.cards, req.user);
  }

  res.json({ success: true, data: { columns }, meta: { sort } });
});

export const getOrder = asyncHandler(async (req, res) => {
  const order = await SalesOrder.findById(req.params.id)
    .populate(POPULATE)
    .populate('releasedBy', 'name')
    .populate('verification.poReceived.by', 'name')
    .populate('statusHistory.by', 'name');

  if (!order) throw ApiError.notFound('Order not found');
  if (!ownsRecord(req.user, order)) throw ApiError.notFound('Order not found');

  res.json({
    success: true,
    data: orderVisibleTo(order, req.user),
    /*
     * The checklist as the screen should draw it: every check, whether it is ticked, and what
     * it means. Sent from here rather than duplicated in the web app, so §13's list has one
     * definition and adding a ninth check needs no second edit.
     */
    checks: VERIFICATION_CHECKS.map((check) => ({
      ...check,
      done: Boolean(order.verification?.[check.key]?.by),
      at: order.verification?.[check.key]?.at,
      note: order.verification?.[check.key]?.note,
    })),
  });
});

export const exportOrders = asyncHandler(async (req, res) => {
  const { sort, filter } = await orderFilters(req);
  const rows = await SalesOrder.find(filter).populate(POPULATE).sort(sort).limit(EXPORT_LIMIT);

  /*
   * One row per line, not per order. A file with one row per order would have to fold several
   * models into a cell, and the first thing anybody does with this download is a pivot by
   * model — which that shape makes impossible.
   *
   * The two money columns come off for a reader who may not see them, the same as they do on
   * the screen. A redaction the Export button walks around is not a redaction.
   */
  const money = allOrdersVisibleTo([rows[0]].filter(Boolean), req.user)[0]?.valueHidden !== true;

  const flat = rows.flatMap((order) =>
    (order.lines || []).map((line, index) => ({ order, line, index }))
  );

  sendCsv(res, 'sales-orders', flat, [
    ['Order', (row) => row.order.number],
    ['Order date', (row) => row.order.orderDate],
    ['Customer', (row) => row.order.customer?.name],
    ['PO number', (row) => row.order.customerPo?.number],
    ['Status', (row) => row.order.status],
    ['Line', (row) => row.index + 1],
    ['Model', (row) => row.line.modelNumber || row.line.mould?.mouldCode],
    ['Mould', (row) => row.line.mould?.mouldCode],
    ['Colour', (row) => row.line.colour],
    ['Ordered', (row) => row.line.quantity],
    ...(money ? [['Rate', (row) => row.line.unitPrice]] : []),
    ...(money ? [['Line value', (row) => row.line.lineValue]] : []),
    ['Delivery date', (row) => row.line.deliveryDate],
    ['Production status', (row) => row.line.production?.status],
    ['Ready', (row) => row.line.production?.readyQty],
    ['Owner', (row) => row.order.assignedTo?.name],
  ]);
});

/* ------------------------------- Writing them ------------------------------- */

/** What a line carries when it is written by hand rather than taken off a quotation. */
const lineFrom = (line) => ({
  mould: line.mould || undefined,
  modelNumber: line.modelNumber,
  category: line.category,
  material: line.material,
  colour: line.colour,
  printing: line.printing,
  packing: line.packing,
  quantity: line.quantity,
  unitPrice: line.unitPrice,
  deliveryDate: line.deliveryDate,
  pricing: line.pricing || undefined,
  remarks: line.remarks,
});

/**
 * Raising an order.
 *
 * Two doors, and this is the general one — a repeat job, a tender, an order placed against a
 * quote that was never recorded. The quotation door below is the ordinary one and should be
 * used wherever a quote exists, because it retypes nothing.
 */
export const createOrder = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.body.customer);
  if (!customer) throw ApiError.badRequest('That customer does not exist');

  if (req.body.assignedTo) await assertAssignable(req.body.assignedTo);

  const order = await SalesOrder.create({
    ...req.body,
    lines: (req.body.lines || []).map(lineFrom),
    number: await nextNumber('SO'),
    assignedTo: req.body.assignedTo || req.user._id,
    statusHistory: [{ to: 'po_received', by: req.user._id }],
  });

  await order.populate(POPULATE);
  res.status(201).json({ success: true, data: orderVisibleTo(order, req.user) });
});

/**
 * The ordinary door: an accepted quotation becomes an order.
 *
 * **Nothing is retyped.** The lines come across whole — mould, model number, colour, printing,
 * packing, rate and the costing behind it — because retyping is how an order comes to be for a
 * different quantity or a different rate than the one that was quoted, with neither document
 * saying which of them is wrong.
 *
 * The quantity is the one figure that has to be supplied, and that is not an oversight: a
 * quotation now quotes a *rate against a minimum* and carries no quantity at all [§10], so the
 * purchase order is the first document in the whole chain that says how many. Lines are matched
 * by their quotation line id, so a PO that takes six of the eight models quoted is expressed by
 * naming six ids rather than by editing a copy of the quote.
 */
export const orderFromQuotation = asyncHandler(async (req, res) => {
  const quotation = await Quotation.findById(req.params.id).populate('lines.mould', '_id');
  if (!quotation) throw ApiError.notFound('Quotation not found');
  if (!ownsRecord(req.user, quotation)) throw ApiError.notFound('Quotation not found');

  if (quotation.status !== 'accepted') {
    throw ApiError.badRequest(
      `This quotation is ${quotation.status.replace(/_/g, ' ')} — mark it accepted before raising the order`
    );
  }

  const existing = await SalesOrder.findOne({
    quotation: quotation._id,
    status: { $nin: ['cancelled'] },
  });
  if (existing) {
    throw ApiError.conflict(`${existing.number} was already raised from this quotation`, {
      order: { id: existing._id, number: existing.number, status: existing.status },
    });
  }

  /*
   * The quantities, keyed by the quotation line they belong to. A line the PO does not mention
   * is simply not ordered — that is the six-of-eight case, and it needs no separate flag.
   */
  const wanted = new Map(
    (req.body.lines || []).map((line) => [String(line.quotationLine), line])
  );
  if (!wanted.size) throw ApiError.badRequest('Say which models the PO covers, and how many of each');

  const unknown = [...wanted.keys()].filter(
    (id) => !(quotation.lines || []).some((line) => String(line._id) === id)
  );
  if (unknown.length) {
    throw ApiError.badRequest(`Those lines are not on this quotation: ${unknown.join(', ')}`);
  }

  const lines = (quotation.lines || [])
    .filter((line) => wanted.has(String(line._id)))
    .map((line) => {
      const asked = wanted.get(String(line._id));
      return {
        mould: line.mould?._id || line.mould || undefined,
        modelNumber: line.modelNumber,
        colour: asked.colour,
        printing: asked.printing,
        packing: asked.packing || quotation.packing,
        quantity: asked.quantity,
        /* The rate that was offered, unless the buyer negotiated one on the PO itself. */
        unitPrice: asked.unitPrice ?? line.unitPrice,
        deliveryDate: asked.deliveryDate,
        pricing: line.pricing || undefined,
      };
    });

  const order = await SalesOrder.create({
    number: await nextNumber('SO'),
    customer: quotation.customer,
    quotation: quotation._id,
    enquiry: quotation.enquiry,
    /* The quote's owner keeps the customer — an order does not change whose relationship it is. */
    assignedTo: quotation.assignedTo,
    customerPo: req.body.customerPo,
    lines,
    gstPercent: req.body.gstPercent ?? quotation.gstPercent,
    isExport: req.body.isExport ?? quotation.isExport,
    paymentTerms: req.body.paymentTerms || quotation.paymentTerms,
    deliveryTerms: req.body.deliveryTerms || quotation.deliveryTerms,
    freightTerms: req.body.freightTerms || quotation.freightTerms,
    remarks: req.body.remarks,
    statusHistory: [{ to: 'po_received', by: req.user._id, note: `From ${quotation.number}` }],
  });

  await order.populate(POPULATE);
  res.status(201).json({ success: true, data: orderVisibleTo(order, req.user) });
});

/**
 * Correcting an order.
 *
 * The lines are editable only before release. Afterwards the plant is running against them and
 * a quantity changed underneath a job in progress is a quantity nobody agreed to — the ready
 * count would suddenly be short against a number that moved, and nothing on the record would
 * say it had. Terms and remarks stay editable throughout, because those are paperwork.
 */
export const updateOrder = asyncHandler(async (req, res) => {
  const order = await SalesOrder.findById(req.params.id);
  if (!order) throw ApiError.notFound('Order not found');
  if (!ownsRecord(req.user, order)) throw ApiError.notFound('Order not found');

  expectVersion(order, req.body);
  const before = snapshot(order);
  const patch = withoutVersion(req.body);

  if (patch.lines && !PRE_RELEASE_STATUSES.includes(order.status)) {
    throw ApiError.badRequest(
      'This order is already with production — its lines cannot be changed. Raise a clarification instead'
    );
  }
  if (patch.lines) patch.lines = patch.lines.map(lineFrom);
  if (patch.assignedTo) await assertAssignable(patch.assignedTo);

  Object.assign(order, patch);
  await order.save();
  await recordChange({ model: 'SalesOrder', doc: order, before, by: req.user });

  await order.populate(POPULATE);
  res.json({ success: true, data: orderVisibleTo(order, req.user) });
});

/* ------------------------------ The §13 gate ------------------------------ */

/**
 * Ticking, or un-ticking, one of the eight checks.
 *
 * Un-ticking is deliberately allowed and deliberately recorded. A check ticked in error is
 * ordinary, and the alternative — a tick that can never be taken back — means the only way to
 * correct one is through the database, which leaves no trail at all. What it cannot do is
 * happen after release: the checks describe a decision taken before the plant started, and
 * editing them afterwards rewrites the record of why the job was allowed to run.
 */
export const setOrderCheck = asyncHandler(async (req, res) => {
  const order = await SalesOrder.findById(req.params.id);
  if (!order) throw ApiError.notFound('Order not found');
  if (!ownsRecord(req.user, order)) throw ApiError.notFound('Order not found');

  const { check, done = true, note } = req.body;
  if (!VERIFICATION_KEYS.includes(check)) {
    throw ApiError.badRequest(`${check} is not one of the §13 checks`);
  }
  if (!PRE_RELEASE_STATUSES.includes(order.status)) {
    throw ApiError.badRequest(
      'This order has already been released — its verification is a record of what was checked then'
    );
  }

  const before = snapshot(order);
  const label = VERIFICATION_CHECKS.find((entry) => entry.key === check).label;

  if (done) {
    order.verification[check] = { by: req.user._id, at: new Date(), note };
  } else {
    order.verification[check] = undefined;
  }

  /*
   * Ticking the first check starts verification, so nobody has to remember to press a button
   * before pressing the one they meant. The status is the summary of what is happening, and
   * "PO received" stops being true the moment somebody starts checking it.
   */
  if (order.status === 'po_received' && order.outstandingChecks.length < VERIFICATION_KEYS.length) {
    order.statusHistory.push({ from: order.status, to: 'order_verification', by: req.user._id });
    order.status = 'order_verification';
  }

  await order.save();
  await recordChange({
    model: 'SalesOrder',
    doc: order,
    before,
    by: req.user,
    note: done ? `Checked: ${label}` : `Un-checked: ${label}`,
  });

  await order.populate(POPULATE);
  res.json({
    success: true,
    data: orderVisibleTo(order, req.user),
    outstanding: order.outstandingChecks,
    releasable: order.releasable,
  });
});

/* -------------------------------- Actions -------------------------------- */

/** What §13 still wants, in words a person can act on. */
const missingChecks = (order) =>
  order.outstandingChecks
    .map((key) => VERIFICATION_CHECKS.find((check) => check.key === key).label.toLowerCase())
    .join(', ');

export const applyOrderAction = asyncHandler(async (req, res) => {
  const order = await SalesOrder.findById(req.params.id);
  if (!order) throw ApiError.notFound('Order not found');
  if (!ownsRecord(req.user, order)) throw ApiError.notFound('Order not found');

  const { action, note, ...rest } = req.body;
  const recipe = ORDER_ACTIONS[action];
  if (!recipe) throw ApiError.badRequest('That is not something you can do to an order');

  if (!orderActionsFrom(order.status).includes(action)) {
    throw ApiError.badRequest(
      CLOSED_ORDER_STATUSES.includes(order.status)
        ? `This order is ${order.status} — nothing further can be done to it`
        : `“${recipe.label}” does not apply to an order at ${order.status.replace(/_/g, ' ')}`
    );
  }

  /*
   * The gate [§13]. Named checks, not a count: "still needs the printing approval and a
   * confirmed delivery date" is something a person can go and do, and "8 checks required" is
   * not.
   */
  if (recipe.gate === 'verified' && !order.isVerified) {
    throw ApiError.badRequest(
      `This order still needs ${missingChecks(order)} before it can go to production`
    );
  }

  for (const field of recipe.needs) {
    if (!rest[field]) throw ApiError.badRequest(`“${recipe.label}” needs ${field}`);
  }

  const before = snapshot(order);

  Object.assign(order, rest);
  order.statusHistory.push({ from: order.status, to: recipe.to, by: req.user._id, note });
  order.status = recipe.to;

  if (action === 'release') {
    order.releasedBy = req.user._id;
    order.releasedAt = new Date();
    /*
     * Every line joins the plant's queue at once. The alternative — releasing lines
     * individually — is a real requirement one day and not this one: §13 gates *the order*,
     * and a half-released order would need a status the ladder does not have.
     */
    for (const line of order.lines) {
      if (!line.production) line.production = {};
      line.production.status = 'awaiting_planning';
    }
  }

  await order.save();
  await recordChange({ model: 'SalesOrder', doc: order, before, by: req.user, note: recipe.label });

  await order.populate(POPULATE);
  res.json({ success: true, data: orderVisibleTo(order, req.user), did: recipe.label });
});

/** The actions this order can take from where it is, so the screen need not guess. */
export const listOrderActions = asyncHandler(async (req, res) => {
  const order = await SalesOrder.findById(req.params.id);
  if (!order) throw ApiError.notFound('Order not found');
  if (!ownsRecord(req.user, order)) throw ApiError.notFound('Order not found');

  res.json({
    success: true,
    data: orderActionsFrom(order.status).map((key) => ({
      action: key,
      ...ORDER_ACTIONS[key],
      /*
       * A gated action is listed, not hidden, with the reason it cannot be taken yet. Hiding
       * "Release to production" until the last box is ticked hides the thing the person is
       * working towards; showing it disabled tells them how far they have got.
       */
      blockedBy:
        ORDER_ACTIONS[key].gate === 'verified' && !order.isVerified
          ? `Still needs ${missingChecks(order)}`
          : null,
    })),
  });
});

/* ------------------------------- The PO scan ------------------------------- */

/**
 * The customer's purchase order, as a file.
 *
 * §13's first check is that the PO has been *received*, and a tick against a document nobody
 * can open is a tick against a phone call. Uploading it here is what makes that check mean
 * something, so this door and that one are deliberately close together.
 */
export const setOrderPo = asyncHandler(async (req, res) => {
  const order = await SalesOrder.findById(req.params.id);
  if (!order) throw ApiError.notFound('Order not found');
  if (!ownsRecord(req.user, order)) throw ApiError.notFound('Order not found');
  if (!req.file) throw ApiError.badRequest('Attach the purchase order');

  const previous = order.customerPo?.attachment;

  const key = await put({ buffer: req.file.buffer, mimeType: req.file.mimetype });
  let attachment;
  try {
    attachment = await Attachment.create({
      key,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      uploadedBy: req.user._id,
      salesOrder: order._id,
      title: `${order.number} — customer PO`,
    });
  } catch (error) {
    /* The row failed, so the bytes are unreferenced: take them back out rather than leak them. */
    await remove(key);
    throw error;
  }

  order.customerPo = { ...(order.customerPo || {}), attachment: attachment._id };
  await order.save();

  /* Only now, with the new scan saved on the record, is the old one safe to delete. */
  if (previous) {
    const old = await Attachment.findById(previous);
    if (old) {
      await remove(old.key).catch(() => {});
      await old.deleteOne();
    }
  }

  await order.populate(POPULATE);
  res.json({ success: true, data: orderVisibleTo(order, req.user) });
});
