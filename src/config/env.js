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

  /**
   * Quality's one policy switch [§15].
   *
   * A consignment whose pre-dispatch check *failed* always warns — that is not negotiable and
   * needs no setting. This decides the other case: whether a consignment nobody has inspected
   * at all also warns.
   *
   * **Off by default, deliberately.** Turned on before the plant has adopted pre-dispatch
   * checks, every single consignment warns, despatch types "n/a" ten times a day, and the
   * overrides report — the one thing that makes a soft gate honest — fills with a hundred
   * percent of consignments and tells nobody anything. A signal that fires on everything is not
   * a signal. Switch it on once inspections are routine, and it becomes the real gate.
   */
  quality: {
    requirePreDispatchCheck: process.env.QUALITY_REQUIRE_PRE_DISPATCH === 'true',
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

  /**
   * Chirix ERP's sales order feed [§12].
   *
   * Read-only and one-directional by design: orders raised in Chirix appear here so the plant
   * is not typing them a second time, and nothing is ever written back. Two systems writing to
   * each other produce a class of disagreement that cannot be debugged from either side.
   *
   * Off unless `CHIRIX_API_KEY` is set, like IndiaMART above — which is the right state for a
   * deployment that does not run Chirix, and the right state for every deployment until the
   * vendor answers the questions in `docs/CHIRIX_API_REQUEST.md`.
   *
   * `fallbackOwnerEmail` rather than an id, because a `.env` written by a person should not
   * contain a Mongo ObjectId they have to look up — and because the id changes when the
   * database is re-seeded and the email does not. It is resolved at poll time.
   */
  chirix: {
    key: process.env.CHIRIX_API_KEY,
    baseUrl: process.env.CHIRIX_API_URL,
    /** How the key is presented. See the guide — vendors differ and this is cheaper than a fork. */
    authHeader: process.env.CHIRIX_AUTH_HEADER || 'Authorization',
    authScheme: process.env.CHIRIX_AUTH_SCHEME ?? 'Bearer',
    /**
     * The poll interval, in minutes.
     *
     * Slower than it could be, on purpose. A sales order is not a lead: nothing downstream of it
     * happens in under an hour anyway, and the §13 checks take longer than that. Polling every
     * minute would buy nothing and spend the vendor's rate limit — see question 5 in the request
     * document.
     */
    pollMinutes: Number(process.env.CHIRIX_POLL_MINUTES ?? 15),
    /** How far back the very first run reaches, before there is a watermark. */
    backfillDays: Number(process.env.CHIRIX_BACKFILL_DAYS ?? 7),
    /**
     * Overlap re-asked on every poll.
     *
     * Their `modifiedSince` is their clock, not ours, and an order landing either side of the
     * watermark would fall between two windows and never arrive. Re-reading is free because the
     * import is idempotent on `(source, id)` — that is the whole point of the unique index on
     * `externalRef` — so the overlap costs a few rows and closes the gap.
     */
    overlapMinutes: Number(process.env.CHIRIX_OVERLAP_MINUTES ?? 30),
    timeoutMs: Number(process.env.CHIRIX_TIMEOUT_MS || 20000),
    /** Who an imported order belongs to when nothing else resolves an owner [§29]. */
    fallbackOwnerEmail: process.env.CHIRIX_FALLBACK_OWNER_EMAIL,
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
