import { env, escalationIntervalMinutes } from './config/env.js';
import { reconcileDispatches } from './services/dispatchRecovery.service.js';
import { runSamplingEscalations } from './services/escalation.service.js';
import { runStallSweep, runLeadStaleSweep } from './services/anomaly.service.js';
import { runQueryEscalations } from './services/queryEscalation.service.js';
import { runPaymentEscalations } from './services/receivable.service.js';
import { runProductionEscalations } from './services/productionEscalation.service.js';
import { runDispatchEscalations } from './services/dispatchEscalation.service.js';
import { isConfigured as isIndiamartConfigured } from './services/indiamart.client.js';
import { syncIndiamartLeads } from './services/indiamart.ingest.js';
import { recoverEvents } from './services/events.service.js';
import { everyExclusively, releaseLease } from './services/lease.service.js';

/**
 * The work nobody asks for: reminders and escalations, the IndiaMART feed, finishing dispatches
 * that were interrupted, and re-delivering handovers whose listeners failed.
 *
 * Started by the API (unless RUN_BACKGROUND=false) and by `src/worker.js`. However many processes
 * start it, each job runs on one of them at a time — see lease.service.js — so a second API
 * instance adds capacity without doubling a single reminder.
 */

/**
 * Sweeps for overdue samples on a timer [§25].
 *
 * Lives here rather than in app.js so importing the app — which every test does — never
 * starts a background timer. `unref` keeps the sweep from holding the process open on its
 * own. A failed sweep logs and waits for the next one: an escalation that crashed the
 * process would be worse than a late one.
 */
function startEscalationSweep() {
  if (escalationIntervalMinutes <= 0) {
    console.warn('Sampling escalations: disabled (ESCALATION_INTERVAL_MINUTES=0)');
    return null;
  }

  const sweep = async () => {
    try {
      const raised = await runSamplingEscalations();
      if (raised.length) {
        console.log(`Sampling escalations: raised ${raised.length} (${raised.map((entry) => `${entry.sample} L${entry.level}`).join(', ')})`);
      }

      /*
       * And the samples nobody is working on. Runs on the same timer because it answers the
       * neighbouring question — that one asks whether a date has passed, this asks whether
       * anyone has touched it — and a stall is the overdue of next week, worth catching while
       * there is still time to do something about it.
       */
      const quietLeads = await runLeadStaleSweep();
      if (quietLeads.length) {
        console.log(`Quiet leads: told management about ${quietLeads.length}`);
      }

      const stalled = await runStallSweep();
      if (stalled.length) {
        console.log(
          `Stalled samples: told management about ${stalled.length} ` +
            `(${stalled.map((entry) => `${entry.sample} ${entry.idleDays}d`).join(', ')})`
        );
      }

      /*
       * And the questions nobody has answered. On the same timer for the same reason as the
       * others: it is the clock that makes a query different from a WhatsApp message, and a
       * clock nobody winds is a decoration.
       */
      const questions = await runQueryEscalations();
      if (questions.length) {
        console.log(
          `Order questions: raised ${questions.length} ` +
            `(${questions.map((entry) => `${entry.query} L${entry.level}`).join(', ')})`
        );
      }

      /* And the jobs past the date the plant itself agreed [§25]. */
      const late = await runProductionEscalations();
      if (late.length) {
        console.log(
          `Late production: raised ${late.length} ` +
            `(${late.map((entry) => `${entry.order} ${entry.daysLate}d`).join(', ')})`
        );
      }

      /*
       * And the material nobody has collected [§25]. The mirror of the one above: that asks
       * whether the plant is late, this asks whether the plant finished and the goods are still
       * standing on the floor — which is the more embarrassing of the two, because everything
       * the customer is waiting for has already been done.
       */
      const sitting = await runDispatchEscalations();
      if (sitting.length) {
        console.log(
          `Undispatched stock: raised ${sitting.length} ` +
            `(${sitting.map((entry) => `${entry.order} ${entry.daysWaiting}d`).join(', ')})`
        );
      }
      /*
       * And the money [§25's four tiers]. The last link in the chain and the one that pays for
       * everything upstream: an order made on time, shipped on time and never collected is a
       * loss with good paperwork.
       *
       * The first tier fires three days *before* the due date, which is the only rung that can
       * still prevent the problem — a marketing person reminded on Tuesday mentions it on
       * Wednesday's call. Everything after it is recovery.
       */
      const money = await runPaymentEscalations();
      if (money.escalated) {
        console.log(`Payments: escalated ${money.escalated} of ${money.checked} open receivables`);
      }
    } catch (error) {
      console.error('Sampling escalation sweep failed:', error.message);
    }
  };

  /* At once, because a process that has been down overnight has a backlog — then on the timer,
     on whichever process holds the lease. */
  console.log(`Sampling escalations: sweeping every ${escalationIntervalMinutes} minute(s)`);
  return everyExclusively('sweep:escalations', escalationIntervalMinutes * 60 * 1000, sweep);
}

/**
 * Pulls IndiaMART leads on a timer [§41 by analogy].
 *
 * Off unless a key is configured, which is the normal state for a deployment that does not
 * sell through IndiaMART — an integration that logs a warning every quarter of an hour is one
 * people learn to ignore, and then miss the warning that mattered.
 *
 * The interval is bounded below by *their* rate limit rather than by our appetite: IndiaMART
 * answers a burst with an error instead of data, so polling harder returns fewer leads, not
 * more. The watermark is what makes a slow poll safe — nothing is missed by waiting, only
 * delayed.
 */
function startIndiamartPoll() {
  if (!isIndiamartConfigured()) {
    console.log('IndiaMART: no key configured — the feed is off');
    return null;
  }

  const minutes = env.indiamart.pollMinutes;
  if (!minutes) {
    console.log('IndiaMART: polling disabled');
    return null;
  }

  const poll = async () => {
    try {
      const result = await syncIndiamartLeads();
      if (result.failed) {
        console.error(`IndiaMART: sync failed — ${result.error}`);
      } else if (result.created || result.attachedToExisting) {
        console.log(
          `IndiaMART: ${result.created} new lead(s), ` +
            `${result.attachedToExisting} added to leads we already had, ` +
            `${result.duplicates} seen before`
        );
      }
    } catch (error) {
      /*
       * Swallowed and logged, like every other subscriber. A feed that cannot reach a third
       * party must not take the API process down with it — the plant's own work does not stop
       * because IndiaMART is having an afternoon.
       */
      console.error('IndiaMART: poll threw —', error.message);
    }
  };

  /* At once: a process down overnight has a window to catch up on. */
  console.log(`IndiaMART: pulling leads every ${minutes} minute(s)`);
  return everyExclusively('sweep:indiamart', minutes * 60 * 1000, poll);
}


const LEASES = ['sweep:escalations', 'sweep:indiamart', 'sweep:dispatch-recovery', 'sweep:outbox'];

export function startBackground() {
  const timers = [
    /* Interrupted dispatches, every minute, independent of the reminders [data-consistency.md]. */
    everyExclusively('sweep:dispatch-recovery', 60_000, () =>
      reconcileDispatches().catch((error) => console.error('Dispatch recovery failed:', error.message))
    ),
    /* Handovers whose listeners failed or never ran — a crash between the save and the task. */
    everyExclusively('sweep:outbox', 30_000, async () => {
      const { delivered, failed } = await recoverEvents();
      if (delivered || failed) console.log(`Handovers: re-delivered ${delivered}, gave up on ${failed}`);
    }),
    startEscalationSweep(),
    startIndiamartPoll(),
  ].filter(Boolean);

  return async function stopBackground() {
    for (const timer of timers) clearInterval(timer);
    /* Hand the leases back so another process can take over at once rather than after expiry. */
    await Promise.all(LEASES.map((name) => releaseLease(name).catch(() => {})));
  };
}
