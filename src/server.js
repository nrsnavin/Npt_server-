import app from './app.js';
import { env, escalationIntervalMinutes, isProduction } from './config/env.js';
import { connectDatabase } from './config/db.js';
import { configurationProblem, isConfigured } from './providers/twilio.js';
import { configurationProblem as smtpConfigurationProblem } from './services/notification.service.js';
import { runSamplingEscalations } from './services/escalation.service.js';
import { runStallSweep, runLeadStaleSweep } from './services/anomaly.service.js';

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
    } catch (error) {
      console.error('Sampling escalation sweep failed:', error.message);
    }
  };

  // Once at startup, because a process that has been down overnight has a backlog.
  sweep();

  console.log(`Sampling escalations: sweeping every ${escalationIntervalMinutes} minute(s)`);
  return setInterval(sweep, escalationIntervalMinutes * 60 * 1000).unref();
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

    const shutdown = (signal) => {
      console.log(`${signal} received, shutting down`);
      clearInterval(escalations);
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
