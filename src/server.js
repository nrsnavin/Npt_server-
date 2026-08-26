import app from './app.js';
import { env, isProduction } from './config/env.js';
import { connectDatabase } from './config/db.js';
import { configurationProblem, isConfigured } from './providers/twilio.js';
import { configurationProblem as smtpConfigurationProblem } from './services/notification.service.js';

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

async function start() {
  try {
    checkOtpDelivery();

    await connectDatabase();
    console.log('MongoDB connected');

    const server = app.listen(env.port, () => {
      console.log(`NPT ERP API listening on port ${env.port} (${env.nodeEnv})`);
    });

    const shutdown = (signal) => {
      console.log(`${signal} received, shutting down`);
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
