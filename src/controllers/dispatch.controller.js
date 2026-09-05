import Dispatch, {
  DISPATCH_STATUSES,
  CLOSED_DISPATCH_STATUSES,
  GONE_DISPATCH_STATUSES,
} from '../models/Dispatch.js';
import SalesOrder, { PRE_RELEASE_STATUSES } from '../models/SalesOrder.js';
import Attachment from '../models/Attachment.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { nextNumber } from '../services/numbering.service.js';
import { listParams, paginated } from '../utils/query.js';
import { expectVersion, withoutVersion } from '../utils/concurrency.js';
import { recordChange, snapshot } from '../services/audit.service.js';
import { ownershipFilter, ownsRecord } from '../services/ownership.service.js';
import { allDispatchesVisibleTo, dispatchVisibleTo } from '../services/pricingVisibility.js';
import { buildBoard, perColumnFrom } from '../services/board.service.js';
import { DISPATCH_ACTIONS, dispatchActionsFrom } from '../services/dispatchActions.js';
import {
  assertClaimable, claimsFor, rollUpDispatchStatus, stockFor, stockOf,
} from '../services/dispatchStock.service.js';
import { put, remove } from '../services/storage.service.js';
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
  { path: 'customer', select: 'code name city state gstin mobile' },
  { path: 'order', select: 'number status customerPo orderDate' },
  { path: 'assignedTo', select: 'name' },
  { path: 'raisedBy', select: 'name' },
  { path: 'lines.mould', select: 'mouldCode name category sizeMm packingQty' },
  { path: 'pod.attachment', select: 'key filename mimeType size' },
];

const EXPORT_LIMIT = 5000;

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
      deliveryDate: line.deliveryDate,
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
export const createDispatch = asyncHandler(async (req, res) => {
  const order = await orderForDispatch(req.body.order, req.user);
  await order.populate('customer', 'code name city state');

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
      city: req.body.destination?.city || order.customer?.city,
      state: req.body.destination?.state || order.customer?.state,
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

  /* The order follows its consignments — see dispatchStock.service.js for the precedence. */
  const moved = rollUpDispatchStatus(order, await stockFor(order), req.user);
  if (moved) await order.save();

  await dispatch.populate(POPULATE);
  res.status(201).json({
    success: true,
    data: dispatchVisibleTo(dispatch, req.user),
    orderMovedTo: moved,
  });
});

/**
 * Correcting a consignment.
 *
 * The paperwork stays editable throughout — an invoice number arrives after the request is
 * raised, an LR after the lorry is loaded, a POD a week later — and the *load* does not. Once
 * the goods are on a lorry the quantity is a claim about what is physically on it, and a
 * quantity edited afterwards is either a correction that should be visible or a fiction. A load
 * that went out wrong is cancelled and re-raised, which leaves both facts on the record.
 */
export const updateDispatch = asyncHandler(async (req, res) => {
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

  Object.assign(dispatch, patch);
  await dispatch.save();
  await recordChange({ model: 'Dispatch', doc: dispatch, before, by: req.user });

  /* A changed load changes what the order can still send, so its status is recomputed. */
  if (order) {
    const moved = rollUpDispatchStatus(order, await stockFor(order), req.user);
    if (moved) await order.save();
  }

  await dispatch.populate(POPULATE);
  res.json({
    success: true,
    data: dispatchVisibleTo(dispatch, req.user),
    outstanding: dispatch.outstandingPaperwork,
  });
});

/* -------------------------------- Actions -------------------------------- */

export const applyDispatchAction = asyncHandler(async (req, res) => {
  const dispatch = await Dispatch.findById(req.params.id);
  if (!dispatch) throw ApiError.notFound('Consignment not found');
  if (!ownsRecord(req.user, dispatch)) throw ApiError.notFound('Consignment not found');

  const { action, note, ...rest } = req.body;
  const recipe = DISPATCH_ACTIONS[action];
  if (!recipe) throw ApiError.badRequest('That is not something you can do to a consignment');

  if (!dispatchActionsFrom(dispatch.status).includes(action)) {
    throw ApiError.badRequest(
      CLOSED_DISPATCH_STATUSES.includes(dispatch.status)
        ? `This consignment is ${dispatch.status} — nothing further can be done to it`
        : `“${recipe.label}” does not apply to a consignment at ${dispatch.status.replace(/_/g, ' ')}`
    );
  }

  /* Anything supplied alongside the action lands first, so a gate can be satisfied by the same
     request that trips it — typing the invoice number into the dispatch dialog, which is where
     somebody actually has it in front of them. */
  Object.assign(dispatch, rest);

  /*
   * §19's gate. Named paperwork, not a count: "still needs an invoice number and a transporter"
   * is something a person can go and do, and "not shippable" is not.
   */
  if (recipe.gate === 'shippable' && !dispatch.shippable) {
    throw ApiError.badRequest(
      `This consignment still needs ${dispatch.outstandingPaperwork.join(', ')} before it can be dispatched`
    );
  }

  for (const field of recipe.needs) {
    if (!rest[field] && !dispatch[field]) throw ApiError.badRequest(`“${recipe.label}” needs ${field}`);
  }

  const before = snapshot(dispatch);

  /* Stamped from the action rather than typed, so the dates cannot disagree with the status.
     A back-dated value supplied in the same request wins — a lorry recorded the next morning
     left the night before, and the record should say so. */
  if (recipe.to === 'dispatched' && !dispatch.dispatchDate) dispatch.dispatchDate = new Date();
  if (recipe.to === 'delivered' && !dispatch.deliveredAt) dispatch.deliveredAt = new Date();

  dispatch.statusHistory.push({ from: dispatch.status, to: recipe.to, by: req.user._id, note });
  dispatch.status = recipe.to;

  await dispatch.save();
  await recordChange({ model: 'Dispatch', doc: dispatch, before, by: req.user, note: recipe.label });

  /*
   * The order follows. A consignment leaving is the moment an order becomes part- or
   * fully-dispatched, and a cancellation puts the pieces back — both are the same recomputation
   * over the same arithmetic, which is why neither is written by hand here.
   */
  const order = await SalesOrder.findById(dispatch.order);
  let moved = null;
  if (order) {
    moved = rollUpDispatchStatus(order, await stockFor(order), req.user);
    if (moved) await order.save();
  }

  await dispatch.populate(POPULATE);
  res.json({
    success: true,
    data: dispatchVisibleTo(dispatch, req.user),
    did: recipe.label,
    orderMovedTo: moved,
  });
});

/** The actions this consignment can take from where it is, so the screen need not guess. */
export const listDispatchActions = asyncHandler(async (req, res) => {
  const dispatch = await Dispatch.findById(req.params.id);
  if (!dispatch) throw ApiError.notFound('Consignment not found');
  if (!ownsRecord(req.user, dispatch)) throw ApiError.notFound('Consignment not found');

  res.json({
    success: true,
    data: dispatchActionsFrom(dispatch.status).map((key) => ({
      action: key,
      ...DISPATCH_ACTIONS[key],
      /* Listed disabled with the reason, never hidden — see the note in dispatchActions.js. */
      blockedBy:
        DISPATCH_ACTIONS[key].gate === 'shippable' && !dispatch.shippable
          ? `Still needs ${dispatch.outstandingPaperwork.join(', ')}`
          : null,
    })),
  });
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
