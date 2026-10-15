# Several accounts on one device, and the device PIN

Web: `src/auth/accounts.js`, `src/auth/pinCrypto.js`, `src/auth/idle.js`, `src/context/AuthContext.jsx`,
`src/components/PinGate.jsx`. Server: `services/settings.service.js`, `GET/PUT /settings/security`,
`/auth/me` (`policy`, `sessionExpiresAt`), `POST /auth/switched`.

## Accounts

- A sign-in of any kind (password, email code, SMS code, password link) adds the account to the
  browser's list and makes it the active one. The account menu lists the others under
  **Switch account**; **+ Add another account** opens the login page in add mode, where the
  current session stays.
- `npt.token` always mirrors the active account's plain token, so the API client is unchanged
  and every request carries one Authorization header.
- Switching remounts the signed-in app on the user id, so nothing of the previous person
  survives: no screen, hook or cache. The server records a switch as a sign-in (`switch`), and the
  device's push subscription is re-registered for the account now active.
- **Sign out** removes the active account; the next one takes over, or the login page. **Sign out
  of all accounts** clears the device.
- A 401 for the active account (lapsed, deleted, offboarded, password changed elsewhere) drops
  only that account and switches to the next.
- Guards for a shared plant computer: at most five accounts; one unused for seven days is
  forgotten.
- Browser conveniences (start page, inbox read marker, board filters, dock, sidebar) are keyed
  by account (`scopedKey`), so they belong to the person, not the browser.

## The PIN

- The PIN seals the account's token: a key derived from the PIN (PBKDF2, 150 000 rounds, a salt
  per seal) encrypts it (AES-GCM, a nonce per seal). The PIN never leaves the browser and is
  never sent to the server.
- Locking drops the plain token from storage and keeps the seal: while locked, the browser holds
  nothing a request could use. Unlocking opens the seal back into the token and the app carries
  on where it was.
- The lock fires after the policy's minutes with no pointer, key, touch, scroll or non-GET
  request, shared across tabs through `npt.lastActivity`; a tab reopened after longer locks at
  once. **Lock now** is on the account menu.
- Five wrong PINs sign the account out of the device; the full sign-in is needed again. A
  forgotten PIN is not recoverable, by design: "Sign in again" on the lock screen.
- Changing the password drops the seal (the old token is gone); the person sets the PIN again
  from the profile.

## Policy (Admin, Profile → Security for everyone)

- `pinRequired`: everyone must set a PIN; the app asks right after sign-in and will not go on
  without one. Removing a PIN is refused while this is on; changing it is allowed.
- `lockAfterMinutes`: 1 to 240, default 15.

Tests: `web/tests/accounts.test.js`, `server/tests/security-policy.test.js`; the flow was driven
in Chromium (add, switch, set PIN, lock, wrong and right PIN, idle lock, sign out).
