# Product audit — Navin Plastic Tech CRM/ERP

October 2026. The audit followed an enquiry from the buyer to the delivery for each of the 13 roles. It looked at what each person sees first, where the same work is held in two places, and where a screen is empty because nothing feeds it.

The 13 role landing pages were crawled with no errors.

## Fixed in this round

| # | Finding | Fix |
|---|---|---|
| F1 | Quality had two ways to record a check: the SO's **Inspections**, and **QC records**. They did not know about each other, so a QC sheet on an SO line left the SO showing "not inspected". | A QC record for an SO line now writes that line's inspection: stages in-process, final and pre-dispatch, with a verdict and a sample. The SO's Quality card opens the QC form first. "Quick check on a consignment" stays for checking one named consignment. The QC record shows whether it wrote an inspection, and if not, why. |
| F2 | The Production task (Ask EDD) had no way into mould runs. The run, and the SO production it feeds, had to be started from a different menu, re-typing the enquiry and SO. | A **Start a run** button on the Production task opens the run dialog with the enquiry, its SO and the buyer filled in. |
| F3 | The new plant screens show nothing until master data is filled in: reject report, maintenance reminders, resin store, distance grouping and the QC standards prefill. Nothing told Admin this. | Admin's overview has a **Finish setting up** card. It lists what is still empty: machines, mould maintenance intervals, test standards, resin reorder levels, buyer pins and delivery details, dispatch lists, and WhatsApp. Each item has a count and an Open link. The card goes away when everything is done and can be hidden for the day. |
| F4 | Global search did not find QC records, trips, mould runs or machines, and mould results went to the list instead of the mould. | Search now covers all four, and mould results open the mould. |
| F5 | A Production user starting a run from a task saw an empty Enquiry box, the same problem as #15 on the QC form. | The task passes the enquiry number and buyer name to the dialog. |
| #5 | Dispatch could group buyers only by route, landmark or pincode. | Buyers can be asked for their location on WhatsApp, and a shared location is pinned on the customer. Pinned buyers on our own vehicle are grouped by real distance (within 3 km). The planner can ask every unpinned buyer at once. |
| #14 | The web lint reported 4 errors in `useQueryInbox.js`. | Fixed. Lint now reports 0 errors. |
| #15 | A Quality user who had never worked an enquiry saw a blank Enquiry box on the QC form. | The box shows the enquiry number and buyer even when the user cannot open the enquiry. |
| #16 | When an enquiry had several SOs, a QC record, run or dispatch request not tied to an SO went to the newest SO. | With more than one open SO, every form asks which one. The server refuses a request without an SO, and automatic follow-on tasks keep the SO of the task they came from. |

## Decisions needed

These are product choices, not bugs. Each one has a recommendation.

### P1: Two dispatch systems

*Consignments* (Sales → Dispatch) and *dispatch requests → trips → LR* (department tasks and planning) both record "goods left for the buyer". People have to know which one to update. They are kept apart by your choice.

**Recommendation:** make the trip the single record of a dispatch. A consignment becomes the line-level part of a trip stop: quantity per SO line, plus the invoice. Do this as one migration once the current flow has settled.

### P1: Soft gate on a failed pre-dispatch inspection

A consignment whose pre-dispatch inspection failed can still be marked dispatched with an override reason. This matches your rule that QC warns and never blocks.

**Recommendation:** keep it, but have Admin confirm the override. Today anyone with dispatch rights can override. The reason is kept on the consignment and appears in the monthly overrides list either way.

### P2: Production status in two places

The Production task's 15 statuses and the SO line's production status both describe progress. Mould runs now update the SO line's produced quantity.

**Recommendation:** have the task's ready statuses (Part / Full Quantity Ready) read from the SO line instead of being set by hand.

### P2: Too many places to look

To-do, News, Notes, Waiting, the Queries panel and the bell each hold some of what a person must act on.

**Recommendation:** use one inbox, the bell, with filters by kind. Keep To-do as the work list. Fold News and Notes into the bell.

### P3: `/today` overlaps `/departments/mine`

Every role lands on its department desk, so the Today page repeats most of it.

**Recommendation:** remove Today from the menu, or make it the phone view of the desk.

## Still waiting on your input

- What the Quotation, Audit and Payment Collection workflows really look like in the plant. Today's statuses are placeholders.
- The five open dispatch questions from the dispatch planning round.

## Checks

- Server: 1491 of 1491 tests pass.
- Web: 321 of 321 tests pass, lint reports 0 errors, and the build succeeds.
- Browser checks passed: the setup checklist on Admin's overview, and Start a run from a task (enquiry filled in). The earlier rounds' QC prefill and AQL plan, QC flag on the trip plan, ask-location, store receipt and reject report also passed.
