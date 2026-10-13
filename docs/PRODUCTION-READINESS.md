# Production readiness — October 2026

What was tested before going live, what it found, what was changed, and how to run each check
again. Every figure here comes from a run in this repository, not an estimate.

## 50 people at once

`npm run load-test:50` starts a throwaway replica set and real API processes pinned to two CPU
cores (a stand-in for the t3.small/t3.medium in DEPLOY-AWS.md). Fifty people — twenty in
marketing, thirty across the departments — sign in at the same moment and work the enquiry
workflow for two minutes, pausing about two seconds between actions. People collide on purpose:
several departments on one enquiry, two people moving one task in the same instant.

| API processes | Slowest 5% of reads | Slowest 5% of writes | Fifty sign-ins at once | Errors |
| --- | --- | --- | --- | --- |
| 1 | 0.63 s | 0.53 s | up to 5.4 s | none |
| 2 (`ecosystem.config.cjs`) | 0.48 s | 0.37 s | up to 2.6 s | none |

Every run also checks: no server error or dropped connection, every refusal one a person can be
shown, no duplicate enquiry number or customer, no enquiry with two open tasks of one kind, no
lock left behind, every handover delivered.

Flat out — fifty people clicking as fast as the API answers, no pause — one process manages about
23 actions a second and two about 32, with no errors; the wait then grows because two cores are
fully used, which is the point to add a core, not a code change.

What the load test found and what changed:

- **The sign-in limiter counted successful sign-ins.** Fifty people behind the office's one
  internet address locked the fifty-first out for fifteen minutes. Only failed attempts count now.
- **Password checks ran on the request thread.** A burst of sign-ins stalled every other request.
  They now run on a small pool of worker threads (`src/utils/password.js`); the stored hashes are
  unchanged.
- **Department desks built full documents** for a few hundred tasks on every load. They read
  plain objects now.
- **A won order could not take a call with a next step.** It can now, until its LR closes it.

## Security

- `npm audit --omit=dev`: no known vulnerabilities in what runs in production, in either repo.
  The development tools (Vite's dev server, nodemon's file watcher) carry advisories that do not
  reach the built app.
- React Router moved to 7.x, which closes the open-redirect advisories in 6.x.
- Uploads are stored only when their first bytes match the type they claim (PNG, JPEG, WebP,
  HEIC, PDF, Word, Excel): a renamed page of script cannot pass as a picture.
- A production server refuses to start with `CORS_ORIGIN` unset or `*`, as it already did with a
  weak `JWT_SECRET`.
- A live probe as two marketing people and a production user: nobody reads, edits, logs against
  or raises tasks on another person's enquiry or customer; a bulk edit cannot change an
  enquiry's stage, status, owner or number; a forged or missing token is refused; security
  headers are set.

## Readability

`npm run audit:ui` (web repo) signs in and reads 40 screens at desktop width, phone width and in
the dark theme — 120 checks — for errors on the page, a page wider than the phone, text under
12 px, text under WCAG AA contrast, and buttons with no name. It found colour only: white counts
on the bright orange and red badges, accent links on tinted panels, teal labels in the dark
theme. All are fixed; the last run reports no findings.

## Tests

| | Tests | Coverage |
| --- | --- | --- |
| Server | `npm test` — 1,578 | 97% of lines, 93% of functions (`npm run test:coverage`) |
| Web | `npm test` — 374 | the plain modules; screens are checked by `npm run audit:ui` |

## Before each release

```bash
# server
npm test
npm run load-test:50
npm audit --omit=dev
# web
npm test && npm run lint && npm run build
npm run audit:ui        # against a running copy; see the script's header for the settings
```
