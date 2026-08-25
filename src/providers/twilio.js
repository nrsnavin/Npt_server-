import { env, isProduction } from '../config/env.js';
import ApiError from '../utils/ApiError.js';

const API_BASE = 'https://api.twilio.com/2010-04-01';

/**
 * Twilio failures caused by the recipient's number. These are the caller's problem,
 * so they surface as a 400 with a message that is safe to show a user.
 * https://www.twilio.com/docs/api/errors
 */
const RECIPIENT_ERRORS = {
  21211: 'That phone number is not valid.',
  21214: 'That phone number could not be reached.',
  21217: 'That phone number is not valid.',
  21610: 'This number has unsubscribed from our messages. Reply START to receive them again.',
  21612: 'We cannot deliver a message to that number.',
  21614: 'That number cannot receive SMS. Try signing in with your email instead.',
};

/**
 * Failures caused by our own account or configuration. The operator needs the detail;
 * the user only ever sees a generic "try again", because these leak account posture.
 */
const CONFIG_ERRORS = {
  20003: 'Twilio authentication failed — check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.',
  20404: 'Twilio account not found — check TWILIO_ACCOUNT_SID.',
  21408: 'Twilio is not permitted to send to that region — enable it under Geo Permissions.',
  21606: 'The Twilio sender is not a valid SMS-capable number.',
  21609: 'The Twilio messaging service SID is not valid.',
  21659: 'The Twilio sender number is not owned by this account.',
  63038: 'The Twilio daily message limit has been reached.',
};

/** True when enough Twilio settings are present to actually send. */
export function isConfigured() {
  const { accountSid, authToken, fromNumber, messagingServiceSid } = env.twilio;
  return Boolean(accountSid && authToken && (fromNumber || messagingServiceSid));
}

/**
 * Explains a partial configuration, so a half-filled .env fails loudly at startup
 * rather than silently dropping every code.
 */
export function configurationProblem() {
  const { accountSid, authToken, fromNumber, messagingServiceSid } = env.twilio;
  if (!accountSid && !authToken && !fromNumber && !messagingServiceSid) return null;

  const missing = [];
  if (!accountSid) missing.push('TWILIO_ACCOUNT_SID');
  if (!authToken) missing.push('TWILIO_AUTH_TOKEN');
  if (!fromNumber && !messagingServiceSid) {
    missing.push('TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID');
  }

  return missing.length ? `Twilio is partially configured — missing ${missing.join(', ')}` : null;
}

function translate(payload, httpStatus) {
  const code = Number(payload?.code);

  if (RECIPIENT_ERRORS[code]) {
    return ApiError.badRequest(RECIPIENT_ERRORS[code]);
  }

  if (CONFIG_ERRORS[code]) {
    // Log the real cause for the operator; never put it in the response body.
    console.error(`[twilio] ${CONFIG_ERRORS[code]} (code ${code})`);
    return new ApiError(500, 'We could not send the code right now. Please try again shortly.');
  }

  console.error(
    `[twilio] send failed with HTTP ${httpStatus}`,
    // Twilio echoes the message body back on some errors; keep it out of the logs.
    { code: payload?.code, status: payload?.status, message: payload?.message }
  );

  return new ApiError(502, 'We could not send the code right now. Please try again shortly.');
}

/**
 * Sends one SMS through Twilio's Programmable Messaging API.
 *
 * Prefers a messaging service (number pool, compliance, sender selection) over a single
 * from-number when both are set. Retries once on a transient network or 5xx failure.
 * Returns the message SID so a delivery can be traced in the Twilio console.
 */
export async function sendSms({ to, body }, attempt = 1) {
  const { accountSid, authToken, fromNumber, messagingServiceSid, timeoutMs, maxAttempts } =
    env.twilio;

  const params = new URLSearchParams({ To: to, Body: body });
  if (messagingServiceSid) params.set('MessagingServiceSid', messagingServiceSid);
  else params.set('From', fromNumber);

  let response;
  try {
    response = await fetch(`${API_BASE}/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
      // Without this a hung Twilio call holds the API request open indefinitely.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (attempt < maxAttempts) {
      return sendSms({ to, body }, attempt + 1);
    }
    const reason = error.name === 'TimeoutError' ? 'timed out' : error.message;
    console.error(`[twilio] request ${reason} after ${attempt} attempt(s)`);
    throw new ApiError(504, 'We could not send the code right now. Please try again shortly.');
  }

  if (response.ok) {
    const payload = await response.json().catch(() => ({}));
    return { delivered: true, channel: 'sms', sid: payload.sid, status: payload.status };
  }

  // 429 and 5xx are worth one more try; 4xx will fail identically every time.
  if ((response.status >= 500 || response.status === 429) && attempt < maxAttempts) {
    return sendSms({ to, body }, attempt + 1);
  }

  const payload = await response.json().catch(() => ({}));
  throw translate(payload, response.status);
}
