import { env, isProduction } from '../config/env.js';
import { isConfigured as twilioConfigured, sendSms as twilioSendSms } from '../providers/twilio.js';

/**
 * Delivery of OTP codes. Both channels fall back to logging the message when no
 * provider is configured, so the API is usable in development without SMTP or Twilio
 * credentials. In production a missing provider is an error rather than a silent no-op.
 */

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

  await transporter.sendMail({ from: env.smtp.from, to, subject, text, html });
  return { delivered: true, channel: 'email' };
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
