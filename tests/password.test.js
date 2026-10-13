/**
 * Password hashes on background threads [utils/password.js]: the same bcrypt hashes as before,
 * and the request thread keeps answering while a burst of sign-ins is checked.
 *
 *   node --test tests/password.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { checkPassword, hashPassword } from '../src/utils/password.js';

test('a hash made here is plain bcrypt, and one made by bcrypt is checked here', async () => {
  const made = await hashPassword('Pass@123456');
  assert.match(made, /^\$2[aby]\$10\$/);
  assert.equal(await bcrypt.compare('Pass@123456', made), true);
  const old = bcrypt.hashSync('Older@123', 10);
  assert.equal(await checkPassword('Older@123', old), true, 'every password already stored still signs in');
  assert.equal(await checkPassword('wrong', old), false);
  assert.equal(await checkPassword('anything', undefined), false, 'no stored hash is never a match');
});

test('six sign-ins checked at once leave the request thread free', async () => {
  const hash = await hashPassword('Pass@123456');
  let worst = 0;
  let last = Date.now();
  const tick = setInterval(() => {
    const now = Date.now();
    worst = Math.max(worst, now - last - 10);
    last = now;
  }, 10);
  const answers = await Promise.all(Array.from({ length: 6 }, (_, i) => checkPassword(i % 2 ? 'Pass@123456' : 'nope', hash)));
  clearInterval(tick);
  assert.deepEqual(answers, [false, true, false, true, false, true]);
  assert.ok(worst < 60, `the event loop stalled ${worst} ms — hashing ran on the request thread`);
});
