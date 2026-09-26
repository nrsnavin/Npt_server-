import { PassThrough } from 'node:stream';

/**
 * Uploaded files in S3, for when the API runs on more than one machine — or on one machine that
 * should not be the only copy of every photo the plant has taken.
 *
 * Switched on by S3_BUCKET. Credentials come the usual AWS way: the instance's IAM role on EC2 or
 * ECS, else AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY. S3_ENDPOINT points it at anything that
 * speaks S3 (MinIO, a test double). Objects are written encrypted and private; the app still
 * serves every download itself, after its own permission check, exactly as before.
 *
 * Keys keep the same shape as on disk, under S3_PREFIX (default `uploads/`), so
 * `npm run migrate:uploads-to-s3` can copy the existing folder across as it is.
 */

let clientPromise = null;

export const s3Configured = () => Boolean(process.env.S3_BUCKET);
const bucket = () => process.env.S3_BUCKET;
const prefix = () => process.env.S3_PREFIX ?? 'uploads/';
export const objectKey = (key) => `${prefix()}${key}`;

async function s3() {
  if (!clientPromise) {
    clientPromise = import('@aws-sdk/client-s3').then((sdk) => ({
      sdk,
      client: new sdk.S3Client({
        region: process.env.S3_REGION || process.env.AWS_REGION || 'ap-south-1',
        ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true } : {}),
        maxAttempts: 3,
      }),
    }));
  }
  return clientPromise;
}

/** For the tests, which point it at a different endpoint per file. */
export const forgetS3Client = () => {
  clientPromise = null;
};

const missing = (error) => error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404;

export async function putObject(key, buffer, mimeType) {
  const { sdk, client } = await s3();
  await client.send(new sdk.PutObjectCommand({
    Bucket: bucket(),
    Key: objectKey(key),
    Body: buffer,
    ContentType: mimeType || 'application/octet-stream',
    ServerSideEncryption: 'AES256',
  }));
}

/** The object's bytes, or null when there is no such object. */
export async function getObjectBuffer(key) {
  const { sdk, client } = await s3();
  try {
    const object = await client.send(new sdk.GetObjectCommand({ Bucket: bucket(), Key: objectKey(key) }));
    return Buffer.from(await object.Body.transformToByteArray());
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

/**
 * A stream of the object, returned at once like a file stream is, and fed when S3 answers.
 * `fallback()` is tried for an object S3 does not have — a file still on the old disk.
 */
export function objectStream(key, fallback) {
  const out = new PassThrough();
  s3()
    .then(({ sdk, client }) => client.send(new sdk.GetObjectCommand({ Bucket: bucket(), Key: objectKey(key) })))
    .then((object) => {
      object.Body.on('error', (error) => out.destroy(error));
      object.Body.pipe(out);
    })
    .catch((error) => {
      const local = missing(error) ? fallback?.() : null;
      if (local) {
        local.on('error', (problem) => out.destroy(problem));
        local.pipe(out);
      } else {
        out.destroy(error);
      }
    });
  return out;
}

export async function deleteObject(key) {
  const { sdk, client } = await s3();
  await client.send(new sdk.DeleteObjectCommand({ Bucket: bucket(), Key: objectKey(key) }));
}

export async function objectExists(key) {
  const { sdk, client } = await s3();
  try {
    await client.send(new sdk.HeadObjectCommand({ Bucket: bucket(), Key: objectKey(key) }));
    return true;
  } catch (error) {
    if (missing(error) || error?.name === 'NotFound') return false;
    throw error;
  }
}
