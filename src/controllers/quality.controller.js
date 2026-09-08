import Inspection, {
  DEFECT_TYPES, HOLDING_VERDICTS, INSPECTION_STAGES, VERDICTS,
} from '../models/Inspection.js';
import SalesOrder, { PRE_RELEASE_STATUSES } from '../models/SalesOrder.js';
import Dispatch from '../models/Dispatch.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { nextNumber } from '../services/numbering.service.js';
import { listParams, paginated } from '../utils/query.js';
import { ownershipFilter, ownsRecord } from '../services/ownership.service.js';
import { recordChange, snapshot } from '../services/audit.service.js';
import { raiseTask } from '../services/task.service.js';
import { qualityForLines } from '../services/quality.service.js';

/**
 * Quality [BLUEPRINT §15, stage 7].
 *
 * An inspection is written against **a line of a released order**, and optionally against the
 * consignment it is about to go out on. Everything else in this file follows from that one
 * choice — see the model for why it is not the order.
 *
 * Two behaviours are worth finding here rather than in the model:
 *
 * **A rejection stops the line.** The verdict does not sit beside `quality_hold`; it sets it.
 * Two records that can disagree about whether goods are fit to send is worse than either alone,
 * and the one that loses is always the one somebody forgot to update.
 *
 * **A rejection tells marketing.** The person who has to ring the buyer is not standing at the
 * inspection bench, and a held lot they learn about on the delivery date is a held lot they
 * cannot do anything about. §31's list of what is worth interrupting somebody for includes
 * production delayed; a lot rejected is that, arriving earlier.
 */

const POPULATE = [
  { path: 'inspectedBy', select: 'name' },
  { path: 'mould', select: 'mouldCode name category' },
  { path: 'materialRef', select: 'name code type colour' },
  { path: 'order', select: 'number customer', populate: { path: 'customer', select: 'code name' } },
  { path: 'dispatch', select: 'number status lrNumber' },
];

/** The vocabulary, so a screen need not carry its own copy of any of the three lists. */
export const listQualityOptions = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: { defects: DEFECT_TYPES, stages: INSPECTION_STAGES, verdicts: VERDICTS },
  });
});

/* -------------------------------- Recording -------------------------------- */

export const recordInspection = asyncHandler(async (req, res) => {
  const order = await SalesOrder.findById(req.params.id).populate('lines.mould', 'mouldCode name');
  if (!order) throw ApiError.notFound('Order not found');
  if (!ownsRecord(req.user, order)) throw ApiError.notFound('Order not found');

  /*
   * Nothing to inspect before release. An order still being verified may have its lines changed,
   * so an inspection against one would be a statement about a quantity that can still become a
   * different quantity — and §13's checks are the gate that decides it is real.
   */
  if (PRE_RELEASE_STATUSES.includes(order.status)) {
    throw ApiError.badRequest('This order has not been released to production yet');
  }

  const line = order.lines.id(req.body.line);
  if (!line) throw ApiError.badRequest('That line is not on this order');

  const { stage, dispatch: dispatchId, quantityInspected, quantityRejected = 0, defects = [] } = req.body;

  /*
   * A pre-dispatch check is about one lorry, so it must name one — and that lorry must be
   * carrying this line. Attaching it to somebody else's consignment would put one customer's
   * inspection on another customer's paperwork.
   */
  let consignment = null;
  if (stage === 'pre_dispatch') {
    if (!dispatchId) throw ApiError.badRequest('Say which consignment is being checked');

    consignment = await Dispatch.findById(dispatchId);
    if (!consignment || String(consignment.order) !== String(order._id)) {
      throw ApiError.badRequest('That consignment is not on this order');
    }
    if (!consignment.lines.some((row) => String(row.orderLine) === String(line._id))) {
      throw ApiError.badRequest('That consignment does not carry this line');
    }
  } else if (dispatchId) {
    throw ApiError.badRequest('Only a pre-dispatch check names a consignment');
  }

  if (quantityRejected > quantityInspected) {
    throw ApiError.badRequest('More rejected than inspected — check the figures');
  }

  /*
   * Defect counts may legitimately exceed the reject count, because one piece can carry two
   * faults, so there is no equality to enforce. What *is* worth refusing is a rejection with no
   * defect named: it is the record that makes every report useless, and the person filling it in
   * is the one person who knows the answer.
   */
  if (quantityRejected > 0 && !defects.length) {
    throw ApiError.badRequest('Say what was wrong with them — a rejection with no defect named cannot be reported on');
  }

  const inspection = await Inspection.create({
    number: await nextNumber('QC'),
    order: order._id,
    line: line._id,
    dispatch: consignment?._id,
    /* Copied, not joined. See the model: an inspection is a statement about what was on the
       machine that day, and a line's mould can be corrected afterwards. */
    mould: line.mould?._id || line.mould,
    materialRef: line.materialRef,
    modelNumber: line.modelNumber,
    colour: line.colour,
    stage,
    inspectedBy: req.user._id,
    inspectedAt: req.body.inspectedAt || new Date(),
    quantityInspected,
    quantityRejected,
    defects,
    verdict: req.body.verdict,
    remarks: req.body.remarks,
  });

  /*
   * A rejection stops the line, unless it has already gone. Setting the status here rather than
   * asking quality to also set it is what stops the two records disagreeing — and a
   * `pre_dispatch` rejection deliberately does not touch production, because the line may be
   * long finished and what failed is this load, not the run.
   */
  let heldLine = false;
  if (HOLDING_VERDICTS.includes(inspection.verdict) && stage !== 'pre_dispatch') {
    if (line.production?.status !== 'completed') {
      const before = snapshot(order);
      line.production.status = 'quality_hold';
      line.production.holdReason =
        `${inspection.number}: ${quantityRejected} of ${quantityInspected} rejected`;
      await order.save();
      await recordChange({
        model: 'SalesOrder', documentId: order._id, before, after: snapshot(order), by: req.user,
        note: `Quality hold from ${inspection.number}`,
      });
      heldLine = true;
    }
  }

  /*
   * And marketing is told. The person who has to ring the buyer is not standing at the bench,
   * and a held lot they learn about on the delivery date is one they can do nothing about.
   */
  if (HOLDING_VERDICTS.includes(inspection.verdict)) {
    await raiseTask({
      user: order.assignedTo,
      title: `${order.number} held on quality — ${line.modelNumber || 'a line'}`,
      notes:
        `${inspection.number}: ${quantityRejected} of ${quantityInspected} rejected` +
        `${defects.length ? ` · ${defects.map((d) => d.type.replace(/_/g, ' ')).join(', ')}` : ''}` +
        `${req.body.remarks ? ` · ${req.body.remarks}` : ''}`,
      dueDate: new Date(),
      priority: 'high',
      link: `/orders/${order._id}`,
      originKey: `quality-hold:${inspection._id}`,
    }).catch(() => null);
  }

  await inspection.populate(POPULATE);
  res.status(201).json({ success: true, data: inspection, heldLine });
});

/* --------------------------------- Reading --------------------------------- */

/** Every inspection on one order, newest first — the panel on the order screen. */
export const listOrderInspections = asyncHandler(async (req, res) => {
  const order = await SalesOrder.findById(req.params.id);
  if (!order) throw ApiError.notFound('Order not found');
  if (!ownsRecord(req.user, order)) throw ApiError.notFound('Order not found');

  const inspections = await Inspection.find({ order: order._id })
    .populate(POPULATE)
    .sort({ inspectedAt: -1 });

  /* The standing verdict per line beside the history, because the history answers "what
     happened" and the screen also has to answer "what is true now". */
  const byLine = await qualityForLines(order.lines.map((line) => line._id));

  res.json({
    success: true,
    data: inspections,
    lines: order.lines.map((line) => {
      const state = byLine.get(String(line._id));
      return {
        line: line._id,
        modelNumber: line.modelNumber,
        held: Boolean(state?.held),
        inspections: state?.inspections || 0,
        inspected: state?.inspected || 0,
        rejected: state?.rejected || 0,
        latestVerdict: state?.latest?.verdict || null,
      };
    }),
  });
});

/** The quality register: every inspection, filterable — the module's own list screen. */
export const listInspections = asyncHandler(async (req, res) => {
  const { page, limit, sort, filter } = listParams(req.query, {
    searchFields: ['number', 'modelNumber', 'remarks'],
    defaultSort: '-inspectedAt',
  });

  /*
   * Scoped to what the reader may see, the same way the report beside it is [§29].
   *
   * An inspection has no owner of its own — it belongs to the order behind it — so the scope
   * has to be resolved through the orders first. Left out, this was the one door in the module
   * that leaked: the report and the overrides both applied ownership and this list did not, so
   * a marketing person reading the register saw every inspection in the building, including
   * their colleagues' customers. Found by counting rows on the seeded screen against the three
   * the same person sees on the chase list.
   */
  const scope = ownershipFilter(req.user);
  const owned = Object.keys(scope).length
    ? (await SalesOrder.find(scope).select('_id')).map((order) => String(order._id))
    : null;

  if (req.query.stage) filter.stage = { $in: String(req.query.stage).split(',') };
  if (req.query.verdict) filter.verdict = { $in: String(req.query.verdict).split(',') };
  if (req.query.mould) filter.mould = req.query.mould;
  /* A named order narrows *within* the scope rather than replacing it — asking for an order you
     may not read must not become a way to read it. */
  if (req.query.order) {
    filter.order = owned && !owned.includes(String(req.query.order))
      ? { $in: [] }
      : req.query.order;
  } else if (owned) {
    filter.order = { $in: owned };
  }
  /* The one view a quality head opens first: what is currently stopping something. */
  if (req.query.held === 'true') filter.verdict = { $in: HOLDING_VERDICTS };

  const [data, total] = await Promise.all([
    Inspection.find(filter).populate(POPULATE).sort(sort).skip((page - 1) * limit).limit(limit),
    Inspection.countDocuments(filter),
  ]);

  paginated(res, data, { page, limit, total });
});

/* -------------------------------- Reporting -------------------------------- */

/**
 * What quality actually found, over a period.
 *
 * Four questions in one reply, because they are read together and a screen that fetched them
 * separately could show a Pareto that disagrees with the totals above it.
 *
 * The ordering of the four is the argument: **which tool** sends somebody to a press, **which
 * defect** decides where the effort goes, **which resin** separates a material problem from a
 * tool problem, and **the overrides** say whether the soft gate is a judgement or a rubber
 * stamp. Everything else a quality report could show is downstream of those.
 */
export const qualityReport = asyncHandler(async (req, res) => {
  const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 90 * 86400000);
  const until = req.query.until ? new Date(req.query.until) : new Date();

  /*
   * Scoped like every other list. A marketing reader sees quality on their own orders, which is
   * the §29 rule applied to a report rather than abandoned at its edge — a report that ignored
   * ownership would be the one door in the building that leaks another person's customers.
   */
  const scope = ownershipFilter(req.user);
  const orderIds = Object.keys(scope).length
    ? (await SalesOrder.find(scope).select('_id')).map((order) => order._id)
    : null;

  const match = {
    inspectedAt: { $gte: since, $lte: until },
    ...(orderIds ? { order: { $in: orderIds } } : {}),
  };

  const inspections = await Inspection.find(match)
    .populate([
      { path: 'mould', select: 'mouldCode name' },
      { path: 'materialRef', select: 'name code' },
    ])
    .limit(5000);

  const inspected = inspections.reduce((sum, row) => sum + row.quantityInspected, 0);
  const rejected = inspections.reduce((sum, row) => sum + row.quantityRejected, 0);

  /** Groups rows by a key, summing what was looked at and what failed. */
  const tally = (keyOf, labelOf) => {
    const rows = new Map();
    for (const inspection of inspections) {
      const key = keyOf(inspection);
      if (!key) continue;

      const row = rows.get(key) || {
        key, label: labelOf(inspection), inspected: 0, rejected: 0, inspections: 0,
      };
      row.inspected += inspection.quantityInspected;
      row.rejected += inspection.quantityRejected;
      row.inspections += 1;
      rows.set(key, row);
    }

    return [...rows.values()]
      .map((row) => ({
        ...row,
        rejectionPercent: row.inspected ? Math.round((row.rejected / row.inspected) * 1000) / 10 : 0,
      }))
      /* By rejection *rate*, not by count: a tool that made ten thousand and scrapped four
         hundred is a worse tool than one that made a million and scrapped a thousand, and
         sorting by volume would put the big run on top every time and hide it. */
      .sort((a, b) => b.rejectionPercent - a.rejectionPercent);
  };

  /*
   * The Pareto. Counted across defects rather than pieces, which is why these can sum above the
   * reject total — one piece with a short shot and flash is two faults, and both are worth
   * fixing. Stated here so nobody reconciles the two columns and finds a bug that is not one.
   */
  const defects = new Map();
  for (const inspection of inspections) {
    for (const defect of inspection.defects) {
      const row = defects.get(defect.type) || { key: defect.type, count: 0, inspections: 0 };
      row.count += defect.count;
      row.inspections += 1;
      defects.set(defect.type, row);
    }
  }

  const byDefect = [...defects.values()]
    .map((row) => ({
      ...row,
      label: DEFECT_TYPES.find((d) => d.key === row.key)?.label || row.key,
      group: DEFECT_TYPES.find((d) => d.key === row.key)?.group || 'other',
    }))
    .sort((a, b) => b.count - a.count);

  /*
   * What the scrap cost, which is the figure management reacts to. Priced off the order line's
   * own rate rather than a costing, because the rate is what the piece would have sold for and
   * that is the money actually lost. Approximate by design — it is an order of magnitude to
   * argue about, not an accounting figure, and it says so on the screen.
   */
  const orders = await SalesOrder.find({
    _id: { $in: [...new Set(inspections.map((row) => String(row.order)))] },
  }).select('lines');

  const rateOf = new Map();
  for (const order of orders) {
    for (const line of order.lines) rateOf.set(String(line._id), line.unitPrice || 0);
  }
  const cost = inspections.reduce(
    (sum, row) => sum + (row.quantityRejected || 0) * (rateOf.get(String(row.line)) || 0),
    0
  );

  res.json({
    success: true,
    data: {
      byMould: tally((row) => row.mould && String(row.mould._id), (row) => row.mould?.mouldCode || '—').slice(0, 15),
      byDefect,
      byMaterial: tally(
        (row) => row.materialRef && String(row.materialRef._id),
        (row) => row.materialRef?.name || '—'
      ).slice(0, 10),
      byStage: tally((row) => row.stage, (row) => row.stage),
    },
    meta: {
      since, until,
      inspections: inspections.length,
      inspected,
      rejected,
      rejectionPercent: inspected ? Math.round((rejected / inspected) * 1000) / 10 : 0,
      costOfRejection: Math.round(cost),
      held: inspections.filter((row) => HOLDING_VERDICTS.includes(row.verdict)).length,
    },
  });
});

/**
 * Consignments that went out despite a failed or missing inspection.
 *
 * The report that makes a soft gate honest. The plant chose "warn, but let it go" over a hard
 * refusal, which is the better choice — it lets a real deadline through and leaves a trail —
 * but only while somebody can see how often the warning is overridden and by whom. Without this
 * list the warning is a dialog people learn to dismiss, and quality is decorative.
 */
export const listQualityOverrides = asyncHandler(async (req, res) => {
  const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 90 * 86400000);

  const overridden = await Dispatch.find({
    'qualityOverride.at': { $gte: since },
    ...ownershipFilter(req.user),
  })
    .populate([
      { path: 'customer', select: 'code name' },
      { path: 'order', select: 'number' },
      { path: 'qualityOverride.by', select: 'name' },
    ])
    .sort({ 'qualityOverride.at': -1 })
    .limit(200);

  res.json({
    success: true,
    data: overridden.map((dispatch) => ({
      _id: dispatch._id,
      number: dispatch.number,
      order: dispatch.order,
      customer: dispatch.customer,
      dispatchQty: dispatch.dispatchQty,
      dispatchDate: dispatch.dispatchDate,
      by: dispatch.qualityOverride?.by?.name || null,
      at: dispatch.qualityOverride?.at,
      concern: dispatch.qualityOverride?.concern,
      reason: dispatch.qualityOverride?.reason,
      link: `/dispatches/${dispatch._id}`,
    })),
    meta: { since, overrides: overridden.length },
  });
});
