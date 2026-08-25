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
    password: process.env.SMTP_PASSWORD,
    from: process.env.SMTP_FROM || 'NPT Hangers <no-reply@npthangers.com>',
  },

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    fromNumber: process.env.TWILIO_FROM_NUMBER,
    /** Preferred over a single from-number in production: number pool and compliance. */
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
    timeoutMs: Number(process.env.TWILIO_TIMEOUT_MS || 10000),
    /** Total attempts, including the first, for transient network and 5xx failures. */
    maxAttempts: Number(process.env.TWILIO_MAX_ATTEMPTS || 2),
  },
};

export const isProduction = env.nodeEnv === 'production';
