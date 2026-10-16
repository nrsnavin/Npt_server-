# Quotation department — product audit (October 2026)

Scope: from the enquiry reaching *pricing required* (or the Create Quotation button) through
costing, Admin's sign-off under the floor, sending, revisions, the buyer's answer and the order
raised from it. Read with `docs/BLUEPRINT.md` §7–§10 and `docs/WORKFLOW-AUDIT.md`. Files:
`models/Quotation.js`, `controllers/quotation.controller.js`, `services/costingRequest.service.js`,
`services/pricing.service.js`, `services/pricingVisibility.js`, `services/quotationPdf.js`,
`subscribers/pricing.subscriber.js`, `subscribers/quotation.subscriber.js`,
`subscribers/handoff.subscriber.js`, `controllers/order.controller.js` (the order door); web
`pages/QuotationDetail.jsx`, `pages/Quotations.jsx`, `pages/SentQuotations.jsx`.

## What works and is well guarded

- One open quotation per enquiry; a re-applied status or a second press reuses it.
- The cost base never reaches marketing: the cost, margin, markup, floor and the tier table are
  stripped per line, the registers' rates and the trading master's inward price with them; a
  refusal to send names the models and never a figure.
- Rates copied from the registers when picked, so a later rate change cannot reach back into a
  price already given. Prices rounded **up** to five paise on one step for the whole sheet.
- §9 is enforced per line: under the floor waits on Admin; a floor under the cost is refused; a
  refused price stays refused until it moves; a lower price after sign-off needs signing again.
- A sent quotation is frozen: the offer and the document terms change only through a revision,
  and every revision the buyer saw is kept with its `sentAt`. Rev 0 follows the draft until it
  first goes out, so the history never begins at Rev 1.
- Sending marks sent only when a channel actually delivered (or none was asked for); sending
  again what the buyer already has is refused.
- Accepting moves the enquiry to PO expected and asks for the PO; refusing leaves the enquiry
  open, which is marketing's call. The order is built from the quotation, keyed by line, and the
  same quotation cannot book two orders.
- Validity dates in the past are refused at every door that sets one.

## Logical errors and gaps, by severity

### P1 — wrong outcome in production

| # | Finding | Where | Effect | Fix |
|---|---|---|---|---|
| 1 | **The buyer's answer can be recorded against a revision they never saw.** `respondToQuotation` only checks `sentAt` on the document. After *Revise* the status is `revised` and the latest revision has no `sentAt`, but the API accepts "accepted" and the order door then prices the order from the **current** lines. The web hides the button unless the status is `sent`, so this is reachable through the API and through a stale tab. | `quotation.controller.js` `respondToQuotation`; `order.controller.js` (order from quotation) | An order at a price the buyer never agreed to, with the record saying they did. | Refuse an answer while the latest revision is unsent: "Rev N has not gone to the buyer — send it, or revise back". Record `acceptedRevision` on acceptance and build the order from that revision's lines. |
| 2 | **Admin's signature survives a cost change.** `settleLine` clears a price under the floor whenever `unitPrice >= approvedPrice`. A re-cost after sign-off that raises the cost (another resin, a hook added) raises the floor, but the line stays `approved` — even when the signed price is now **below cost**. | `models/Quotation.js` `settleLine`; `costLine` | The one control §9 exists for is bypassed by the ordinary act of correcting a costing. | Record the floor the price was signed against (`approvedFloor`); when the line's floor moves above it, the signature lapses and the line goes back to `approval_pending`. Tell Admin why ("cost moved since sign-off"). |
| 3 | **The document says "GST 18% EXTRA" on every quotation, export ones included.** The PDF prints the fixed company note; `gstPercent` and `isExport` on the quotation are never read by it. | `quotationPdf.js` (company `gstNote`); `config/company.js` | An export buyer is told GST applies; a quotation entered at 12% or 5% prints 18%. | Print from the record: nothing (or "No GST — export") when `isExport`, else `GST <gstPercent>% extra`, falling back to the company note only when the record carries no percent. |
| 4 | **Closing or losing an enquiry leaves its quotation open.** Nothing on `ENQUIRY_LOST` or the enquiry close touches the quotation: one at `costing` stays on the Quotation department's queue, one at `approval_pending` stays in Admin's inbox ("needs your signature") with the approval task open, one `sent` keeps its follow-up chase. The sampling module had the same gap and was fixed this week (`cancelOpenSamples`). | `handoff.service.js` `closeOpenTasks`; `subscribers/quotation.subscriber.js`; `inbox.controller.js` `approvalItems` | Admin is asked to sign prices on enquiries that are over; the Quotation department costs work nobody will buy. | On lost or closed: an unsent quotation becomes `rejected` with the note "NPT-… closed/lost" (or a new `withdrawn` status), its approval, ready and follow-up tasks resolved; a sent one is left as it is but its follow-up task resolved. |

### P2 — the record disagrees with itself

| # | Finding | Where | Effect | Fix |
|---|---|---|---|---|
| 5 | **The document never says until when the price holds.** `validUntil` drives expiry, the follow-up chase and the "validity passed" notice, but the PDF does not print it. | `quotationPdf.js` | The buyer is held to a date they were never shown. | Print "Valid until <date>" in the terms block; the notice on screen then matches the paper. |
| 6 | **An expired quotation can still be sent, and still be accepted.** `assertValidityAhead` runs when the date is set, not when the document goes out; `respondToQuotation` does not look at `validUntil` either. The screen warns "Revise it before the buyer can act on it" and the server lets it through. | `sendQuotation`, `respondToQuotation` | A quote drafted a fortnight ago goes out already expired; an acceptance is recorded on a dead price. | Refuse to send when `validUntil` is behind today; on an answer after expiry require a revision first (or an explicit "accepted after validity" note). |
| 7 | **A prospect's enquiry reaching *pricing required* raises an error loop, not a costing.** `ensureCostingFor` → `newQuotation` → `requireEnquiry`, which refuses a prospect ("convert it to a customer first"). From the button that is a clear refusal; from the status change it is an exception in the subscriber, retried by the outbox up to eight times and then dropped. Nobody is told. | `costingRequest.service.js`; `subscribers/pricing.subscriber.js`; `enquiryLink.service.js` | Marketing moves a prospect to pricing and the Quotation department never hears of it. | In the subscriber, catch the prospect case and raise a task to the enquiry's owner: "Convert the prospect to a customer, then ask for the price" — or let a prospect be costed and block only the send. |
| 8 | **Re-quoting after a refusal starts the costing from scratch.** A refused quotation cannot be revised ("raise a new one"); the new one is built from the enquiry's rows with the registers' defaults, not from the last costing. Previous Quotes shows the old price beside the sheet, but the resin, parts, markup and the job's own minimum have to be re-entered. | `costingRequest.service.js`, `newQuotation`, `lineFrom` | Re-keying, and a second chance for the two sheets to disagree. | Seed the new quotation's lines from the last closed quotation on the enquiry (cost, refs, markup, minimumOverride) and note "costed from NP/…". |
| 9 | **A revision can be raised on a quotation that never went out.** `reviseQuotation` checks only that the quotation is not closed. The web offers *Revise* only after sending; through the API an unsent draft becomes "Rev 1", and the first thing the buyer ever sees is called a revision. | `reviseQuotation` | A history that lies about what the buyer saw first. | Refuse a revision until `sentAt` is set: before that, *Edit* changes the draft in place. |
| 10 | **A line's remarks change after sending without a revision.** `OFFER_FIELDS` is model, quantity, MOQ, colour and price; line remarks are not in it, yet they are kept in the revision snapshot. | `updateQuotation`, `OFFER_FIELDS` | A remark the buyer read ("price includes printing") can be edited away after the fact. | Add `remarks` to `OFFER_FIELDS` (and the document-level `remarks` is already a document field). |

### P3 — screens, timing and races

| # | Finding | Where | Fix |
|---|---|---|---|
| 11 | **Admin's refusal reason is visible to marketing.** The line's `rejectionNote` and the status-history note ("Refused NH-400 — cost is 7.20, cannot go under 7.90") pass through `visibleTo` untouched; only numeric cost fields are stripped. | `pricingVisibility.js` `visibleTo`; `decideLine` | Keep the note for whoever may see costing; show marketing only "Admin refused this price". |
| 12 | **Two sends at once deliver twice.** `sendQuotation` is not transactional and does not check the version; two clicks (or two tabs) both pass the `sent` check and both email the buyer. | `sendQuotation` | Take the operation lock on the quotation (as costing does) or require `expectedUpdatedAt`. |
| 13 | **"Today" for the validity check is the server's midnight, not India's.** `assertValidityAhead` uses `setHours(0,0,0,0)`; on a UTC server a date valid "today" in India is refused until 5:30 am. The sampling screens were moved to `startOfIndiaDay` this week. | `assertValidityAhead` | Use the India-day helper. |
| 14 | **Admin can sign or refuse a line on an answered quotation.** `decideLine` does not check `CLOSED_QUOTATION_STATUSES` (only `costLine` and `updateQuotation` do). | `decideLine` | Refuse on a closed quotation, as the other doors do. |
| 15 | **The follow-up task has no due date when the quotation has no validity.** `dueDate: quotation.validUntil` is undefined then, so the chase sits on the list with no day. | `quotation.subscriber.js` | Default the chase to seven days after sending when there is no validity. |

### Confirmed by design (no change)

- A line with no cost behind it has no floor, so a price typed on it is cleared without Admin:
  the repeat job quoted from a known rate. Worth keeping, with one addition the §9 reviewer may
  want: a "no cost on this line" mark on the document list, so a sheet that skipped costing is
  visible as such.
- Marketing may set the offered price before sending (above the floor without anyone, below it
  with Admin); the Quotation department's job is the cost, not the final price.
- A refused quotation does not move the enquiry; whether it is lost is marketing's call.
- Automation only ever advances the enquiry; re-sending a revision never pulls it back from
  negotiation to quote submitted.

## Suggested order of work

1. P1 #1 (answer against the sent revision), #2 (signature lapses with the cost), #3 (GST line
   from the record), #4 (close/lost withdraws the quotation). One day.
2. P2 #5 and #6 (validity on paper and at the doors), #7 (prospect reaching pricing). Half a day.
3. P2 #8–#10 and P3 #11–#15. Half a day.

Each fix lands with a test in `tests/quotation.test.js` or `tests/quotation-send.test.js`, and
`npm run doctor:workflows` gains "open quotation on a closed enquiry" beside the sample check.
