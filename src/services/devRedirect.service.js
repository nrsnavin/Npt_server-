/**
 * While the plant is still trying the app out, every notification goes to one person.
 *
 * On a server started with NODE_ENV=development, each email, push and WhatsApp the app would
 * send to staff or buyers goes instead to DEV_NOTIFY_EMAIL (rsnavin1@gmail.com unless set) —
 * with who it was meant for written on it — so a test run never messages a real buyer or wakes
 * a colleague. Pushes go to that person's devices; WhatsApp to DEV_NOTIFY_PHONE (+91 75500 05370
 * unless set), else their phone on the user register. Set DEV_NOTIFY_EMAIL= (empty) to turn it
 * off.
 *
 * Sign-in codes and password links are never redirected: they are how a person gets in, and
 * sending them elsewhere would lock everybody but one out of their own test server.
 *
 * Production (NODE_ENV=production), the test suite and a server with NODE_ENV unset send to the
 * real people.
 */

export const redirectEmail = () => {
  if (process.env.NODE_ENV !== 'development') return null;
  const value = process.env.DEV_NOTIFY_EMAIL ?? 'rsnavin1@gmail.com';
  return String(value).trim().toLowerCase() || null;
};

export const redirecting = () => Boolean(redirectEmail());

/** The people the redirect lands on: users whose email is the redirect address. */
export async function redirectUsers() {
  const email = redirectEmail();
  if (!email) return [];
  const { default: User } = await import('../models/User.js');
  return User.find({ email, isActive: { $ne: false } }).select('_id name phone email').lean();
}

/** The phone WhatsApp is redirected to: DEV_NOTIFY_PHONE (7550005370 unless set), else the redirect user's phone. */
export async function redirectPhone() {
  if (!redirecting()) return null;
  const { normalisePhone } = await import('../utils/phone.js');
  const set = normalisePhone(process.env.DEV_NOTIFY_PHONE ?? '7550005370');
  if (set) return set;
  const [person] = await redirectUsers();
  return person?.phone || null;
}

/** "for Ramesh, Priya" — who a redirected push was meant for. */
export async function namesOf(userIds) {
  const { default: User } = await import('../models/User.js');
  const people = await User.find({ _id: { $in: userIds } }).select('name email').lean();
  return people.map((person) => person.name || person.email).join(', ') || `${userIds.length} people`;
}
