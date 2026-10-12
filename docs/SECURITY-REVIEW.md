# Security review — October 2026

A review of both repositories for the ways an app like this gets broken into: sessions and
secrets, who may read what, what the API accepts, uploads and downloads, the doors with no
session behind them (the WhatsApp webhook, the signed public links), the dependencies, and what
the browser is told. Then a live probe of the running app as each role.

## What was already right

Most of the ground was covered by the earlier QA passes, and it held:

- Every module route sits behind `authenticate` and a module grant; the role-landing crawl and the
  285-route permission probe found no route that answers somebody it should not.
- Ownership is enforced on reads, not just lists: a marketing person opening a colleague's
  customer, enquiry or quotation by id gets a 404. The one customer another marketing person could
  open was shared with them on purpose (a query put them in the room — `sharedWith`).
- Self-registration only creates the very first account; after that only an administrator makes
  accounts, and a person can change their own name and phone but never their department or role.
- Passwords are bcrypt-hashed and never selected; password links and sign-in codes are stored
  hashed with expiry and attempt limits; a password change ends every earlier session.
- The query string refuses objects, so `?customer[$ne]=` cannot reach a Mongo filter; every body
  is checked by a zod schema; search text is regex-escaped.
- Stored files have random keys and the download route checks the owning record, not the key;
  path traversal is refused by shape; uploads are limited by type and size.
- The Meta webhook is HMAC-verified over the raw bytes; the Twilio one needs a shared token.
- Rate limits on sign-in and codes, helmet headers, a request id on every answer, and production
  never returns a stack trace or a server-internal message.

## Fixed in this review

| # | Finding | Severity | Fix |
|---|---|---|---|
| 1 | `JWT_SECRET` fell back to the development default in every environment. A production server started without the variable signed every session — and every public document link — with a string that is in this repository. | **High** | The API and the worker refuse to start in production when the secret is the default or shorter than 32 characters, naming the fix (`openssl rand -base64 48`). `config/env.js secretProblem`. |
| 2 | `proxy-addr` (critical: IP spoofing through the `trust proxy` setting, which the rate limits key on), `qs` (body-parser and express), `nodemailer` (recipient-domain bypass, DoS). | **High** | Dependencies updated; `npm audit` reports 0 vulnerabilities on the server. |
| 3 | `axios` in the web app (header injection, prototype-pollution gadget, redirect SSRF). | Medium | Updated to 1.20; the remaining web advisories are React Router 6's (see below). |
| 4 | The WhatsApp webhook accepts its shared token in the query string, and the access log printed the whole URL — the secret in every log line and log shipper. | Medium | The log redacts `token`, `hub.verify_token` and `signature` values. `utils/redact.js`. |
| 5 | A shared location from the Twilio or plain-JSON webhook was written to the thread, and from there onto the buyer's pin, as whatever arrived — a string, an object, coordinates off the globe. | Medium | A location is two finite coordinates on the globe or nothing; media entries are plain string records, at most ten; text fields are capped. `whatsapp.inbox.js cleanLocation / cleanMedia`. |
| 6 | `npm run seed` wipes the users collection and plants ten demo logins whose passwords are in the repository, with nothing stopping it on a production database. | Medium | With `NODE_ENV=production` the seed refuses unless run with `--i-mean-production`. |
| 7 | An uploaded filename with a quote, a newline or a non-ASCII character broke the `Content-Disposition` header on two public document routes (Node refuses to send it; the download answered 500). | Low | `storage.service.js safeFilename` keeps printable ASCII and a fallback name. |
| 8 | The web app was served with no browser-side policy: no CSP, no frame denial. The theme script was inline in `index.html`, which a strict policy would block. | Low | The theme script is a file (`public/theme.js`); the deploy guide's nginx config now sets `Content-Security-Policy` (no inline script, own origin and the API only), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy` and `Permissions-Policy`, with HSTS ready to switch on once TLS is live. The built app signed in under that policy with zero violations. |

## Left as is, with a reason

- **React Router 6 advisories** (open redirect through a backslash in `<Link>` / `useNavigate`,
  SSR deserialisation). The only navigation that takes a value not written in the code is the
  after-login redirect, and it reads `location.state`, which an outside link cannot set; the app
  does no server rendering. The fix is React Router 7, a breaking upgrade of every route file, not
  worth doing for a path that is not reachable. Do it with the next planned front-end work.
- **Session in `localStorage`.** A stolen session needs script running in the page; React escapes
  everything rendered, the app has no `dangerouslySetInnerHTML`, and the new CSP forbids inline
  and foreign script. Moving to an httpOnly cookie would also need CSRF protection and a change to
  every API client; not justified by the exposure.
- **No per-account lockout** on password sign-in, only the 50-per-15-minutes limit per address.
  Fine for a plant office; add a per-account delay if the app is ever opened to the internet
  without a VPN.
- **Twilio's own request signature** is not checked, only the shared token. Equivalent strength
  as long as the token is long and random; the Meta path, which is the one configured, verifies
  the signature.

## Checks run

- Server: 1497 of 1497 tests, including the new `tests/hardening.test.js` and a webhook test for a
  bad location. Web: 321 of 321, lint 0 errors, build.
- Production guards tried by hand: the API refuses to start on the default secret; the seed
  refuses on `NODE_ENV=production`; the access log shows `token=[redacted]`.
- Live, against the running app: the 285-route permission and bad-input probe (0 findings), the
  owner-isolation probe for two marketing accounts (only shared customers cross), and the built
  web app signed in under the strict CSP with zero violations. A crawl of every role's landing
  page and the main Admin screens on the updated dependencies: 34 pages, no page error, no console
  error, no 5xx.
