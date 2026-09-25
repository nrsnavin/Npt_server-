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
export const pushPublicKey = () => process.env.WEB_PUSH_PUBLIC_KEY || null;
export const pushConfigured = () =>
  Boolean(process.env.WEB_PUSH_PUBLIC_KEY && process.env.WEB_PUSH_PRIVATE_KEY && process.env.WEB_PUSH_SUBJECT);

/*
 * `web-push` is loaded on the first push, not when the API starts. A deploy that pulled this code
 * but skipped `npm ci` then loses push — said in the log — rather than the whole API.
 */
let client;
async function webPush() {
  if (client !== undefined) return client;
  try {
    const { default: webpush } = await import('web-push');
    webpush.setVapidDetails(process.env.WEB_PUSH_SUBJECT, process.env.WEB_PUSH_PUBLIC_KEY, process.env.WEB_PUSH_PRIVATE_KEY);
    client = webpush;
  } catch (error) {
    console.error(`[push] web-push is not installed — run \`npm ci\` on the server. Nothing is sent. (${error.message})`);
    client = null;
  }
  return client;
}

/** Sends `{ title, body, link }` to every device each person has allowed. Never throws. */
export async function sendPush(userIds, message) {
  const ids = [...new Set((userIds || []).map(String))];
  if (!ids.length) return;
  const devices = await PushSubscription.find({ user: { $in: ids } });
  if (!devices.length) return;
  await deliverPush(devices, message);
}

/** Sends to the devices given. Never throws. */
export async function deliverPush(devices, message) {
  if (!pushConfigured()) {
    for (const device of devices) {
      console.log(`\n[push] to user ${device.user}\n${message.title}\n${message.body || ''}\n${message.link || ''}\n`);
    }
    return;
  }

  const webpush = await webPush();
  if (!webpush) return;
  const payload = JSON.stringify(message);
  await Promise.all(
    devices.map((device) =>
      webpush
        .sendNotification({ endpoint: device.endpoint, keys: device.keys }, payload, { TTL: 60 * 60 * 24 })
        .catch(async (error) => {
          if (error.statusCode === 404 || error.statusCode === 410) await device.deleteOne();
          else console.error(`[push] to user ${device.user} not sent: ${error.message}`);
        })
    )
  );
}
