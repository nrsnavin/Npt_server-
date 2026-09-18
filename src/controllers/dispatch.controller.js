import { withOrderLock } from '../services/operationLock.service.js';
import Dispatch, {
  ARRIVED_DISPATCH_STATUSES,
  DISPATCH_STATUSES,
  CLOSED_DISPATCH_STATUSES,
  GONE_DISPATCH_STATUSES,
  MIN_OVERRIDE_REASON,
} from '../models/Dispatch.js';
import SalesOrder, { PRE_RELEASE_STATUSES } from '../models/SalesOrder.js';
import Attachment from '../models/Attachment.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { nextNumber } from '../services/numbering.service.js';
import { listParams, paginated, sortRows } from '../utils/query.js';
import { expectVersion, withoutVersion } from '../utils/concurrency.js';
import { recordChange, snapshot } from '../services/audit.service.js';
import { ownershipFilter, ownsRecord } from '../services/ownership.service.js';
import { allDispatchesVisibleTo, dispatchVisibleTo } from '../services/pricingVisibility.js';
import { buildBoard, perColumnFrom } from '../services/board.service.js';
import { DISPATCH_ACTIONS, dispatchActionsFrom } from '../services/dispatchActions.js';
import {
  assertClaimable, claimsFor, stockFor, stockOf,
} from '../services/dispatchStock.service.js';
import {
  ACTIONABLE_BANDS, byDispatchUrgency, dispatchUrgencyOf,
} from '../services/dispatchUrgency.service.js';
import { urgentOrdersFor } from '../services/urgentOrders.service.js';
import OrderQuery from '../models/OrderQuery.js';
import { dispatchQuality } from '../services/quality.service.js';
import { completeDispatchEffects } from '../services/dispatchRecovery.service.js';
import { put, remove } from '../services/storage.service.js';
import { raiseTask } from '../services/task.service.js';
import { sendCsv } from '../utils/csv.js';

/**
 * Dispatch [BLUEPRINT §18–19].
 *
 * The last stage that produces a fact a customer can check, and therefore the one where a
 * disagreement between the system and the plant is most expensive: a buyer told "it went
 * yesterday" against a lorry that has not been loaded is a relationship problem, not a data
 * problem.
 *
 * Two rules carry this file.
 *
 * **Nothing goes on a lorry that is not free.** Every consignment is checked against what
 * production has packed less what other consignments already hold — the arithmetic lives in
 * `dispatchStock.service.js`, and every door into a claim goes through it. §17's part delivery
 * is exactly the case that makes this necessary: 20,000 of 50,000 released while 30,000 stays
 * open is only safe if the 20,000 stop being available the moment they are claimed.
 *
 * **§19's promise is a gate, not a hope.** Marketing is promised the invoice, LR, transporter
 * and date the instant a consignment is dispatched. So the action that dispatches it refuses
 * until those exist — see `dispatchActions.js`.
 */

const POPULATE = [
  /* `address` and `pincode` too, so the consignment page can offer "use the customer's
     address" without a second request for a record it is already showing. */
  { path: 'customer', select: 'code name address city state pincode gstin mobile' },
  { path: 'order', select: 'number status customerPo orderDate' },
  { path: 'assignedTo', select: 'name' },
  { path: 'raisedBy', select: 'name' },
  /* Who gave the customer the date, so the row can say whose promise it is rather than
     presenting it as the system's own. */
  { path: 'promise.by', select: 'name' },
  { path: 'lines.mould', select: 'mouldCode name category sizeMm packingQty' },
  { path: 'pod.attachment', select: 'key filename mimeType size' },
  /*
   * The three names behind an override [§15, §19]. All three fields exist so that "sent past a
   * quality warning", "closed with no proof" and "sent with no delivery address" are answerable
   * by a *person*, and without the populate the screens hold an id, print nothing where the
   * name goes, and the record reads as though the system decided by itself.
   */
  { path: 'qualityOverride.by', select: 'name' },
  { path: 'closedWithoutPod.by', select: 'name' },
  { path: 'addressOverride.by', select: 'name' },
];

const EXPORT_LIMIT = 5000;

/**
 * What the consignment table will order by.
 *
 * `expectedDeliveryDate` is the one that earns its place: the whole §19 conversation is about
 * a date somebody gave a buyer, and a board ranked by it is the board despatch actually works
 * from. `dispatchDate` answers the other half — what has already gone, most recent first.
 *
 * Pieces is a virtual summed over the lines, so it is not here, for the reason written on the
 * orders list: a sort arrow that does nothing is worse than no arrow.
 *
 * Promise and status history are left out on purpose. `promise.date` looks tempting and would
 * rank a board by a field most rows do not carry, burying every consignment nobody has
 * promised anything about — which is most of them, and the ones with room left to promise.
 *
 * `invoice.value` is on the list, and it is the one entry here that deserves an argument,
 * because every other list in the app that carries a figure gates the ordering on who may read
 * the column [§8].
 *
 * It is not gated here because **the gate is already the door**. This list is served only
 * behind `requireModule('dispatch')`, and `seesConsignmentValue` is satisfied by holding a
 * dispatch grant at any level — so every reader who gets far enough to send a `?sort=` has
 * already passed the check a split would apply. Writing one anyway produces a conditional that
 * reads like a security control and can never refuse anything, which is worse than no check at
 * all: the next person to touch this file trusts it.
 *
 * The redaction in `dispatchVisibleTo` is *not* redundant in the same way, and the difference
 * is worth keeping straight — consignments are also reachable through the order tracker at
 * `/orders/:id/dispatches`, which is behind the `orders` grant, so a production reader does
 * arrive at a consignment record without a dispatch grant. That route is not a sortable list.
 */
const DISPATCH_SORTABLE = [
  'number', 'createdAt', 'status', 'dispatchDate', 'expectedDeliveryDate',
  'deliveredAt', 'invoice.number', 'invoice.date', 'invoice.value', 'destination.city',
];

/**
 * What the ready-stock table will order by.
 *
 * Every key here is a column the screen draws, and every one of them is a plain number or a
 * date on a row this process built — so unlike the consignment list above, nothing is off the
 * table for being a virtual. `available` is the one that matters most: "biggest load first" is
 * how a clerk fills a lorry that is going out half empty.
 */
const STOCK_SORTABLE = [
  'modelNumber', 'order.number', 'deliveryDate',
  'quantity', 'readyQty', 'reserved', 'dispatched', 'available',
];

/* ------------------------------- Reading them ------------------------------- */

/**
 * What the despatch list understands, in one function.
 *
 * Shared by the list, the board and the export for the reason every other module shares it:
 * three copies of a filter block start agreeing and stop without anybody noticing, and the
 * promise of a download is that the file is what was on the screen.
 */
function dispatchFilters(req, { withStatus = true } = {}) {
  const { page, limit, sort, filter } = listParams(req.query, {
    searchFields: ['number', 'invoice.number', 'lrNumber', 'vehicleNumber', 'lines.modelNumber'],
    defaultSort: '-createdAt',
    sortable: DISPATCH_SORTABLE,
  });

  /*
   * Ownership on the consignment's own `assignedTo`, which is copied from the order it came
   * from. Carried across rather than joined, so a marketing person's list is one query — and
   * so §29 answers the same way here as it does on the order behind it.
   */
  Object.assign(filter, ownershipFilter(req.user));

  if (withStatus && req.query.status) {
    filter.status = { $in: String(req.query.status).split(',') };
  }
  if (withStatus && req.query.open === 'true') {
    filter.status = { $nin: CLOSED_DISPATCH_STATUSES };
  }
  /** On the road: gone, and not yet acknowledged as delivered. */
  if (withStatus && req.query.inTransit === 'true') {
    filter.status = { $in: ['dispatched'] };
  }
  if (req.query.order) filter.order = req.query.order;
  if (req.query.customer) filter.customer = req.query.customer;

  /*
   * Past the date it was given, and not there yet — `isOverdue` on the model, said as a query.
   *
   * Unlike most of the "is it late" questions in this system this one **is** expressible, and
   * that is worth spelling out because the first attempt assumed it was not. A consignment's
   * due date is `promise.date` if marketing has given the buyer one and `expectedDeliveryDate`
   * otherwise; both are stored, so the precedence is an `$or` with the fallback branch
   * requiring the promise to be absent. `null` matches a missing field as well as an explicit
   * one, which is what makes that branch correct rather than merely close.
   *
   * The statuses come from the model beside the virtual, so the query and the flag on the row
   * cannot disagree — a board that filtered to four rows and then drew three of them without
   * the late badge would be the worst possible version of this.
   */
  if (req.query.overdue === 'true') {
    const now = new Date();
    filter.status = { $nin: ARRIVED_DISPATCH_STATUSES };
    filter.$and = [
      ...(filter.$and || []),
      {
        $or: [
          { 'promise.date': { $lt: now } },
          { 'promise.date': null, expectedDeliveryDate: { $lt: now } },
        ],
      },
    ];
  }

  return { page, limit, sort, filter };
}

export const listDispatches = asyncHandler(async (req, res) => {
  const { page, limit, sort, filter } = dispatchFilters(req);

  const [rows, total] = await Promise.all([
    Dispatch.find(filter).populate(POPULATE).sort(sort).skip((page - 1) * limit).limit(limit),
    Dispatch.countDocuments(filter),
  ]);

  /*
   * The overdue tally is computed over the *open* set rather than this page, because it is a
   * headline about the queue and a headline that changed when somebody turned a page would be
   * read as the queue changing.
   */
  const open = await Dispatch.find({ ...filter, status: { $nin: CLOSED_DISPATCH_STATUSES } })
    .select('status expectedDeliveryDate lines')
    .limit(EXPORT_LIMIT);

  paginated(res, allDispatchesVisibleTo(rows, req.user), { page, limit, total }, {
    meta: {
      open: open.length,
      inTransit: open.filter((row) => row.status === 'dispatched').length,
      overdue: open.filter((row) => row.isOverdue).length,
      pieces: open.reduce((sum, row) => sum + row.dispatchQty, 0),
    },
  });
});

/** The §18 ladder as columns you can work in, rather than a strip of counts you can only read. */
export const dispatchBoard = asyncHandler(async (req, res) => {
  const { sort } = dispatchFilters(req);

  const columns = await buildBoard({
    Model: Dispatch,
    filter: dispatchFilters(req, { withStatus: false }).filter,
    statuses: DISPATCH_STATUSES,
    sort,
    perColumn: perColumnFrom(req.query),
    select:
      'number order customer assignedTo status lines invoice lrNumber transporter vehicleNumber ' +
      'dispatchDate expectedDeliveryDate createdAt',
    populate: [
      { path: 'customer', select: 'code name' },
      { path: 'order', select: 'number' },
    ],
  });

  for (const column of columns) {
    column.cards = allDispatchesVisibleTo(column.cards, req.user);
  }

  res.json({ success: true, data: { columns }, meta: { sort } });
});

export const getDispatch = asyncHandler(async (req, res) => {
  const dispatch = await Dispatch.findById(req.params.id)
    .populate(POPULATE)
    .populate('statusHistory.by', 'name');

  if (!dispatch) throw ApiError.notFound('Consignment not found');
  if (!ownsRecord(req.user, dispatch)) throw ApiError.notFound('Consignment not found');

  res.json({
    success: true,
    data: dispatchVisibleTo(dispatch, req.user),
    /* What §19 still wants, so the screen can say it beside a disabled button. */
    outstanding: dispatch.outstandingPaperwork,
  });
});

export const exportDispatches = asyncHandler(async (req, res) => {
  const { sort, filter } = dispatchFilters(req);
  const rows = await Dispatch.find(filter).populate(POPULATE).sort(sort).limit(EXPORT_LIMIT);

  /*
   * One row per model on the lorry, not per lorry. The first thing anybody does with this file
   * is a pivot by model or by customer, and a shape that folded three models into a cell makes
   * that impossible.
   *
   * The invoice value comes off for a reader who may not see it, exactly as it does on the
   * screen. A redaction the Export button walks around is not a redaction.
   */
  const money = allDispatchesVisibleTo([rows[0]].filter(Boolean), req.user)[0]?.valueHidden !== true;

  const flat = rows.flatMap((dispatch) =>
    (dispatch.lines || []).map((line) => ({ dispatch, line }))
  );

  sendCsv(res, 'dispatches', flat, [
    ['Consignment', (row) => row.dispatch.number],
    ['Order', (row) => row.dispatch.order?.number],
    ['Customer', (row) => row.dispatch.customer?.name],
    ['Status', (row) => row.dispatch.status],
    ['Model', (row) => row.line.modelNumber || row.line.mould?.mouldCode],
    ['Colour', (row) => row.line.colour],
    ['Quantity', (row) => row.line.quantity],
    ['Cartons', (row) => row.line.cartons],
    ['Destination', (row) => row.dispatch.destination?.city || row.dispatch.destination?.address],
    ['Transporter', (row) => (row.dispatch.ownVehicle ? 'Own vehicle' : row.dispatch.transporter)],
    ['Vehicle', (row) => row.dispatch.vehicleNumber],
    ['Invoice', (row) => row.dispatch.invoice?.number],
    ...(money ? [['Invoice value', (row) => row.dispatch.invoice?.value]] : []),
    ['LR', (row) => row.dispatch.lrNumber],
    ['E-way bill', (row) => row.dispatch.ewayBillNumber],
    ['Dispatched', (row) => row.dispatch.dispatchDate],
    ['Expected delivery', (row) => row.dispatch.expectedDeliveryDate],
    ['Delivered', (row) => row.dispatch.deliveredAt],
    ['Late', (row) => (row.dispatch.isOverdue ? 'Yes' : '')],
  ]);
});

/* ------------------------------ What can go out ------------------------------ */

/**
 * Despatch's own queue: every line with pieces free to put on a lorry.
 *
 * This is the screen the §5 automation is really about. The blueprint says production reaching
 * "ready for dispatch" should *create a dispatch request* — and creating a document per line the
 * moment it is packed would be wrong in the ordinary case, because one lorry carries several
 * lines of one order and often several orders for the same customer. Despatch decides what
 * travels together; nobody else can.
 *
 * So the automation raises a task and this list answers it. What is packed, what is spoken for,
 * and what is left — with the consignments already holding it named, so the answer to "why is
 * there only 12,000 free when 32,000 are packed" is on the same row as the question.
 */
export const listReadyStock = asyncHandler(async (req, res) => {
  const filter = {
    status: { $nin: [...PRE_RELEASE_STATUSES, 'cancelled', 'closed'] },
    ...ownershipFilter(req.user),
    'lines.production.readyQty': { $gt: 0 },
  };
  if (req.query.customer) filter.customer = req.query.customer;
  /* By `_id`: this list is built from *orders*, and an order has no `order` field to match on. */
  if (req.query.order) filter._id = req.query.order;

  const orders = await SalesOrder.find(filter)
    .populate([
      { path: 'customer', select: 'code name city state' },
      { path: 'lines.mould', select: 'mouldCode name packingQty' },
    ])
    .limit(EXPORT_LIMIT);

  const claims = await claimsFor(orders.map((order) => order._id));

  let rows = orders.flatMap((order) =>
    (order.lines || []).map((line) => ({
      order: { _id: order._id, number: order.number, status: order.status, customer: order.customer },
      mould: line.mould,
      /*
       * What the buyer is owed, not only what the PO said.
       *
       * `dueToBuyer` reads the re-agreed date when marketing has recorded one and the PO's own
       * otherwise. Reading `deliveryDate` alone meant this queue and the production queue showed
       * different dates for the same line the moment a buyer was given more time — two screens
       * disagreeing in front of the same person, which is worse than either being wrong.
       *
       * The PO's date travels too, so a row can say "was 7 Oct" rather than silently drawing a
       * date the paperwork does not carry.
       */
      deliveryDate: line.dueToBuyer,
      poDeliveryDate: line.deliveryDate,
      promisedDate: line.promisedDate,
      productionStatus: line.production?.status,
      ...stockOf(line, claims.get(String(line._id))),
    }))
  );

  /* The default is the only question this screen answers: what can I load today. */
  if (req.query.free !== 'false') rows = rows.filter((row) => row.available > 0);
  if (req.query.search) {
    const term = String(req.query.search).toLowerCase();
    rows = rows.filter((row) =>
      [row.modelNumber, row.order.number, row.order.customer?.name]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term))
    );
  }

  /*
   * Oldest promise first. A despatch queue sorted by order number is a list nobody can work
   * from — what should go on today's lorry is whatever has been waiting longest against a date
   * somebody gave a buyer.
   */
  rows.sort((a, b) => {
    if (!a.deliveryDate) return 1;
    if (!b.deliveryDate) return -1;
    return new Date(a.deliveryDate) - new Date(b.deliveryDate);
  });

  /*
   * And then whatever the clerk asked for, on top of that ranking rather than instead of it.
   * The rows are built here rather than fetched, so this is `sortRows` and not `.sort()` — but
   * it refuses an unknown key with the same message every other list gives, which is the point
   * of the shared helper.
   */
  rows = sortRows(rows, req.query.sort, STOCK_SORTABLE);

  const { page, limit } = listParams(req.query, { defaultLimit: 25 });
  const start = (page - 1) * limit;

  paginated(res, rows.slice(start, start + limit), { page, limit, total: rows.length }, {
    meta: {
      lines: rows.length,
      available: rows.reduce((sum, row) => sum + row.available, 0),
      reserved: rows.reduce((sum, row) => sum + row.reserved, 0),
    },
  });
});

/**
 * The tracker panel on an order [§19].
 *
 * Gated on the *order's* read grant rather than dispatch's, and that is the whole point of the
 * panel: marketing is who §19 is written for, and the question "where are my customer's goods"
 * is a question about their order. The order's own ownership check runs first, so a consignment
 * on an order they may not open is refused the same way the order is.
 *
 * Returns the per-line position alongside the consignments, because either on its own is half
 * an answer: the consignments say what went, and the stock says what is left.
 */
export const listOrderDispatches = asyncHandler(async (req, res) => {
  const order = await SalesOrder.findById(req.params.id).populate('lines.mould', 'mouldCode name');
  if (!order) throw ApiError.notFound('Order not found');
  if (!ownsRecord(req.user, order)) throw ApiError.notFound('Order not found');

  const [dispatches, stock] = await Promise.all([
    Dispatch.find({ order: order._id })
      .populate([
        { path: 'raisedBy', select: 'name' },
        { path: 'pod.attachment', select: 'key filename mimeType' },
        /* The tracker panel draws every override notice, so it needs the names too. */
        { path: 'qualityOverride.by', select: 'name' },
        { path: 'closedWithoutPod.by', select: 'name' },
        { path: 'addressOverride.by', select: 'name' },
      ])
      .sort('-createdAt'),
    stockFor(order),
  ]);

  res.json({
    success: true,
    data: allDispatchesVisibleTo(dispatches, req.user),
    stock,
    meta: {
      /* The three figures the panel leads with, over the whole order. */
      readyQty: stock.reduce((sum, line) => sum + line.readyQty, 0),
      reserved: stock.reduce((sum, line) => sum + line.reserved, 0),
      dispatched: stock.reduce((sum, line) => sum + line.dispatched, 0),
      available: stock.reduce((sum, line) => sum + line.available, 0),
    },
  });
});

/* ------------------------------- Writing them ------------------------------- */

/** The order this consignment is against, loaded and checked, or a refusal. */
async function orderForDispatch(id, user) {
  const order = await SalesOrder.findById(id).populate('lines.mould', '_id mouldCode');
  if (!order) throw ApiError.badRequest('That order does not exist');
  if (!ownsRecord(user, order)) throw ApiError.badRequest('That order does not exist');

  if (PRE_RELEASE_STATUSES.includes(order.status)) {
    throw ApiError.badRequest(
      'This order has not been released to production yet — nothing has been made to dispatch'
    );
  }
  if (order.status === 'cancelled') {
    throw ApiError.badRequest('This order was cancelled — nothing goes out against it');
  }
  return order;
}

/**
 * Raising a consignment.
 *
 * The lines are named by *order line* and quantity, and everything else about them — the model,
 * the tool, the colour — is copied off the order rather than accepted from the request. A
 * delivery note that described the goods differently from the order it ships against is a
 * dispute waiting for a buyer to notice it, and the way that happens is a screen sending its
 * own idea of what is on the line.
 */
export const createDispatch = asyncHandler(withOrderLock(req => req.body.order, async (req, res) => {
  const order = await orderForDispatch(req.body.order, req.user);
  /* `address` and `pincode` as well, or the prefill below has nothing to read. */
  await order.populate('customer', 'code name address city state pincode');

  const stock = await stockFor(order);
  const refusal = assertClaimable(stock, req.body.lines);
  if (refusal) throw ApiError.badRequest(refusal);

  const byId = new Map((order.lines || []).map((line) => [String(line._id), line]));

  const lines = req.body.lines.map((ask) => {
    const line = byId.get(String(ask.orderLine));
    return {
      orderLine: line._id,
      mould: line.mould?._id || line.mould || undefined,
      modelNumber: line.modelNumber,
      colour: line.colour,
      quantity: ask.quantity,
      cartons: ask.cartons,
      remarks: ask.remarks,
    };
  });

  const dispatch = await Dispatch.create({
    number: await nextNumber('DSP'),
    order: order._id,
    customer: order.customer?._id || order.customer,
    /* The order's owner, so §29 scopes this list without a join — see `dispatchFilters`. */
    assignedTo: order.assignedTo,
    raisedBy: req.user._id,
    lines,
    /*
     * Prefilled from the customer, because the ordinary consignment goes to the address the
     * customer master already holds. Editable because a buying house's goods go to a garment
     * unit and an exporter's go to a CFS, and neither is where the customer is.
     */
    destination: {
      name: req.body.destination?.name || order.customer?.name,
      /* The street address too, which is the one §19 actually gates on. It was left out of this
         list because the customer register had no such field, so the comment above described a
         prefill that could not happen and every consignment was raised one item short. */
      address: req.body.destination?.address || order.customer?.address,
      city: req.body.destination?.city || order.customer?.city,
      state: req.body.destination?.state || order.customer?.state,
      pincode: req.body.destination?.pincode || order.customer?.pincode,
      ...req.body.destination,
    },
    ownVehicle: req.body.ownVehicle,
    transporter: req.body.transporter,
    vehicleNumber: req.body.vehicleNumber,
    invoice: req.body.invoice,
    lrNumber: req.body.lrNumber,
    ewayBillNumber: req.body.ewayBillNumber,
    expectedDeliveryDate: req.body.expectedDeliveryDate,
    remarks: req.body.remarks,
    statusHistory: [{ to: 'dispatch_request_received', by: req.user._id }],
  });

  const moved = await completeDispatchEffects(dispatch, req.user);

  await dispatch.populate(POPULATE);
  res.status(201).json({
    success: true,
    data: dispatchVisibleTo(dispatch, req.user),
    orderMovedTo: moved,
  });
}));

/**
 * Correcting a consignment.
 *
 * The paperwork stays editable throughout — an invoice number arrives after the request is
 * raised, an LR after the lorry is loaded, a POD a week later — and the *load* does not. Once
 * the goods are on a lorry the quantity is a claim about what is physically on it, and a
 * quantity edited afterwards is either a correction that should be visible or a fiction. A load
 * that went out wrong is cancelled and re-raised, which leaves both facts on the record.
 */
/*
 * And the nested paperwork *merges* rather than replaces, which is what makes a partial patch
 * safe. `invoice` and `destination` are filled in over time by different people — accounts puts
 * the value on, despatch the number, the address arrives with the order — and `Object.assign`
 * replaces a nested path wholesale. So a caller sending only the invoice number, which is
 * exactly what the board's fill-in-what-is-missing control sends, would take the date and the
 * value with it. Nothing errors; the figures are simply gone.
 */
function applyPaperwork(dispatch, patch) {
  if (patch.invoice) {
    if (dispatch.hasLeft) for (const [key, value] of Object.entries(patch.invoice)) {
      const before = dispatch.invoice?.[key];
      if (!(key === 'date' ? +new Date(before) === +new Date(value) : before === value)) throw ApiError.conflict('An issued invoice cannot be changed here. Ask accounts to record a correction against the original invoice.');
    }
    patch.invoice = { ...dispatch.toObject().invoice, ...patch.invoice };
  }
  if (patch.destination) patch.destination = { ...dispatch.toObject().destination, ...patch.destination };
  Object.assign(dispatch, patch);
}

export const updateDispatch = asyncHandler(withOrderLock(async req => (await Dispatch.findById(req.params.id).select('order'))?.order || req.params.id, async (req, res) => {
  const dispatch = await Dispatch.findById(req.params.id);
  if (!dispatch) throw ApiError.notFound('Consignment not found');
  if (!ownsRecord(req.user, dispatch)) throw ApiError.notFound('Consignment not found');

  expectVersion(dispatch, req.body);
  const before = snapshot(dispatch);
  const patch = withoutVersion(req.body);

  let order = null;

  if (patch.lines) {
    if (!dispatch.isEditable) {
      throw ApiError.badRequest(
        `This consignment is ${dispatch.status.replace(/_/g, ' ')} — cancel it and raise another if the load has changed`
      );
    }

    order = await orderForDispatch(dispatch.order, req.user);
    /* Checked against the floor *without* this consignment's own hold, or raising 20,000 to
       25,000 would be refused by the 20,000 it is replacing. */
    const stock = await stockFor(order, { excluding: dispatch._id });
    const refusal = assertClaimable(stock, patch.lines);
    if (refusal) throw ApiError.badRequest(refusal);

    const byId = new Map((order.lines || []).map((line) => [String(line._id), line]));
    patch.lines = patch.lines.map((ask) => {
      const line = byId.get(String(ask.orderLine));
      return {
        orderLine: line._id,
        mould: line.mould?._id || line.mould || undefined,
        modelNumber: line.modelNumber,
        colour: line.colour,
        quantity: ask.quantity,
        cartons: ask.cartons,
        remarks: ask.remarks,
      };
    });
  }

  applyPaperwork(dispatch, patch);
  dispatch.orderSyncPending = true;
  await dispatch.save();
  await recordChange({ model: 'Dispatch', doc: dispatch, before, by: req.user });

  /* A changed load changes what the order can still send, so its status is recomputed. */
  await completeDispatchEffects(dispatch, req.user);

  await dispatch.populate(POPULATE);
  res.json({
    success: true,
    data: dispatchVisibleTo(dispatch, req.user),
    outstanding: dispatch.outstandingPaperwork,
  });
}));

/* -------------------------------- Actions -------------------------------- */

export const applyDispatchAction = asyncHandler(withOrderLock(async req => (await Dispatch.findById(req.params.id).select('order'))?.order || req.params.id, async (req, res) => {
  const dispatch = await Dispatch.findById(req.params.id);
  if (!dispatch) throw ApiError.notFound('Consignment not found');
  if (!ownsRecord(req.user, dispatch)) throw ApiError.notFound('Consignment not found');

  /* Pulled out of `rest` rather than deleted afterwards: everything left in `rest` is assigned
     straight onto the document, and this one belongs inside the override record, not beside it. */
  const { action, note, qualityOverrideReason, noPodReason, addressOverrideReason, ...rest } =
    withoutVersion(req.body);
  /* Keyed by the `needs` name each soft gate asks for, so the block below can look one up
     without a branch per gate — and so one request can answer every gate it tripped. */
  const answers = { addressOverrideReason, qualityOverrideReason, noPodReason };
  const recipe = DISPATCH_ACTIONS[action];
  if (!recipe) throw ApiError.badRequest('That is not something you can do to a consignment');

  if (action === 'dispatch' && dispatch.hasLeft) {
    if (rest.invoice) applyPaperwork(dispatch, { invoice: rest.invoice });
    await completeDispatchEffects(dispatch, req.user);
    await dispatch.populate(POPULATE);
    return res.json({
      success: true,
      data: dispatchVisibleTo(dispatch, req.user),
      outstanding: dispatch.outstandingPaperwork,
      replayed: true,
    });
  }
  expectVersion(dispatch, req.body);

  if (!dispatchActionsFrom(dispatch.status).includes(action)) {
    throw ApiError.badRequest(
      CLOSED_DISPATCH_STATUSES.includes(dispatch.status)
        ? `This consignment is ${dispatch.status} — nothing further can be done to it`
        : `“${recipe.label}” does not apply to a consignment at ${dispatch.status.replace(/_/g, ' ')}`
    );
  }

  /*
   * Everything this action writes is diffed, so `before` is taken before any of it.
   *
   * It used to be taken after the paperwork had landed and after all three overrides had been
   * assigned, which made the audit row for a dispatch say only that the status moved: the
   * invoice number typed in the same breath, and the reason somebody gave for going past a
   * check, were both in `before` and in `after` and so diffed to nothing. The one field a
   * person might later have to answer for was the one the trail did not keep.
   */
  const before = snapshot(dispatch);

  /* Anything supplied alongside the action lands first, so a gate can be satisfied by the same
     request that trips it — typing the invoice number into the dispatch dialog, which is where
     somebody actually has it in front of them. */
  applyPaperwork(dispatch, rest);

  /*
   * §19's hard gate. Named paperwork, not a count: "still needs an invoice number and a
   * transporter" is something a person can go and do, and "not shippable" is not.
   *
   * Two kinds of shortfall, and the difference is whether an answer exists in the world. An
   * invoice number does — somebody cut the invoice, and the refusal sends them to go and read
   * it off it. A delivery address sometimes does not, and that row carries a way past; it joins
   * the soft gates gathered below. See `SHIPPING_PAPERWORK` for why it is the only one.
   *
   * The hard half is checked first, and on its own, so a consignment short of both is not asked
   * to explain the address while it is still waiting on an invoice — that would be a dialog
   * demanding a reason for something nobody had yet been told was in the way.
   */
  if (recipe.gate === 'shippable' && !dispatch.shippable) {
    const mustSupply = dispatch.paperworkShortfall.filter((field) => !field.needs);

    if (mustSupply.length) {
      throw ApiError.badRequest(
        `This consignment still needs ${mustSupply.map((field) => field.label).join(', ')} ` +
          'before it can be dispatched'
      );
    }
  }

  /*
   * The soft gates: gathered, then answered or asked about together [§15, §19].
   *
   * Three of them warn rather than refuse — a load quality has not cleared, a consignment with
   * no proof of delivery, a consignment with no delivery address. Each is the right call on its
   * own: a hard gate on a soft judgement gets worked around outside the system, where nobody
   * can see it. What makes each safe is the record — the reason, the name, the day.
   *
   * **They are collected rather than thrown one at a time, and that is the whole point of this
   * shape.** Written as three sequential `if (…) throw`, a consignment short of two of them
   * could never be dispatched at all. Each request is atomic, so an override assigned in memory
   * is lost when the next gate throws; the screen sends back only the field it was last asked
   * for; and the server then asks for the other one again. Measured, pressing Dispatched on a
   * consignment with no address and no inspection went:
   *
   *     press 1                  → 409 addressOverrideReason
   *     press 2 (address only)   → 409 qualityOverrideReason
   *     press 3 (quality only)   → 409 addressOverrideReason
   *     press 4 (address only)   → 409 qualityOverrideReason
   *
   * — forever, with the load on the lorry and the record unable to say so. Gathering them makes
   * the refusal name everything it wants (`needsAll`) and, more importantly, makes one request
   * able to answer everything it named.
   */
  const soft = [];

  if (recipe.gate === 'shippable' && !dispatch.shippable) {
    for (const field of dispatch.paperworkShortfall) {
      soft.push({
        needs: field.needs,
        refusal: `${dispatch.number} ${field.refusal}`,
        details: { missing: field.label },
        apply: (reason) => dispatch.set(field.overrideField, { reason, by: req.user._id, at: new Date() }),
      });
    }
  }

  if (recipe.to === 'dispatched') {
    const quality = await dispatchQuality(dispatch._id);

    if (!quality.passed) {
      soft.push({
        needs: 'qualityOverrideReason',
        refusal:
          `${quality.concern}. It can still go, but say why — the reason is kept against the ` +
          'consignment and appears in the monthly overrides list.',
        /* The concern travels with the refusal: it is more specific than anything the dialog
           could say for itself, and it is what the record keeps. */
        details: { concern: quality.concern },
        apply: (reason) => {
          dispatch.qualityOverride = {
            concern: quality.concern, reason, by: req.user._id, at: new Date(),
          };
        },
      });
    }
  }

  /*
   * Closing was the silent escape from the POD chase. The day screen's `pod` band catches a
   * consignment delivered without its receipt, and `closed` drops out of the despatch queue
   * altogether — so the one status that made a missing proof invisible was the one requiring no
   * explanation, while `pod_pending`, which exists to hold exactly this gap, kept it on a list.
   *
   * Refused outright would be wrong: a POD needs an attachment and not every delivery produces
   * one a clerk can lay hands on. A gate there gets satisfied by scanning any piece of paper,
   * which is a POD column full of nothing.
   */
  if (recipe.to === 'closed' && !dispatch.pod?.attachment) {
    soft.push({
      needs: 'noPodReason',
      refusal:
        `${dispatch.number} has no proof of delivery on file. It can still be closed, but say ` +
        'why — the reason is kept against the consignment. Otherwise leave it waiting on the ' +
        'POD, where the chase will keep it in front of somebody.',
      apply: (reason) => {
        dispatch.closedWithoutPod = { reason, by: req.user._id, at: new Date() };
      },
    });
  }

  const unanswered = soft.filter(
    (gate) => String(answers[gate.needs] || '').trim().length < MIN_OVERRIDE_REASON
  );

  if (unanswered.length) {
    /*
     * 409 rather than 400: this is not a malformed request, it is a correct one awaiting a
     * second, deliberate press with an answer attached — and a screen can tell those apart.
     *
     * Phrased for the first one, because a dialog asks one question at a time and a paragraph
     * naming two gets read as neither. `needsAll` is beside it so the screen can say there is
     * another question coming rather than springing it.
     */
    const [first] = unanswered;
    throw ApiError.conflict(first.refusal, {
      needs: first.needs,
      ...first.details,
      needsAll: unanswered.map((gate) => gate.needs),
    });
  }

  for (const gate of soft) gate.apply(String(answers[gate.needs]).trim());

  for (const field of recipe.needs) {
    if (!rest[field] && !dispatch[field]) throw ApiError.badRequest(`“${recipe.label}” needs ${field}`);
  }

  /* Stamped from the action rather than typed, so the dates cannot disagree with the status.
     A back-dated value supplied in the same request wins — a lorry recorded the next morning
     left the night before, and the record should say so. */
  if (recipe.to === 'dispatched' && !dispatch.dispatchDate) dispatch.dispatchDate = new Date();
  if (recipe.to === 'delivered' && !dispatch.deliveredAt) dispatch.deliveredAt = new Date();

  dispatch.statusHistory.push({ from: dispatch.status, to: recipe.to, by: req.user._id, note });
  dispatch.status = recipe.to;
  dispatch.orderSyncPending = true;
  if (recipe.to === 'dispatched') dispatch.accountingPending = true;

  await dispatch.save();
  await recordChange({ model: 'Dispatch', doc: dispatch, before, by: req.user, note: recipe.label });

  let moved = null, pending = false;
  try { moved = await completeDispatchEffects(dispatch, req.user); }
  catch (error) { pending = true; console.error('Dispatch completion pending:', dispatch.number, error.message); }

  await dispatch.populate(POPULATE);
  res.status(pending ? 202 : 200).json({
    success: true,
    data: dispatchVisibleTo(dispatch, req.user),
    /*
     * What is still short *after* the action, on every action rather than only on the paperwork
     * PATCH. The screen keeps whatever it last held when a response omits this, which is right
     * for a response that genuinely does not know — and wrong here: dispatching answered for the
     * missing address, and the header went on reading "Needs a delivery address" over a
     * consignment already on the road, because nothing had told it otherwise.
     */
    outstanding: dispatch.outstandingPaperwork,
    did: recipe.label,
    pending,
    message: pending ? 'Departure recorded; accounting or order totals are pending. The server will retry automatically.' : undefined,
    orderMovedTo: moved,
  });
}));

/** The actions this consignment can take from where it is, so the screen need not guess. */
export const listDispatchActions = asyncHandler(async (req, res) => {
  const dispatch = await Dispatch.findById(req.params.id);
  if (!dispatch) throw ApiError.notFound('Consignment not found');
  if (!ownsRecord(req.user, dispatch)) throw ApiError.notFound('Consignment not found');

  /*
   * A shortfall is reported as one of two different things, because the screen has to do two
   * different things with them.
   *
   * `blockedBy` greys the button: nothing the person can say here will help, they have to go and
   * fetch the invoice number. `answerable` leaves it live and tells the dialog what it will be
   * asked for — the address that genuinely has no answer is not a blockage, it is a question.
   * Collapsing the two would grey out the one button whose whole point is that it can be pressed.
   */
  const short = dispatch.paperworkShortfall;
  const mustSupply = short.filter((field) => !field.needs);
  const answerable = short.filter((field) => field.needs);

  res.json({
    success: true,
    data: dispatchActionsFrom(dispatch.status).map((key) => {
      const gated = DISPATCH_ACTIONS[key].gate === 'shippable';

      return {
        action: key,
        ...DISPATCH_ACTIONS[key],
        /* Listed disabled with the reason, never hidden — see the note in dispatchActions.js. */
        blockedBy:
          gated && mustSupply.length
            ? `Still needs ${mustSupply.map((field) => field.label).join(', ')}`
            : null,
        answerable:
          gated && !mustSupply.length && answerable.length
            ? answerable.map((field) => ({ missing: field.label, needs: field.needs }))
            : null,
      };
    }),
  });
});

/* ------------------------- What the customer was told ------------------------- */

/**
 * The date a buyer was actually given for this consignment.
 *
 * Marketing's to set, and only marketing's — the same rule as the order priority, for the same
 * reason. Its entire value is that it carries something the plant cannot know: what was said on
 * a phone call to a buyer. A despatch team that could set it would be marking its own homework,
 * and "promised Thursday" would stop meaning anybody had promised anything.
 *
 * Guarded at read level on the route, like the priority. Setting this changes nothing about the
 * consignment's contents, its quantity or its paperwork — it records a fact about the customer
 * relationship — and gating it on `dispatch: write` would leave it to the despatch team, who
 * are precisely the people not in the conversation.
 *
 * A null date clears it, and lateness falls back to the plant's own estimate. That matters:
 * a promise renegotiated away should not leave a consignment on the late list for ever.
 */
export const setDispatchPromise = asyncHandler(async (req, res) => {
  const dispatch = await Dispatch.findById(req.params.id);
  if (!dispatch) throw ApiError.notFound('Consignment not found');
  if (!ownsRecord(req.user, dispatch)) throw ApiError.notFound('Consignment not found');

  /*
   * Refused with a reason rather than a 404, exactly as the order priority is: the plant may
   * genuinely read this consignment, so pretending it is missing would be a lie told to
   * somebody entitled to the truth — and without the explanation they conclude the screen is
   * broken and ring marketing to ask, which is the phone call this whole feature removes.
   */
  const owner = String(dispatch.assignedTo) === String(req.user._id);
  const oversees = req.user.role === 'admin' || req.user.department === 'management';
  const sells = req.user.department === 'marketing';
  if (!owner && !oversees && !sells) {
    throw ApiError.forbidden(
      'Only marketing can record what the customer was promised — it is what was said to them'
    );
  }

  if (CLOSED_DISPATCH_STATUSES.includes(dispatch.status)) {
    throw ApiError.badRequest('This consignment is finished — a promise cannot change it now');
  }

  const before = snapshot(dispatch);
  const { date, note } = req.body;

  if (date === null) {
    dispatch.promise = undefined;
  } else {
    dispatch.promise = { date, note, by: req.user._id, at: new Date() };
  }

  await dispatch.save();
  await recordChange({
    model: 'Dispatch',
    doc: dispatch,
    before,
    by: req.user,
    /* A date given to a customer is a commitment the plant is now judged against, so it belongs
       in the trail beside the other commitments. */
    note: date === null
      ? 'Cleared what the customer was promised'
      : `Promised the customer ${new Date(date).toISOString().slice(0, 10)}${note ? `: ${note}` : ''}`,
  });

  await dispatch.populate(POPULATE);
  res.json({ success: true, data: dispatchVisibleTo(dispatch, req.user) });
});

/** `pod_pending` is not a sentence. This is, and it is the first thing the reader wants. */
const readableStatus = (status) =>
  String(status || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * Telling marketing where a consignment has got to.
 *
 * The answer to the question this board exists to stop being asked. Somebody flags an order
 * critical or promises a buyer Thursday, and then rings despatch to find out what happened —
 * and the answer is given on the phone, to one person, and lost. The next person to wonder
 * rings again.
 *
 * So the update goes back up the same thread it came down: to whoever raised the priority, and
 * to whoever made the promise. It lands on their to-do list, which is a place they already
 * look, rather than in a notification centre built for this one message.
 *
 * **Dated today**, because `raiseTask` puts an undated task in the rail only, and My day would
 * call their day clear while an answer they are waiting for sits in it.
 *
 * **Deduplicated per consignment**, not per message. A despatch clerk updating the same
 * consignment three times in a morning should replace one open item, not stack three — the
 * to-do list is a list of things to do, and "read this" three times is one thing.
 */
export const tellMarketing = asyncHandler(async (req, res) => {
  const dispatch = await Dispatch.findById(req.params.id).populate([
    { path: 'order', select: 'number priorityBy priority' },
    { path: 'customer', select: 'name' },
  ]);
  if (!dispatch) throw ApiError.notFound('Consignment not found');
  if (!ownsRecord(req.user, dispatch)) throw ApiError.notFound('Consignment not found');

  const note = req.body.note.trim();

  /*
   * Everyone with a stake in this consignment's date, deduplicated — the two are usually the
   * same person and occasionally are not, and sending one person the same update twice is how
   * a useful channel becomes one people mute.
   */
  const audience = new Set(
    [dispatch.order?.priorityBy, dispatch.promise?.by]
      .map((who) => String(who?._id || who || ''))
      .filter((id) => id && id !== String(req.user._id))
  );

  if (!audience.size) {
    throw ApiError.badRequest(
      'Nobody has asked about this consignment — there is no priority or promise on it to answer'
    );
  }

  for (const user of audience) {
    await raiseTask({
      user,
      title: `${dispatch.number} — update from despatch`,
      /* The status in front of the note, because "loaded" is often the whole answer and the
         sentence after it is the detail. */
      notes: `${readableStatus(dispatch.status)}. ${note}`.slice(0, 500),
      dueDate: new Date(),
      priority: dispatch.order?.priority === 'critical' ? 'high' : 'normal',
      link: `/dispatches/${dispatch._id}`,
      originKey: `dispatch-update:${dispatch._id}`,
    }).catch(() => null);
  }

  /* No `before`: nothing on the record moved. The change *is* the note — see `recordChange`,
     which tells the two cases apart rather than writing a diff against nothing. */
  await recordChange({
    model: 'Dispatch',
    doc: dispatch,
    before: null,
    by: req.user,
    note: `Told marketing: ${note}`,
  });

  res.json({ success: true, data: { told: audience.size, note } });
});

/* --------------------------------- The POD --------------------------------- */

/**
 * The signed delivery note coming back.
 *
 * §18 gives POD its own status, and a status with nothing behind it is a status somebody ticks
 * to clear their list. The file is what makes "POD received" mean anything — it is the document
 * accounts will want the day a buyer disputes having taken delivery.
 */
export const setDispatchPod = asyncHandler(async (req, res) => {
  const dispatch = await Dispatch.findById(req.params.id);
  if (!dispatch) throw ApiError.notFound('Consignment not found');
  if (!ownsRecord(req.user, dispatch)) throw ApiError.notFound('Consignment not found');
  if (!req.file) throw ApiError.badRequest('Attach the signed delivery note');

  if (!GONE_DISPATCH_STATUSES.includes(dispatch.status)) {
    throw ApiError.badRequest('Nothing has been delivered yet — there is no proof of delivery to file');
  }

  const previous = dispatch.pod?.attachment;

  const key = await put({ buffer: req.file.buffer, mimeType: req.file.mimetype });
  let attachment;
  try {
    attachment = await Attachment.create({
      key,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      uploadedBy: req.user._id,
      /* Hung off the order, which is what the download route checks a reader against. */
      salesOrder: dispatch.order,
      title: `${dispatch.number} — proof of delivery`,
    });
  } catch (error) {
    /* The row failed, so the bytes are unreferenced: take them back out rather than leak them. */
    await remove(key);
    throw error;
  }

  dispatch.pod = {
    attachment: attachment._id,
    receivedAt: new Date(),
    note: req.body?.note || dispatch.pod?.note,
  };
  await dispatch.save();

  /* Only now, with the new file on the record, is the old one safe to delete. */
  if (previous) {
    const old = await Attachment.findById(previous);
    if (old) {
      await remove(old.key).catch(() => {});
      await old.deleteOne();
    }
  }

  await dispatch.populate(POPULATE);
  res.json({ success: true, data: dispatchVisibleTo(dispatch, req.user) });
});

/* ------------------------------ The team's day ------------------------------ */

/**
 * What despatch has to do today, and who is waiting to be told.
 *
 * The same shape as the plant's own front page and for the same reason: a supervisor opens the
 * app with two questions, and the second one — "what has somebody asked me that I have not
 * answered" — is nearly always about the first. Splitting them across two screens is how a
 * question about a lorry sits unanswered beside the lorry.
 *
 * Three lists rather than the plant's two, because despatch has a failure the plant does not.
 * A consignment that is late, blocked or ready to load is at least *on the screen*; goods that
 * were packed and for which nobody ever raised a consignment are on no screen at all. That is
 * how stock sits on a floor for a fortnight against an order everybody believes is moving, and
 * it is the single most useful thing this page can surface — so `unclaimed` is its own list and
 * not a footnote under the others.
 */
export const dispatchDay = asyncHandler(async (req, res) => {
  const now = new Date();

  const consignments = await Dispatch.find({
    status: { $nin: CLOSED_DISPATCH_STATUSES },
    ...ownershipFilter(req.user),
  })
    .populate([
      { path: 'customer', select: 'code name city state' },
      /*
       * The order's priority, which this screen has never had.
       *
       * `select: 'number'` was the whole of it — so marketing could mark an order critical,
       * watch the press queue lift it, and then watch it land in despatch as an ordinary row.
       * The last department before the buyer, and the one the buyer actually rings, was the one
       * that could not see the flag. A populate that omits the field does not fail; it just
       * quietly hands back an order with no priority on it.
       */
      {
        path: 'order',
        select: 'number priority priorityReason priorityAt priorityBy',
        /* Nested, so the row can say "Nandhini asked for this" rather than showing an id. */
        populate: { path: 'priorityBy', select: 'name' },
      },
      { path: 'assignedTo', select: 'name' },
      { path: 'promise.by', select: 'name' },
    ])
    .limit(EXPORT_LIMIT);

  const rows = consignments
    .map((consignment) => ({
      _id: consignment._id,
      number: consignment.number,
      status: consignment.status,
      customer: consignment.customer,
      order: consignment.order,
      transporter: consignment.transporter,
      lrNumber: consignment.lrNumber,
      vehicleNumber: consignment.vehicleNumber,
      dispatchDate: consignment.dispatchDate,
      expectedDeliveryDate: consignment.expectedDeliveryDate,
      /*
       * Both dates, and which of them is being judged against.
       *
       * The screen needs the pair rather than the winner: "promised the 14th, we planned the
       * 20th" is the sentence that tells a despatch clerk this is not a scheduling detail but a
       * gap somebody has to close, and it cannot be reconstructed from one date.
       */
      dueDate: consignment.dueDate,
      promise: consignment.promise?.date
        ? {
            date: consignment.promise.date,
            note: consignment.promise.note || null,
            by: consignment.promise.by?.name || null,
            at: consignment.promise.at,
          }
        : null,
      dispatchQty: consignment.dispatchQty,
      lineCount: consignment.lineCount,
      outstandingPaperwork: consignment.outstandingPaperwork,
      assignedTo: consignment.assignedTo?.name || null,
      urgency: dispatchUrgencyOf(consignment, {
        now,
        /* What marketing asked the plant for, carried the last mile to the people who load it. */
        priority: consignment.order?.priority || 'normal',
      }),
      link: `/dispatches/${consignment._id}`,
    }))
    .sort(byDispatchUrgency);

  /*
   * Goods packed against an order with no consignment claiming them.
   *
   * Built from the same `stockOf` the ready-stock screen uses rather than from a second count,
   * because "free to load" is a subtraction — packed, less what other consignments have already
   * reserved — and two implementations of a subtraction is how a screen offers the despatch team
   * stock that is already spoken for.
   */
  const openOrders = await SalesOrder.find({
    status: { $nin: [...PRE_RELEASE_STATUSES, 'cancelled', 'closed'] },
    ...ownershipFilter(req.user),
    'lines.production.readyQty': { $gt: 0 },
  })
    .populate([
      { path: 'customer', select: 'code name city state' },
      { path: 'lines.mould', select: 'mouldCode name' },
    ])
    .limit(EXPORT_LIMIT);

  const claims = await claimsFor(openOrders.map((order) => order._id));

  const unclaimed = openOrders
    .flatMap((order) =>
      (order.lines || []).map((line) => ({
        order: { _id: order._id, number: order.number, customer: order.customer },
        modelNumber: line.modelNumber,
        mould: line.mould,
        colour: line.colour,
        /* The buyer's date, re-agreed or not — see the note on the ready queue. */
        deliveryDate: line.dueToBuyer,
        poDeliveryDate: line.deliveryDate,
        promisedDate: line.promisedDate,
        link: `/orders/${order._id}`,
        ...stockOf(line, claims.get(String(line._id))),
      }))
    )
    .filter((row) => row.available > 0)
    /* Oldest promise first: what should go on today's lorry is whatever has been waiting
       longest against a date somebody actually gave a buyer. */
    .sort((a, b) => {
      if (!a.deliveryDate) return 1;
      if (!b.deliveryDate) return -1;
      return new Date(a.deliveryDate) - new Date(b.deliveryDate);
    })
    .slice(0, 15);

  /*
   * The orders marketing has flagged, and why each one has not gone [§29].
   *
   * Despatch is the last department before the buyer, so despatch is who gets rung about an
   * urgent order — and very often the answer is not theirs to give. Putting the *blocker* on
   * their screen is what lets them say "it is on a quality hold" instead of going to find out,
   * and it is what decides who a concern gets addressed to.
   *
   * Every urgent order, not only the ones with a consignment: an order marketing escalated
   * that nothing has been raised against yet is the most invisible case there is, and the one
   * most worth showing.
   */
  const urgent = await urgentOrdersFor(req.user);

  /*
   * The questions, from the same request — see the note on the plant's day screen. Addressed to
   * this user's own department rather than to despatch by name, so the shape serves quality and
   * accounts unchanged when their screens are built.
   */
  const queries = await OrderQuery.find({
    askedOf: req.user.department,
    status: { $in: ['open', 'answered'] },
  })
    .populate([
      { path: 'raisedBy', select: 'name department' },
      { path: 'answers.by', select: 'name' },
      { path: 'order', select: 'number customer', populate: { path: 'customer', select: 'name' } },
      /* The consignment it is about, when it names one — on an order already sent in three
         loads, "where is the vehicle" is unanswerable without it. */
      { path: 'dispatch', select: 'number status transporter lrNumber expectedDeliveryDate' },
    ])
    .sort({ status: 1, dueBy: 1 })
    .limit(50);

  const inBand = (band) => rows.filter((row) => row.urgency.band === band);

  res.json({
    success: true,
    data: {
      chase: inBand('chase'),
      blocked: inBand('blocked'),
      load: inBand('load'),
      pod: inBand('pod'),
      watch: inBand('watch'),
      unclaimed,
      urgent,
      queries: queries.filter((query) => query.status === 'open'),
      answered: queries.filter((query) => query.status === 'answered'),
    },
    meta: {
      chase: inBand('chase').length,
      blocked: inBand('blocked').length,
      load: inBand('load').length,
      pod: inBand('pod').length,
      open: rows.length,
      /* Everything with a verb against it, which is the one number the team is judged on —
         derived from the band list so it cannot drift from what the screen actually groups. */
      actionable: rows.filter((row) => ACTIONABLE_BANDS.includes(row.urgency.band)).length,
      /* Lines, and the pieces on them: "7 lines" understates a floor holding 340,000 pieces. */
      unclaimed: unclaimed.length,
      unclaimedQty: unclaimed.reduce((sum, row) => sum + row.available, 0),
      urgent: urgent.length,
      /* The half despatch cannot fix themselves — what a concern exists to hand over. */
      urgentBlockedElsewhere: urgent.filter(
        (row) => row.blockedBy && row.blockedBy !== 'despatch'
      ).length,
      questions: queries.filter((query) => query.status === 'open').length,
      questionsOverdue: queries.filter((query) => query.isOverdue).length,
    },
  });
});
