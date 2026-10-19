import PushSubscription from '../models/PushSubscription.js';
import Setting from '../models/Setting.js';
import asyncHandler from '../utils/asyncHandler.js';
import { pushConfigured, pushProblem, pushPublicKey } from '../services/push.service.js';

/** What a device needs to subscribe — and whether this server sends pushes at all. */
export const pushKey = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { publicKey: pushPublicKey(), configured: pushConfigured() } });
});

/** This device, for me. The same device signed in as somebody else moves to them. */
export const subscribePush = asyncHandler(async (req, res) => {
  const { endpoint, keys } = req.body;
  await PushSubscription.findOneAndUpdate(
    { endpoint },
    { user: req.user._id, endpoint, keys, userAgent: String(req.get('user-agent') || '').slice(0, 300) },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  res.status(201).json({ success: true, data: { subscribed: true } });
});

/** Stop notifying this device. Only my own — anybody else's endpoint is simply not found. */
export const unsubscribePush = asyncHandler(async (req, res) => {
  const { deletedCount } = await PushSubscription.deleteOne({ endpoint: req.body.endpoint, user: req.user._id });
  res.json({ success: true, data: { removed: deletedCount > 0 } });
});

/**
 * Whether notifications are set up, for the profile's check: push keys, the mail server, the
 * WhatsApp provider, how many devices I have switched on, and — on a development server — where
 * everything is being redirected [devRedirect.service]. Never a key or a password.
 */
export const notificationStatus = asyncHandler(async (req, res) => {
  const [{ env, isProduction }, { isWhatsAppConfigured, whatsappProvider }, redirect] = await Promise.all([
    import('../config/env.js'), import('../providers/whatsapp.js'), import('../services/devRedirect.service.js'),
  ]);
  const myDevices = await PushSubscription.countDocuments({ user: req.user._id });
  const lastTest = (await Setting.findOne({ key: waTestKey(req.user._id) }).lean())?.value || null;
  res.json({
    success: true,
    data: {
      mode: isProduction ? 'production' : process.env.NODE_ENV || 'not set',
      redirect: redirect.redirecting() ? { email: redirect.redirectEmail(), phone: await redirect.redirectPhone() } : null,
      push: { configured: pushConfigured(), myDevices, problem: pushProblem() },
      email: { configured: Boolean(env.smtp.host), host: env.smtp.host || null, from: env.smtp.from || null },
      whatsapp: { configured: isWhatsAppConfigured(), provider: whatsappProvider() || null, lastTest },
    },
  });
});

/**
 * "Send me a test": a push to my devices and an email to me, through the same path every real
 * notification takes (so on a development server, redirected too). Says what happened to each.
 */
export const sendTestNotification = asyncHandler(async (req, res) => {
  const [{ sendPush }, { sendEmail }] = await Promise.all([import('../services/push.service.js'), import('../services/notification.service.js')]);
  const devices = await PushSubscription.countDocuments({ user: req.user._id });
  const when = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const delivered = await sendPush([req.user._id], { title: 'Test notification', body: `Notifications work on this device — ${when}`, link: '/profile', kind: 'test' });
  let email = { sent: false, why: 'No email address on your profile' };
  if (req.user.email) {
    try {
      const result = await sendEmail({ to: req.user.email, subject: 'Test notification from NPT Hangers', text: `If you can read this, email from the app works. Sent ${when}.` });
      email = result.delivered ? { sent: true } : { sent: false, why: 'The mail server is not set — the server printed it to its log instead' };
    } catch (error) {
      email = { sent: false, why: error.message };
    }
  }
  const whatsapp = await testWhatsApp(req.user, when);
  const { redirecting, redirectEmail } = await import('../services/devRedirect.service.js');
  res.json({
    success: true,
    data: {
      redirect: redirecting() ? redirectEmail() : null,
      push: { pushConfigured: pushConfigured(), devices, delivered },
      email,
      whatsapp,
    },
  });
});

const waTestKey = (userId) => `wa-test:${userId}`;

/**
 * A WhatsApp test to my phone (on a development server, to the redirect phone). Meta only says
 * "accepted" here; whether it was delivered — or refused, say for the 24-hour rule — arrives on
 * the webhook a moment later and is kept, so the status check can show it [noteWhatsAppTest].
 */
async function testWhatsApp(user, when) {
  const { isWhatsAppConfigured, sendWhatsApp, whatsappTemplate } = await import('../providers/whatsapp.js');
  if (!isWhatsAppConfigured()) return { configured: false, sent: false, why: 'WhatsApp is not set up on the server' };
  const { redirecting } = await import('../services/devRedirect.service.js');
  if (!user.phone && !redirecting()) return { configured: true, sent: false, why: 'No phone number on your profile — add it, then test again' };
  const template = whatsappTemplate('task');
  try {
    const sent = await sendWhatsApp({
      to: user.phone || user.email,
      body: `Test message from NPT Hangers — WhatsApp from the app works. ${when}`,
      ...(template ? { template, variables: { 1: 'Test notification', 2: `WhatsApp from the app works — ${when}`, 3: 'Profile' } } : {}),
    });
    if (!sent?.delivered && sent?.redirected) return { configured: true, sent: false, why: 'Development server: no phone to redirect to — set DEV_NOTIFY_PHONE' };
    await Setting.findOneAndUpdate(
      { key: waTestKey(user._id) },
      { $set: { value: { id: sent?.id || null, status: sent?.status || 'accepted', at: new Date(), template: Boolean(template) }, updatedBy: user._id } },
      { upsert: true }
    );
    return { configured: true, sent: true, status: sent?.status || 'accepted', template: Boolean(template) };
  } catch (error) {
    return { configured: true, sent: false, why: error.message };
  }
}

/** Meta's word on a test message — sent, delivered, read, or failed and why — kept for the check. */
export async function noteWhatsAppTest({ id, status, error }) {
  if (!id) return;
  await Setting.updateOne(
    { key: /^wa-test:/, 'value.id': id },
    { $set: { 'value.status': status, 'value.statusAt': new Date(), ...(error ? { 'value.error': String(error).slice(0, 300) } : {}) } }
  );
}
