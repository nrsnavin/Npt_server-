import Setting from '../models/Setting.js';

/**
 * The security policy every signed-in app follows: a device PIN for everybody or only for those
 * who choose one, and the idle minutes before the app locks behind it. The PIN itself never
 * reaches the server — it seals the session token in the browser — so this is policy alone.
 */
export const SECURITY_DEFAULTS = Object.freeze({ pinRequired: false, lockAfterMinutes: 15 });
export const LOCK_MINUTES = Object.freeze({ min: 1, max: 240 });

export async function securityPolicy() {
  const row = await Setting.findOne({ key: 'security' }).lean();
  return { ...SECURITY_DEFAULTS, ...(row?.value || {}) };
}

export async function setSecurityPolicy(changes, by) {
  const current = await securityPolicy();
  const next = {
    pinRequired: changes.pinRequired === undefined ? current.pinRequired : Boolean(changes.pinRequired),
    lockAfterMinutes: changes.lockAfterMinutes === undefined
      ? current.lockAfterMinutes
      : Math.min(LOCK_MINUTES.max, Math.max(LOCK_MINUTES.min, Math.round(Number(changes.lockAfterMinutes)))),
  };
  await Setting.updateOne({ key: 'security' }, { $set: { value: next, updatedBy: by?._id } }, { upsert: true });
  return next;
}
