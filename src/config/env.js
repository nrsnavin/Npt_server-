import dotenv from 'dotenv';

dotenv.config();

const required = (key, fallback) => {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 5000),
  mongoUri: required('MONGO_URI', 'mongodb://127.0.0.1:27017/npt_erp'),
  jwtSecret: required('JWT_SECRET', 'npt-dev-secret-change-me'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  /** Bare local phone numbers are assumed to belong to this country. */
  defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE || '+91',

  otp: {
    length: Number(process.env.OTP_LENGTH || 6),
    ttlMinutes: Number(process.env.OTP_TTL_MINUTES || 5),
    maxAttempts: Number(process.env.OTP_MAX_ATTEMPTS || 5),
    resendCooldownSeconds: Number(process.env.OTP_RESEND_COOLDOWN_SECONDS || 60),
    maxPerHour: Number(process.env.OTP_MAX_PER_HOUR || 5),
    /**
     * Returns the code in the API response so a developer without SMTP or Twilio
     * can still sign in. Ignored outside development.
     */
    exposeInResponse: process.env.OTP_EXPOSE_IN_RESPONSE === 'true',
  },

  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER,
    /*
     * `SMTP_PASS` is what nodemailer's own documentation calls it, so it is what people
     * write. Reading only SMTP_PASSWORD meant a correct-looking .env produced an empty
     * password and an EAUTH that named neither variable — accept both rather than make
     * everyone find that out once.
     */
    password: process.env.SMTP_PASSWORD || process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || 'NPT Hangers <no-reply@npthangers.com>',
  },

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    fromNumber: process.env.TWILIO_FROM_NUMBER,
    /** Preferred over a single from-number in production: number pool and compliance. */
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
    /** A WhatsApp-enabled sender, which is not the same number as the SMS one. */
    whatsappFrom: process.env.TWILIO_WHATSAPP_FROM,
    timeoutMs: Number(process.env.TWILIO_TIMEOUT_MS || 10000),
    /** Total attempts, including the first, for transient network and 5xx failures. */
    maxAttempts: Number(process.env.TWILIO_MAX_ATTEMPTS || 2),
  },
};

/**
 * Approved WhatsApp templates, by the event that sends them.
 *
 * Meta refuses free text for a business-initiated message outside the 24-hour window, so a
 * scheduled update has to go as a template registered in advance. Each value is the Twilio
 * content SID for that template; without one the send falls back to a plain body, which
 * works in the sandbox and inside an open conversation and is refused otherwise.
 */
export const whatsappTemplates = {
  sample_ready: process.env.WHATSAPP_TEMPLATE_SAMPLE_READY,
  sample_dispatched: process.env.WHATSAPP_TEMPLATE_SAMPLE_DISPATCHED,
};

/**
 * How often the §25 sampling escalation sweeps. Hourly is the right grain for a threshold
 * measured in days: fine enough that nothing sits unnoticed for a working morning, coarse
 * enough that the sweep is invisible. Set to 0 to turn it off.
 */
export const escalationIntervalMinutes = Number(process.env.ESCALATION_INTERVAL_MINUTES ?? 60);

export const isProduction = env.nodeEnv === 'production';
