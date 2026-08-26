import { env, isProduction } from '../config/env.js';
import ApiError from '../utils/ApiError.js';
import { isConfigured as twilioConfigured, sendSms as twilioSendSms } from '../providers/twilio.js';

/**
 * Message delivery: OTP codes over email and SMS, and the customer updates in
 * `customerMessage.service.js` reuse `sendEmail` from here.
 *
 * Every channel falls back to logging when no provider is configured, so the API is usable
 * in development without SMTP or Twilio credentials. In production a missing provider is an
 * error rather than a silent no-op.
 */

/**
 * Explains a half-filled SMTP block, so it fails at startup rather than on the first sign-in.
 *
 * The failure this catches is specific and unhelpful when it happens live: a host with a user
 * but no password builds a transport happily, then nodemailer attempts PLAIN auth with
 * nothing to send and the server answers `Missing credentials for PLAIN`. Twilio has had this
 * check since it was wired up; SMTP was missing it.
 *
 * Takes the block to check so it can be exercised directly. Reading `env` alone would make
 * every case need its own module instance, and a check that awkward to test is one nobody
 * trusts enough to extend.
 */
export function configurationProblem(smtp = env.smtp) {
  const { host, user, password } = smtp;
  // Nothing set at all is a valid choice: codes go to the console.
  if (!host && !user && !password) return null;

  const missing = [];
  if (!host) missing.push('SMTP_HOST');
  if (user && !password) missing.push('SMTP_PASSWORD');
  if (password && !user) missing.push('SMTP_USER');

  return missing.length
    ? `SMTP is partially configured — missing ${missing.join(', ')}. ` +
      'Set it, or clear SMTP_HOST to print codes to the console instead.'
    : null;
}

let transporterPromise = null;

/** Lazily builds a nodemailer transport so the dependency is optional. */
async function getMailTransporter() {
  if (!env.smtp.host) return null;

  if (!transporterPromise) {
    transporterPromise = import('nodemailer')
      .then((nodemailer) =>
        nodemailer.default.createTransport({
          host: env.smtp.host,
          port: env.smtp.port,
          secure: env.smtp.port === 465,
          auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.password } : undefined,
        })
      )
      .catch((error) => {
        console.error('nodemailer is not installed; email delivery is disabled:', error.message);
        return null;
      });
  }

  return transporterPromise;
}

function logFallback(channel, to, body) {
  if (isProduction) {
    throw new Error(
      `No ${channel} provider configured. Set the ${
        channel === 'email' ? 'SMTP_*' : 'TWILIO_*'
      } environment variables.`
    );
  }
  console.log(`\n[${channel}] to ${to}\n${body}\n`);
}

export async function sendEmail({ to, subject, text, html }) {
  const transporter = await getMailTransporter();

  if (!transporter) {
    logFallback('email', to, `${subject}\n${text}`);
    return { delivered: false, channel: 'email' };
  }

  try {
    const info = await transporter.sendMail({ from: env.smtp.from, to, subject, text, html });
    // The message id is what makes a delivery traceable in the mail server's own logs.
    return { delivered: true, channel: 'email', messageId: info?.messageId };
  } catch (error) {
    return handleSendFailure(error, to, `${subject}\n${text}`);
  }
}

/** Mail-server refusals worth naming, because each has a different fix. */
const SMTP_HINTS = {
  EAUTH:
    'the mail server rejected the credentials — check SMTP_USER and SMTP_PASSWORD. ' +
    'Gmail needs an app password, not the account password.',
  ECONNECTION: 'the mail server could not be reached — check SMTP_HOST and SMTP_PORT.',
  ETIMEDOUT: 'the mail server did not answer — check SMTP_HOST, SMTP_PORT and any firewall.',
  ESOCKET: 'the connection to the mail server failed — check SMTP_PORT and whether it needs TLS.',
};

/**
 * A mail server that refuses us is our problem, not the user's.
 *
 * The operator gets the real cause named, with what to change. Outside production the message
 * still goes to the console, because being unable to sign in to your own development
 * environment over a wrong app password helps nobody — and the warning above it is loud.
 */
function handleSendFailure(error, to, body) {
  const hint = SMTP_HINTS[error.code] || error.message;
  console.error(`[email] send to ${to} failed: ${hint}`);

  if (isProduction) {
    throw new ApiError(502, 'We could not send that email right now. Please try again shortly.');
  }

  console.warn('[email] falling back to the console because delivery failed');
  logFallback('email', to, body);
  return { delivered: false, channel: 'email', fallback: true };
}

export async function sendSms({ to, body }) {
  if (!twilioConfigured()) {
    logFallback('sms', to, body);
    return { delivered: false, channel: 'sms' };
  }

  return twilioSendSms({ to, body });
}

const OTP_SUBJECTS = {
  login: 'Your NPT Hangers sign-in code',
  verify_email: 'Verify your email address',
  verify_phone: 'Verify your phone number',
};

/** Sends a code over whichever channel matches the identifier. */
export async function sendOtp({ identifier, channel, code, purpose, ttlMinutes }) {
  const expiry = `${ttlMinutes} minute${ttlMinutes === 1 ? '' : 's'}`;

  if (channel === 'email') {
    return sendEmail({
      to: identifier,
      subject: OTP_SUBJECTS[purpose] || OTP_SUBJECTS.login,
      text: `Your NPT Hangers verification code is ${code}. It expires in ${expiry}. If you did not request this, you can ignore this email.`,
      html: `
        <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px">
          <h2 style="margin:0 0 8px">NPT Hangers</h2>
          <p style="color:#475569;margin:0 0 20px">${OTP_SUBJECTS[purpose] || OTP_SUBJECTS.login}</p>
          <p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:0 0 16px">${code}</p>
          <p style="color:#475569">This code expires in ${expiry}.</p>
          <p style="color:#94a3b8;font-size:13px">If you did not request this, you can ignore this message.</p>
        </div>`,
    });
  }

  return sendSms({
    to: identifier,
    body: `${code} is your NPT Hangers verification code. It expires in ${expiry}.`,
  });
}
