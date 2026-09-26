import { createHmac, timingSafeEqual } from 'node:crypto';
import ApiError from '../utils/ApiError.js';

/**
 * WhatsApp through Meta's own WhatsApp Business Platform (the Cloud API), with no Twilio between.
 *
 * Four settings, all from Meta Business Manager / the app dashboard:
 *
 *   META_WA_TOKEN            a permanent (system user) access token with whatsapp_business_messaging
 *   META_WA_PHONE_NUMBER_ID  the id of the business number messages are sent from (not the number)
 *   META_WA_APP_SECRET       the app's secret — proves an inbound webhook really came from Meta
 *   META_WA_VERIFY_TOKEN     any long random string, typed into the webhook setup once
 *
 * Read at call time rather than import time, so a restart is all a settings change needs and the
 * tests can set them per case.
 */
export function metaConfig() {
  return {
    token: process.env.META_WA_TOKEN,
    phoneNumberId: process.env.META_WA_PHONE_NUMBER_ID,
    appSecret: process.env.META_WA_APP_SECRET,
    verifyToken: process.env.META_WA_VERIFY_TOKEN,
    /* Overridable so tests can point it at a local server, and so a version bump is a setting. */
    graphUrl: (process.env.META_GRAPH_URL || `https://graph.facebook.com/${process.env.META_WA_API_VERSION || 'v23.0'}`).replace(/\/$/, ''),
    templateLanguage: process.env.META_WA_TEMPLATE_LANGUAGE || 'en',
    timeoutMs: Number(process.env.META_WA_TIMEOUT_MS || 10000),
    maxAttempts: Number(process.env.META_WA_MAX_ATTEMPTS || 2),
  };
}

/** True when messages can be sent: a token and the number to send from. */
export function isMetaConfigured() {
  const { token, phoneNumberId } = metaConfig();
  return Boolean(token && phoneNumberId);
}

/** A half-filled block fails at startup, naming what is missing, rather than on the first send. */
export function metaConfigurationProblem() {
  const { token, phoneNumberId, appSecret, verifyToken } = metaConfig();
  if (!token && !phoneNumberId && !appSecret && !verifyToken) return null;
  const missing = [];
  if (!token) missing.push('META_WA_TOKEN');
  if (!phoneNumberId) missing.push('META_WA_PHONE_NUMBER_ID');
  if (!appSecret) missing.push('META_WA_APP_SECRET');
  return missing.length ? `WhatsApp (Meta) is partially configured — missing ${missing.join(', ')}` : null;
}

/** Meta addresses a number as its digits, country code first, no "+". */
export const waId = (number) => String(number || '').replace(/\D/g, '');

/*
 * Meta's error codes worth naming. The message is shown to staff (a quotation's send log, a
 * failed delivery), so it says what to do; nothing in it is the token or account detail.
 * https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
const RECIPIENT_ERRORS = {
  131026: 'That number could not receive the message — it may not be on WhatsApp.',
  131047: 'The buyer has not messaged in the last 24 hours, so WhatsApp only accepts an approved template. Set the template for this message.',
  131051: 'WhatsApp does not support that kind of message.',
  131052: 'The file could not be downloaded from the link given.',
  131053: 'The file could not be sent — check it is a PDF or an image under the size limit.',
  131030: 'That number is not on the test number\'s allowed list in Meta\'s dashboard.',
  132000: 'The template\'s placeholders do not match what was sent — check the template in WhatsApp Manager.',
  132001: 'That template does not exist in this language, or is not approved yet.',
  132005: 'The template text is too long once filled in.',
  132007: 'The template text breaks WhatsApp\'s formatting rules.',
  132012: 'The template\'s placeholders are in the wrong format.',
  132015: 'That template is paused by Meta for low quality.',
  132016: 'That template has been disabled by Meta.',
  133010: 'The WhatsApp business number is not registered with the Cloud API yet.',
  470: 'The buyer has not messaged in the last 24 hours, so WhatsApp only accepts an approved template.',
};

const CONFIG_ERRORS = {
  190: 'The Meta access token has expired or is not valid — check META_WA_TOKEN (use a permanent system-user token).',
  10: 'The Meta access token lacks the whatsapp_business_messaging permission.',
  200: 'The Meta access token lacks the whatsapp_business_messaging permission.',
  100: 'Meta refused the request as malformed — often a wrong META_WA_PHONE_NUMBER_ID.',
  131031: 'The WhatsApp business account has been locked by Meta.',
  368: 'The WhatsApp business account is temporarily blocked for policy violations.',
};

const RATE_LIMITS = [4, 80007, 130429, 131048, 131056];

function translate(payload, httpStatus) {
  const error = payload?.error || {};
  const code = Number(error.code);
  if (RECIPIENT_ERRORS[code]) return ApiError.badRequest(RECIPIENT_ERRORS[code]);
  if (CONFIG_ERRORS[code]) {
    console.error(`[whatsapp/meta] ${CONFIG_ERRORS[code]} (code ${code}, trace ${error.fbtrace_id || '-'})`);
    return new ApiError(500, 'WhatsApp is not set up correctly on the server. An administrator can see why in the server log.');
  }
  if (RATE_LIMITS.includes(code)) return new ApiError(503, 'WhatsApp is limiting how fast messages go out. Try again in a minute.');
  console.error(`[whatsapp/meta] send failed with HTTP ${httpStatus}`, { code: error.code, subcode: error.error_subcode, message: error.message, trace: error.fbtrace_id });
  return new ApiError(502, 'WhatsApp did not accept the message. Please try again shortly.');
}

async function graph(path, { method = 'GET', body } = {}, attempt = 1) {
  const { token, graphUrl, timeoutMs, maxAttempts } = metaConfig();
  let response;
  try {
    response = await fetch(`${graphUrl}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (attempt < maxAttempts) return graph(path, { method, body }, attempt + 1);
    console.error(`[whatsapp/meta] request ${error.name === 'TimeoutError' ? 'timed out' : error.message} after ${attempt} attempt(s)`);
    throw new ApiError(504, 'WhatsApp could not be reached. Please try again shortly.');
  }
  const payload = await response.json().catch(() => ({}));
  if (response.ok) return payload;
  const code = Number(payload?.error?.code);
  if ((response.status >= 500 || RATE_LIMITS.includes(code)) && attempt < maxAttempts) {
    return graph(path, { method, body }, attempt + 1);
  }
  throw translate(payload, response.status);
}

/*
 * A template parameter may not hold a newline, a tab or more than four spaces in a row, and may
 * not be empty — Meta refuses the whole message otherwise (132012 / 131008).
 */
const parameter = (value) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return { type: 'text', text: text || '-' };
};

/** `{ 1: 'a', 2: 'b' }` → Meta's ordered body parameters. */
const ordered = (variables = {}) =>
  Object.keys(variables)
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => parameter(variables[key]));

/** "quote_sent" or "quote_sent:en_US" → { name, language }. */
export const templateRef = (value) => {
  const [name, language] = String(value).split(':');
  return { name: name.trim(), language: (language || metaConfig().templateLanguage).trim() };
};

const CAPTION_LIMIT = 1024;

async function post(message) {
  const { phoneNumberId } = metaConfig();
  const payload = await graph(`${phoneNumberId}/messages`, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', recipient_type: 'individual', ...message },
  });
  const sent = payload.messages?.[0] || {};
  /* "accepted" is all a send can say: delivery and failure arrive later on the webhook. */
  return { delivered: true, channel: 'whatsapp', id: sent.id, sid: sent.id, status: sent.message_status || 'accepted' };
}

/**
 * One WhatsApp message.
 *
 * - `template` (a template name, optionally `name:language`) with `variables` — the only kind
 *   WhatsApp accepts outside 24 hours of the person's own last message.
 * - Otherwise `body`, and `document: { url, filename }` to send a file with it: the file goes as
 *   a document with the body as its caption, or — when the body is longer than a caption may be —
 *   as the text first and the document straight after.
 * - `code` sends a one-time code on an authentication template (the code in the body and in its
 *   copy-code button, which is how Meta's authentication templates are shaped).
 */
export async function sendMetaWhatsApp({ to, body, template, variables, document, code }) {
  const address = waId(to);
  if (!address) throw ApiError.badRequest('Give a WhatsApp number to send it to.');

  if (template) {
    const { name, language } = templateRef(template);
    const components = code
      ? [
          { type: 'body', parameters: [parameter(code)] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [parameter(code)] },
        ]
      : variables && Object.keys(variables).length
        ? [{ type: 'body', parameters: ordered(variables) }]
        : [];
    return post({ to: address, type: 'template', template: { name, language: { code: language }, ...(components.length ? { components } : {}) } });
  }

  const text = String(body || '');
  if (document?.url) {
    const file = { link: document.url, ...(document.filename ? { filename: document.filename } : {}) };
    if (text.length <= CAPTION_LIMIT) return post({ to: address, type: 'document', document: { ...file, ...(text ? { caption: text } : {}) } });
    await post({ to: address, type: 'text', text: { body: text.slice(0, 4096), preview_url: false } });
    return post({ to: address, type: 'document', document: file });
  }

  return post({ to: address, type: 'text', text: { body: text.slice(0, 4096), preview_url: true } });
}

/** Where Meta serves media from once asked for its address. Widened only by the tests. */
const mediaHosts = () =>
  (process.env.WHATSAPP_MEDIA_HOSTS || '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
const isMetaMediaHost = (hostname) =>
  /(^|\.)fbsbx\.com$/i.test(hostname) || /(^|\.)facebook\.com$/i.test(hostname) || /(^|\.)whatsapp\.net$/i.test(hostname)
  || mediaHosts().includes(hostname.toLowerCase());

/**
 * The bytes of a photo sent to the number. Meta sends an id, not a link: the id is exchanged for
 * a short-lived address, which is then fetched with the same token.
 */
export async function fetchMetaMedia(id, { maxBytes }) {
  if (!/^[\w.-]+$/.test(String(id || ''))) throw new Error('The media id is not valid');
  const described = await graph(encodeURIComponent(id));
  if (Number(described.file_size) > maxBytes) throw new Error('The photo is too large');
  let parsed;
  try {
    parsed = new URL(described.url);
  } catch {
    throw new Error('Meta did not give an address for the media');
  }
  if (!isMetaMediaHost(parsed.hostname)) throw new Error(`Media is only fetched from Meta, not ${parsed.hostname}`);

  const response = await fetch(parsed, {
    headers: { Authorization: `Bearer ${metaConfig().token}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`The media could not be fetched (${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error('The photo is too large');
  const mimeType = String(described.mime_type || response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  return { buffer, mimeType };
}

/* ---------------------------------- Inbound ---------------------------------- */

/** True when this body is Meta's, not Twilio's form post or the plain JSON shape. */
export const isMetaWebhook = (body) => body?.object === 'whatsapp_business_account';

/**
 * Whether Meta signed this body with the app's secret. Compared on the exact bytes received —
 * a re-serialised body is not what was signed.
 */
export function verifyMetaSignature(rawBody, header) {
  const { appSecret } = metaConfig();
  if (!appSecret || !rawBody || !header) return false;
  const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const offered = Buffer.from(String(header));
  const wanted = Buffer.from(expected);
  return offered.length === wanted.length && timingSafeEqual(offered, wanted);
}

/** The words of a message, whatever kind it is. */
function wordsOf(message) {
  return message.text?.body
    ?? message.image?.caption
    ?? message.document?.caption
    ?? message.video?.caption
    ?? message.button?.text
    ?? message.interactive?.button_reply?.title
    ?? message.interactive?.list_reply?.title
    ?? undefined;
}

function mediaOf(message) {
  const item = message.image || message.document || message.video || message.audio || message.sticker;
  return item?.id ? [{ id: item.id, contentType: item.mime_type, ...(item.filename ? { filename: item.filename } : {}) }] : [];
}

/**
 * Meta's webhook body, as the messages and the delivery updates in it.
 * Messages: `{ from, body, media, providerId, profileName, receivedAt }`, the shape the inbox and
 * the lead cards already take. Statuses: `{ id, status, error }`.
 */
export function parseMetaWebhook(body) {
  const messages = [];
  const statuses = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const names = new Map((value.contacts || []).map((contact) => [contact.wa_id, contact.profile?.name]));
      for (const message of value.messages || []) {
        messages.push({
          from: `+${waId(message.from)}`,
          body: wordsOf(message),
          media: mediaOf(message),
          providerId: message.id,
          profileName: names.get(message.from),
          receivedAt: message.timestamp ? new Date(Number(message.timestamp) * 1000) : undefined,
        });
      }
      for (const status of value.statuses || []) {
        const error = status.errors?.[0];
        statuses.push({
          id: status.id,
          status: status.status,
          error: error ? RECIPIENT_ERRORS[Number(error.code)] || error.title || error.message || `WhatsApp error ${error.code}` : undefined,
        });
      }
    }
  }
  return { messages, statuses };
}
