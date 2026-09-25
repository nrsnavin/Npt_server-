import PushSubscription from '../models/PushSubscription.js';
import asyncHandler from '../utils/asyncHandler.js';
import { pushConfigured, pushPublicKey } from '../services/push.service.js';

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
