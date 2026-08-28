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

  /**
   * IndiaMART's Lead Manager pull API [§41 by analogy].
   *
   * Pulled rather than pushed. A push needs a public endpoint and signature verification, and
   * a push missed while the API is down is gone — a missed poll is picked up by the next
   * window. Nothing here is required: with no key the integration is simply off, which is the
   * normal state for a deployment that does not sell through IndiaMART.
   */
  indiamart: {
    /** From Lead Manager → Import/Export Leads → API. The whole integration hangs off this. */
    key: process.env.INDIAMART_CRM_KEY,
    baseUrl: process.env.INDIAMART_API_URL || 'https://mapi.indiamart.com/wservce/crm/crmListing/v2/',
    /*
     * IndiaMART rate-limits this endpoint hard — roughly one call every five minutes — and
     * answers a burst with an error rather than data. So the poll interval is a floor, not a
     * preference, and the default sits above it.
     */
    pollMinutes: Number(process.env.INDIAMART_POLL_MINUTES ?? 15),
    /*
     * How far back the first run reaches when there is no watermark yet. Their window is
     * capped at seven days; asking for more returns nothing rather than more.
     */
    backfillDays: Number(process.env.INDIAMART_BACKFILL_DAYS ?? 7),
    /*
     * Re-asked overlap on every poll. Their `QUERY_TIME` is the buyer's clock, not ours, and a
     * lead landing a minute before the watermark would fall between two windows and never be
     * seen. Duplicates are free — the unique query id makes ingestion idempotent — so the
     * overlap costs nothing and closes the gap.
     */
    overlapMinutes: Number(process.env.INDIAMART_OVERLAP_MINUTES ?? 10),
    timeoutMs: Number(process.env.INDIAMART_TIMEOUT_MS || 20000),
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
