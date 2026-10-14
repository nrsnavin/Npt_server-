import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * A link that works without a session, for a recipient who has none — WhatsApp fetching a
 * document to deliver it. The signature is the permission: it names what is shared and until
 * when, so it cannot be bent to another file or used after it lapses.
 */
export const signatureOf = (kind, id, expires) =>
  createHmac('sha256', env.jwtSecret).update(`${kind}:${id}:${expires}`).digest('hex');

/** `/<id>/<expires>/<signature>/<file>`, to append to a public route. */
export function signedPath(kind, id, file, days = 30) {
  const expires = Date.now() + days * 86400000;
  return `/${id}/${expires}/${signatureOf(kind, id, expires)}/${encodeURIComponent(file)}`;
}

/**
 * Why a link is refused — for the server log, never for the reply (a bent link learns nothing).
 * `signature` is a link minted under another JWT_SECRET (the secret changed, or another server
 * sent it); `expired` is a link past its date; null means the link stands.
 */
export function linkProblem(kind, id, expires, signature) {
  const expected = Buffer.from(signatureOf(kind, id, expires));
  const given = Buffer.from(String(signature || ''));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'signature';
  if (!(Number(expires) > Date.now())) return 'expired';
  return null;
}

export function signatureValid(kind, id, expires, signature) {
  return linkProblem(kind, id, expires, signature) === null;
}

/**
 * Where a public link starts: the API's public address, with the `/api` prefix every route is
 * mounted under. PUBLIC_API_URL is what the plant sets (docs/go-live-guide.html); a value that
 * stops at the host (`https://api.example.com`) gets the `/api` added, since a link without it
 * answers "Route not found" and WhatsApp cannot fetch the document. Without the setting, the
 * address the request came in on.
 */
export function publicApiBase(req, configured = process.env.PUBLIC_API_URL) {
  const set = String(configured || '').trim().replace(/\/+$/, '');
  if (!set) return `${req.protocol}://${req.get('host')}/api`;
  return /\/api$/i.test(set) ? set : `${set}/api`;
}
