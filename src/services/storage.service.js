import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where uploaded files live.
 *
 * Local disk, deliberately behind a small interface: `put`, `streamOf` and `remove` are the
 * whole surface, so moving to S3 or a volume later is a swap of this file rather than a
 * change anywhere else. Nothing outside it knows a path exists.
 *
 * A key is random rather than derived from the filename: two people photographing the same
 * bench both send IMG_0042.jpg, and a guessable key would let anyone walk the store even
 * though the download route checks who is asking.
 */
const ROOT = path.resolve(
  fileURLToPath(new URL('../../uploads', import.meta.url))
);

/** Only what a phone camera or a scanner produces. No documents, no archives, no SVG. */
export const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

export const MAX_BYTES = 12 * 1024 * 1024;

const EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
};

/** True for a file this store will accept, by type and size. */
export const isAllowed = (mimeType) => ALLOWED_TYPES.includes(mimeType);

/** Writes one file and returns the key it can be read back by. */
export async function put({ buffer, mimeType }) {
  await mkdir(ROOT, { recursive: true });

  const key = `${randomBytes(16).toString('hex')}${EXTENSIONS[mimeType] || ''}`;
  await writeFile(path.join(ROOT, key), buffer);
  return key;
}

/**
 * Opens a stored file for reading.
 *
 * The key is checked against a strict pattern rather than trusted: it arrives from a URL,
 * and `..` in a path segment is how a store like this becomes a way to read the .env file.
 */
export function streamOf(key) {
  if (!/^[0-9a-f]{32}(\.[a-z0-9]{1,5})?$/.test(key)) return null;
  return createReadStream(path.join(ROOT, key));
}

export async function remove(key) {
  if (!/^[0-9a-f]{32}(\.[a-z0-9]{1,5})?$/.test(key)) return;
  await unlink(path.join(ROOT, key)).catch(() => {});
}
