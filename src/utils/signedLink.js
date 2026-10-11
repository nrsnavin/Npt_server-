import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * A link that works without a session, for a recipient who has none — WhatsApp fetching a
 * document to deliver it. The signature is the permission: it names what is shared and until
 * when, so it cannot be bent to another file or used after it lapses.
 */
const signatureOf = (kind, id, expires) =>
  createHmac('sha256', env.jwtSecret).update(`${kind}:${id}:${expires}`).digest('hex');

/** `/<id>/<expires>/<signature>/<file>`, to append to a public route. */
export function signedPath(kind, id, file, days = 30) {
  const expires = Date.now() + days * 86400000;
  return `/${id}/${expires}/${signatureOf(kind, id, expires)}/${encodeURIComponent(file)}`;
}

export function signatureValid(kind, id, expires, signature) {
  const expected = Buffer.from(signatureOf(kind, id, expires));
  const given = Buffer.from(String(signature || ''));
  return given.length === expected.length && timingSafeEqual(given, expected) && Number(expires) > Date.now();
}
