/*
 * The front door's sign-in page [views/signin.html] — to look at, not to sign in from.
 *
 * The tabs switch, and Code by SMS really sends the code: the same request the app makes
 * (/api/auth/otp/request), with its own limits on how often. Nothing here ever exchanges a code
 * or a password for a session — there is no call that could — so the person is told to sign in
 * from the app, whatever they press.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const APP_ONLY = 'This page cannot sign you in. Open the Navin Plastic Tech CRM app and sign in there.';
  const RESEND_SECONDS = 30;

  const say = (el, text, tone) => {
    el.textContent = text;
    el.className = `status ${tone || ''}`.trim();
    el.hidden = !text;
  };
  /* Ten digits, as the app takes it; the server adds +91 [utils/phone.js]. */
  const mobileOf = (value) => {
    let digits = String(value || '').replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    return /^[6-9]\d{9}$/.test(digits) ? digits : null;
  };

  /* Tabs. */
  const tabs = [['tab-password', 'panel-password'], ['tab-sms', 'panel-sms']];
  for (const [tabId] of tabs) {
    $(tabId).addEventListener('click', () => {
      for (const [id, panel] of tabs) {
        const on = id === tabId;
        $(id).classList.toggle('on', on);
        $(id).setAttribute('aria-selected', String(on));
        $(panel).hidden = !on;
      }
    });
  }

  /* Password: nothing is sent. */
  $('password-form').addEventListener('submit', (event) => {
    event.preventDefault();
    say($('password-status'), APP_ONLY, 'warn');
  });

  /* Code by SMS: the code is sent for real; it is never exchanged here. */
  let sentTo = null;
  let timer = null;
  const countdown = (seconds) => {
    const resend = $('sms-resend');
    clearInterval(timer);
    let left = seconds;
    resend.disabled = true;
    resend.textContent = `Resend code in ${left}s`;
    timer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(timer);
        resend.disabled = false;
        resend.textContent = 'Resend code';
      } else {
        resend.textContent = `Resend code in ${left}s`;
      }
    }, 1000);
  };
  const send = async (mobile) => {
    const button = $('sms-send-button');
    button.disabled = true;
    button.textContent = 'Sending…';
    try {
      const response = await fetch('/api/auth/otp/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: mobile }),
        credentials: 'omit',
      });
      const answer = await response.json().catch(() => ({}));
      if (!response.ok) {
        say($('sms-status'), answer.message || 'The code could not be sent. Try again in a minute.', 'warn');
        return false;
      }
      sentTo = mobile;
      $('sms-send').hidden = true;
      $('sms-verify').hidden = false;
      say($('verify-status'), `If an account exists for ${answer.data?.maskedIdentifier || `+91 ${mobile}`}, a code is on its way by SMS.`, 'ok');
      $('sms-code').value = '';
      $('sms-code').focus();
      countdown(RESEND_SECONDS);
      return true;
    } catch {
      say($('sms-status'), 'The code could not be sent — check the connection and try again.', 'warn');
      return false;
    } finally {
      button.disabled = false;
      button.textContent = 'Send code by SMS';
    }
  };

  $('sms-send').addEventListener('submit', (event) => {
    event.preventDefault();
    const mobile = mobileOf($('sms-mobile').value);
    if (!mobile) {
      say($('sms-status'), 'Enter a 10-digit mobile number.', 'warn');
      return;
    }
    say($('sms-status'), '');
    send(mobile);
  });

  $('sms-verify').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!/^\d{4,8}$/.test($('sms-code').value.trim())) {
      say($('verify-status'), 'Enter the code from the SMS.', 'warn');
      return;
    }
    say($('verify-status'), APP_ONLY, 'warn');
  });

  $('sms-resend').addEventListener('click', async () => {
    if (!sentTo) return;
    $('sms-send').hidden = false;
    $('sms-verify').hidden = true;
    if (!(await send(sentTo))) countdown(0);
  });

  $('sms-change').addEventListener('click', () => {
    clearInterval(timer);
    sentTo = null;
    $('sms-verify').hidden = true;
    $('sms-send').hidden = false;
    say($('sms-status'), '');
    $('sms-mobile').focus();
  });
})();
