/* First: the plant's day, before any date is made [config/timezone.js]. */
import './config/timezone.js';
import app from './app.js';
import { installProcessGuards } from './config/processGuards.js';
import { env, isProduction } from './config/env.js';
import { startBackground } from './background.js';
import { connectCache, disconnectCache } from './services/cache.service.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { configurationProblem, isConfigured } from './providers/twilio.js';
import { metaConfigurationProblem } from './providers/meta.js';
import { whatsappProvider } from './providers/whatsapp.js';
import { phoneCodesByWhatsApp } from './services/notification.service.js';
import { configurationProblem as smtpConfigurationProblem } from './services/notification.service.js';

/** Reports how one-time codes will actually reach people on this deployment. */
function checkOtpDelivery() {
  const problem = configurationProblem() || metaConfigurationProblem();
  if (problem) throw new Error(problem);

  const whatsapp = whatsappProvider();
  console.log(`WhatsApp delivery: ${whatsapp === 'meta' ? 'Meta WhatsApp Business Platform' : whatsapp === 'twilio' ? 'Twilio' : 'not configured'}`);

  if (isConfigured()) {
    const { messagingServiceSid, fromNumber } = env.twilio;
    console.log(
      `SMS delivery: Twilio (${messagingServiceSid ? `messaging service ${messagingServiceSid}` : `from ${fromNumber}`})`
    );
  } else if (phoneCodesByWhatsApp()) {
    console.log('Phone sign-in codes: WhatsApp authentication template');
  } else if (isProduction) {
    throw new Error(
      'Phone sign-in codes have no way out. Set WHATSAPP_TEMPLATE_OTP (an approved WhatsApp '
        + 'authentication template) with the META_WA_* settings, or the TWILIO_* SMS settings.'
    );
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
  installProcessGuards();
  try {
    checkOtpDelivery();

    await connectDatabase();
    console.log('MongoDB connected');
    /* Optional: without REDIS_URL, limits and caches stay in this process as before. */
    await connectCache();

    const server = app.listen(env.port, () => {
      console.log(`NPT ERP API listening on port ${env.port} (${env.nodeEnv})`);
    });

    /*
     * Background work runs here too unless a separate worker (`npm run worker`) has been given
     * it. Either way each job runs on one process at a time, so leaving it on everywhere is safe.
     */
    const stopBackground = process.env.RUN_BACKGROUND === 'false' ? null : startBackground();
    if (!stopBackground) console.log('Background work: left to the worker (RUN_BACKGROUND=false)');

    /*
     * A request that never finishes sending its headers or body is closed rather than held open
     * for ever: one slow or broken client per socket otherwise ties up a connection each.
     */
    server.headersTimeout = 30_000;
    server.requestTimeout = 120_000;
    /* Longer than a load balancer's idle timeout (60 s on AWS), so the balancer closes first. */
    server.keepAliveTimeout = 65_000;

    let stopping = false;
    const shutdown = async (signal) => {
      if (stopping) return;
      stopping = true;
      console.log(`${signal} received, shutting down`);
      /* Requests in flight get ten seconds to finish; then the process goes regardless. */
      setTimeout(() => {
        console.error('Shutdown took too long — exiting with requests still open');
        process.exit(1);
      }, 10_000).unref();
      await stopBackground?.().catch(() => {});
      server.close(async () => {
        await disconnectCache().catch(() => {});
        await disconnectDatabase().catch(() => {});
        process.exit(0);
      });
      /* Idle keep-alive sockets would otherwise hold `close` open until they time out. */
      server.closeIdleConnections?.();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
}

start();
