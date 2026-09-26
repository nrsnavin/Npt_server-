import {
  fetchMedia as fetchTwilioMedia,
  isWhatsAppConfigured as isTwilioWhatsAppConfigured,
  sendWhatsApp as sendTwilioWhatsApp,
  MAX_MEDIA_BYTES,
} from './twilio.js';
import { fetchMetaMedia, isMetaConfigured, sendMetaWhatsApp } from './meta.js';

/**
 * WhatsApp, whichever way this deployment sends it: Meta's WhatsApp Business Platform directly,
 * or Twilio. Every feature calls this module and none of them knows which is behind it.
 *
 * `WHATSAPP_PROVIDER` chooses (`meta` or `twilio`). Unset, Meta is used when its settings are
 * present, then Twilio — so moving from one to the other is setting the new block, not code.
 */
export function whatsappProvider() {
  const chosen = String(process.env.WHATSAPP_PROVIDER || '').trim().toLowerCase();
  if (chosen === 'meta') return isMetaConfigured() ? 'meta' : null;
  if (chosen === 'twilio') return isTwilioWhatsAppConfigured() ? 'twilio' : null;
  if (isMetaConfigured()) return 'meta';
  if (isTwilioWhatsAppConfigured()) return 'twilio';
  return null;
}

export const isWhatsAppConfigured = () => Boolean(whatsappProvider());

/*
 * The approved template for each business-initiated message, as the provider names it: a
 * template name (optionally `name:language`) on Meta, a content SID (HX…) on Twilio. The old
 * Twilio-only variable names are still read, so an existing .env keeps working.
 */
const TEMPLATE_SETTINGS = {
  quote: ['WHATSAPP_TEMPLATE_QUOTE', 'TWILIO_WHATSAPP_QUOTE_TEMPLATE_SID'],
  tag: ['WHATSAPP_TEMPLATE_TAG', 'TWILIO_WHATSAPP_TAG_TEMPLATE_SID'],
  sample_ready: ['WHATSAPP_TEMPLATE_SAMPLE_READY'],
  sample_dispatched: ['WHATSAPP_TEMPLATE_SAMPLE_DISPATCHED'],
  otp: ['WHATSAPP_TEMPLATE_OTP'],
};

/** The template configured for `key`, or undefined — read now, so a restart picks up a change. */
export function whatsappTemplate(key) {
  for (const name of TEMPLATE_SETTINGS[key] || []) {
    const value = String(process.env[name] || '').trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Sends one message: `{ to, body, template?, variables?, document?: { url, filename } }`.
 * `variables` is `{ 1: …, 2: … }`, the template's placeholders in order.
 * Returns `{ delivered, channel, id, sid, status }`.
 */
export async function sendWhatsApp({ to, body, template, variables, document }) {
  const provider = whatsappProvider();
  if (provider === 'meta') return sendMetaWhatsApp({ to, body, template, variables, document });
  if (provider === 'twilio') {
    const sent = await sendTwilioWhatsApp({
      to,
      body,
      ...(template ? { contentSid: template, contentVariables: variables } : {}),
      ...(document?.url ? { mediaUrl: document.url } : {}),
    });
    return { ...sent, id: sent.sid };
  }
  throw new Error('No WhatsApp provider is configured. Set the META_WA_* (or TWILIO_*) settings.');
}

/**
 * A one-time sign-in code over WhatsApp, on the approved authentication template. Null when
 * there is no template for it — then codes cannot go by WhatsApp.
 */
export async function sendWhatsAppCode({ to, code }) {
  const template = whatsappTemplate('otp');
  if (!template || !isWhatsAppConfigured()) return null;
  if (whatsappProvider() === 'meta') return sendMetaWhatsApp({ to, template, code });
  return sendWhatsApp({ to, template, variables: { 1: code } });
}

/**
 * The bytes of a photo sent to the number, as `{ buffer, mimeType }`, from what the webhook gave:
 * `{ id }` from Meta, `{ url }` from Twilio.
 */
export async function fetchMedia(item, { maxBytes = MAX_MEDIA_BYTES } = {}) {
  if (item?.id) return fetchMetaMedia(item.id, { maxBytes });
  return fetchTwilioMedia(item?.url ?? item, { maxBytes });
}
