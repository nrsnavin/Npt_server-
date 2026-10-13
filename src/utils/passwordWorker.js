import { parentPort } from 'node:worker_threads';
import bcrypt from 'bcryptjs';

/* One hash or one comparison at a time, off the request thread [utils/password.js]. */
parentPort.on('message', async ({ id, op, plain, hash, rounds }) => {
  try {
    const result = op === 'hash' ? await bcrypt.hash(plain, rounds) : await bcrypt.compare(plain, hash);
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: error.message });
  }
});
