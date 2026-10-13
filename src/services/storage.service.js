import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ApiError from '../utils/ApiError.js';
import { deleteObject, getObjectBuffer, objectStream, putObject, s3Configured } from './storage.s3.js';

/**
 * Where uploaded files live.
 *
 * Local disk, or S3 when S3_BUCKET is set (storage.s3.js), behind the same small interface:
 * `put`, `streamOf`, `bufferOf` and `remove` are the whole surface, and nothing outside this
 * file knows which it is. On S3, a file not found there is looked for on the local disk — so a
 * deployment can switch to S3 first and copy the old folder across afterwards
 * (`npm run migrate:uploads-to-s3`) without a moment where old photos are missing.
 *
 * A key is random rather than derived from the filename: two people photographing the same
 * bench both send IMG_0042.jpg, and a guessable key would let anyone walk the store even
 * though the download route checks who is asking.
 */
/* UPLOAD_DIR moves it (a mounted volume, a test's own folder); the default is uploads/ beside src/. */
const ROOT = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve(fileURLToPath(new URL('../../uploads', import.meta.url)));
/** The local folder — for the copy-to-S3 script. */
export const UPLOAD_ROOT = ROOT;

/** Only what a phone camera or a scanner produces. No documents, no archives, no SVG. */
export const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

/**
 * What may be attached to a customer or an enquiry [§27].
 *
 * Wider than the sample log's photos, because these are documents rather than shots of a
 * shot: a buyer's drawing, print artwork, a signed approval. They arrive as PDFs at least as
 * often as images, and refusing one means it goes back to living in somebody's email.
 */
export const ALLOWED_DOCUMENT_TYPES = [
  ...ALLOWED_TYPES,
  'application/pdf',
  /* Word and Excel: a buyer's PO or a price list arrives as one of these as often as a PDF. */
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

export const isAllowedDocument = (mimeType) => ALLOWED_DOCUMENT_TYPES.includes(mimeType);

export const MAX_BYTES = 12 * 1024 * 1024;

/**
 * A stored filename, fit for a Content-Disposition header. The name came from whoever uploaded
 * the file; a quote, a newline or a control character in it would break the header — Node
 * refuses to send one, and the download answers 500 — so the header keeps printable ASCII only.
 */
export const safeFilename = (name, fallback = 'document') =>
  String(name || '').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '').trim() || fallback;

export const EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
};

/** True for a file this store will accept, by type and size. */
export const isAllowed = (mimeType) => ALLOWED_TYPES.includes(mimeType);

/*
 * What a file of each kind starts with. The type an upload claims is the browser's word — a
 * renamed page of script can claim to be a PNG — so the first bytes are checked against it
 * before anything is stored. A kind with no signature here is taken at its word.
 */
const SIGNATURES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'image/heic': (b) => b.subarray(4, 8).toString('latin1') === 'ftyp',
  'image/heif': (b) => b.subarray(4, 8).toString('latin1') === 'ftyp',
  /* A PDF may carry a few bytes of junk before its header; readers accept it within the first kilobyte. */
  'application/pdf': (b) => b.subarray(0, 1024).includes('%PDF-'),
  'application/msword': (b) => b.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])),
  'application/vnd.ms-excel': (b) => b.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])),
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': (b) => b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': (b) => b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
};

/** True when the bytes look like the kind of file they claim to be (or the kind has no signature). */
export const contentMatches = (buffer, mimeType) => !SIGNATURES[mimeType] || Boolean(buffer?.length && SIGNATURES[mimeType](buffer));

const KIND_WORDS = { 'application/pdf': 'a PDF', 'image/jpeg': 'a JPEG photo', 'image/png': 'a PNG picture', 'image/webp': 'a WebP picture' };

/**
 * Writes one file and returns the key it can be read back by. `verify: false` only for bytes
 * that came from a provider, not a person's upload.
 */
export async function put({ buffer, mimeType, verify = true }) {
  if (verify && !contentMatches(buffer, mimeType)) {
    throw ApiError.badRequest(`That file is not really ${KIND_WORDS[mimeType] || `a ${mimeType} file`} — it may have been renamed. Save it again in its own format and attach that.`);
  }
  const key = `${randomBytes(16).toString('hex')}${EXTENSIONS[mimeType] || ''}`;
  if (s3Configured()) {
    await putObject(key, buffer, mimeType);
    return key;
  }
  await mkdir(ROOT, { recursive: true });
  await writeFile(path.join(ROOT, key), buffer);
  return key;
}

/**
 * What a key is allowed to look like.
 *
 * Checked rather than trusted on every way in, because a key arrives from a URL and `..` in a
 * path segment is how a store like this becomes a way to read the .env file. Named once so the
 * three doors cannot drift — the one that forgets is the one that gets walked through.
 */
export const SAFE_KEY = /^[0-9a-f]{32}(\.[a-z0-9]{1,5})?$/;

/** Opens a stored file for reading. */
export function streamOf(key) {
  if (!SAFE_KEY.test(key)) return null;
  const local = () => createReadStream(path.join(ROOT, key));
  if (s3Configured()) return objectStream(key, () => (existsSync(path.join(ROOT, key)) ? local() : null));
  return local();
}

/**
 * The whole file, in memory.
 *
 * For the one caller that cannot take a stream: a PDF embeds an image by buffer, and the
 * document has to be laid out before it is sent. Null rather than a throw when the file is
 * missing — a quotation whose photograph has been deleted should still print, with a gap where
 * the picture was, rather than failing to produce a document at all.
 */
export async function bufferOf(key) {
  if (!SAFE_KEY.test(key)) return null;
  if (s3Configured()) {
    const fromS3 = await getObjectBuffer(key).catch((error) => {
      console.error(`[storage] reading ${key} from S3 failed: ${error.message}`);
      return null;
    });
    if (fromS3) return fromS3;
  }
  return readFile(path.join(ROOT, key)).catch(() => null);
}

export async function remove(key) {
  if (!SAFE_KEY.test(key)) return;
  if (s3Configured()) {
    await deleteObject(key).catch((error) => console.error(`[storage] deleting ${key} from S3 failed: ${error.message}`));
  }
  await unlink(path.join(ROOT, key)).catch(() => {});
}
