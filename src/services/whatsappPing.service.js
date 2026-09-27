import { normalisePhone } from '../utils/phone.js';
import { isWhatsAppConfigured, sendWhatsApp, whatsappProvider } from '../providers/whatsapp.js';

/**
 * A live check of the WhatsApp integration: every sign-in sends a template to one number.
 *
 *   WHATSAPP_LOGIN_PING=7550005370                 the number to send to (off when unset)
 *   WHATSAPP_LOGIN_PING_TEMPLATE=hello_world:en_US  the template (Meta's pre-approved sample)
 *
 * It proves the whole path, not just the settings: the send is accepted by Meta (token, phone
 * number id, template), and then Meta's delivery report arrives on the webhook ("delivered",
 * "read") — which proves the webhook and its signature too. The latest attempt is on
 * /health/ready under `platform.whatsappLoginPing` and in the server log. Meant for setting up;
 * every sign-in is a message, so unset it once the check has passed.
 *
 * Never slows or breaks a sign-in: it runs after the reply and every failure is only reported.
 */

let last = null;

const masked = (number) => `${number.slice(0, 3)}******${number.slice(-4)}`;

export function pingOnSignIn(user, method) {
  const raw = process.env.WHATSAPP_LOGIN_PING;
  if (!raw) return;
  const to = normalisePhone(raw);
  const template = process.env.WHATSAPP_LOGIN_PING_TEMPLATE || 'hello_world:en_US';
  const entry = { to: to ? masked(to) : String(raw), template, at: new Date(), status: 'sending' };
  last = entry;
  const say = (line) => console.log(`[whatsapp/login-ping] ${line}`);

  if (!to) {
    Object.assign(entry, { status: 'failed', error: `WHATSAPP_LOGIN_PING is not a phone number: ${raw}` });
    return say(entry.error);
  }
  if (!isWhatsAppConfigured()) {
    Object.assign(entry, { status: 'not_configured', error: 'No WhatsApp provider is set up: add the META_WA_* settings and restart.' });
    return say(entry.error);
  }

  entry.provider = whatsappProvider();
  sendWhatsApp({ to, template })
    .then((sent) => {
      Object.assign(entry, { status: sent.status || 'accepted', messageId: sent.id });
      say(`${template} to ${entry.to} accepted by ${entry.provider} (${sent.id}) — sign-in by ${user?.name || 'someone'} via ${method}`);
    })
    .catch((error) => {
      /* The real reason where there is one — this check exists to say what is wrong. */
      Object.assign(entry, { status: 'failed', error: error.diagnosis || error.message });
      say(`${template} to ${entry.to} failed: ${entry.error}`);
    });
}

/** Meta's delivery report for the check's message, from the webhook. */
export function notePingStatus({ id, status, error }) {
  if (!last?.messageId || last.messageId !== id) return;
  Object.assign(last, { status, statusAt: new Date(), ...(error ? { error } : {}) });
  console.log(`[whatsapp/login-ping] ${last.template} to ${last.to}: ${status}${error ? ` — ${error}` : ''}`);
}

/** The latest attempt, for /health/ready. The number is masked; no names — the endpoint is public. */
export const loginPingReport = () =>
  last && {
    to: last.to,
    template: last.template,
    at: last.at,
    status: last.status,
    ...(last.statusAt ? { statusAt: last.statusAt } : {}),
    ...(last.error ? { error: last.error } : {}),
  };
