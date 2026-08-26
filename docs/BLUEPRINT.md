# Navin Plastic Tech — CRM implementation guide

Distilled from *Navin Plastic Tech — CRM Full Conversation & Implementation Blueprint v3*
(26 August 2026, 22 pages). This is the reference to build against; nothing below is
implemented yet except announcements and user administration.

Section numbers in brackets refer to the source document, and `src/config/modules.js`
carries the same reference on every module.

---

## 1. What this CRM is

Not a Lead → Follow-up → Close system. A **Customer Order Lifecycle CRM** that coordinates
five departments against one record:

```
WhatsApp → Lead/Enquiry → Sampling → Pricing → Quotation → Negotiation
        → PO / Sales Order → Production → Quality → Dispatch → Payment → Closed
```

**The governing principle [§C.1, §34]:** one department completing a stage must
automatically create and assign the next department's task. The process must not depend on
WhatsApp messages or phone calls between departments. One order has **one master record** —
SO-2684 holds its sample, quote, PO, production, part dispatches, invoice and payment.
Departments must not keep separate spreadsheets for the same order.

**The success test [§40].** The CRM works if it answers these without a phone call:
where is this customer's sample; has the quotation been sent; what price is the customer
asking; has the PO been received; is production planning or running; how much is completed;
can we part dispatch; has dispatch happened; what is the LR number; has payment been
received; **who has the next action**.

---

## 2. Module map

| Module | Stage | Owner | Blueprint |
| --- | --- | --- | --- |
| `whatsapp` — WhatsApp inbox | 1 | Communications | §41 |
| `enquiries` — Leads & enquiries | 2 | Marketing | §3 |
| `samples` — Sampling | 3 | Sample team | §4–6 |
| `pricing` — Pricing & costing | 4 | Pricing | §7–9 |
| `quotations` — Quotations & negotiation | 5 | Marketing | §10–11 |
| `orders` — Sales orders | 6 | Order confirmation | §12–13 |
| `production` — Production status | 7 | Production | §14–17 |
| `quality` — Quality | 8 | Quality | §15 |
| `dispatch` — Dispatch | 9 | Despatch | §18–19 |
| `payments` — Payments | 10 | Accounts | §20 |
| `customers` — Customer master | — | Marketing | §2 |
| `products` — Product master | — | Sample team | §28 |
| `customer_comms` — Send to customer | — | Marketing | §42 |
| `announcements` — Announcements | — | Communications | §26 |
| `tasks` — Tasks & follow-ups | — | Marketing | §35 |
| `reports` — Reports & dashboards | — | Management | §21–24, §37–38 |
| `users` — User administration | — | Management | §29 |

---

## 3. Field dictionary

### Customers [§2]
Customer name · company · location · state · country · **customer type** (garment factory /
exporter / buying house / retailer / domestic distributor / overseas buyer) · contact person ·
mobile · **WhatsApp** · email · GST number · assigned marketing person · credit terms ·
payment terms · **rating A/B/C** · last order date · total business value · outstanding amount.

Opening a customer must show the whole timeline in one place: enquiries → samples →
quotations → orders → production → dispatch → payments → complaints.

### Enquiries [§3]
Enquiry number (auto) · date · customer · marketing person · product category · model number ·
size · material · colour · quantity · printing requirement · packing requirement · target price ·
required delivery date · reference image/drawing · remarks.

> **Rule [§3]:** every open enquiry must carry a **next action** and **next follow-up date**.
> An enquiry may not sit open without a defined next action.

### Samples [§4]
Sample request number · customer · linked enquiry · requested by · model · size · colour ·
material · printing · hook type · quantity · required date · **purpose** (existing model /
colour approval / print approval / new development / fit test / buyer approval).

### Pricing [§7]
Pricing request number · customer · enquiry · model · quantity · material · gram weight ·
raw material rate · production cost · printing cost · hook/clip cost · packing cost · other cost ·
target margin · calculated selling price · approved selling price · **minimum selling price** ·
approved by.

### Quotations [§10]
Customer · enquiry · model · quantity · unit price · GST/export terms · delivery · packing ·
payment terms · quote validity · freight terms · ex-factory/FOB · remarks.
**Every revision stays in history** — Rev 0 ₹7.50, Rev 1 ₹7.30, Rev 2 ₹7.20.

### Sales orders [§12]
Customer PO number · PO date · **PO upload** · model · colour · quantity · unit price ·
delivery date · printing · packing · payment terms · special instructions.

### Production [§14]
Sales order · customer · model · order qty · planned qty · produced qty · balance qty ·
ready qty · machine/line (optional) · planned start · planned completion · actual start ·
expected completion · status · remarks.

> The CRM holds **customer-facing production visibility only**. Material planning, machine
> planning and manufacturing stay in the production ERP [§14, §33 Phase 3].

### Dispatch [§18]
Dispatch request number · customer · sales order · model · ready quantity · dispatch quantity ·
destination · transporter · vehicle · invoice number · LR number · e-way bill · dispatch date ·
expected delivery date.

### Payments [§20]
Customer · invoice · invoice value · invoice date · payment terms · due date · amount received ·
balance · status · last follow-up · next follow-up.

### Product master [§28]
Model code · product name · size · material · standard weight · available colours · hook/clip ·
product photo · **mould available** · current standard price · MOQ · packing qty.
Marketing selects from this master rather than typing model names.

---

## 4. Status matrices

**Enquiry [§3]** — New enquiry · Requirement clarification · Sample required · Pricing required ·
Quote submitted · Negotiation · Customer decision pending · PO expected · Won · Lost · Hold

**Sample [§4]** — Request received · Checking stock · Sample available · Production required ·
Printing required · Sample ready · Dispatched · Delivered · Customer feedback pending ·
Approved · Modification required · Rejected

**Negotiation [§11]** — Customer reviewing · Price negotiation · Quantity negotiation ·
Payment term negotiation · Delivery negotiation · Management approval · Final offer submitted ·
Verbal confirmation · PO awaited · Lost
Mandatory alongside: next follow-up date, expected order value, probability %, customer target
price, last offered price.

**Quotation [§10]** — Draft · Approval pending · Approved · Sent · Revised · Accepted · Rejected

**Order [§12]** — PO received · Order verification · Clarification pending · Approved for
production · Production planning · Production running · Part quantity ready · Production
completed · Dispatch planning · Part dispatched · Fully dispatched · Payment pending · Closed

**Production [§15]** — Awaiting planning · Planning · Material pending · Mould pending ·
Printing material pending · Scheduled · Running · Part quantity ready · Production hold ·
Quality hold · Completed

**Dispatch [§18]** — Dispatch request received · Invoice preparation · Packing ·
Vehicle/transport pending · Ready to load · Loaded · Dispatched · Delivered · POD pending · Closed

**Payment [§20]** — Not due · Due soon · Due today · Overdue · Part payment · Paid · Dispute · Hold

**Colour coding [§36]** — green on track · yellow action required / due soon · red delayed /
overdue · grey not started.

---

## 5. Automations

| Trigger | Effect | Ref |
| --- | --- | --- |
| Enquiry → **Sample required** | Create sample request, assign to sample team, set due date, acknowledge to marketing | §6 |
| Sample → **Sample ready** | Notify the requesting marketing person | §6 |
| Sample → **Dispatched** | Courier, AWB, dispatch date and quantity become **mandatory**; enquiry moves to Sample feedback pending | §6 |
| Enquiry → **Pricing required** | Create pricing task | §41.8 |
| Price below approved minimum | Move to **Price approval pending**; block quotation until MD approves | §9 |
| Order verification complete | **Release to production** becomes available | §13 |
| Production → **Ready for dispatch** | Create dispatch request, assign to despatch, notify marketing, **reserve the ready quantity** | §19 |
| Dispatch → **Dispatched** | Marketing immediately sees quantity, invoice, LR, transporter, date | §19 |

**Order verification gate [§13]** — release to production only when: PO received · correct
model · correct colour · printing approved · sample approved · price approved · delivery date
confirmed · packing confirmed.

**Part delivery [§17]** — on a 50,000 pc order with 20,000 ready, production releases 20,000
to dispatch and the remaining 30,000 stays open on the same order.

---

## 6. Escalations [§25]

| Area | Threshold | Escalate to |
| --- | --- | --- |
| Sampling | Required date crossed | Sampling in-charge + marketing |
| Sampling | > 1 day overdue | Manager |
| Pricing | Request > 24 hrs | Costing person |
| Pricing | > 48 hrs | Management dashboard red flag |
| Production | Expected completion crossed | Production head + marketing + MD red flag |
| Dispatch | Material ready > 24 hrs | Dispatch escalation |
| Payment | Due date − 3 days | Marketing reminder |
| Payment | Due date | Accounts + marketing |
| Payment | 7 days overdue | Manager |
| Payment | 30 days overdue | MD |

**Notifications [§31]** — avoid overload. Only: new assigned task · sample ready · pricing
completed · approval required · PO received · production delayed · part quantity ready ·
dispatch done · payment overdue.

---

## 7. Permissions [§29]

Mapped onto `src/config/modules.js` department defaults. Two constraints the module system
cannot express and which must be enforced **inside** the modules when they are built:

1. **Pricing field visibility [§8].** Marketing sees quoted price, MOQ, validity, payment and
   delivery terms. Raw material rate, full cost, gross margin, minimum approved price and
   special approval price are management/costing only. Marketing holds `pricing: read` — the
   field-level split is the module's own job.
2. **Outbound customer messages [§42.4].** Sampling, production and dispatch update internal
   status only. Direct customer communication is restricted to the assigned marketing person
   and specifically authorised roles. `customer_comms: write` is granted narrowly, and the
   module must still check assignment.

Marketing also cannot see other marketing persons' confidential details unless permitted —
another in-module ownership rule, not a module grant.

---

## 8. WhatsApp as the front door [§41]

```
WhatsApp enquiry → CRM lead → marketing assignment → qualification → enquiry
                → sampling / pricing → quotation → negotiation → PO → production
                → dispatch → payment
```

**Duplicate prevention is mandatory [§41.2].** Never create a lead per message. Search the
mobile/WhatsApp number first: an existing contact attaches the conversation to that customer
and routes to the existing owner; only an unknown number becomes a new WhatsApp lead.

**Assignment [§41.3]** — existing customers go to the account owner; genuinely new leads go
round-robin across the marketing team (territory or product rules can come later).

**Work queues [§41.5]** — New · Unassigned · Waiting for customer · Sample requested ·
Pricing required · Converted to enquiry.

Conversation history, photos, artwork and documents stay linked to the lead / contact /
customer / enquiry record, so marketing never searches a personal chat [§41.6–41.7].

**Acceptance criteria [§41.11]** — 10 tests, from number matching before lead creation
through to duplicate suppression on repeat messages.

---

## 9. Send-to-customer control [§42]

> **Core rule:** an internal status update is **not** a customer notification. No sampling,
> pricing, production or dispatch change may reach the customer merely because an internal
> status changed.

Customer contact happens only through an explicit **Send to customer** action by an
authorised marketing user: pick the update → choose WhatsApp or email → preview a generated
customer-friendly draft → **edit** → confirm send.

- Only customer-safe fields feed the draft. Internal notes — machine issues, material
  shortages, margin discussions, quality investigations — are never forwarded [§42.8].
- Every send is audited: what was sent, channel, recipient, date/time, sent by, final text,
  and delivery/read status where available [§42.6].
- A sent update shows **Customer notified**, and a second attempt warns who sent it and when
  [§42.7].
- Eligible stages [§42.5]: sample ready · sample dispatched · quotation and revisions ·
  production planning / scheduled / running · part quantity ready · expected completion ·
  dispatch ready · dispatched · delivery tracking.

**Acceptance criteria [§42.9]** — 10 tests, from "changing a status notifies nobody" through
to the duplicate-send warning.

---

## 10. Dashboards

**Marketing person [§21]** — enquiries new/clarification · sampling pending/feedback ·
pricing pending/quote approval · negotiation/PO expected · production and delays ·
dispatch ready/pending · payment due today/overdue.

**MD [§22]** — an **exception dashboard**, not an activity list. Sales: active enquiries,
new this month, quotes submitted, conversion %, expected order value. Sampling: pending,
overdue > 2 days, awaiting customer approval. Pricing: pending, special approvals, low-margin
quotes. Production: active, delayed, on hold, part ready, value pending. Dispatch: ready,
delayed, ready > 24 hrs undispatched. Payment: total receivable, due this week, overdue,
overdue > 30 days.

**Marketing performance [§23]** — per person: enquiries, samples, quotes, orders, order value,
collection; plus enquiry→sample, sample→quote and quote→order conversion, average closing days
and lost order value.

**Daily morning list [§37]** — samples due · quotes pending · customer follow-ups ·
production delayed · dispatch pending · payments due. This becomes the team's daily work list.

**Weekly MD review [§38]** — new enquiry value, quoted value, confirmed order value, lost order
value, conversion %, orders in production, orders delayed, dispatch pending, receivables,
overdue, marketing-wise performance.

**Global search [§32]** — one search across customer, mobile, PO number, order number, invoice,
model, quotation number and sample number must retrieve the entire related history.

**Documents [§27]** — attachments on every relevant record: customer drawing, product photo,
print artwork, sample approval, quotation, customer PO, invoice, LR, POD, payment advice.

**Mobile [§30]** — marketing must be able to add an enquiry, photograph a customer or visiting
card, raise a sample request, check quotation / production / dispatch, add a follow-up note and
view payment dues from a phone.

---

## 11. Build order [§39]

Build and stabilise each phase — do not build everything at once.

| Phase | Scope | Modules |
| --- | --- | --- |
| 1 | Sales | `customers`, `enquiries`, `products`, follow-ups |
| 2 | Sampling | `samples` and approval tracking |
| 3 | Pricing & quoting | `pricing`, `quotations`, negotiation, approval route |
| 4 | Order coordination | `orders`, `production`, `quality` |
| 5 | Dispatch & payment | `dispatch` incl. part dispatch, `payments` |
| 6 | Automation & dashboards | escalations, notifications, `reports` |
| 7 | WhatsApp & customer comms | `whatsapp` front door, `customer_comms` |

> The source blueprint recommends Zoho CRM plus custom modules. We are building this
> directly instead, so the platform advice in §33 and Part D does not apply — the module map,
> field dictionary, status matrices, automation and permission rules all do.

**Integration boundary [§33 Phase 3].** If the existing production ERP stays, the CRM receives
only status, quantity and date fields. Material, machine and production planning remain there.
