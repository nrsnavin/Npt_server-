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
Lead/Enquiry → Sampling → Pricing → Quotation → Negotiation
             → PO / Sales Order → Production → Quality → Dispatch → Payment → Closed
```

> **Data is entered manually; automation comes last.** The blueprint opens this chain with
> WhatsApp as the front door [§41], but that integration is wired up **after** every module
> exists. Manual entry is the primary path — which the blueprint already specifies [§3] — and
> it is **permanent, not a stopgap**: walk-ins, phone calls, trade shows and email will never
> arrive over WhatsApp. When the integration lands it adds a source, it does not replace one.
> See §8 for what to build now so it slots in without rework.

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
| `enquiries` — Leads & enquiries | 1 | Marketing | §3 |
| `samples` — Sampling | 2 | Sample team | §4–6 |
| `pricing` — Pricing & costing | 3 | Management | §7–9 |
| `quotations` — Quotations & negotiation | 4 | Marketing | §10–11 |
| `orders` — Sales orders | 5 | Order confirmation | §12–13 |
| `production` — Production status | 6 | Production | §14–17 |
| `quality` — Quality | 7 | Quality | §15 |
| `dispatch` — Dispatch | 8 | Despatch | §18–19 |
| `payments` — Payments | 9 | Accounts | §20 |
| `customers` — Customer master | — | Marketing | §2 |
| `moulds` — Mould & model register | — | Production | §28 |
| `customer_comms` — Send to customer | — | Marketing | §42 |
| `whatsapp` — WhatsApp inbox | **deferred** | Marketing | §41 |
| `announcements` — Announcements | — | Management | §26 |
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

### Mould & model register [§28]
Mould code · name · category · size · hook/clip · resin · part photo · MOQ · packing qty, and
the measured facts the tool is costed from: cavities, cavities running, part weight, runner
weight, regrind recovery, cycle time, efficiency, press and hourly rate.
Marketing selects from this register rather than typing model names.

**A model is a mould.** This was originally specified as a separate product master carrying a
model code, a size, a `mould available` tick and a standard price, with the register beside it.
Two masters describing one steel tool disagree the week they are built, and the tick in
particular restates something the register already knows. So the tool is the record, and the
catalogue's fields sit on it.

Two consequences worth stating, because both are ordinary rather than exceptional:

- **A traded item has no entry.** Five of the twenty-five models on the plant's own 26-27 sheet
  are bought in and resold. There is no steel of ours behind them, so an enquiry, costing or
  quotation for one carries the buyer's model number and no mould. An empty mould means
  "bought in", not "missing".
- **A model reaches the master when the tool exists.** A new development is promoted onto the
  register once there is something to measure — the register will not take a record without a
  part weight and a cycle time. Standard price is gone: what a model is worth is the costing
  register's answer, per customer and per quantity, not a figure on a master.

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

Mapped onto `src/config/modules.js` department defaults.

**Eight departments**, not the blueprint's ten. The blueprint assumes a separate costing
function and a separate communications function; this organisation has neither as its own
team. The modules still exist — costing and announcements sit with **management**, and the
WhatsApp front door and customer messages sit with **marketing**, who own the customer
anyway. If either team is ever formed, adding the department back is one entry plus a
default grant set; the modules do not change.

> One consequence worth knowing: with no costing team, `pricing: write` belongs to
> management alone. Nobody but an admin can price a job by default. That is a deliberate
> control — §9 already routes prices below the minimum to MD approval — but if a marketing
> person should be able to build a costing, grant them `pricing: write` explicitly.

Two constraints the module system cannot express and which must be enforced **inside** the
modules when they are built:

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

## 8. WhatsApp as the front door [§41] — deferred

**Not being built yet.** It is automated last, after every other module exists. This section
stays here as the specification for that work, plus what to do *now* so it slots in cleanly.

### Manual entry is the primary path

Every module is built for a person typing the record in. That is not a temporary measure
while the integration is missing — it is how most data will always arrive, and it must stay
fully supported after WhatsApp lands. Two consequences for design:

- **Never require a conversation.** A conversation reference on an enquiry is optional
  forever. An enquiry with no WhatsApp thread behind it is the normal case, not a defect.
- **Manual entry must be fast.** If typing an enquiry is tedious, the CRM loses to the
  notebook. Model selection comes from the mould register [§28] rather than typed model names,
  and the next-action rule [§3] is the only mandatory extra field.

### What to build now so the integration lands without rework

The blueprint requires a qualified WhatsApp lead to convert into an enquiry **without
re-entering core data** [§41.4]. That only works if the enquiry module is built with the
right shape from the start:

- **`source` on every enquiry and customer** — `manual`, `phone`, `email`, `walk_in`,
  `referral`, `trade_show`, and later `whatsapp`. Add it in Phase 1 with `manual` as the
  default. Retrofitting an origin field across live enquiries is a migration nobody wants,
  and the field earns its place immediately: it is what §23's source-wise conversion
  reporting is built on.
- **An optional conversation reference** on the enquiry, left null until the integration
  exists. §41.6 requires conversation history to stay linked to the lead, contact, customer
  and enquiry.
- **Attachments from day one** [§27] — the integration attaches product photos and artwork
  received over WhatsApp to the same record, so the attachment model must already exist.
- **Contact lookup by mobile number** on the customer master. §41.2 makes de-duplication
  mandatory, and it is a number search against existing contacts. Index `phone` and
  `whatsapp` on the customer record now.
- **Round-robin assignment** [§41.3] is a marketing-team rule, not a WhatsApp rule. Build it
  with the enquiry module; WhatsApp then reuses it.

Nothing above requires the integration itself, and each item is cheap now and expensive later.

### The specification, for when it is built

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
| 1 | Sales | `customers`, `enquiries`, `moulds`, follow-ups |
| 2 | Sampling | `samples` and approval tracking |
| 3 | Pricing & quoting | `pricing`, `quotations`, negotiation, approval route |
| 4 | Order coordination | `orders`, `production`, `quality` |
| 5 | Dispatch & payment | `dispatch` incl. part dispatch, `payments` |
| 6 | Automation & dashboards | escalations, notifications, `tasks`, `reports` |
| 7 | Customer communication | `customer_comms` — email channel first |
| 8 | WhatsApp | `whatsapp` front door, and WhatsApp as a `customer_comms` channel |

**Phase 8 is deliberately last.** WhatsApp is an external integration with its own
credentials, approvals and failure modes; wiring it before the modules it feeds exist would
mean building against moving targets. `customer_comms` can ship in Phase 7 over email alone —
§42's send control, preview, edit, audit trail and duplicate warning are all channel-agnostic
— and gain WhatsApp as a second channel in Phase 8.

> The source blueprint recommends Zoho CRM plus custom modules. We are building this
> directly instead, so the platform advice in §33 and Part D does not apply — the module map,
> field dictionary, status matrices, automation and permission rules all do.

**Integration boundary [§33 Phase 3].** If the existing production ERP stays, the CRM receives
only status, quantity and date fields. Material, machine and production planning remain there.
