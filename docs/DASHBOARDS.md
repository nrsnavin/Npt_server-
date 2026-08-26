# Dashboards & analytics

What each department sees, and which module supplies it. Derived from the blueprint
(§21–24, §25, §36–38) and from how a hanger plant actually runs.

Nothing here is built. `Depends on` names the module that must exist first, so the
dashboard fills in as the build progresses rather than arriving all at once.

---

## 1. Grammar

Every dashboard is assembled from six component types. Using a fixed set keeps them
comparable and keeps the build cheap.

| Component | Use it for | Example |
| --- | --- | --- |
| **Stat tile** | One number that answers one question, with period-on-period change | Enquiries this month · 34 ▲ 21% |
| **Target gauge** | Achieved against a committed target | Order value: ₹7.0L of ₹10L |
| **Funnel** | Stage-to-stage conversion, absolute and % | Enquiry → Sample → Quote → Order |
| **Trend** | A measure over time, monthly or weekly | Order value, last 6 months |
| **Breakdown** | Composition of a whole | Enquiries by source · rejections by reason |
| **Ranked table** | Top or bottom N, with a drill-through | Top 10 debtors · slowest samples |

**Colour is state, not decoration [§36].** Green on track · amber action required or due
soon · red delayed or overdue · grey not started. Never use the brand accent to mean
"good" — it means "the one action on this screen".

**Rules that apply everywhere**

- **Every tile drills through** to the filtered list behind it. A number nobody can open is
  a number nobody trusts.
- **Scope by ownership.** A marketing person sees their own enquiries; a manager sees the
  team. The same component, a different filter — never a separate screen.
- **Exceptions beat totals.** The MD dashboard [§22] is explicitly an exception dashboard.
  "8 orders delayed" is actionable; "142 orders" is wallpaper.
- **Ageing beats counts** for anything with an SLA. "12 samples pending" hides the one that
  has been sitting 9 days.
- **Every dashboard opens with "action required today"** [§37] before any analysis.

---

## 2. My day — everyone

The home screen, before any department view. **Built now**, with reminders.

| Component | Metric | Depends on |
| --- | --- | --- |
| Stat tiles | Overdue · due today · due tomorrow · open tasks | ✅ built |
| List | Action required today, ticked off in place | ✅ built |
| List | Latest announcements with unread marker | ✅ built |
| List | My next actions falling due [§3] | `enquiries` |
| List | Records assigned to me awaiting my step | `tasks` |

---

## 3. Marketing

The busiest dashboard: marketing carries the customer from enquiry to payment [§21].

### Today
| Metric | Why | Depends on |
| --- | --- | --- |
| Enquiries with no next action | The blueprint forbids this state [§3] | `enquiries` |
| Follow-ups due today / overdue | The daily call list | `enquiries` |
| Samples awaiting customer feedback, by age | The commonest silent stall | `samples` |
| Quotes sent with no response > 7 days | Where deals die quietly | `quotations` |
| My orders delayed against promised date | What the customer will ring about | `production` |
| My payments overdue | Collection is a marketing job here [§20] | `payments` |

### Performance
| Metric | Form | Depends on |
| --- | --- | --- |
| Enquiries this month, value and count | Stat tile + trend | `enquiries` |
| Conversion funnel: enquiry → sample → quote → order | Funnel, count and % | `orders` |
| Win rate %, average closing days | Stat tiles | `orders` |
| Lost value and **lost reasons** | Breakdown | `enquiries` |
| Enquiries by source (manual, phone, walk-in, referral, trade show) | Breakdown | `enquiries` |
| Order value against target | Target gauge | `orders` |
| Top customers by value; customers with no enquiry in 90 days | Ranked tables | `customers` |

> **Field limit [§8].** Marketing dashboards may show quoted price and order value. They must
> never surface cost, margin or minimum price, even aggregated — an average margin chart
> leaks the same information a cost field would.

---

## 4. Sampling

Samples are where the relationship is won, and where the blueprint sets the tightest SLA
[§25: overdue → in-charge; > 1 day → manager].

| Metric | Form | Depends on |
| --- | --- | --- |
| New requests · due today · **overdue** | Stat tiles, red on overdue | `samples` |
| Queue by status: checking stock, production required, printing required, ready | Breakdown | `samples` |
| **Average turnaround**, split request→ready and ready→dispatched | Stat tiles | `samples` |
| Oldest open requests | Ranked table, worst first | `samples` |
| Awaiting customer feedback, by age | Ranked table | `samples` |
| Approval outcome: approved / modification / rejected | Breakdown | `samples` |
| **Rework rate** — % needing modification | Stat tile with trend | `samples` |
| Requests by marketing person | Breakdown | `samples` |
| Samples by purpose (colour, print, new development, fit, buyer) | Breakdown | `samples` |

> Rework rate is the quality signal for this team. A high approval rate with a high
> modification rate means samples are going out before they are right.

---

## 5. Pricing & costing

> No costing team exists here, so this dashboard belongs to **management**. It stays a
> separate view rather than being folded into the MD dashboard, because it answers a
> different question: the MD view asks what is stuck, this one asks whether we are pricing
> well.

| Metric | Form | Depends on |
| --- | --- | --- |
| Pending requests, **aged > 24h and > 48h** [§25] | Stat tiles, amber then red | `pricing` |
| Average turnaround, request → price issued | Stat tile | `pricing` |
| **Special approvals pending** — quotes below minimum awaiting MD [§9] | Stat tile + list | `pricing` |
| Margin distribution across quotes issued | Breakdown | `pricing` |
| **Low-margin quotes** below threshold | Ranked table | `pricing` |
| Average margin by product category and by customer | Breakdown | `pricing` |
| Raw material rate movement | Trend | `pricing` |
| Revisions per quote | Stat tile | `quotations` |
| Quotes won vs lost, by margin band | Funnel | `orders` |

> The last one is the question this team actually wants answered: *are we losing on price,
> or losing anyway?* Win rate split by margin band answers it.

---

## 6. Order confirmation

| Metric | Form | Depends on |
| --- | --- | --- |
| POs received this month, count and value | Stat tile + trend | `orders` |
| Orders **pending verification** | Stat tile | `orders` |
| Verification failures by reason — sample not approved, price not approved, artwork missing [§13] | Breakdown | `orders` |
| Clarification pending, by age | Ranked table | `orders` |
| **Time PO → released to production** | Stat tile with trend | `orders` |
| Orders released this week, quantity and value | Stat tile | `orders` |
| Orders held at the gate > 48h | Ranked table | `orders` |

> The verification-failure breakdown is the highest-value chart here: it shows *which
> upstream department* keeps stalling orders, which is exactly what the blueprint's
> coordination goal is about.

---

## 7. Production

The CRM holds customer-facing visibility only [§14] — planning stays in the ERP.

| Metric | Form | Depends on |
| --- | --- | --- |
| Active orders · quantity in production | Stat tiles | `production` |
| **Orders delayed** against expected completion [§25] | Stat tile, red | `production` |
| Produced vs planned, today and this week | Trend | `production` |
| **On hold**, split by cause: material, mould, printing material, quality [§15] | Breakdown | `production` |
| **Part quantity ready awaiting release** to dispatch [§17] | Stat tile + list | `production` |
| Balance quantity by order, soonest delivery first | Ranked table | `production` |
| Scrap and rejection % | Stat tile with trend | `quality` |
| Output by machine or line | Breakdown | `production` |
| Orders due this week vs capacity committed | Target gauge | `production` |

> The on-hold breakdown is the one that earns its place. "6 orders on hold" is not
> actionable; "4 waiting on masterbatch" is a purchase order.

---

## 8. Quality

| Metric | Form | Depends on |
| --- | --- | --- |
| Inspections pending | Stat tile | `quality` |
| **First-pass yield %** | Stat tile with trend | `quality` |
| Passed vs rejected quantity | Trend | `quality` |
| **Rejection reasons**, worst first | Ranked breakdown (Pareto) | `quality` |
| Rejection rate by model and by line | Breakdown | `quality` |
| Active quality holds, by age | Ranked table | `production` |
| Customer complaints traced to a batch | Ranked table | `customers` |

> A Pareto of rejection reasons is the single most useful chart a moulding QC team can have:
> two or three causes will account for most of the loss.

---

## 9. Despatch

| Metric | Form | Depends on |
| --- | --- | --- |
| Open dispatch requests | Stat tile | `dispatch` |
| **Ready material > 24h not dispatched** [§25] | Stat tile, red + list | `dispatch` |
| Dispatched today / this week, quantity and value | Stat tiles + trend | `dispatch` |
| Part dispatches open against orders | Ranked table | `dispatch` |
| **On-time delivery %** against promised date | Stat tile with trend | `dispatch` |
| POD pending, by age | Ranked table | `dispatch` |
| Transporter performance: on-time %, average transit days | Ranked table | `dispatch` |
| Dispatch by destination | Breakdown | `dispatch` |

---

## 10. Accounts

| Metric | Form | Depends on |
| --- | --- | --- |
| **Total receivable** | Stat tile | `payments` |
| Due this week · overdue · **overdue > 30 days** [§22] | Stat tiles, escalating colour | `payments` |
| Ageing buckets: current, 1–30, 31–60, 61–90, 90+ | Breakdown | `payments` |
| Collection this month against target | Target gauge | `payments` |
| **DSO** — days sales outstanding | Stat tile with trend | `payments` |
| Top debtors | Ranked table | `payments` |
| **Customers over credit limit** | Ranked table, red | `customers` |
| Disputes and holds | Stat tile + list | `payments` |
| **Dispatched but not invoiced** | Stat tile | `dispatch` |

> The last one catches revenue leaking between two departments, which is precisely the gap
> this CRM exists to close.

---

## 11. Customer communication

No communications team exists here — **marketing** owns the customer conversation. This is a
section of the marketing dashboard rather than a department of its own. Mostly waits on the
deferred WhatsApp work, but the send-to-customer audit [§42.6] is measurable as soon as that
module ships.

| Metric | Form | Depends on |
| --- | --- | --- |
| Customer updates sent, by stage | Breakdown | `customer_comms` |
| Updates sent per marketing person | Ranked table | `customer_comms` |
| **Duplicate-send warnings triggered** [§42.7] | Stat tile | `customer_comms` |
| Stages most often shared with customers | Breakdown | `customer_comms` |
| Incoming messages · **unassigned queue** | Stat tiles | `whatsapp` (deferred) |
| Unanswered inbound, by age | Ranked table | `whatsapp` (deferred) |
| First-response time | Stat tile | `whatsapp` (deferred) |
| Leads created vs converted to enquiry | Funnel | `whatsapp` (deferred) |

---

## 12. MD / Management

An **exception dashboard** [§22] — what is wrong, not what exists. Everything red opens the
list behind it.

### Exceptions, in priority order
| Metric | Depends on |
| --- | --- |
| Orders delayed against promised delivery | `production` |
| Ready material > 24h not dispatched | `dispatch` |
| Receivables overdue > 30 days | `payments` |
| Special price approvals pending | `pricing` |
| Samples overdue > 2 days | `samples` |
| Pricing requests > 48h | `pricing` |
| Orders on hold, by cause | `production` |
| Enquiries with no next action | `enquiries` |

### Business shape
| Metric | Form | Depends on |
| --- | --- | --- |
| Pipeline value by stage | Funnel | `orders` |
| Order conversion % and trend | Stat tile + trend | `orders` |
| New enquiry value · quoted value · confirmed value · lost value [§38] | Stat tiles | `orders` |
| Order value against annual target | Target gauge | `orders` |
| **Marketing-wise comparison** [§23]: enquiries, samples, quotes, orders, value, collection | Ranked table | `orders` |
| Conversion by person: enquiry→sample, sample→quote, quote→order | Ranked table | `orders` |
| Average closing days by person | Ranked table | `orders` |
| Value pending production · value pending dispatch · value pending collection | Stat tiles | `production` |

> **Value at each stage** is the metric that turns this from an activity report into a
> business view: it answers "where is our money sitting?" in one row.

### Weekly review [§38]
The Monday pack is the same components filtered to the week, exportable as one page: new
enquiry value, quoted, confirmed, lost, conversion %, orders in production, delayed,
dispatch pending, receivables, overdue, marketing-wise performance.

---

## 13. Build order

Dashboards are not a phase of their own — each ships **with** its module, because a module
without its metrics is half delivered.

| Phase | Module lands | Dashboard that lights up |
| --- | --- | --- |
| 1 | `customers`, `enquiries`, `products` | Marketing: today, funnel top, sources, dormant customers |
| 2 | `samples` | Sampling in full; marketing gains sample ageing |
| 3 | `pricing`, `quotations` | Pricing in full; MD gains approvals pending |
| 4 | `orders`, `production`, `quality` | Order confirmation, production, quality; MD gains delays and pipeline value |
| 5 | `dispatch`, `payments` | Despatch, accounts; MD gains receivables and value-at-stage |
| 6 | `tasks`, `reports` | Escalations feed the exception dashboard; weekly pack exports |
| 7 | `customer_comms` | Communications send audit |
| 8 | `whatsapp` | Communications inbox metrics |

**One caution.** Do not build a metric before the field it reads exists. Every entry above
names its module; if the module is not built, the number is a guess, and a dashboard that
guesses once is never trusted again.
