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
| 1 | **The buyer's answer can be recorded against a revision they never saw.** `respondToQuotation` only checks `sentAt` on the document. After *Revise* the status is `revised` and the latest revision has no `sentAt`, but the API accepts "accepted" and the order door then prices the order from the **current** lines. The web hides the button unless the status is `sent`, so this is reachable through the API and through a stale tab. | `quotation.controller.js` `respondToQuotation`; `order.controller.js` (order from quotation) | An order at a price the buyer never agreed to, with the record saying they did. | **Fixed.** An answer is refused while the latest revision is unsent ("Rev N has not gone to the buyer. Send it first"). `acceptedRevision` is recorded; the lines are frozen from acceptance, so the order is priced from what the buyer held. |
| 2 | **Admin's signature survives a cost change.** `settleLine` clears a price under the floor whenever `unitPrice >= approvedPrice`. A re-cost after sign-off that raises the cost (another resin, a hook added) raises the floor, but the line stays `approved` — even when the signed price is now **below cost**. | `models/Quotation.js` `settleLine`; `costLine` | The one control §9 exists for is bypassed by the ordinary act of correcting a costing. | **Fixed.** `approvedFloor` records the floor Admin saw; a re-cost that raises the floor above it lapses the signature and the line goes back to Admin. |
| 3 | **The document says "GST 18% EXTRA" on every quotation, export ones included.** The PDF prints the fixed company note; `gstPercent` and `isExport` on the quotation are never read by it. | `quotationPdf.js` (company `gstNote`); `config/company.js` | An export buyer is told GST applies; a quotation entered at 12% or 5% prints 18%. | **Fixed.** `taxNoteFor`: "EXPORT — GST NOT APPLICABLE" on an export quotation, "GST <n>% EXTRA" from the record, the company note only when the record names no rate. |
| 4 | **Closing or losing an enquiry leaves its quotation open.** Nothing on `ENQUIRY_LOST` or the enquiry close touches the quotation: one at `costing` stays on the Quotation department's queue, one at `approval_pending` stays in Admin's inbox ("needs your signature") with the approval task open, one `sent` keeps its follow-up chase. The sampling module had the same gap and was fixed this week (`cancelOpenSamples`). | `handoff.service.js` `closeOpenTasks`; `subscribers/quotation.subscriber.js`; `inbox.controller.js` `approvalItems` | Admin is asked to sign prices on enquiries that are over; the Quotation department costs work nobody will buy. | **Fixed (owner's choice: a new status).** `withdrawQuotationsFor` runs on lost and on both closes: an unsent quotation becomes **withdrawn** with "NPT-… closed/lost" on its history and its approval, ready, follow-up and refusal tasks resolved; a sent one keeps its status and loses only its chase. The inbox and the doctor ("Open quotation on a closed enquiry") read the closed list. |

### P2 — the record disagrees with itself

| # | Finding | Where | Effect | Fix |
|---|---|---|---|---|
| 5 | **The document never says until when the price holds.** `validUntil` drives expiry, the follow-up chase and the "validity passed" notice, but the PDF does not print it. | `quotationPdf.js` | The buyer is held to a date they were never shown. | **Fixed.** "Valid until dd/mm/yyyy" prints in the delivery-terms box. |
| 6 | **An expired quotation can still be sent, and still be accepted.** `assertValidityAhead` runs when the date is set, not when the document goes out; `respondToQuotation` does not look at `validUntil` either. The screen warns "Revise it before the buyer can act on it" and the server lets it through. | `sendQuotation`, `respondToQuotation` | A quote drafted a fortnight ago goes out already expired; an acceptance is recorded on a dead price. | **Fixed (owner's choice: the answer is allowed, and marked).** Sending is refused once the validity has passed ("give it a new validity date"). An answer after the validity goes through, with `answeredAfterValidity` on the record, "after the validity passed on …" on the history, and a notice on the screen. |
| 7 | **A prospect's enquiry reaching *pricing required* raises an error loop, not a costing.** `ensureCostingFor` → `newQuotation` → `requireEnquiry`, which refuses a prospect ("convert it to a customer first"). From the button that is a clear refusal; from the status change it is an exception in the subscriber, retried by the outbox up to eight times and then dropped. Nobody is told. | `costingRequest.service.js`; `subscribers/pricing.subscriber.js`; `enquiryLink.service.js` | Marketing moves a prospect to pricing and the Quotation department never hears of it. | **Fixed (owner's choice: task the owner).** The status button already refuses a prospect; the automation (an approved sample moving the enquiry to pricing) now raises "Convert <prospect> to a customer, then ask for the price" to the enquiry's owner instead of throwing, and raises no quotation. |
| 8 | **Re-quoting after a refusal starts the costing from scratch.** A refused quotation cannot be revised ("raise a new one"); the new one is built from the enquiry's rows with the registers' defaults, not from the last costing. Previous Quotes shows the old price beside the sheet, but the resin, parts, markup and the job's own minimum have to be re-entered. | `costingRequest.service.js`, `newQuotation`, `lineFrom` | Re-keying, and a second chance for the two sheets to disagree. | **Fixed (owner's choice: cost and parts, not the price).** `seedCosting` carries the registers, build-up, markup, category, packing and the job's own floor from the last closed quotation by model; the price is left for the Quotation department; the history says "Costing carried from NP/…". Where the enquiry names no model, the models last quoted are the basis. |
| 9 | **A revision can be raised on a quotation that never went out.** `reviseQuotation` checks only that the quotation is not closed. The web offers *Revise* only after sending; through the API an unsent draft becomes "Rev 1", and the first thing the buyer ever sees is called a revision. | `reviseQuotation` | A history that lies about what the buyer saw first. | **Fixed.** A revision needs `sentAt`; before that the draft is edited in place. |
| 10 | **A line's remarks change after sending without a revision.** `OFFER_FIELDS` is model, quantity, MOQ, colour and price; line remarks are not in it, yet they are kept in the revision snapshot. | `updateQuotation`, `OFFER_FIELDS` | A remark the buyer read ("price includes printing") can be edited away after the fact. | **Fixed.** `remarks` is an offer field. |

### P3 — screens, timing and races

| # | Finding | Where | Fix |
|---|---|---|---|
| 11 | **Admin's refusal reason is visible to marketing.** The line's `rejectionNote` and the status-history note ("Refused NH-400 — cost is 7.20, cannot go under 7.90") pass through `visibleTo` untouched; only numeric cost fields are stripped. | `pricingVisibility.js` `visibleTo`; `decideLine` | **Fixed.** The history line says "Refused NH-400" only; the reason stays on the line for whoever may see costing, and marketing reads "Admin refused this price". |
| 12 | **Two sends at once deliver twice.** `sendQuotation` is not transactional and does not check the version; two clicks (or two tabs) both pass the `sent` check and both email the buyer. | `sendQuotation` | **Fixed.** One operation lock per quotation, held through the delivery; the second send finds it already sent. |
| 13 | **"Today" for the validity check is the server's midnight, not India's.** `assertValidityAhead` uses `setHours(0,0,0,0)`; on a UTC server a date valid "today" in India is refused until 5:30 am. The sampling screens were moved to `startOfIndiaDay` this week. | `assertValidityAhead` | **Fixed.** `utils/indiaDay.js` is shared by the sample model, the validity check and `validityPassed`. |
| 14 | **Admin can sign or refuse a line on an answered quotation.** `decideLine` does not check `CLOSED_QUOTATION_STATUSES` (only `costLine` and `updateQuotation` do). | `decideLine` | **Fixed.** "A withdrawn/accepted/rejected quotation has nothing left to sign." |
| 15 | **The follow-up task has no due date when the quotation has no validity.** `dueDate: quotation.validUntil` is undefined then, so the chase sits on the list with no day. | `quotation.subscriber.js` | **Fixed.** Seven days after sending when there is no validity. |

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

## Status

All fifteen are fixed (October 2026), each with a test under "Audit fixes" in
`tests/quotation.test.js`; `npm run doctor:workflows` reports "Open quotation on a closed enquiry"
beside the sample check. The web reads the new `withdrawn` status (register filter, badge, the
detail page's closed state and notice) and says when an answer came after the validity.
