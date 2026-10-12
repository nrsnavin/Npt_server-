import { inflateRawSync } from 'node:zlib';
import Attachment from '../models/Attachment.js';
import { MAX_BYTES, put, remove } from './storage.service.js';

/**
 * A photograph put on a register record — a mould or a bought-in piece — from bytes, or from a
 * link to them [scripts/import-mould-sheet.js].
 */

/** The image a buffer holds, by its first bytes: Dropbox and most shares label everything "binary". */
export function imageTypeOf(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const isZip = (buffer) => buffer?.length > 22 && buffer.readUInt32LE(0) === 0x04034b50;

/** The entries of a zip — enough of the format for a shared folder's download, no library. */
export function zipEntries(buffer) {
  let end = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 65557); at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) return [];
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count && buffer.readUInt32LE(at) === 0x02014b50; index += 1) {
    const method = buffer.readUInt16LE(at + 10);
    const compressed = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    entries.push({
      name,
      read() {
        const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
        const data = buffer.subarray(start, start + compressed);
        return method === 8 ? inflateRawSync(data) : Buffer.from(data);
      },
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const letters = (text) => String(text || '').toUpperCase().replace(/\.[A-Z]+$/, '').replace(/[^A-Z0-9]/g, '');
const family = (text) => letters(text).replace(/[0-9]+/g, '');

/**
 * The picture in a shared folder that is this code's: the same name ("MAU-30.jpg" for MAU-30),
 * else the same family ("MAUWB.jpg" for MAU-25 WB). None, rather than a guess, when neither.
 */
export function pickFromZip(entries, code) {
  const images = entries.filter((entry) => /\.(jpe?g|png|webp)$/i.test(entry.name) && !entry.name.endsWith('/'));
  const base = (entry) => entry.name.split('/').pop();
  return images.find((entry) => letters(base(entry)) === letters(code))
    || images.find((entry) => family(base(entry)) === family(code))
    || null;
}

/**
 * Fetches a photo link. `{ buffer, mimeType, filename }`, or `{ error }` saying why not — a link
 * to a page, a folder with no matching picture, a file too big. Folder links (Dropbox's
 * `/sh/…?dl=1`) arrive as a zip; the picture named for the code is taken from it.
 */
export function photoFetcher({ fetchImpl = globalThis.fetch, timeoutMs = 45000 } = {}) {
  const downloads = new Map();
  const download = (url) => {
    if (!downloads.has(url)) {
      downloads.set(url, (async () => {
        const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) return { error: `the link answered ${response.status}` };
        return { buffer: Buffer.from(await response.arrayBuffer()) };
      })().catch((failure) => ({ error: failure.name === 'TimeoutError' ? 'the link timed out' : failure.message })));
    }
    return downloads.get(url);
  };

  return async (url, code) => {
    const got = await download(url);
    if (got.error) return got;
    let { buffer } = got;
    let filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'photo');
    if (isZip(buffer)) {
      const entry = pickFromZip(zipEntries(buffer), code);
      if (!entry) return { error: 'the link is a folder with no picture named for this code' };
      buffer = entry.read();
      filename = entry.name.split('/').pop();
    }
    const mimeType = imageTypeOf(buffer);
    if (!mimeType) return { error: 'the link is not a picture' };
    if (buffer.length > MAX_BYTES) return { error: `the picture is over ${Math.round(MAX_BYTES / 1048576)} MB` };
    return { buffer, mimeType, filename };
  };
}

/**
 * Puts a photo on a record — `link` is the attachment's field for the record (`mould`,
 * `tradedItem`) — and retires the one it replaces. The bytes go first and are taken back if the
 * row fails, as the upload route does [mould.controller `setMouldPhoto`].
 */
export async function attachPhoto(record, { link, buffer, mimeType, filename, by, title, sourceUrl }) {
  const key = await put({ buffer, mimeType });
  let attachment;
  try {
    attachment = await Attachment.create({
      key, filename, mimeType, size: buffer.length, uploadedBy: by, [link]: record._id, title,
    });
  } catch (error) {
    await remove(key);
    throw error;
  }
  const previous = record.photo;
  record.photo = attachment._id;
  record.photoSourceUrl = sourceUrl || undefined;
  await record.save();
  if (previous) {
    const old = await Attachment.findById(previous);
    if (old) {
      await remove(old.key).catch(() => {});
      await old.deleteOne();
    }
  }
  return attachment;
}
