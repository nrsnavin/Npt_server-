# What to ask Chirix for

A draft email to the Chirix vendor, and the reasoning behind each question, so the answers
arrive in one round-trip rather than four.

Every question below exists because getting it wrong costs a rebuild rather than an edit. The
covering note is deliberately short — a vendor support desk answers a short list and ignores a
long one.

---

## The email

> **Subject:** API access for reading sales orders — Navin Plastic Tech
>
> Hello,
>
> We are connecting our own production system to Chirix so that sales orders raised in Chirix
> appear automatically for our plant, rather than being typed a second time. We only need to
> **read** sales orders — we will never write anything back.
>
> Could you send us the following?
>
> 1. **Endpoint and authentication.** The base URL for listing sales orders, and how we
>    authenticate — an API key in a header, OAuth, or something else. A read-only credential is
>    all we need, and we would prefer one if you can issue it.
>
> 2. **A sample response.** One real sales order as your API returns it — both the list response
>    and the single-order response if they differ. Please feel free to replace customer names and
>    prices with dummy values; we need the field names and the structure, not the data.
>
> 3. **Filtering by change.** Can we ask for "orders created or modified since <timestamp>"? If
>    so, which parameter, and is the timestamp in IST or UTC? Without this we have to re-read
>    everything on every poll.
>
> 4. **Paging.** How the list pages — page number, offset, or a cursor — and the maximum page
>    size.
>
> 5. **Rate limits.** How often we may call, and what you return when we exceed it.
>
> 6. **Order lines.** Are the line items included in the list response, or is a second call per
>    order needed?
>
> 7. **Amendments and cancellations.** When a sales order is amended after being raised, does its
>    identifier stay the same? Is there a revision or version number, and a status field that
>    shows a cancelled order?
>
> 8. **A test environment**, if you have one, so we can develop without touching live data.
>
> Happy to have a short call if that is easier than writing it out.
>
> Thanks,
> Navin

---

## Why each question is on the list

**1 — Endpoint and auth.** Obvious, but "read-only credential" is the part worth insisting on.
The integration never writes to Chirix, so a credential that *can* write is a standing risk with
no upside.

**2 — A sample response.** The single most valuable item, and the one most often refused as
"we'll send documentation". Documentation describes the fields somebody meant to build;
a real response shows what is actually there, including the empty ones. We cannot write the
normaliser without it, and every day it is missing is a day the field mapping is guesswork.

**3 — Filtering by change.** This decides whether the poll is cheap or expensive. With a
`modifiedSince`, each poll asks for the handful that moved. Without it we re-read the whole open
order book every time — workable, but it caps how often we can poll and makes their rate limit
our bottleneck.

*The timezone half is not pedantry.* An IST timestamp read as UTC skips five and a half hours of
orders, silently, and only on the orders raised in that window. It is the classic integration bug
that surfaces a month later as "some orders don't come through".

**4 — Paging.** A list endpoint that silently returns only the first 50 is how an integration
looks like it works and quietly drops the rest. We need to know the shape so we can walk it and
prove we reached the end.

**5 — Rate limits.** IndiaMART's feed taught us this one directly — it allows roughly one call
every five minutes and answers a burst with an error rather than data, so our poll interval had
to become a floor rather than a preference. Better to know the number than to discover it.

**6 — Order lines.** If lines need a second call per order, a hundred orders is a hundred and one
requests, which interacts with question 5 and may decide the whole polling strategy.

**7 — Amendments.** This is the one that shapes the design rather than the plumbing. Our rule is
that an amendment to an order the plant has already started is *not* applied silently — it raises
a question to the order's owner instead, because quietly changing a quantity under a running press
is how the wrong quantity gets made. To do that we need to recognise "this is the same order,
changed" rather than "this is a new order", which needs a stable identifier and ideally a revision
number.

**A cancelled order matters just as much.** Without a status field we would have to infer
cancellation from an order disappearing out of the feed — and absence is not cancellation. A page
boundary, a filter change or a slow query all look identical to a deletion, and acting on that
inference would close a live order.

**8 — A test environment.** Nice to have. If there is none we develop against a saved copy of the
sample response from question 2, which is why that one matters even more.

---

## What we do not ask for, and why

**Write access.** The integration is one-directional by design. Two systems writing to each other
produce a class of disagreement that cannot be debugged from either side, and nothing in the plan
needs it.

**Their database.** A direct connection would be faster to build and would couple us to their
schema, so it breaks silently whenever they upgrade. Through the API we break loudly, which is
the failure we want.

**Their full documentation.** It usually arrives eventually and is usually out of date. The
sample response in question 2 is worth more than the whole PDF.
