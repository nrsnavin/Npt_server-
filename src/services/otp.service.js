import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { env, isProduction } from '../config/env.js';
import ApiError from '../utils/ApiError.js';
import OtpToken from '../models/OtpToken.js';
import { isEmail, normalisePhone } from '../utils/phone.js';
import { sendOtp } from './notification.service.js';

/** Generates a numeric code using a CSPRNG rather than Math.random. */
function generateCode(length = env.otp.length) {
  const max = 10 ** length;
  return String(crypto.randomInt(0, max)).padStart(length, '0');
}

/**
 * Resolves a raw identifier into its canonical form and channel.
 * Throws when it is neither a valid email nor a valid phone number.
 */
export function resolveIdentifier(input) {
  const raw = String(input || '').trim();

  if (isEmail(raw)) {
    return { identifier: raw.toLowerCase(), channel: 'email', field: 'email' };
  }

  const phone = normalisePhone(raw);
  if (phone) {
    return { identifier: phone, channel: 'sms', field: 'phone' };
  }

  throw ApiError.badRequest('Enter a valid email address or phone number');
}

/** Applies the resend cooldown and the hourly cap for one identifier. */
async function assertWithinRateLimits(identifier, purpose) {
  const now = Date.now();

  const [recent, hourlyCount] = await Promise.all([
    OtpToken.findOne({ identifier, purpose }).sort('-createdAt'),
    OtpToken.countDocuments({
      identifier,
      purpose,
      createdAt: { $gte: new Date(now - 60 * 60 * 1000) },
    }),
  ]);

  if (recent) {
    const elapsedSeconds = (now - recent.createdAt.getTime()) / 1000;
    const waitSeconds = Math.ceil(env.otp.resendCooldownSeconds - elapsedSeconds);
    if (waitSeconds > 0) {
      throw new ApiError(429, `Please wait ${waitSeconds} second(s) before requesting another code`);
    }
  }

  if (hourlyCount >= env.otp.maxPerHour) {
    throw new ApiError(429, 'Too many codes requested. Please try again in an hour.');
  }
}

/**
 * Issues a code for an identifier and delivers it over the matching channel.
 * Any earlier unconsumed code for the same identifier and purpose is invalidated,
 * so only the newest code can ever be redeemed.
 */
export async function issueOtp({ identifier, channel, purpose = 'login', user, requestIp }) {
  await assertWithinRateLimits(identifier, purpose);

  await OtpToken.deleteMany({ identifier, purpose, consumedAt: null });

  const code = generateCode();
  const token = await OtpToken.create({
    identifier,
    channel,
    purpose,
    codeHash: await bcrypt.hash(code, 10),
    user: user?._id,
    expiresAt: new Date(Date.now() + env.otp.ttlMinutes * 60 * 1000),
    requestIp,
  });

  try {
    await sendOtp({
      identifier,
      channel,
      code,
      purpose,
      ttlMinutes: env.otp.ttlMinutes,
    });
  } catch (error) {
    // A code nobody received must not hold the resend cooldown open, or the user is
    // locked out for a minute over our delivery failure.
    await OtpToken.deleteOne({ _id: token._id });
    throw error;
  }

  return {
    tokenId: token._id,
    expiresAt: token.expiresAt,
    // Never leak the code in production, whatever the configuration says.
    ...(env.otp.exposeInResponse && !isProduction ? { devCode: code } : {}),
  };
}

/**
 * Checks a submitted code. Consumes the token on success; counts the attempt and
 * discards the token once the attempt limit is reached on failure.
 */
export async function verifyOtp({ identifier, code, purpose = 'login' }) {
  const token = await OtpToken.findOne({ identifier, purpose, consumedAt: null }).sort('-createdAt');

  if (!token) {
    throw ApiError.badRequest('That code is no longer valid. Please request a new one.');
  }

  if (token.expiresAt.getTime() < Date.now()) {
    await OtpToken.deleteOne({ _id: token._id });
    throw ApiError.badRequest('That code has expired. Please request a new one.');
  }

  if (token.attempts >= env.otp.maxAttempts) {
    await OtpToken.deleteOne({ _id: token._id });
    throw ApiError.badRequest('Too many incorrect attempts. Please request a new code.');
  }

  if (!(await bcrypt.compare(String(code), token.codeHash))) {
    token.attempts += 1;
    const remaining = env.otp.maxAttempts - token.attempts;

    if (remaining <= 0) {
      await OtpToken.deleteOne({ _id: token._id });
      throw ApiError.badRequest('Too many incorrect attempts. Please request a new code.');
    }

    await token.save();
    throw ApiError.badRequest(`Incorrect code. ${remaining} attempt(s) remaining.`);
  }

  token.consumedAt = new Date();
  await token.save();

  return token;
}
