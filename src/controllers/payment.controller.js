import { applyPaymentPositions } from '../services/paymentPosition.service.js';
import { withOrderLock } from '../services/operationLock.service.js';
import Receivable, { JUDGED_STATUSES } from '../models/Receivable.js';
import SalesOrder from '../models/SalesOrder.js';
import Customer from '../models/Customer.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { nextNumber } from '../services/numbering.service.js';
import { listParams, paginated } from '../utils/query.js';
import { recordChange, snapshot } from '../services/audit.service.js';
import { ownershipFilter, ownsRecord } from '../services/ownership.service.js';
import { raiseTask } from '../services/task.service.js';
import { dueDateFor, orderPosition } from '../services/receivable.service.js';

/**
 * Payments [BLUEPRINT §20, §25].
 *
 * A chase, not a ledger — see the model. Two departments work this file and they are not the
 * same people: a **separate payments team** owns the record and the receipts, and **marketing**
 * chases too, because the buyer knows their marketing person and takes their call. So a
 * follow-up may be logged by either, and both see the same list scoped to what they own.
 *
 * The receipts are the one thing only accounts writes. That is not a status distinction — it is
 * that a payment marked received is a claim about a bank account, and the person who can check
 * the bank account should be the person who makes it.
 */

const POPULATE = [
  { path: 'customer', select: 'code name city mobile creditTermsDays paymentTerms' },
  { path: 'order', select: 'number customerPo' },
  { path: 'dispatch', select: 'number lrNumber dispatchDate' },
  { path: 'assignedTo', select: 'name' },
  { path: 'followUps.by', select: 'name' },
  { path: 'receipts.recordedBy', select: 'name' },
];

/** Refuses a receivable the caller may not see, in the shape reading it would take. */
async function readable(id, user) {
  const receivable = await Receivable.findById(id).populate(POPULATE);
  if (!receivable) throw ApiError.notFound('Nothing owed under that reference');
  if (!ownsRecord(user, receivable)) throw ApiError.notFound('Nothing owed under that reference');
  await applyPaymentPositions([receivable]);
  return receivable;
}

/* --------------------------------- Reading --------------------------------- */

export const listReceivables = asyncHandler(async (req, res) => {
  const { page, limit, sort, filter } = listParams(req.query, {
    searchFields: ['number', 'invoice.number'],
    /* Soonest first, because a chase list is worked from the top and the top is what is oldest
       against a promise somebody made. */
    defaultSort: 'dueBy',
  });

  Object.assign(filter, ownershipFilter(req.user));
  if (req.query.customer) filter.customer = req.query.customer;
  if (req.query.order) filter.order = req.query.order;
  if (req.query.kind) filter.kind = req.query.kind;

  const [rows, total] = await Promise.all([
    Receivable.find(filter).populate(POPULATE).sort(sort).skip((page - 1) * limit).limit(limit),
    Receivable.countDocuments(filter),
  ]);

  /*
   * The open set, not this page. `balance` and `state` are virtuals, so "what is still owed"
   * cannot be a database filter — and a headline computed over one page would change when
   * somebody turned it, which reads as the debt changing.
   */
  const open = await Receivable.find(filter);
  await applyPaymentPositions(open);
  const positions = new Map(open.map(row => [String(row._id), row.$locals]));
  for (const row of rows) Object.assign(row.$locals, positions.get(String(row._id)));
  const owing = open.filter((row) => row.balance > 0);

  paginated(res, rows, { page, limit, total }, {
    meta: {
      open: owing.length,
      outstanding: Math.round(owing.reduce((sum, row) => sum + row.balance, 0)),
      overdue: owing.filter((row) => row.isOverdue).length,
      overdueValue: Math.round(
        owing.filter((row) => row.isOverdue).reduce((sum, row) => sum + row.balance, 0)
      ),
      brokenPromises: owing.filter((row) => row.promise?.broken).length,
    },
  });
});

export const getReceivable = asyncHandler(async (req, res) => {
  const receivable = await readable(req.params.id, req.user);
  res.json({
    success: true,
    data: receivable,
    /* The order's whole position beside this one invoice, with advances netted — the number the
       buyer will quote back on the phone is what they owe on the order, not on one document. */
    order: await orderPosition(receivable.order._id || receivable.order),
  });
});

/**
 * The chase, as a day's work.
 *
 * Ordered by what the caller should do rather than by how much is owed, because a chase list
 * sorted by value has the biggest customer at the top every morning whether or not anything has
 * changed. The groups are the four different conversations:
 *
 *   **Broken promises** — they said a date and it has gone. The call that has to be made today,
 *   and the only one where the chaser starts with something to hold the buyer to.
 *   **Overdue, never promised** — nobody has got a commitment yet.
 *   **Due this week** — the cheap call, before it is late.
 *   **Promised, still ahead** — nothing to do, shown so nobody rings them by mistake.
 */
export const paymentDay = asyncHandler(async (req, res) => {
  const rows = await Receivable.find(ownershipFilter(req.user))
    .populate([
      { path: 'customer', select: 'code name mobile' },
      { path: 'order', select: 'number' },
      { path: 'assignedTo', select: 'name' },
      { path: 'followUps.by', select: 'name' },
    ]);
  await applyPaymentPositions(rows);

  const owing = rows.filter((row) => row.balance > 0 && !row.judgement);

  const card = (receivable) => ({
    _id: receivable._id,
    number: receivable.number,
    kind: receivable.kind,
    invoiceNumber: receivable.invoice?.number,
    customer: receivable.customer,
    order: receivable.order,
    owner: receivable.assignedTo?.name || null,
    value: receivable.invoice?.value || 0,
    received: receivable.received,
    advanceApplied: receivable.advanceApplied,
    balance: receivable.balance,
    dueBy: receivable.dueBy,
    daysToDue: receivable.daysToDue,
    state: receivable.state,
    promise: receivable.promise,
    lastFollowUp: receivable.lastFollowUp
      ? {
          at: receivable.lastFollowUp.at,
          by: receivable.lastFollowUp.by?.name || null,
          spokeTo: receivable.lastFollowUp.spokeTo,
          note: receivable.lastFollowUp.note,
        }
      : null,
    link: `/payments/${receivable._id}`,
  });

  /* Oldest debt first inside every group: the longest-standing is the hardest to collect, and
     it gets harder. */
  const oldest = (a, b) => new Date(a.dueBy) - new Date(b.dueBy);

  /**
   * How old the overdue money is, in the four bands every ledger uses.
   *
   * "₹3,83,000 overdue" is one number that answers the wrong question. Three lakh a fortnight
   * late is a chasing problem; the same three lakh four months late is a provisioning problem,
   * and the two want different work out of the same person. The groups above sort the calls by
   * *what to say*; this sorts the money by *how bad it has got*, which is the figure management
   * asks for and the one nobody could get out of this screen.
   *
   * Counted against the same rows as `overdueValue`, so the bands always add up to it.
   */
  const ageingOf = (rows) => {
    const bands = [
      { key: 'to30', label: 'Up to 30 days', within: (late) => late <= 30 },
      { key: 'to60', label: '31 to 60 days', within: (late) => late <= 60 },
      { key: 'to90', label: '61 to 90 days', within: (late) => late <= 90 },
      { key: 'over90', label: 'Over 90 days', within: () => true },
    ];

    return bands.map(({ key, label, within }, index) => {
      const inBand = rows.filter((row) => {
        const late = -(row.daysToDue ?? 0);
        return within(late) && (index === 0 || late > [30, 60, 90][index - 1]);
      });

      return {
        key,
        label,
        count: inBand.length,
        value: Math.round(inBand.reduce((sum, row) => sum + row.balance, 0)),
      };
    });
  };

  const broken = owing.filter((row) => row.promise?.broken).sort(oldest);
  const brokenIds = new Set(broken.map((row) => String(row._id)));

  const overdue = owing
    .filter((row) => row.isOverdue && !brokenIds.has(String(row._id)))
    .sort(oldest);
  const chasing = new Set([...brokenIds, ...overdue.map((row) => String(row._id))]);

  const soon = owing
    .filter((row) => !chasing.has(String(row._id)) && (row.daysToDue ?? 99) <= 7)
    .sort(oldest);
  const settled = new Set([...chasing, ...soon.map((row) => String(row._id))]);

  const promised = owing
    .filter((row) => !settled.has(String(row._id)) && row.promise)
    .sort(oldest);

  res.json({
    success: true,
    data: {
      broken: broken.map(card),
      overdue: overdue.map(card),
      soon: soon.map(card),
      promised: promised.map(card),
    },
    meta: {
      open: owing.length,
      outstanding: Math.round(owing.reduce((sum, row) => sum + row.balance, 0)),
      overdue: broken.length + overdue.length,
      overdueValue: Math.round(
        [...broken, ...overdue].reduce((sum, row) => sum + row.balance, 0)
      ),
      broken: broken.length,
      soon: soon.length,
      ageing: ageingOf([...broken, ...overdue]),
      /* Advances still to arrive, which is money owed before anything has shipped. */
      awaitingAdvance: Math.round(
        owing.filter((row) => row.kind === 'advance').reduce((sum, row) => sum + row.balance, 0)
      ),
    },
  });
});

/* --------------------------------- Writing --------------------------------- */

/**
 * The advance a buyer owes before anything is made.
 *
 * Raised by hand rather than derived, because the trigger is a commercial agreement rather than
 * an event the system sees: §20's terms are free text ("30% with the PO"), and reading a
 * percentage out of a sentence is the kind of cleverness that is right nine times and books the
 * wrong number the tenth. The person typing it has the PO in front of them.
 */
export const raiseAdvance = asyncHandler(withOrderLock(req => req.params.id, async (req, res) => {
  const order = await SalesOrder.findById(req.params.id);
  if (!order) throw ApiError.notFound('Order not found');
  if (!ownsRecord(req.user, order)) throw ApiError.notFound('Order not found');

  const existing = await Receivable.findOne({ order: order._id, kind: 'advance' });
  if (existing) throw ApiError.conflict('An advance is already recorded against this order', { existing: existing.number });

  const customer = await Customer.findById(order.customer).select('creditTermsDays assignedTo');

  let receivable;
  try {
    receivable = await Receivable.create({
      number: await nextNumber('RCV'),
      kind: 'advance',
      customer: order.customer,
      order: order._id,
      assignedTo: order.assignedTo || customer?.assignedTo,
      invoice: { value: req.body.amount, date: new Date() },
      /* Advances are due when they are due — usually now, sometimes a named date on the PO — so
         the caller may say, and the credit terms are not applied: they govern invoices, not the
         money taken before the work starts. */
      dueBy: req.body.dueBy ? new Date(req.body.dueBy) : dueDateFor(new Date(), 0),
    });
  } catch (error) {
    /*
     * The read above lost a race — two people raising the advance in the same instant both saw
     * none. The unique index is what turns that into this branch instead of an order carrying
     * two advances, and the answer is the same one the read would have given.
     */
    if (error?.code === 11000) {
      const already = await Receivable.findOne({ order: order._id, kind: 'advance' });
      throw ApiError.conflict('An advance is already recorded against this order', {
        existing: already?.number,
      });
    }
    throw error;
  }

  await applyPaymentPositions([receivable]);
  res.status(201).json({ success: true, data: await receivable.populate(POPULATE) });
}));

/**
 * A conversation, logged.
 *
 * Either department may log one — accounts owns the record, marketing is who the buyer takes a
 * call from, and a chase where only one of them can write is a chase where the other rings
 * anyway and nobody knows.
 *
 * `promisedDate` is what makes this a chase rather than a log. Recording it means the next
 * caller opens with "you said Friday" instead of starting the same conversation again.
 */
export const logFollowUp = asyncHandler(async (req, res) => {
  const receivable = await readable(req.params.id, req.user);

  receivable.followUps.push({
    by: req.user._id,
    at: req.body.at || new Date(),
    spokeTo: req.body.spokeTo,
    note: req.body.note,
    promisedDate: req.body.promisedDate,
    promisedAmount: req.body.promisedAmount,
  });

  await receivable.save();

  /*
   * A promise gets a task on the day it falls due, for whoever logged it. Without this the
   * promise is a note somebody has to remember to go back and read — which is exactly the
   * failure the whole module exists to fix, reproduced one level down.
   */
  if (req.body.promisedDate) {
    await raiseTask({
      user: req.user._id,
      title: `${receivable.customer?.name || 'A customer'} promised payment today`,
      notes:
        `${receivable.invoice?.number || receivable.number} · ₹${Math.round(receivable.balance).toLocaleString('en-IN')}` +
        `${req.body.spokeTo ? ` · spoke to ${req.body.spokeTo}` : ''}`,
      dueDate: new Date(req.body.promisedDate),
      link: `/payments/${receivable._id}`,
      originKey: `payment-promise:${receivable._id}:${new Date(req.body.promisedDate).toISOString().slice(0, 10)}`,
    }).catch(() => null);
  }

  await receivable.populate(POPULATE);
  res.status(201).json({ success: true, data: receivable });
});

/**
 * Money in — accounts only, and that is not a status distinction.
 *
 * A receipt is a claim about a bank account, and the person who can look at the bank account
 * should be the one making it. Marketing chasing a buyer who says "we paid on Tuesday" records
 * that as a *follow-up*, which is what it is: something they were told, not something anybody
 * has seen.
 */
export const recordReceipt = asyncHandler(withOrderLock(async req => (await Receivable.findById(req.params.id).select('order'))?.order || req.params.id, async (req, res) => {
  const receivable = await readable(req.params.id, req.user);

  const key = req.body.idempotencyKey;
  const reference = req.body.reference?.trim();
  const duplicate = receivable.receipts.find(row => key ? row.idempotencyKey === key : reference && row.reference === reference && row.mode === (req.body.mode || 'neft') && row.amount === req.body.amount);
  if (duplicate) {
    if (duplicate.amount !== req.body.amount || duplicate.mode !== (req.body.mode || 'neft') || (duplicate.reference || '') !== (reference || '') ||
        (req.body.receivedAt && +duplicate.receivedAt !== +new Date(req.body.receivedAt)) || (duplicate.note || '') !== (req.body.note?.trim() || '')) throw ApiError.conflict('This payment operation was already used with different details.');
    return res.json({ success: true, data: receivable, replayed: true });
  }
  if (req.body.amount > receivable.receiptable) {
    throw ApiError.badRequest(
      `That is more than the ₹${Math.round(receivable.balance).toLocaleString('en-IN')} still owed on this one — ` +
        'record the rest against the invoice it belongs to'
    );
  }

  const before = snapshot(receivable);

  receivable.receipts.push({
    idempotencyKey: key,
    amount: req.body.amount,
    receivedAt: req.body.receivedAt || new Date(),
    mode: req.body.mode,
    reference: req.body.reference,
    note: req.body.note,
    recordedBy: req.user._id,
  });

  await applyPaymentPositions([receivable]);

  /* Settled: the ladder stops, and a re-opened balance starts it again from wherever it stands
     rather than from where it left off. */
  if (receivable.balance <= 0) receivable.escalationLevel = 0;

  await receivable.save();
  /* `doc`, not `documentId` — the service snapshots the document itself and takes its id from
     it. Passing the id instead threw inside `recordChange`, whose catch is there so that a
     failed audit cannot fail the write it describes: the receipt saved, the trail did not, and
     nothing said so. */
  await recordChange({
    model: 'Receivable', doc: receivable, before,
    by: req.user, note: `Received ₹${Math.round(req.body.amount).toLocaleString('en-IN')}`,
  });

  /*
   * The owner is told when it is settled, and only then. §31 warns against overload: a marketing
   * person does not need every part payment, but "this one is closed" is what stops them ringing
   * a buyer who has already paid.
   */
  if (receivable.balance <= 0) {
    await raiseTask({
      user: receivable.assignedTo,
      title: `Paid: ${receivable.customer?.name || 'a customer'} — ${receivable.invoice?.number || receivable.number}`,
      notes: `₹${Math.round(receivable.invoice?.value || 0).toLocaleString('en-IN')} settled in full.`,
      dueDate: new Date(),
      link: `/payments/${receivable._id}`,
      originKey: `payment-settled:${receivable._id}`,
    }).catch(() => null);
  }

  await receivable.populate(POPULATE);
  res.status(201).json({ success: true, data: receivable });
}));

/**
 * Marking one disputed or on hold, and clearing it again.
 *
 * The only two states a person sets — everything else is arithmetic. Both stop the escalation
 * ladder, because chasing a buyer for money they are arguing about turns a commercial
 * disagreement into a relationship one, and somebody has decided that conversation is happening
 * elsewhere.
 *
 * Clearing it returns the receivable to whatever the dates actually say rather than to a
 * remembered status, which is why the judgement is a field of its own and not an overwrite.
 */
export const setJudgement = asyncHandler(async (req, res) => {
  const receivable = await readable(req.params.id, req.user);
  const before = snapshot(receivable);

  const { judgement, note } = req.body;
  if (judgement && !JUDGED_STATUSES.includes(judgement)) {
    throw ApiError.badRequest('That is not something a receivable can be put on');
  }

  receivable.judgement = judgement || undefined;
  receivable.judgementNote = judgement ? note : undefined;
  /* Held then released: the ladder restarts from where the dates now put it, so a month spent
     in dispute does not fire four tiers the moment it clears. */
  if (!judgement) receivable.escalationLevel = 0;

  await receivable.save();
  await recordChange({
    model: 'Receivable', doc: receivable, before,
    by: req.user, note: judgement ? `${judgement}: ${note}` : 'Dispute cleared',
  });

  await receivable.populate(POPULATE);
  res.json({ success: true, data: receivable });
});
