/**
 * The footer on every customer email [services/emailSignature.js].
 *
 *   node --test tests/email-signature.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { company } from '../src/config/company.js';
import { customerEmail, signatureText, withoutSignOff } from '../src/services/emailSignature.js';

test('a customer email ends with the plant’s footer, as text and as HTML', () => {
  const mail = customerEmail('Dear Ravi,\n\nPlease find the LR copy attached.');
  assert.ok(mail.text.startsWith('Dear Ravi,'));
  assert.ok(mail.text.endsWith(signatureText()));
  for (const part of ['Thanks &amp; Regards', 'Senthil kumar. A', 'Managing Director', 'NAVIN', 'HANGERS', '+91-99444 23690', '+91-421-4334690', 'info@navinplastic.com', 'www.navinplastic.com', 'NAVIN PLASTIC TECH', 'Vanjipalayam Post, Tirupur-641663']) {
    assert.ok(mail.html.includes(part), `the footer shows ${part}`);
  }
});

test('the body’s own closing lines are dropped, so the mail is not signed twice', () => {
  const body = `Dear Ravi,\n\nYour goods have been dispatched.\n\nThank you,\n${company.name}\n${company.phone}\n`;
  assert.equal(withoutSignOff(body), 'Dear Ravi,\n\nYour goods have been dispatched.');
  assert.equal(withoutSignOff('Hello,\n\nSample ready.\n\nNavin Plastic Tech'), 'Hello,\n\nSample ready.');
  assert.equal(withoutSignOff('Hello,\n\nCall me on Friday.'), 'Hello,\n\nCall me on Friday.', 'an ordinary last line stays');
});

test('what the person typed is escaped in the HTML', () => {
  const mail = customerEmail('Rate <b>7.20</b> & GST extra');
  assert.ok(mail.html.includes('Rate &lt;b&gt;7.20&lt;/b&gt; &amp; GST extra'));
});
