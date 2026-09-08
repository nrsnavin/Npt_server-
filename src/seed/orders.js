import Customer from '../models/Customer.js';
import Mould from '../models/Mould.js';
import SalesOrder, { VERIFICATION_KEYS } from '../models/SalesOrder.js';
import Dispatch from '../models/Dispatch.js';
import OrderQuery from '../models/OrderQuery.js';
import Receivable from '../models/Receivable.js';
import { nextNumber } from '../services/numbering.service.js';
import { few } from './size.js';

/**
 * Sales orders, what the plant has made of them, and what has left the yard [§12–19].
 *
 * The phase that was missing, and its absence was not cosmetic: a freshly seeded database had
 * **no orders at all**, so production's day screen, despatch's day screen, the tracker and the
 * query threads all opened empty. Three modules that cannot be demonstrated, tested by hand, or
 * even eyeballed for a layout bug.
 *
 * A fixture for these two screens has to be built backwards from what they *say*, because both
 * are ranked by a judgement rather than sorted by a field. It is not enough to have orders; the
 * set has to contain one row that lands in each band, or the band's code path never runs against
 * anything and the screen looks finished while half of it has never been seen.
 *
 * So this file is laid out as the two screens read:
 *
 *   **Production** wants a line past its date, a line that will miss because there is more left
 *   than the days can carry, a line pulled up by marketing with a reason, and a calm one to sit
 *   underneath them.
 *
 *   **Despatch** wants a consignment to chase, one blocked on paperwork, one ready to load, one
 *   whose receipt has not come back — and, most importantly, **stock packed with nothing
 *   claiming it**, which is the case that appears on no other screen and is the reason that
 *   section exists.
 *
 * Written against the models rather than through the API, like every other seed phase. That
 * skips the §13 gate, so the released orders here set `verification`, `releasedBy` and
 * `releasedAt` exactly as the release action does — a fixture whose orders are released without
 * the checks recorded would show a plant working against orders that could never have reached
 * it, and the first person to open one would rightly not believe the screen.
 */

/** Days from now, at a sensible hour. Negative is the past. */
const days = (offset, hour = 17) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  date.setHours(hour, 0, 0, 0);
  return date;
};

/**
 * The §13 checklist as a released order carries it: eight ticks, each with a name and a time.
 *
 * `by` and `at` rather than eight booleans, because that is what the model stores and what the
 * screen prints. An order released with bare `true`s would render a checklist saying "checked by
 * nobody", which is exactly the thing §13 exists to make impossible.
 */
const verifiedBy = (user, when) =>
  Object.fromEntries(VERIFICATION_KEYS.map((key) => [key, { by: user._id, at: when }]));

export async function seedOrders({ priya, nandhini, arun, ramesh, anita }) {
  await Promise.all([
    SalesOrder.deleteMany({}),
    Dispatch.deleteMany({}),
    OrderQuery.deleteMany({}),
    Receivable.deleteMany({}),
  ]);

  const customers = await Customer.find({}).sort({ code: 1 });
  const moulds = await Mould.find({ isActive: { $ne: false } }).sort({ mouldCode: 1 });
  if (!customers.length || !moulds.length) return { orders: 0, dispatches: 0, queries: 0 };

  /* Cycled rather than indexed, so a trimmed register still fills every order. */
  const customer = (n) => customers[n % customers.length];
  const mould = (n) => moulds[n % moulds.length];

  /**
   * One order, released and with the plant's progress recorded against each line.
   *
   * `readyQty` is what despatch may claim and `producedQty` what came off the press; keeping
   * them distinct is what makes the ready-stock arithmetic mean anything, and setting them equal
   * everywhere would have hidden the one bug that matters — stock offered twice.
   */
  const book = async ({
    buyer, owner, lines, orderDate, priority, priorityReason, priorityBy, status = 'production_running',
  }) => {
    const when = orderDate || days(-20, 10);

    return SalesOrder.create({
      number: await nextNumber('SO'),
      orderDate: when,
      customer: buyer._id,
      assignedTo: owner._id,
      customerPo: { number: `PO/${buyer.code}/${String(Math.abs(when.getDate())).padStart(2, '0')}`, date: when },
      lines: lines.map((line) => ({
        mould: line.mould._id,
        modelNumber: line.modelNumber,
        colour: line.colour,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        deliveryDate: line.deliveryDate,
        production: {
          status: line.productionStatus || 'running',
          plannedQty: line.plannedQty ?? line.quantity,
          producedQty: line.producedQty ?? 0,
          readyQty: line.readyQty ?? 0,
          readyAt: line.readyQty ? days(-2, 11) : undefined,
          expectedCompletion: line.expectedCompletion,
          holdReason: line.holdReason,
        },
      })),
      gstPercent: 18,
      paymentTerms: '30 days from invoice',
      priority: priority || 'normal',
      priorityReason,
      priorityBy: priorityBy?._id,
      priorityAt: priority && priority !== 'normal' ? days(-1, 9) : undefined,
      verification: verifiedBy(priya, when),
      releasedBy: priya._id,
      releasedAt: when,
      status,
      statusHistory: [
        { to: 'po_received', at: when, by: priya._id },
        { to: 'approved_for_production', at: when, by: priya._id, note: 'All eight checks passed' },
        { to: status, at: when, by: ramesh._id },
      ],
    });
  };

  /* ---------------------------------------------------------------- *
   * What production's day screen has to show
   * ---------------------------------------------------------------- */

  const ORDERS = [
    /*
     * Past its date, with most of it still to make. The band nothing outranks — a promise the
     * plant has already broken, and the first thing a supervisor should see this morning.
     */
    {
      buyer: customer(0), owner: nandhini, orderDate: days(-32, 10),
      /*
       * 22,000 packed against 18,000 already claimed by the two consignments below, leaving
       * 4,000 free. Deliberately *partly* claimed: the ready-stock arithmetic is a subtraction,
       * and a fixture where every line is either wholly free or wholly gone never exercises it.
       */
      lines: [{
        mould: mould(0), modelNumber: 'NPT-400S', colour: 'White',
        quantity: 60000, unitPrice: 7.65, deliveryDate: days(-4),
        producedQty: 24000, readyQty: 22000,
      }],
    },

    /*
     * Not late, and cannot be finished: 85,000 to make against two days. The judgement the whole
     * production screen exists for, and the one a date sort cannot make — this line is in more
     * trouble than the late one above it and its date has not even passed.
     */
    {
      buyer: customer(1), owner: nandhini, orderDate: days(-12, 11),
      lines: [{
        mould: mould(1), modelNumber: 'NPT-420T', colour: 'Black',
        quantity: 95000, unitPrice: 8.35, deliveryDate: days(2),
        producedQty: 10000, readyQty: 8000,
      }],
    },

    /*
     * Calm on its own dates — six weeks out, 4,000 to make — and pulled to the top by marketing
     * with a reason. Exists so the lift is visible on the screen *and* so the row shows the
     * arithmetic underneath it: "due in 42 days, not pressing on its own dates" above "marketing
     * marked this critical". A screen that asserted the second without the first would be
     * telling a supervisor to move a job with no argument attached.
     */
    {
      buyer: customer(2), owner: nandhini, orderDate: days(-6, 15),
      priority: 'critical',
      priorityReason: 'First order from this buyer and they are visiting the plant on Monday',
      priorityBy: nandhini,
      lines: [{
        mould: mould(2), modelNumber: 'NPT-380S', colour: 'Ivory',
        quantity: 4000, unitPrice: 6.95, deliveryDate: days(42),
        producedQty: 0, readyQty: 0, productionStatus: 'scheduled',
      }],
    },

    /*
     * Held, which is its own kind of stuck: nothing is moving and the reason is on the record.
     * Two lines, because a multi-model order is where per-line production actually matters and a
     * fixture of single-line orders quietly never exercises it.
     */
    {
      buyer: customer(3), owner: arun, orderDate: days(-9, 12),
      lines: [
        {
          mould: mould(3), modelNumber: 'NPT-410V', colour: 'Grey',
          quantity: 30000, unitPrice: 7.10, deliveryDate: days(9),
          producedQty: 12000, readyQty: 9000,
        },
        {
          mould: mould(0), modelNumber: 'NPT-400S', colour: 'Navy',
          quantity: 20000, unitPrice: 7.40, deliveryDate: days(9),
          producedQty: 0, readyQty: 0,
          productionStatus: 'material_pending',
          holdReason: 'Navy masterbatch not in — supplier promised Thursday',
        },
      ],
    },

    /*
     * Finished and fully packed, with **no consignment against it**. The most valuable row in
     * this file: it is the case that appears on no screen but despatch's own, and it is how
     * stock sits on a floor for a fortnight against an order everybody believes is moving.
     */
    {
      buyer: customer(1), owner: nandhini, orderDate: days(-15, 9),
      status: 'production_completed',
      lines: [{
        mould: mould(2), modelNumber: 'NPT-380S', colour: 'White',
        quantity: 25000, unitPrice: 6.80, deliveryDate: days(3),
        producedQty: 25000, readyQty: 25000, productionStatus: 'completed',
      }],
    },

    /* An ordinary line, comfortably inside its date, so the screen has a "coming up" to show
       and the pressing groups are not the whole page. */
    {
      buyer: customer(0), owner: arun, orderDate: days(-3, 14),
      /* 3,000 packed, 2,000 of it on the lorry below. Nothing may be claimed off a line with
         nothing packed — `assertClaimable` refuses it through the API, and a fixture that wrote
         it directly would show the plant a consignment that could never have been raised. */
      lines: [{
        mould: mould(1), modelNumber: 'NPT-420T', colour: 'Beige',
        quantity: 18000, unitPrice: 8.10, deliveryDate: days(21),
        producedQty: 4000, readyQty: 3000, productionStatus: 'running',
      }],
    },
  ];

  const orders = [];
  for (const spec of few(ORDERS, 6)) orders.push(await book(spec));

  /* ---------------------------------------------------------------- *
   * What despatch's day screen has to show
   * ---------------------------------------------------------------- */

  const PAPERWORK = (n) => ({
    invoice: { number: `NPT/26-27/${String(1200 + n)}`, date: days(-3, 11), value: 180000 + n * 15000 },
    transporter: 'KPN Roadways',
    lrNumber: `LR-${88200 + n}`,
    destination: {
      address: '14 Avinashi Road, Perumanallur',
      city: 'Tiruppur',
      state: 'Tamil Nadu',
      pincode: '641666',
      contactName: 'Stores in-charge',
      contactMobile: '9840011224',
    },
  });

  /**
   * One consignment against one line of one order.
   *
   * The model number and colour are copied onto the line rather than looked up, exactly as the
   * controller does: a delivery note says what went on the lorry and has to keep saying it.
   */
  const load = async ({ order, lineIndex = 0, quantity, status, papers, dispatchDate, expectedDeliveryDate, deliveredAt, remarks }) => {
    const line = order.lines[lineIndex];

    return Dispatch.create({
      number: await nextNumber('DSP'),
      order: order._id,
      customer: order.customer,
      assignedTo: order.assignedTo,
      raisedBy: anita._id,
      lines: [{
        orderLine: line._id,
        mould: line.mould,
        modelNumber: line.modelNumber,
        colour: line.colour,
        quantity,
        cartons: Math.ceil(quantity / 200),
      }],
      ...(papers || {}),
      dispatchDate,
      expectedDeliveryDate,
      deliveredAt,
      remarks,
      status,
      statusHistory: [{ to: 'dispatch_request_received', at: days(-6, 10), by: anita._id }],
    });
  };

  const dispatches = [];

  if (orders[0]) {
    /*
     * On the road and past the day the customer was promised. The only despatch band with a
     * buyer already let down, so it leads the screen — and it carries a transporter, because the
     * useful row says who to ring rather than that something is late.
     */
    dispatches.push(await load({
      order: orders[0], quantity: 12000, status: 'dispatched',
      papers: PAPERWORK(1),
      dispatchDate: days(-6, 16), expectedDeliveryDate: days(-2),
    }));
  }

  if (orders[1]) {
    /*
     * Raised with nothing filled in, so it cannot go. Sits above "ready to load" deliberately:
     * the missing invoice has to be asked for from somebody else, and the asking is what takes
     * the day, while loading is in the team's own hands and keeps until the afternoon.
     */
    dispatches.push(await load({
      order: orders[1], quantity: 8000, status: 'invoice_preparation',
      expectedDeliveryDate: days(4),
      remarks: 'Buyer wants this split — balance to follow next week.',
    }));
  }

  if (orders[3]) {
    /* Papers complete, nothing stopping it. The one band the team can finish alone. */
    dispatches.push(await load({
      order: orders[3], quantity: 9000, status: 'ready_to_load',
      papers: PAPERWORK(2), expectedDeliveryDate: days(3),
    }));
  }

  if (orders[0]) {
    /*
     * Delivered a week ago with no signed copy back. Left long enough it stops being
     * collectable, which is why it is on the day screen rather than in a monthly report.
     */
    dispatches.push(await load({
      order: orders[0], quantity: 6000, status: 'pod_pending',
      papers: PAPERWORK(3),
      dispatchDate: days(-9, 15), expectedDeliveryDate: days(-6), deliveredAt: days(-6, 12),
    }));
  }

  if (orders[5]) {
    /* On the road, inside its date. Nothing to do — shown so the team can see the whole
       picture, and named as needing nothing so nobody spends attention working that out. */
    dispatches.push(await load({
      order: orders[5], quantity: 2000, status: 'dispatched',
      papers: PAPERWORK(4),
      dispatchDate: days(-1, 17), expectedDeliveryDate: days(4),
    }));
  }

  /* ---------------------------------------------------------------- *
   * The questions marketing is waiting on
   * ---------------------------------------------------------------- */

  const ask = async ({ order, askedOf, question, urgency = 'normal', dispatch, raisedBy, dueBy, answers, status = 'open' }) =>
    OrderQuery.create({
      number: await nextNumber('QRY'),
      order: order._id,
      dispatch: dispatch?._id,
      raisedBy: raisedBy._id,
      askedOf,
      question,
      urgency,
      dueBy,
      status,
      answers: answers || [],
      createdAt: dueBy ? new Date(dueBy.getTime() - 4 * 3600 * 1000) : undefined,
    });

  const queries = [];

  if (orders[1]) {
    /* Overdue, so despatch's and production's screens both lead with an unanswered question
       rather than with their own work — there is a buyer on the phone behind this one. */
    queries.push(await ask({
      order: orders[1], askedOf: 'production', raisedBy: nandhini, urgency: 'urgent',
      question: 'Buyer is asking whether the first 20,000 can be ready this week. Can we commit?',
      dueBy: days(-1, 9),
    }));
  }

  if (orders[0] && dispatches[0]) {
    /*
     * Scoped to a consignment, which is the case the plain order-level question cannot serve: on
     * an order already sent in two loads, "where is the vehicle" is unanswerable without knowing
     * which — and a confident answer about the wrong lorry gets relayed to the buyer.
     */
    queries.push(await ask({
      order: orders[0], askedOf: 'despatch', raisedBy: nandhini, urgency: 'urgent',
      dispatch: dispatches[0],
      question: 'This one should have arrived on Tuesday — where has the lorry got to?',
      dueBy: days(0, 9),
    }));
  }

  if (orders[3]) {
    queries.push(await ask({
      order: orders[3], askedOf: 'production', raisedBy: arun,
      question: 'When is the navy masterbatch expected? The buyer wants a firm date.',
      dueBy: days(1, 12),
    }));
  }

  if (orders[4]) {
    /* Answered but not closed, so the "answered, waiting on the asker" half of the thread is
       visible too — the state that exists precisely because an answer may not have answered. */
    queries.push(await ask({
      order: orders[4], askedOf: 'despatch', raisedBy: nandhini, status: 'answered',
      question: 'All 25,000 are packed — can they go on Friday\'s vehicle?',
      dueBy: days(-2, 15),
      answers: [{
        body: 'Friday is full. Booking a separate lorry for Monday morning — will confirm the LR.',
        by: anita._id,
        at: days(-2, 16),
      }],
    }));
  }

  /* ---------------------------------------------------------------- *
   * What is owed, and the state of the chase [§20, §25]
   * ---------------------------------------------------------------- */

  /*
   * Built band by band, the same way the consignments above were, and for the same reason: the
   * chase screen groups by *which conversation this is* rather than sorting by a field, so a
   * fixture without a row in each group leaves half the screen never rendered against anything.
   *
   * The four conversations, in the order the screen puts them:
   *
   *   **A broken promise** — they named a day and it has gone. The only call that opens with
   *   something to hold the buyer to, which is why it leads.
   *   **Overdue and never promised** — nobody has got a commitment out of them yet.
   *   **Due this week** — the cheap call, made before it is late.
   *   **Promised and still ahead** — nothing to do, shown so nobody rings them by mistake.
   *
   * Plus a part-paid one, because a balance that is neither nothing nor the whole invoice is
   * where an off-by-one in the arithmetic hides, and an advance, because it is the same object
   * with no consignment behind it and the screen has to read it as ordinary.
   */

  const owe = async ({ kind = 'invoice', order, dispatch, value, dueBy, owner, receipts, followUps, judgement, judgementNote }) =>
    Receivable.create({
      number: await nextNumber('RCV'),
      kind,
      customer: order.customer,
      order: order._id,
      dispatch: dispatch?._id,
      assignedTo: owner._id,
      invoice: dispatch
        ? { number: dispatch.invoice?.number, date: dispatch.invoice?.date, value }
        : { value, date: days(-2, 11) },
      dueBy,
      receipts: receipts || [],
      followUps: followUps || [],
      judgement,
      judgementNote,
    });

  const receivables = [];

  if (orders[0] && dispatches[0]) {
    /* The broken promise. Said Friday, Friday has gone, and the note is what the next caller
       opens with — the whole argument for recording who was spoken to. */
    receivables.push(await owe({
      order: orders[0], dispatch: dispatches[0], value: 215000,
      dueBy: days(-24, 23), owner: nandhini,
      followUps: [
        {
          at: days(-12, 11), by: nandhini._id, spokeTo: 'Mr Ravi, accounts',
          note: 'Says the invoice is in their approval queue and will move this week.',
        },
        {
          at: days(-5, 16), by: nandhini._id, spokeTo: 'Mr Ravi, accounts',
          note: 'Promised the full amount by Friday. Says the cheque is signed.',
          promisedDate: days(-2, 17), promisedAmount: 215000,
        },
      ],
    }));
  }

  if (orders[0] && dispatches[1]) {
    /* Overdue, and nobody has rung them. The group that exists to show what has been neglected
       rather than what has been chased and failed. */
    receivables.push(await owe({
      order: orders[0], dispatch: dispatches[1], value: 168000,
      dueBy: days(-9, 23), owner: nandhini,
    }));
  }

  if (orders[5] && dispatches[dispatches.length - 1]) {
    /* Part paid, and due in a few days — the cheap call. Two receipts rather than one, because
       a single receipt equal to half the invoice is a case that passes even when the sum is
       written as an assignment. */
    receivables.push(await owe({
      order: orders[5], dispatch: dispatches[dispatches.length - 1], value: 240000,
      dueBy: days(4, 23), owner: nandhini,
      receipts: [
        { amount: 60000, receivedAt: days(-8, 10), mode: 'neft', reference: 'UTR 4471900231', recordedBy: priya._id },
        { amount: 45000, receivedAt: days(-3, 10), mode: 'neft', reference: 'UTR 4472118844', recordedBy: priya._id },
      ],
    }));
  }

  if (orders[1]) {
    /*
     * Promised and still ahead of the day. Nothing to do today, and the screen says so — a row
     * somebody rings anyway is a row that teaches the buyer the promise did not matter.
     *
     * Deliberately more than a week out. The groups are mutually exclusive and `soon` takes
     * everything falling due inside seven days *before* `promised` is considered, so an advance
     * due on day six lands in the wrong band however firm the promise against it — which is
     * what the first version of this fixture did.
     */
    receivables.push(await owe({
      order: orders[1], value: 96000, kind: 'advance',
      dueBy: days(14, 23), owner: arun,
      followUps: [{
        at: days(-1, 15), by: arun._id, spokeTo: 'Mrs Latha',
        note: 'Advance against the PO. Confirmed it goes out with their Tuesday run.',
        promisedDate: days(12, 17), promisedAmount: 96000,
      }],
    }));
  }

  if (orders[3]) {
    /* Disputed, which is the one state that stops the ladder. Overdue by a month and escalating
       to nobody, because somebody has decided that conversation is happening elsewhere — the
       case that proves the judgement is doing something rather than decorating a row. */
    receivables.push(await owe({
      order: orders[3], value: 74000,
      dueBy: days(-31, 23), owner: arun,
      judgement: 'disputed',
      judgementNote: 'Short by 400 pieces on their count. Warehouse is recounting.',
      followUps: [{
        at: days(-20, 12), by: arun._id, spokeTo: 'Purchase office',
        note: 'They are holding the whole invoice over a 400-piece shortfall. Escalated to their buyer.',
      }],
    }));
  }

  return {
    orders: orders.length,
    lines: orders.reduce((sum, order) => sum + order.lines.length, 0),
    dispatches: dispatches.length,
    queries: queries.length,
    receivables: receivables.length,
    /* Counted rather than stated: the fixture moves and a hard-coded figure would drift. */
    owed: Math.round(receivables.reduce((sum, row) => sum + row.balance, 0)),
    /* Counted from the fixture rather than stated, so the summary cannot drift from the data. */
    unclaimed: orders.reduce(
      (sum, order) =>
        sum + order.lines.reduce((lineSum, line) => lineSum + (line.production?.readyQty || 0), 0),
      0
    ),
  };
}
