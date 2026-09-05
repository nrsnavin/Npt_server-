import app from './app.js';
import { env, escalationIntervalMinutes, isProduction } from './config/env.js';
import { connectDatabase } from './config/db.js';
import { configurationProblem, isConfigured } from './providers/twilio.js';
import { configurationProblem as smtpConfigurationProblem } from './services/notification.service.js';
import { runSamplingEscalations } from './services/escalation.service.js';
import { runStallSweep, runLeadStaleSweep } from './services/anomaly.service.js';
import { runQueryEscalations } from './services/queryEscalation.service.js';
import { runProductionEscalations } from './services/productionEscalation.service.js';
import { runDispatchEscalations } from './services/dispatchEscalation.service.js';
import { isConfigured as isIndiamartConfigured } from './services/indiamart.client.js';
import { syncIndiamartLeads } from './services/indiamart.ingest.js';

/** Reports how one-time codes will actually reach people on this deployment. */
function checkOtpDelivery() {
  const problem = configurationProblem();
  if (problem) throw new Error(problem);

  if (isConfigured()) {
    const { messagingServiceSid, fromNumber } = env.twilio;
    console.log(
      `SMS delivery: Twilio (${messagingServiceSid ? `messaging service ${messagingServiceSid}` : `from ${fromNumber}`})`
    );
  } else if (isProduction) {
    throw new Error('No SMS provider configured. Set the TWILIO_* environment variables.');
  } else {
    console.warn('SMS delivery: not configured — codes will be printed to this console');
  }

  // A half-filled SMTP block is the one that hurts: it boots, then fails on the first
  // sign-in with an error naming neither the variable nor the fix.
  const smtpProblem = smtpConfigurationProblem();
  if (smtpProblem) throw new Error(smtpProblem);

  if (!env.smtp.host) {
    if (isProduction) throw new Error('No email provider configured. Set the SMTP_* variables.');
    console.warn('Email delivery: not configured — codes will be printed to this console');
  } else {
    console.log(
      `Email delivery: SMTP via ${env.smtp.host}:${env.smtp.port}` +
        (env.smtp.user ? ` as ${env.smtp.user}` : ' without authentication')
    );
  }
}

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
    } catch (error) {
      console.error('Sampling escalation sweep failed:', error.message);
    }
  };

  // Once at startup, because a process that has been down overnight has a backlog.
  sweep();

  console.log(`Sampling escalations: sweeping every ${escalationIntervalMinutes} minute(s)`);
  return setInterval(sweep, escalationIntervalMinutes * 60 * 1000).unref();
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

  // Once at startup: a process down overnight has a window to catch up on.
  poll();

  console.log(`IndiaMART: pulling leads every ${minutes} minute(s)`);
  return setInterval(poll, minutes * 60 * 1000).unref();
}

async function start() {
  try {
    checkOtpDelivery();

    await connectDatabase();
    console.log('MongoDB connected');

    const server = app.listen(env.port, () => {
      console.log(`NPT ERP API listening on port ${env.port} (${env.nodeEnv})`);
    });

    const escalations = startEscalationSweep();
    const indiamart = startIndiamartPoll();

    const shutdown = (signal) => {
      console.log(`${signal} received, shutting down`);
      clearInterval(escalations);
      if (indiamart) clearInterval(indiamart);
      server.close(() => process.exit(0));
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
}

start();
