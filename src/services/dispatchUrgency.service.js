import { PRE_LOAD_DISPATCH_STATUSES } from '../models/Dispatch.js';

/**
 * What the despatch team has to *do* about a consignment, and why.
 *
 * The sibling of `productionUrgency`, and deliberately built the same way — but the question it
 * answers is different in a way that matters. A press queue is ranked by what will miss, because
 * everything on it is the same kind of work: make pieces. A despatch queue is not. A consignment
 * waiting on an invoice, one sitting shippable on the floor, and one three days late on the road
 * need three unrelated actions from three different people, and the only useful ordering is by
 * *what to do next*, not by how bad it is.
 *
 * So the bands here are verbs rather than severities:
 *
 *   `chase`     gone, past the date it was promised. Ring the transporter.
 *   `blocked`   not gone, and cannot go — §19 paperwork missing. Get the document.
 *   `load`      not gone, and nothing is stopping it. Put it on a vehicle.
 *   `pod`       delivered, and the proof has not come back. Chase the receipt.
 *   `watch`     on the road and inside its date. Nothing to do today.
 *
 * `chase` leads because it is the only one with a customer already let down. `blocked` sits
 * above `load` because a blocked consignment needs somebody *else* to act — an invoice from
 * accounts, an LR from a transporter — and the sooner it is asked for the sooner it moves;
 * loading is entirely within the team's own hands and keeps.
 */

const BANDS = ['chase', 'blocked', 'load', 'pod', 'watch'];

/** After this long without a receipt, the POD is worth chasing rather than waiting for. */
export const POD_GRACE_DAYS = 3;

/** Whole days from now until a date; negative once it has gone by. */
function daysUntil(date, now) {
  if (!date) return null;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(0, 0, 0, 0);
  return Math.round((end - start) / 86400000);
}

const days = (count) => `${count} ${count === 1 ? 'day' : 'days'}`;

/** A list of missing paperwork as a sentence: "an invoice number and a transporter". */
const andList = (items) =>
  items.length <= 1 ? items[0] || '' : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/**
 * Where a consignment sits and what to do about it.
 *
 * Takes the document rather than a flattened row, because every judgement it makes is already a
 * virtual on the model — `isOverdue`, `outstandingPaperwork`, `shippable`, `daysSinceDispatch`.
 * Recomputing any of them here would be a second definition of the same rule, and the pair would
 * disagree the first time either changed.
 */
export function dispatchUrgencyOf(consignment, { now = new Date() } = {}) {
  const why = [];
  const late = daysUntil(consignment.expectedDeliveryDate, now);
  const preLoad = PRE_LOAD_DISPATCH_STATUSES.includes(consignment.status);

  /* Past its promised delivery and still not there. Nothing else on this screen outranks a
     customer who was given a date that has gone. */
  if (consignment.isOverdue) {
    why.push(
      late === -1
        ? 'Should have arrived yesterday'
        : `Should have arrived ${days(Math.abs(late))} ago`
    );
    if (consignment.transporter) why.push(`Ring ${consignment.transporter}`);
    return { band: 'chase', rank: 0, why, daysToDue: late };
  }

  /* Cannot go, and the missing thing is usually somebody else's to produce — so it is worth
     asking for before the vehicle is booked rather than after it is waiting. */
  if (preLoad && !consignment.shippable) {
    const missing = consignment.outstandingPaperwork;
    why.push(`Still needs ${andList(missing)}`);
    if (late !== null && late <= 2) {
      why.push(late < 0 ? 'And its delivery date has gone' : `Due to arrive in ${days(late)}`);
    }
    return { band: 'blocked', rank: 1, why, daysToDue: late };
  }

  /* Nothing is stopping it. This is the one band where the team can finish the job alone. */
  if (preLoad) {
    why.push('Paperwork is complete — put it on a vehicle');
    if (late !== null && late <= 3) {
      why.push(late <= 0 ? 'Due to arrive today' : `Due to arrive in ${days(late)}`);
    }
    return { band: 'load', rank: 2, why, daysToDue: late };
  }

  /* Delivered, but the receipt has not come back. Left long enough it stops being collectable,
     which is why it is on the screen at all rather than in a monthly report. */
  const since = consignment.daysSinceDispatch;
  if (consignment.status === 'pod_pending' || (consignment.status === 'delivered' && !consignment.pod?.attachment)) {
    if (since !== null && since >= POD_GRACE_DAYS) {
      why.push(`Delivered, no proof of delivery back after ${days(since)}`);
      return { band: 'pod', rank: 3, why, daysToDue: late };
    }
  }

  /* On the road, inside its date. Shown so the team can see the whole picture, and named as
     needing nothing so nobody spends attention working out that it does not. */
  if (consignment.hasLeft) {
    why.push(
      late === null
        ? 'On the road — no delivery date given'
        : late === 0
          ? 'Due to arrive today'
          : `Due to arrive in ${days(late)}`
    );
  }
  return { band: 'watch', rank: 4, why, daysToDue: late };
}

/**
 * Sorts consignments that already carry an `urgency`.
 *
 * Band first, then the soonest date. No quantity tie-break, unlike production: a lorry takes the
 * same afternoon to load whether it carries 5,000 pieces or 50,000, so ordering by size would
 * sort by something that costs the team nothing.
 */
export const byDispatchUrgency = (a, b) => {
  if (a.urgency.rank !== b.urgency.rank) return a.urgency.rank - b.urgency.rank;

  const left = a.urgency.daysToDue;
  const right = b.urgency.daysToDue;
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
};

/** The bands that need somebody to act today. `watch` is the whole of the rest. */
export const ACTIONABLE_BANDS = BANDS.filter((band) => band !== 'watch');
