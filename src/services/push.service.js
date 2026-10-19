import PushSubscription from '../models/PushSubscription.js';

/**
 * Notifications to people's phones and browsers, for the staff who installed the app.
 *
 * Configured with VAPID keys — generate a pair once with `npx web-push generate-vapid-keys` and
 * set WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY and WEB_PUSH_SUBJECT (a mailto: address). Without
 * them nothing is sent and the message is printed to the console, as email and WhatsApp are here,
 * so development and the tests never reach a push service.
 *
 * A device that has gone — uninstalled, permission withdrawn — answers 404 or 410, and its
 * subscription is deleted rather than tried again forever.
 */
/*
 * The three settings as they are meant, whatever the .env did to them: spaces trimmed, quotes
 * around them dropped, a trailing "# comment" cut off, and a bare address given its "mailto:".
 * A key pasted with a quote or a stray space was refused by web-push, and the refusal used to be
 * reported as the package being missing.
 */
const clean = (value) => String(value ?? '').trim().replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
export function vapidSettings(source = process.env) {
  const publicKey = clean(source.WEB_PUSH_PUBLIC_KEY);
  const privateKey = clean(source.WEB_PUSH_PRIVATE_KEY);
  let subject = clean(source.WEB_PUSH_SUBJECT);
  if (subject && !/^(mailto:|https:)/i.test(subject) && /^[^\s@]+@[^\s@]+$/.test(subject)) subject = `mailto:${subject}`;
  return { publicKey, privateKey, subject };
}

export const pushPublicKey = () => vapidSettings().publicKey || null;
export const pushConfigured = () => {
  const { publicKey, privateKey, subject } = vapidSettings();
  return Boolean(publicKey && privateKey && subject);
};

/*
 * `web-push` is loaded on the first push, not when the API starts. A deploy that pulled this code
 * but skipped `npm ci` then loses push — said in the log — rather than the whole API. Neither a
 * missing package nor a refused key is remembered: fixed and restarted, the next push works.
 */
let client;
let problem = null;
/** Why push cannot send right now, in words — null when it can (or has not been tried). */
export const pushProblem = () => problem;

async function webPush() {
  if (client) return client;
  let webpush;
  try {
    ({ default: webpush } = await import('web-push'));
  } catch (error) {
    problem = 'the web-push package is missing on the server — in the server folder run npm install, then restart the API';
    console.error(`[push] web-push could not be loaded — run \`npm install\` in the server folder and restart. (${error.message})`);
    return null;
  }
  const { publicKey, privateKey, subject } = vapidSettings();
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
  } catch (error) {
    problem = `the push keys in the server's .env are not accepted: ${error.message.replace(publicKey, '(public key)').replace(privateKey, '(private key)')} — check WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY (not swapped, no quotes or spaces) and WEB_PUSH_SUBJECT (mailto: followed by an address), then restart the API`;
    console.error(`[push] ${problem}`);
    return null;
  }
  problem = null;
  client = webpush;
  return client;
}

/**
 * Sends `{ title, body, link }` to every device each person has allowed. Never throws. Returns
 * what each device's push service answered [deliverPush].
 */
export async function sendPush(userIds, message) {
  let ids = [...new Set((userIds || []).map(String))];
  if (!ids.length) return [];
  /* Development: to the one person trying the app, saying who it was for [devRedirect.service]. */
  const { redirecting, redirectUsers, namesOf } = await import('./devRedirect.service.js');
  if (redirecting()) {
    const meant = await namesOf(ids);
    ids = (await redirectUsers()).map((person) => String(person._id));
    message = { ...message, title: `[for ${meant}] ${message.title || ''}`.trim() };
    if (!ids.length) {
      console.log(`\n[push] development redirect: no user with DEV_NOTIFY_EMAIL — not sent\n${message.title}\n${message.body || ''}\n`);
      return [];
    }
  }
  const devices = await PushSubscription.find({ user: { $in: ids } });
  if (!devices.length) return [];
  return deliverPush(devices, message);
}

/** Which push service a device is on, from its endpoint — what a person can recognise. */
export function serviceOf(endpoint) {
  const host = (() => { try { return new URL(endpoint).host; } catch { return ''; } })();
  if (host.endsWith('push.apple.com')) return 'Apple';
  if (host.includes('googleapis.com') || host.includes('google.com')) return 'Google';
  if (host.includes('mozilla')) return 'Mozilla';
  if (host.includes('windows') || host.includes('microsoft')) return 'Microsoft';
  return host || 'unknown';
}

/** A push service's refusal in words, with what to do. */
export function whyRefused(statusCode, body = '') {
  const text = String(body || '');
  if (statusCode === 404 || statusCode === 410) return 'this device is no longer subscribed — it was removed; turn notifications on again on that device';
  if (statusCode === 403 || /VAPID|BadJwtToken|credentials/i.test(text)) {
    return 'the push keys on the server do not match the ones this device subscribed with (the keys were changed or set after it was turned on) — on that device press Turn off, then Turn on';
  }
  if (statusCode === 400 && /BadWebPushTopic|Subject|BadJwt/i.test(text)) return 'the push service did not accept WEB_PUSH_SUBJECT — make it mailto: followed by a real address, with nothing after it';
  if (statusCode === 413) return 'the message was too long for the push service';
  if (statusCode === 429) return 'the push service is rate-limiting — try again in a minute';
  return `the push service answered ${statusCode || 'with an error'}${text ? `: ${text.slice(0, 160)}` : ''}`;
}

/**
 * Sends to the devices given. Never throws. Returns, per device, `{ service, ok, why? }` — what
 * the push service answered, so a test can say it.
 */
export async function deliverPush(devices, message) {
  if (!pushConfigured()) {
    for (const device of devices) {
      console.log(`\n[push] to user ${device.user}\n${message.title}\n${message.body || ''}\n${message.link || ''}\n`);
    }
    return devices.map((device) => ({ service: serviceOf(device.endpoint), ok: false, why: 'push is not set up on the server (WEB_PUSH_* keys)' }));
  }

  const webpush = await webPush();
  if (!webpush) return devices.map((device) => ({ service: serviceOf(device.endpoint), ok: false, why: problem }));
  const payload = JSON.stringify(message);
  return Promise.all(
    devices.map((device) =>
      webpush
        .sendNotification({ endpoint: device.endpoint, keys: device.keys }, payload, { TTL: 60 * 60 * 24, urgency: 'high' })
        .then(() => ({ service: serviceOf(device.endpoint), ok: true }))
        .catch(async (error) => {
          const why = whyRefused(error.statusCode, error.body);
          if (error.statusCode === 404 || error.statusCode === 410) await device.deleteOne();
          else console.error(`[push] to user ${device.user} not sent (${serviceOf(device.endpoint)} ${error.statusCode || ''}): ${error.body || error.message}`);
          return { service: serviceOf(device.endpoint), ok: false, why };
        })
    )
  );
}
