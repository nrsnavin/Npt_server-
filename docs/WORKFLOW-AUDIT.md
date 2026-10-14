# Workflow audit — every department, end to end

An audit of the hand-offs between departments as they run in production: what each one
promises the next, where the records could disagree once real volume, real delays and real
people are on them, and what was changed. Read with `docs/PAYMENT-COLLECTION-WORKFLOW.md` and
`docs/PRODUCT-AUDIT.md`.

Method: the volume seed (`npm run seed:volume`, 100 enquiries across every stage) was run on a
clean database, then a read-only probe walked the records for the invariants each workflow is
meant to keep. The probe is kept as **`npm run doctor:workflows`** (`--json` for a ticket), so
the same walk can be made on the live database before and after a release.

## 1. What the departments promise each other

| From | To | The promise | Where it is kept |
|---|---|---|---|
| Marketing | Sampling, Pricing, Sales | One open task per kind on the enquiry; the stage follows the task raised | `handoff.service.js` `moveEnquiry` |
| Sampling | Marketing | A sample gone out finishes its request and tells the owner | `SAMPLE_DISPATCHED` subscriber |
| Pricing | Marketing | A quotation sent closes the pricing tasks; accepted reads *PO awaiting* | `QUOTATION_SENT`, `QUOTATION_ACCEPTED` subscribers |
| Sales | Production, Accounts | An order released marks the enquiry Won, asks Production for a date, raises the advance | `ORDER_RELEASED` subscriber, `paymentGates.service.js` |
| Production, Mould, Assembly, QC | Dispatch | Ready for dispatch tells Dispatch; a quality issue reads *QC* | `departmentTaskForms.js` `readyForDispatch`, `marketingStatuses.js` |
| Dispatch | Reception, Buyer | Goods gone raise the LR copy; the consignment is on the register | `DISPATCH_LEFT` subscriber, `remindConsignment` |
| Accounts | Payment Collection, PRT | Money due is chased; money in ends the chase | `receivable.service.js` ladder, `collections.service.js` |
| Anyone | Marketing | Work follows the owner when an enquiry or buyer changes hands | `delegation.service.js` `moveWorkWith` |

## 2. Findings

### Fixed in this release

| # | Gap found on the seeded data | Why it happens in production | Fix |
|---|---|---|---|
| 1 | 22 consignments had left and no LR Copy task was ever raised | `DISPATCH_LEFT` only acted when the enquiry sat at *invoice_dispatch*; a lorry booked from the trip screen while the enquiry still showed Production raised nothing, so Reception never chased the LR | The subscriber acts at every order stage after the SO |
| 2 | An order released while the enquiry still showed Quotation left it un-Won and never asked Production for a date | The same stage guard, on `ORDER_RELEASED` | The enquiry is marked Won whatever its stage (`markEnquiry`); the EDD ask follows at any sales stage |
| 3 | A *Quality issue* raised by Production did not read as QC on the marketing list | `quality_issue` was missing from the task-to-status map | Mapped to *QC* |
| 4 | Receivables weeks overdue with no collection case — only notices | The ladder told Accounts and Management but never put a case on Payment Collection's desk | The due-date rung opens one `team_payment_followup` case per order (`collect-overdue:<order>`), once |
| 5 | *Task Closed* on an enquiry closed its open collection case while money was still owed | `closeOpenTasks` closed every open task on the enquiry | A collection case with a balance stays open, with a note on it; the enquiry still closes |
| 6 | Paid in full did not end the chase; the collector was left pressing *Paid* | Nothing listened for the balance reaching zero | `afterPayment` settles every collection case on the order — only on **confirmed** money, so a field receipt PRT wrote still waits for Accounts |
| 7 | Changing the owner on the enquiry form moved nothing else | Only the Delegate button moved tasks, samples, quotations, orders and receivables | The form edit uses the same `moveWorkWith`, and records a handover |
| 8 | Delegating a buyer left their customer-level tasks (follow-ups, cards) with the old owner | `delegateCustomer` moved enquiry work only | Customer-level tasks move too |
| 9 | *Dispatched* on the dispatch task with no consignment behind it | The status is a word on a task; the register did not have to agree | The person who said it gets a reminder to record the consignment (`record-consignment:<order>`), and the LR copy is still raised |
| 10 | A marketing-status move made by automation with no task behind it crashed (`task.title` on nothing) | Introduced by the audit's own `markEnquiry`; caught by its tests | The history note falls back to the move's note |

### Recommended, not changed

| # | Finding | Why it is left | What to do instead |
|---|---|---|---|
| R1 | An enquiry whose department finished its task and whose next step nobody raised shows the finished stage with nothing open (**Idle** in the doctor) | The stage is where the enquiry *is*; moving it on by itself would guess the next department | The doctor lists them; Admin walks the list on a Monday. A later release can add a "next step" prompt on the task's *Done* |
| R2 | Credit *Watch* / *Hold* is derived by the morning sweep, so a buyer escalated to PRT at 11:00 is not on hold until the next morning | Deriving it on every move would make every receipt and promise write a customer | Run the sweep after a PRT escalation if that hour matters; it is one call (`runCollectionSweep`) |
| R3 | The PO&SO task's brief carries *payment terms* that are not written to the sales order | The order's terms are set by Sales on the order itself; two places to set them would disagree | Prefill the order form from the brief (web) rather than copying silently |
| R4 | Two dispatch systems — the consignment register and the dispatch task's status words — can disagree (`PRODUCT-AUDIT.md` P1) | Merging them is a redesign | #9 above narrows it: a status with no consignment behind it now asks for one |
| R5 | A buyer page opened from a query room shows business totals the reader could not otherwise see | Read-only by design; the totals are what the room is discussing | Hide the money strip for readers outside the owner's scope if it is ever a concern |
| R6 | The sales status and marketing status are two fields that follow each other by rules; a hand-set marketing status further on is kept, which is right, but a reader cannot tell "set by hand" from "followed" | The history records `by` — empty for automation | Show *by the app* on the history line (web) |

### By design, confirmed

- QC never blocks dispatch; a rejected check warns Dispatch and marketing.
- A refused quotation does not close the enquiry; marketing decides.
- An accepted quotation reads *PO awaiting* (one past *Price approved*, which is the buyer still deciding); automation never pulls a status back.
- The advance receivable is raised on booking and re-sized when the terms change before any money is in.
- A closed enquiry stays closed to late events (a late sample or quotation update does not reopen it).

## 3. The doctor

`npm run doctor:workflows` reads the live database and prints, worst first:

- open enquiries holding no task, or more than one, for the stage shown (Idle / double holder);
- enquiry owners who are not the buyer's salesperson;
- consignments that left with no LR Copy task;
- samples gone out whose request is still open;
- receivables overdue with no collection case (the next sweep opens one);
- buyers with PRT but no credit hold (the morning sweep derives it);
- open tasks on closed enquiries.

Nothing is written. A finding is a thing for Admin to look at, not always a bug — see R1 and R2.

## 4. Tests added

- `tests/workflow-phase1.test.js` — LR copy from the Production stage; Won on an order released off a quotation; accepted quotation reads *PO awaiting* and never pulls back; *Dispatched* with no consignment asks for one; *Task Closed* keeps a collection case open, paid in full settles it.
- `tests/payments.test.js` — the overdue rung opens one collection case per order, once.
- `tests/collections.test.js` — confirmed money ends the PRT case by itself.
- `tests/enquiry-delegate.test.js` — the owner edit on the form moves the work and records a handover.
- `tests/marketing-status.test.js` — a quality issue reads *QC*.

## 5. Signed document links (found while auditing, fixed)

A server whose `PUBLIC_API_URL` stopped at the host (`https://api.example.com`, no `/api`) sent
buyers links that answered *Route not found*, and WhatsApp could not fetch the PDF to attach it.

- New links carry `/api` whatever the setting says (`utils/signedLink.js` `publicApiBase`).
- The public document routes are also served at the root (`/public/…`), so links already sent keep working.
- A refused link is logged with the reason — *signature does not match* (minted under another `JWT_SECRET`) or *past its date* — while the reply to the buyer stays the same.
