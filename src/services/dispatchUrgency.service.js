import { PRE_LOAD_DISPATCH_STATUSES } from '../models/Dispatch.js';
import { ORDER_PRIORITY_LEVELS } from '../models/SalesOrder.js';

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
 *
 * **Marketing's priority orders a band; it never moves a consignment between them.** This is
 * the one place this ranking deliberately parts company with production's, and the reason is
 * the bands above. Production's are severities, so lifting a line up one is coherent — it is
 * saying "this matters more than I first said". These are verbs. Lifting a consignment out of
 * `load` and into `chase` would tell a clerk to ring a transporter about goods that have not
 * left the yard, which is not an instruction, it is a contradiction. So a critical consignment
 * is the first thing you load rather than something other than a thing you load.
 *
 * **And the date it is judged against is the customer's, when there is one.** See `dueDate` on
 * the model: a promise made on the phone outranks the plant's own estimate, because the promise
 * is what somebody is let down by.
 */

const BANDS = ['chase', 'blocked', 'load', 'pod', 'watch'];

/**
 * How far up its own band a priority pulls a consignment. Ordering only — see the note above.
 *
 * Read off the order's own levels rather than redefined here, so `critical` cannot come to mean
 * one thing on the press queue and another on the loading bay.
 */
const liftOf = (priority) =>
  ORDER_PRIORITY_LEVELS.find((level) => level.key === priority)?.lift || 0;

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
export function dispatchUrgencyOf(consignment, { now = new Date(), priority = 'normal' } = {}) {
  const why = [];
  /* The customer's date when one was given, the plant's estimate otherwise — see `dueDate`. */
  const late = daysUntil(consignment.dueDate, now);
  const promised = consignment.dueDateIsPromise;
  const preLoad = PRE_LOAD_DISPATCH_STATUSES.includes(consignment.status);

  /**
   * Everything a row needs to explain itself, whatever band it lands in.
   *
   * The priority travels out with the verdict rather than being looked up again by the screen:
   * a badge that says "critical" beside a row ordered as though it were normal is worse than no
   * badge, and two lookups of the same fact is how that happens.
   */
  const verdict = (band, rank) => ({
    band,
    rank,
    why,
    daysToDue: late,
    priority,
    lift: liftOf(priority),
    promised,
    promiseNote: promised ? consignment.promise?.note || null : null,
  });

  /* Past the date it was given and still not there. Nothing else on this screen outranks a
     customer who was promised a day that has gone. */
  if (consignment.isOverdue) {
    const ago = late === -1 ? 'yesterday' : `${days(Math.abs(late))} ago`;
    /*
     * Named as the customer's when it is the customer's. "Should have arrived yesterday" reads
     * as a logistics estimate slipping; "Promised to the customer yesterday" is a person having
     * to make a phone call, and the difference decides which of these gets done first.
     */
    why.push(promised ? `Promised to the customer ${ago}` : `Should have arrived ${ago}`);
    if (promised && consignment.promise?.note) why.push(consignment.promise.note);
    if (consignment.transporter) why.push(`Ring ${consignment.transporter}`);
    return verdict('chase', 0);
  }

  /* Cannot go, and the missing thing is usually somebody else's to produce — so it is worth
     asking for before the vehicle is booked rather than after it is waiting. */
  if (preLoad && !consignment.shippable) {
    const missing = consignment.outstandingPaperwork;
    why.push(`Still needs ${andList(missing)}`);
    if (late !== null && late <= 2) {
      why.push(
        late < 0
          ? promised ? 'And the date the customer was given has gone' : 'And its delivery date has gone'
          : promised ? `Promised in ${days(late)}` : `Due to arrive in ${days(late)}`
      );
    }
    if (promised && consignment.promise?.note) why.push(consignment.promise.note);
    return verdict('blocked', 1);
  }

  /* Nothing is stopping it. This is the one band where the team can finish the job alone. */
  if (preLoad) {
    why.push('Paperwork is complete — put it on a vehicle');
    if (late !== null && late <= 3) {
      why.push(
        late <= 0
          ? promised ? 'Promised to the customer today' : 'Due to arrive today'
          : promised ? `Promised in ${days(late)}` : `Due to arrive in ${days(late)}`
      );
    }
    if (promised && consignment.promise?.note) why.push(consignment.promise.note);
    return verdict('load', 2);
  }

  /* Delivered, but the receipt has not come back. Left long enough it stops being collectable,
     which is why it is on the screen at all rather than in a monthly report. */
  const since = consignment.daysSinceDispatch;
  if (consignment.status === 'pod_pending' || (consignment.status === 'delivered' && !consignment.pod?.attachment)) {
    if (since !== null && since >= POD_GRACE_DAYS) {
      why.push(`Delivered, no proof of delivery back after ${days(since)}`);
      return verdict('pod', 3);
    }
  }

  /* On the road, inside its date. Shown so the team can see the whole picture, and named as
     needing nothing so nobody spends attention working out that it does not. */
  if (consignment.hasLeft) {
    /*
     * Arrived or still travelling — and the two must not share a sentence.
     *
     * `hasLeft` is every status past the gate, delivery included, so a consignment the customer
     * already had was being told "Due to arrive in 2 days" off its original estimate. The
     * estimate is a fact about a journey that is over; repeating it reads as though the goods
     * were still on a lorry, on the one screen despatch uses to answer exactly that question.
     */
    const arrived = ['delivered', 'pod_pending', 'closed'].includes(consignment.status);

    if (arrived) {
      why.push(consignment.pod?.attachment ? 'Delivered, proof on file' : 'Delivered');
    } else {
      why.push(
        late === null
          ? 'On the road — no delivery date given'
          : late === 0
            ? promised ? 'Promised to the customer today' : 'Due to arrive today'
            : promised ? `Promised in ${days(late)}` : `Due to arrive in ${days(late)}`
      );
    }
  }
  return verdict('watch', 4);
}

/**
 * Sorts consignments that already carry an `urgency`.
 *
 * Band, then what marketing asked for, then the soonest date. No quantity tie-break, unlike
 * production: a lorry takes the same afternoon to load whether it carries 5,000 pieces or
 * 50,000, so ordering by size would sort by something that costs the team nothing.
 *
 * **The band comes first and nothing reorders it.** A priority sorts inside a group of rows that
 * all need the same action — see the note at the top of this file. That is the whole of its
 * effect here, and it is a real one: a despatch team works down a list, so first in the group
 * is first on the lorry.
 */
export const byDispatchUrgency = (a, b) => {
  if (a.urgency.rank !== b.urgency.rank) return a.urgency.rank - b.urgency.rank;

  /* Critical before high before normal, inside the band. */
  const lift = (b.urgency.lift || 0) - (a.urgency.lift || 0);
  if (lift !== 0) return lift;

  const left = a.urgency.daysToDue;
  const right = b.urgency.daysToDue;
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
};

/** The bands that need somebody to act today. `watch` is the whole of the rest. */
export const ACTIONABLE_BANDS = BANDS.filter((band) => band !== 'watch');
