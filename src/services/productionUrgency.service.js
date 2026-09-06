import { ORDER_PRIORITY_LEVELS } from '../models/SalesOrder.js';

/**
 * What the plant should put on a press next, and why.
 *
 * The production list already sorts late-first then by the agreed date, which is right for a
 * register and wrong for the first screen of the morning. Sorted that way, a line that is one
 * day late for 500 pieces sits above one that is due on Friday with 80,000 still to make — and
 * the second is the one that will actually miss, because there is no longer time to run it.
 * A date alone cannot see that. Only the date *against the quantity left* can.
 *
 * So a line is placed in a band, and the band is what the screen groups by:
 *
 *   `late`      past the date the plant itself agreed. Nothing outranks a broken promise.
 *   `at_risk`   not late yet, and will be — more still to make than the days remaining can
 *               carry, at this plant's own recent rate.
 *   `soon`      due inside the week, and comfortably makeable.
 *   `normal`    everything else.
 *
 * **Bands rather than a score.** A single number sorts perfectly and explains nothing: a
 * supervisor who cannot see why line 4 is above line 9 works around the screen rather than from
 * it. A band has a name, and every line carries the sentence that put it there.
 *
 * **Marketing's priority lifts a band, it does not replace one.** A line pulled up by a person
 * still shows the arithmetic that would have placed it anyway, so the plant can see whether the
 * request agrees with the facts or overrides them — and `critical` says out loud that something
 * else is being pushed back, because it is.
 */

/**
 * How many pieces the plant gets through in a day, for one line, when nothing else is known.
 *
 * A working assumption and not a measurement — the model carries cavities and a cycle time, but
 * not how many presses are free, how many shifts are running, or what else is on them. Naming
 * it as one number, here, is the honest version of the guess: it is visible, it is arguable,
 * and when the plant says the real figure is 8,000 it is one edit rather than a hunt through
 * three files.
 *
 * Deliberately conservative. The cost of calling a line at risk that turns out fine is that a
 * supervisor glances at it; the cost of missing one is a shipment.
 */
export const PIECES_PER_DAY = 12000;

/** Inside this many days is "soon" — the horizon a weekly plan is actually made against. */
export const SOON_DAYS = 7;

const BANDS = ['late', 'at_risk', 'soon', 'normal'];

/** Whole days from now until a date; negative once it has gone by. */
function daysUntil(date, now) {
  if (!date) return null;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(0, 0, 0, 0);
  return Math.round((end - start) / 86400000);
}

const plural = (count, one, many) => `${count.toLocaleString('en-IN')} ${count === 1 ? one : many}`;

/**
 * Where a line sits and what put it there.
 *
 * Takes the flattened row the production list already builds, so the dashboard and the list
 * cannot disagree about what a line is. Returns the band, its rank for sorting, and `why` — the
 * sentences the screen prints, in the order they matter.
 */
export function urgencyOf(row, { now = new Date(), priority = 'normal' } = {}) {
  const why = [];

  const due = row.production?.expectedCompletion || row.deliveryDate;
  const days = daysUntil(due, now);
  const left = Math.max(0, row.toMakeQty ?? 0);
  const done = row.production?.status === 'completed';

  let band = 'normal';

  if (done) {
    /* Finished work has no urgency, whatever its date or whoever asked for it. Returning early
       keeps it out of the bands entirely rather than sorting it to the bottom of one. */
    return {
      band: 'normal', naturalBand: 'normal', lifted: false,
      rank: BANDS.length, why: [], daysToDue: days, toMake: left, priority,
    };
  }

  if (days !== null && days < 0) {
    band = 'late';
    why.push(days === -1 ? 'A day past its date' : `${Math.abs(days)} days past its date`);
  } else if (days !== null) {
    /*
     * The judgement this screen exists for: can what is left still be made in the time left?
     * A day of grace on either side is not modelled — the estimate is too coarse to earn it,
     * and a line that is borderline is one somebody should look at anyway.
     */
    const daysNeeded = Math.ceil(left / PIECES_PER_DAY);
    if (daysNeeded > days) {
      band = 'at_risk';
      why.push(
        days === 0
          ? `Due today with ${plural(left, 'piece', 'pieces')} still to make`
          : `${plural(left, 'piece', 'pieces')} still to make, and ${plural(days, 'day', 'days')} to do it`
      );
    } else if (days <= SOON_DAYS) {
      band = 'soon';
      why.push(days === 0 ? 'Due today' : `Due in ${plural(days, 'day', 'days')}`);
    }
  } else if (left > 0) {
    /* No date at all is not the same as no hurry — it is a line nothing can chase, which is
       how quantity goes quietly unmade. Named rather than left in the `normal` pile. */
    band = 'soon';
    why.push('No delivery date agreed');
  }

  const lift = ORDER_PRIORITY_LEVELS.find((level) => level.key === priority)?.lift || 0;
  let rank = BANDS.indexOf(band);

  if (lift) {
    rank = Math.max(0, rank - lift);

    /*
     * A lifted line always states its dates, even when it had nothing to say on its own.
     *
     * `normal` produces no sentence — there is nothing wrong with the line, and saying so on
     * every calm row would be noise. But a *lifted* normal line is the one case where the
     * silence actively misleads: the row reaches the top of the plant's screen saying only
     * "marketing marked this critical", and a supervisor about to push back a running job has
     * no way to see that the request is overriding the dates rather than agreeing with them.
     * "Due in 45 days" is exactly the fact that makes it arguable, which is the whole point of
     * showing the arithmetic underneath the request.
     */
    if (!why.length) {
      why.push(
        days === null
          ? 'No delivery date agreed'
          : days === 0
            ? 'Due today'
            : `Due in ${plural(days, 'day', 'days')} — not pressing on its own dates`
      );
    }

    /* Second in the list, deliberately: what the dates say comes first, and the request to
       override them reads as the reason it was moved rather than as the fact itself. */
    why.push(
      priority === 'critical'
        ? 'Marketing marked this critical — something else gives way'
        : 'Marketing asked for this to be pulled forward'
    );
  }

  /*
   * `naturalBand` is what the dates alone said, and the screen needs both.
   *
   * Labelling a lifted row by the band it landed in produces a badge that contradicts the
   * sentence beneath it: an order due in 45 days, pulled up by marketing, was reading "Will
   * miss" directly above "Due in 45 days — not pressing on its own dates". Whichever a
   * supervisor believes, the screen has told them something false. Handing back both lets the
   * screen label a lifted row by *the request that moved it* while still ranking it where the
   * request asked, which is the only version that is true on both lines.
   */
  return {
    band: BANDS[rank],
    naturalBand: band,
    lifted: BANDS[rank] !== band,
    rank,
    why,
    daysToDue: days,
    toMake: left,
    priority,
  };
}

/**
 * Sorts rows that already carry an `urgency`.
 *
 * Band first, then the soonest date, then the biggest quantity outstanding. That last tie-break
 * is not decoration: two lines due the same day are separated by which one takes longer to run,
 * and starting the big one late is what makes it miss.
 */
export const byUrgency = (a, b) => {
  if (a.urgency.rank !== b.urgency.rank) return a.urgency.rank - b.urgency.rank;

  const left = a.urgency.daysToDue;
  const right = b.urgency.daysToDue;
  if (left !== right) {
    if (left === null) return 1;
    if (right === null) return -1;
    return left - right;
  }
  return b.urgency.toMake - a.urgency.toMake;
};

/** The bands the screen leads with — everything else is the ordinary queue. */
export const PRESSING_BANDS = ['late', 'at_risk'];
