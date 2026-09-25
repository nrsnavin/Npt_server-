import webpush from 'web-push';
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

let ready = false;
function configure() {
  if (ready || !pushConfigured()) return;
  webpush.setVapidDetails(process.env.WEB_PUSH_SUBJECT, process.env.WEB_PUSH_PUBLIC_KEY, process.env.WEB_PUSH_PRIVATE_KEY);
  ready = true;
}

/** Sends `{ title, body, link }` to every device each person has allowed. Never throws. */
export async function sendPush(userIds, message) {
  const ids = [...new Set((userIds || []).map(String))];
  if (!ids.length) return;
  const devices = await PushSubscription.find({ user: { $in: ids } });
  if (!devices.length) return;

  if (!pushConfigured()) {
    for (const device of devices) {
      console.log(`\n[push] to user ${device.user}\n${message.title}\n${message.body || ''}\n${message.link || ''}\n`);
    }
    return;
  }

  configure();
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
