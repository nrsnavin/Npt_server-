# Payment Collection and Payment Recovery — workflow design

Designed and built October 2026, on what the app already had, so nothing is kept twice. The
decisions the plant took are at the end; the code is `services/collections.service.js`, the two
workflows in `config/departmentTaskForms.js` (`paymentFollowUp`, `prt_recovery`), the receipt
confirmation in `controllers/payment.controller.js`, the credit status on `models/Customer.js`.

## What exists today

- **A receivable per invoice and per advance** (`models/Receivable.js`): due date from the credit
  terms, receipts, a log of follow-up calls with the plant's statuses (no answer, asked to call
  back, promised to pay, TPCF, says sent, part paid, disputes, other), the payment contact,
  promise date, next follow-up date, a judgement (disputed / on hold) that stops the chasing.
- **A four-rung escalation ladder** that rings once per rung: three days *before* the due date to
  the marketing person, the due date to Accounts and Payment Collection, a week late to Admin.
- **Payment gates**: the advance before production, the agreed percentage before dispatch. A
  short order refuses the step, raises "Collect ₹X before dispatch" on Payment Collection, and
  Admin can waive it with a reason.
- **Three department tasks**: *Team Payment Follow-up* (a tracker form: contact, status, commitment
  period, call-back date, promised date, vigorous), *My Payment Follow-up* (the same, on the raiser's
  own list), and *Request PRT Visit* (a named member visits the buyer: Visit Assigned → Visited →
  Collected → Promised → Closed). *A/C Clarify* goes to Accounts, *GST / Invoice Audit* to Audit.
- **Payments screens**: the chase list, overdue, broken promises, the receivable with its calls.

What is missing: the collection task has **no workflow of its own** (it is a form, so the board
shows no step), **recovery is not a department** (a PRT visit is a task inside Payment Collection),
there is **no rule for when a case moves** from the phone to the field, and nobody can see **how old
the money is** at a glance or **stop new goods going** to a buyer who is not paying.

## The design

### Two departments, one case

A **case** is a receivable (one invoice or one advance). It is worked by one department at a
time, and the hand-over is a step on its task, so the board, the desk and the enquiry all show
who has it and why.

```
Invoice raised ──► Payment Collection (phone / WhatsApp)
                        │ paid ───────────────────────────► closed
                        │ disputed ──► A/C Clarify (Accounts) ──► back, or judged
                        │ escalate (rule or judgement)
                        ▼
                   Payment Recovery Team (field)
                        │ collected ─────────────────────► closed
                        │ promised ──► kept / broken ──► visit again
                        │ cannot recover ──► Admin: legal notice / write-off / credit hold
```

### 1. Payment Collection — the desk

The *Team Payment Follow-up* task gets a workflow (every move with a remark, told to Admin and
the marketing person under Needs your action, as every other department's moves are):

| Step | Means | Sets |
|---|---|---|
| Assigned | On the collector's list | — |
| Contacted | Spoke / messaged the payment contact | the follow-up log entry (who, how, what was said) |
| Promised | A date and an amount | the receivable's promise and next follow-up date; a reminder on that date |
| Part paid | Some money came | the receipt; stays open for the balance |
| Promise broken | *Automatic* on the morning after the promised date with no receipt | priority high; the card turns red |
| Not reachable | Three attempts with no answer | — |
| Disputed | Buyer argues the invoice | raises A/C Clarify on Accounts; chasing pauses until judged |
| Escalated to PRT | Hand-over to the field | raises the PRT case; this task closes with the reason |
| Paid | Money in full | the receipt; the receivable closes; the task closes |

The collector's day is the receivable's **next follow-up date**: the desk opens on today's calls,
then overdue, then promises due this week. The escalation ladder keeps ringing underneath.

### 2. Payment Recovery Team (PRT) — the field

A department of its own (`payment_recovery`): its own logins, desk, queue and notices, on the
same shared-desk mechanism Quality · Assembling · Printing use, so a plant where the same two
people do both can run both from one login.

Its task, *PRT Recovery* (replacing Request PRT Visit, which stays readable):

| Step | Means | Sets |
|---|---|---|
| Assigned | A named PRT member, from the escalation or by Admin | the visit date |
| Visit planned | Date fixed with the buyer | due date = visit date |
| Visited | Met whom, what was said | the follow-up log entry, mode = visit |
| Collected | Cash / cheque / UPI taken on the spot | the receipt, recorded by the PRT member |
| Part collected | Some; the rest promised | receipt + a new promise |
| Promised | A date, no money | the promise; *broken* flips automatically as above |
| Cannot recover | PRT's recommendation | Admin's decision below |
| Closed | — | — |

PRT's desk groups the day's visits by place with the same distance grouping dispatch planning
uses — the buyer pins are already on the customers — so one trip covers nearby buyers.

### 3. Admin's decisions on a case PRT cannot recover

Three buttons, Admin only, each recorded on the receivable with a reason and a date:

- **Legal notice** — the case is marked, the marketing person told, the buyer's credit status
  becomes *Hold*.
- **Write off** — the balance is judged uncollectable; the receivable closes as written off,
  which the collection report shows separately.
- **Credit hold / release** — see 4.

### 4. Credit status on every buyer

Derived nightly from the receivables, shown on the customer, the enquiry and the sales order,
and used by the payment gate:

| Status | Rule (defaults, editable) | Effect |
|---|---|---|
| Good | Nothing overdue beyond 15 days | — |
| Watch | Anything 16–45 days overdue, or one broken promise | A yellow chip on the buyer and the chase screen |
| Hold | 46+ days overdue, two broken promises, a PRT case, or Admin's hold | A red chip on the buyer and the chase screen — a warning only; nothing is refused for it. The order's own payment terms are what hold goods back |

Admin can set or lift a hold by hand, with the reason; Admin's word stands over the rule until
it is cleared.

### 5. The collections board

One screen for Admin, Accounts, Payment Collection and PRT (`/payments`):

- **Ageing**: 0–30 · 31–60 · 61–90 · 90+ days, by amount and count; click a bucket for the list.
- **Promises**: due today, due this week, broken.
- **With PRT**: open recovery cases by member.
- **By collector**: open cases, amount, promises kept this month.
- **Disputed / on hold**: judged cases, with who is handling them.

### 6. What the rest of the plant sees

- The marketing person and Admin hear every move under Needs your action (already the rule).
- The enquiry and the SO show the case's step beside the money position.
- The quotation and new-enquiry screens show the buyer's credit status.

## Decisions (taken 12 Oct 2026)

1. **Payment Recovery is a department of its own** (`payment_recovery`, "Payment Recovery (PRT)"),
   with its own logins, queue, desk and notices. The old *Request PRT Visit* button is hidden;
   what was raised on it still reads.
2. **The rule suggests, the collector or Admin confirms.** Thirty days overdue, two broken
   promises or three unanswered attempts put "Escalate to PRT?" on the task, once, with the
   reason, and tell Admin and the marketing person. The case moves only when somebody chooses
   *Escalated to PRT*.
3. **Collection and PRT record receipts; Accounts confirms them.** A receipt stops the chase the
   moment it is recorded; the payment gates (advance before production, money before dispatch)
   open only on what Accounts has confirmed as seen in the bank. Accounts' and Admin's own
   receipts are confirmed as they are written.
4. **A credit Hold warns only.** It is shown on the buyer, the chase screen and the day screen;
   it never refuses an enquiry, a sales order or a dispatch.

## What the sweep does each morning

Beside the escalation ladder [`receivable.service.js`], `runCollectionSweep` turns a promise
whose day has gone into *Promise Broken* (priority high, the collector, marketing and Admin
told), proposes PRT on the cases that meet the rule, and derives every owing buyer's credit
status — each once, so the sweep may run as often as the timer likes.

## What is deliberately not in this design

- No interest or penalty calculation on late payment.
- No automatic WhatsApp dunning to the buyer: the collector sends messages by hand from the
  receivable, as marketing does from the enquiry — a machine chasing money sours the account.
- No change to how an invoice is raised; the receivable still comes from the dispatch.
