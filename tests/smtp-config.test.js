/**
 * SMTP configuration checking.
 *
 * A host with a user but no password used to boot happily and then answer every sign-in with
 * `Missing credentials for PLAIN` — nodemailer attempting PLAIN auth with nothing to send.
 * The variable it names is not the one that is missing, so the check has to name it instead.
 *
 *   node --test tests/smtp-config.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { configurationProblem } from '../src/services/notification.service.js';

/** The check takes the block to inspect, so a case is a value rather than a fresh process. */
const checkWith = ({ SMTP_HOST: host, SMTP_PORT: port, SMTP_USER: user, SMTP_PASSWORD: password }) =>
  configurationProblem({ host, port, user, password });

test('nothing configured is a valid choice, not a problem', () => {
  // Development prints codes to the console; that is the documented fallback.
  assert.equal(checkWith({}), null);
});

test('a host with a user but no password is named precisely', async () => {
  const problem = checkWith({
    SMTP_HOST: 'smtp.gmail.com',
    SMTP_USER: 'someone@gmail.com',
  });

  assert.match(problem, /SMTP_PASSWORD/);
  // And it says what to do instead, since clearing the host is a legitimate answer.
  assert.match(problem, /clear SMTP_HOST/);
});

test('a password with no user is equally broken, and says so', async () => {
  const problem = checkWith({
    SMTP_HOST: 'smtp.gmail.com',
    SMTP_PASSWORD: 'app-password',
  });

  assert.match(problem, /SMTP_USER/);
});

test('credentials with no host are caught too', async () => {
  const problem = checkWith({
    SMTP_USER: 'someone@gmail.com',
    SMTP_PASSWORD: 'app-password',
  });

  assert.match(problem, /SMTP_HOST/);
});

test('a complete block passes', async () => {
  const problem = checkWith({
    SMTP_HOST: 'smtp.gmail.com',
    SMTP_PORT: '587',
    SMTP_USER: 'someone@gmail.com',
    SMTP_PASSWORD: 'app-password',
  });

  assert.equal(problem, null);
});

test('a host alone passes — a relay that needs no login is normal', async () => {
  assert.equal(checkWith({ SMTP_HOST: 'localhost', SMTP_PORT: '25' }), null);
});
