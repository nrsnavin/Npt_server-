# Sampling department — product audit (October 2026)

Scope: the sample request from the marketing tile to the buyer's verdict. Read with
`docs/BLUEPRINT.md` §4–§6 and `docs/WORKFLOW-AUDIT.md`. Files: `models/Sample.js`,
`services/sampling.service.js`, `controllers/sample.controller.js`,
`controllers/sampleDashboard.controller.js`, `subscribers/sampling.subscriber.js`,
`subscribers/handoff.subscriber.js`, `services/escalation.service.js`; web
`components/SamplingWorkQueue.jsx`, `pages/SampleDetail.jsx`, `utils/samplingQueue.js`.

## What works and is well guarded

- One open request per enquiry; a cancelled or answered one does not block the next.
- Dispatch is the only door to the customer: courier + AWB, or a named handover; the strict
  colour rule is enforced on dispatch and on details entered in advance; a step back needs a
  reason; a sample with the customer cannot return to the bench.
- The bench cannot mark its own work approved; feedback needs write on enquiries.
- Approved → pricing; dispatched → feedback pending; rejected and modification → marketing's
  task; a lost enquiry cancels its samples; the enquiry never retreats by automation.
- The bench queue, the day screen and the escalation sweep share one definition of "closed",
  "with the customer" and "not escalated".

## Logical errors and gaps, by severity

### P1 — wrong outcome in production

| # | Finding | Where | Effect | Fix |
|---|---|---|---|---|
| 1 | **A prospect's sample is judged by the bench.** An enquiry raised on a prospect (no customer record yet) produces a sample with `customer` empty. `recordFeedback` reads "no customer" as "internal trial", so the sampling team may mark it **approved** from `sample_ready`, with no dispatch, no courier, no buyer verdict. §13 then checks an order against that "approval". | `sample.controller.js` `recordFeedback` | The one rule the register's credibility rests on is bypassed for every prospect. | Treat a sample as a customer sample when it has a customer **or an enquiry**. Only a true standalone trial (neither) is the bench's to judge. |
| 2 | **The prospect never hears about the sample.** `notifyCustomer` resolves the address from the Customer record; a prospect's phone and email live on the enquiry (`prospect.*`). "Sample ready" and "sample dispatched" are recorded as skipped, no address. | `customerMessage.service.js` `resolve`/`addressFor` | The buyer most in need of a nudge, a new one, gets nothing. | Fall back to the enquiry's prospect contact when there is no customer. |
| 3 | **Closing an enquiry leaves its samples on the bench.** Only `ENQUIRY_LOST` cancels open samples. *Task Closed* on the enquiry (stage `closed`) and the automatic close leave the request open: it stays on the queue, escalates at 5 pm, and the manager is told about work nobody wants. | `handoff.service.js` `closeOpenTasks` / `closeEnquiryAutomatically`; `sampling.subscriber.js` | Ghost work and false escalations. The workflow doctor already flags it ("Sample gone out but its request is still open"). | On enquiry close, cancel samples still on the bench (`ON_THE_BENCH_STATUSES` + `not_available`) with the note "enquiry closed"; leave ones with the customer as they are. |
| 4 | **Re-sampling a standalone request crashes.** `resample` reads `enquiry.number` in the conflict message when `enquiry` is null. | `sample.controller.js` line ~928 | A 500 instead of the conflict sentence, only on a standalone with a second open attempt. | Guard the message; or dedupe by `previousSample` for standalones. |

### P2 — the record disagrees with itself

| # | Finding | Where | Effect | Fix |
|---|---|---|---|---|
| 5 | **"Not available" blocks the next request.** `not_available` is open for dedupe, so marketing pressing *Sample Request* again (another model, after the bench said no) gets the old request back, still not available; the new instruction is lost. The bench is re-tasked on a request it already answered. | `sampling.service.js` `openSampleFor`, `ANSWERED_SAMPLE_STATUSES` | Marketing must find and edit the old request by hand; the new ask never reaches the bench as written. | Count `not_available` as answered for dedupe; when a new request is raised, cancel the not-available one with "superseded by SMP-…" and link them (`supersededBy`). |
| 6 | **The Sample Request brief is mostly dropped.** The marketing tile collects rows (model, material, colour, hook, clip, print, colour rule, pieces). Only the **first row's** material, colour, colour rule and pieces reach the sample; model, hook, clip, print and every later row are ignored. The sample takes its rows from the enquiry instead. | `handoff.service.js` `sampleFromBrief` | A brief that says "two models, 5 pcs each, print X" produces a sample with the enquiry's models, one quantity, no print. The task shows one thing, the request another. | Build the sample's `items` from the brief rows when the brief has any (resolving the register columns), and fall back to the enquiry's rows only when it has none. |
| 7 | **After "modification required" the enquiry still says "feedback pending".** The enquiry's sales status is `sample_feedback_pending` while the next attempt is on the bench, and the marketing status reads *Sample sent*. | `sampling.subscriber.js`, `resample` | The enquiry list says the buyer is deciding when the plant is making. | On re-sample, set the marketing status back to *Sample requested* (an explicit, recorded exception to forward-only), or add a "re-sampling" note the list shows. |
| 8 | **Linking a standalone request to an enquiry can give it two open samples.** `linkEnquiry` does not check `openSampleFor(enquiry)`. | `sample.controller.js` `linkEnquiry` | Dedupe silently picks one of two; the other is invisible to automation. | Refuse when the enquiry already has an open request, naming it. |
| 9 | **The spec can be rewritten after the bag has gone.** `updateSample` only refuses closed statuses, so model, colour and the colour rule are editable while the sample is with the buyer. `dispatchedColour` is then compared against a colour that was changed afterwards. | `sample.controller.js` `updateSample` | The approved-sample check (§13) and the colour history can be made to lie. | Lock the specification fields once the status is with the customer; allow remarks and reference photo only. |

### P3 — screens disagree or mislead

| # | Finding | Where | Fix |
|---|---|---|---|
| 10 | **"Late" means two things.** The bench queue marks late only when the due date is before today; the day screen, the dashboard and the escalation sweep mark late the moment the time (5 pm) passes. The same request is "today" on one screen and escalated on another. | `sampleQueue` vs `sampleDay`/`escalation` | Use one rule: past the due time. Or move the default to end of day and make all three agree. |
| 11 | **"Not available" is late on the queue but not on the day screen.** The queue counts `not_available` among unsent rows for lateness; the day screen and the sweep exclude it (marketing's turn). | `sampleQueue` `unsent` | Exclude `not_available` from lateness on the queue too; it is highlighted already. |
| 12 | **Tile names don't match their counts.** `dueToday` counts due today **plus late**; `urgentDispatch` counts ready **or** late **or** due today. | `sampleQueue` tiles | Rename to "Due or late" and "Needs a dispatch", or split the counts. |
| 13 | **Anyone can be the bench.** `assignSample` accepts any active user; a sample can be assigned to a marketing person, who then sees it under "mine" on a screen they do not use. | `assignSample`, `assertAssignable` | Require write on `samples` for the assignee. |
| 14 | **A sample can be born overdue.** The default due date is capped by the enquiry's delivery date even when that date is already past. | `defaultRequiredDate` | Ignore a delivery date in the past; use 5 pm today or tomorrow. |
| 15 | **Overdue tier 1 tasks everyone on the bench.** Each late sample raises a task per bench member plus the requester. With six samples late and four people, 30 tasks a morning. | `escalation.service.js` `recipientsFor` | Tier 1 to the assignee if any, else one task to the bench's shared queue (department task), plus the requester. |

### Confirmed by design (no change)

- The default due date is 5 pm the same day. Deliberate: the escalation exists to catch a
  slipping sample, and the bench re-dates what truly needs a mould change.
- "Sample ready" and "sample dispatched" message the buyer automatically.
- A won enquiry keeps its open samples; only a lost one cancels them.

## Suggested order of work

1. P1 #1 and #2 (prospects), P1 #3 (close cancels bench samples), P1 #4 (crash). Half a day.
2. P2 #5 and #6 (not-available dedupe; the brief's rows). One day, with tests on the tile →
   sample path.
3. P2 #7–#9 and P3 #10–#15. Half a day.

Each fix lands with a test in `tests/sampling.test.js` or `tests/sampling-queue.test.js`, and
`npm run doctor:workflows` gains a check for "enquiry closed, sample still on the bench".
