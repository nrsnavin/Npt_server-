# Queries: a CRM that feels like a chat app

**Status:** Phase 1 building · **Owner:** Queries · **Last updated:** 23 Sept 2026

---

## 1. The one-paragraph version

Queries is already the front door of this app: every question about a buyer, and everybody
pulled in to answer it. Underneath it is a CRM case record — customer, participants, status,
audit trail, access grants. On top it has to feel like WhatsApp, because WhatsApp is what the
people using it already use all day, and anything slower loses to it. Today it half-succeeds: the
thread reads like a conversation, but the list is a table, nothing tells you what is new since
you last looked, field staff cannot say *where they are*, and the thread cannot point at the
enquiry, sample or order it is about. This document plans the three phases that close that gap,
and records the decisions that are easy to get wrong.

## 2. Who uses it, and for what

| Person | Where they are | What they need from a thread, in their words |
|---|---|---|
| Marketing (Nandhini, Arun) | At a buyer's factory, on a phone | "I'm at SCM's gate, their QC says 40 pcs broke — despatch, what went out?" |
| Despatch (Anita) | At the loading bay, on a phone | "Which of these is new since lunch?" |
| Accounts (Kiran) | At a desk | "Has despatch even seen my question?" |
| Management | Anywhere | "Who is sitting on what, and since when?" |

Two facts about this population drive most decisions below:

- **They are on phones, on a shop floor, often on patchy 4G.** Every interaction has to work
  one-handed, and anything that needs a second screen does not get done.
- **They will not fill in a form to have a conversation.** Every CRM field is either inferred or
  optional. The only thing that must be done is to type.

## 3. Principles

1. **Chat on the surface, CRM underneath.** The screen is an inbox and a thread. The record is a
   case with a customer, participants, status, audit and access. Nothing on the record is asked
   for if it can be inferred; nothing inferred is presented as a fact somebody stated.
2. **A location is a message somebody chose to send.** Never background, never continuous, never
   on a timer. See §6.
3. **One source of truth.** The `Query` document holds the thread. No parallel activity feed or
   inbox table until scale forces one (§8 says when).
4. **Reuse before build.** The attachment store, the bundled place data, the audit log, the
   ownership rules and the model-reading doors already exist and are tested.
5. **The model never writes a stored fact** (the house rule). Summaries, urgency and drafts stay
   regenerated and labelled; nothing in this plan changes that.

## 4. What is in, what is out

**In (this plan):** inbox with unread counts and last-message preview · read receipts ("seen
by") · location messages with Google Maps · pinning a customer's site · Enter-to-send, optional
subject · linking records · photos · @mentions · owner and due-by · tags · live updates ·
notifications · response-time reporting.

**Out, deliberately:**

- **Continuous or background location tracking.** It is surveillance of staff, it is a DPDP Act
  consent problem, it drains batteries, and nobody asked for it. A check-in is a message.
- **Customer-facing chat.** Buyers are reached on WhatsApp through the existing inbox; this is
  internal. Mixing the two puts internal notes one mis-tap away from a buyer.
- **An embedded map.** Google's embed and static-map APIs need a billed key; a link to Google
  Maps needs nothing and opens the app people already navigate with. Revisit only if a key is
  provisioned for another reason.
- **Typing indicators, emoji reactions, voice notes.** Furniture that makes a record people quote
  in front of buyers read like gossip; voice notes are not searchable.
- **Editing or deleting sent messages.** A thread is quoted in disputes. Corrections are a new
  message. (A narrow exception for location is discussed in §6.)

## 5. Phases

### Phase 1 — "It feels like a chat app" (building now)

| Feature | Why now |
|---|---|
| **Location messages** — "Share my location" in the composer; card with nearest town, accuracy, *Open in Google Maps*, *Directions* | Asked for directly; field staff have no way to say where they are |
| **Pin a customer's site** from a check-in | Turns a one-off check-in into lasting CRM data: the next visitor gets directions to the gate, not the town centre |
| **Inbox rows** — last message preview, who said it, relative time, unread count for *me* | The table answers "what exists"; an inbox answers "what is new", which is the question people open it with |
| **Read receipts** — "Seen by Anita, Kiran" under the last message | Accounts' real question is "has despatch seen this"; today nothing answers it |
| **Enter sends, Shift+Enter is a newline; subject optional** (defaults to the question's first line) | Chat-app muscle memory; the subject field was the one thing people stalled on |

**Exit criteria:** a location round-trips from a phone to the thread to Google Maps; unread counts
are right for the asker and for a department member; opening a thread clears its count *without
reordering the list*; all driven in a browser, all guards proven by revert.

### Phase 2 — "It is a CRM" (next)

| Feature | Design sketch |
|---|---|
| **Link records** — enquiry, sample, quotation, order | `query.links: [{kind, ref}]`, validated through each record's own read rules; a context strip at the top of the thread shows status of each |
| **Photos in messages** | Reuse `Attachment` with a new `query` ref and `message` id; camera capture on mobile; server-side size and type checks already exist |
| **@mentions** | `@Anita` resolves against people in the room *or* adds them through the existing, audited participant door — never a silent grant |
| **Owner and due-by** | Optional, set by the asker; overdue threads feed the department's day screen and the urgency rules as a harder signal than hours waited |
| **Tags** | A small closed list per plant (`damage`, `payment`, `packing`, `quality`) — free-text tags become 40 spellings of "damage" |
| **Two-pane layout** on desktop | List left, thread right; single pane on phones, as now |

### Phase 3 — "It is fast and it reaches people" (later)

| Feature | Design sketch |
|---|---|
| **Live updates** | Server-Sent Events per user, keyed on the same `roomFilter`; 30 s polling fallback. No WebSockets — one-way is all a thread needs, and SSE survives the Nginx config already deployed |
| **Notifications** | Web Push on mention and on answer-to-my-question; WhatsApp template to the person as a fallback, rate-limited |
| **Canned replies** | Per-department, plant-edited; inserted into the composer, never sent on their own |
| **Reporting** | First-response and resolution time by department; visit log (location messages per person per day) under the rules in §6 |
| **Messages to their own collection** | Only when §8's thresholds are crossed |

## 6. Location: design, privacy and threat model

### Capture

The browser's Geolocation API, `enableHighAccuracy: true`, 15 s timeout, no cached position older
than 60 s. The person sees what will be shared — nearest town, accuracy, "visible to everyone in
this thread" — **before** it is sent, and can cancel. Permission denied is answered with how to
turn it on, not an error code.

### What is stored

```
message.location = {
  lat, lng            // 6 dp, rounded — more precision than the fix is noise
  accuracyM           // the phone's own radius, in metres
  capturedAt          // when the phone took the fix
  place: { name, state, distanceKm }   // nearest bundled town, if within 50 km
}
```

`message.at` remains when the server received it. The body becomes optional when a location is
attached, so "📍" alone is a complete message.

### Validation (server)

| Rule | Why |
|---|---|
| lat ∈ [−90, 90], lng ∈ [−180, 180], finite | Garbage in the geo fields breaks every map downstream |
| accuracy ≤ 5 km | Beyond that it is a cell-tower guess, not a place; refused with advice ("move near a window, turn on GPS") rather than stored as if meaningful |
| captured ≤ 15 min ago and ≤ 2 min in the future | A stale or replayed fix is not "where I am"; the 2 min allows clock skew |
| Only on an open thread, only by someone in the room | The same door every other message uses |

### Naming the place, offline

The nearest of the ~85 bundled garment-centre towns, by haversine, if within 50 km — "near
Tiruppur, Tamil Nadu · 3 km". No Google Geocoding call: it needs a billed key, it sends staff
coordinates to a third party on every message, and the bundled towns are the places this business
actually goes. Outside 50 km the card shows coordinates only, which is honest.

### Threat model

| Threat | Mitigation | Residual |
|---|---|---|
| **Spoofed GPS** — a phone reports a location it is not at | None possible from a browser. The card says "shared from Nandhini's phone", never "verified". The record is what the device reported | Accepted. This is a communication tool, not attendance or proof of visit; it must never be used as one without a different design |
| **Over-exposure** — a location visible to people who should not see it | Same `roomFilter` as the message; not in exports; not in the list preview beyond "📍 Location" + town | The room can grow; adding a participant already says what it grants |
| **Surveillance creep** — someone builds "where was everyone today" | No background capture exists to build it from. The Phase 3 visit report is scoped to *a person's own* check-ins and to managers of that department, and is itself audited | Policy, not code, past that point |
| **Customer site pinned wrong** | Pinning takes a recorded message id, not typed coordinates; only the customer's owner or an admin may pin; the change is audited with who, when and from which thread | A mistaken pin is correctable the same way |

### DPDP Act 2023 alignment

Consent is per send and explicit; the purpose is stated on the preview; nothing is collected
without an action; the data is minimal (one fix, not a trail). A person may ask for their location
messages to be removed — Phase 2 adds an admin redaction that replaces the coordinates with
"location removed on request" and keeps the audit row, because deleting the message would break a
thread other people are quoting.

## 7. Data model and API (Phase 1)

```
Query
  messages[]
    body: optional when location is present
    + location: { lat, lng, accuracyM, capturedAt, place }

QueryRead                            // NEW collection, one row per reader per thread
  { query, user, at }                // unique (query, user)

Customer
  + site: { lat, lng, accuracyM, setBy, setAt, fromQuery, fromMessage }
```

**Why read cursors are not on the `Query` document.** It was the obvious place and it would have
been a bug. `Query` runs with optimistic concurrency (`protectWrites`): every update advances
`__v`, and a reply is saved against the version it was loaded at. A cursor on the document means
*opening a thread* advances its version — so somebody else's reply, loaded a moment earlier,
fails with "someone else changed this record". Reading would break writing. Read state is also
per-person and high-churn, which is exactly the data that should not share a document with the
shared record. Its own collection has neither problem, never touches `updatedAt`, and upserts in
one round trip.

| Method | Path | Notes |
|---|---|---|
| POST | `/queries/:id/messages` | Accepts `location`; body optional with it |
| POST | `/queries/:id/read` | Upserts my `QueryRead` cursor. Never touches the `Query` document — see above |
| GET | `/queries` | Each row gains `unread` (for me), `last` (preview), `seenBy` computed per reader, like urgency |
| POST | `/customers/:id/site` | `{ query, message }` → copies that message's location; owner or admin; audited |
| DELETE | `/customers/:id/site` | Clears it; same rule; audited |

**Why read cursors and not per-message read flags:** one row per reader per thread instead of one
per reader per message — O(readers) rather than O(readers × messages) — and "unread" becomes a
comparison of timestamps. It is how every chat product at scale does it.

**Why unread is computed, not stored:** a stored counter has to be incremented for every other
reader on every message and reset on every read, under concurrency; a computed one is always
right and costs a pass over messages the list already loads.

## 8. Scale limits of the current design, and when to change it

Messages are embedded in the `Query` document. That is the right call at this plant's size —
one read gets the whole thread, atomically — and it has known ceilings:

| Limit | Where it bites | Threshold to act |
|---|---|---|
| 16 MB BSON document | ~25,000 messages in one thread | Any thread > 2,000 messages (alert from a nightly count) |
| List endpoint loads messages | A 100-row map view loads every message of every thread | p95 of `GET /queries` > 400 ms |
| `$push` contention on one document | Many people typing into one hot thread | Not plausible at 40 staff |

The migration when a threshold is crossed: a `QueryMessage` collection keyed `(query, at)`,
dual-written for one release, backfilled, then read from; the list keeps a denormalised `last`
on `Query`. Planned, not built.

### Launch: nobody starts with forty unread threads

Every existing thread has no cursor for anybody on the day this ships, so a naive count shows the
whole history as unread. `migrate:query-reads` writes a cursor at each thread's last message for
its raiser, its named participants and the current members of each department on it. Dry run by
default, idempotent, run once before the deploy.

### Known and deliberately deferred

Two replies saved in the same few milliseconds: the second fails with a conflict, because a reply
is a `save()` under optimistic concurrency. It predates this plan, it is rare at this plant's
volume, and the fix — replies as an atomic `$push` outside the version check — belongs with the
Phase 3 message-collection work rather than as a special case now.

## 9. Success measures

| Measure | Now | Phase 1 target |
|---|---|---|
| Median time to first reply on a query | unmeasured | measured, reported per department |
| Queries raised from a phone | unmeasured | > 50 % |
| Threads with a "seen" but no reply after 24 h | invisible | visible on the list |
| Customers with a pinned site | 0 | every customer visited in the quarter |

## 10. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Staff read location sharing as tracking and refuse the feature | Medium | Per-send, visible, cancellable; stated in the preview; no background mode exists |
| Location permission denied on the plant's phones | Medium | Clear instructions in the denial message; the rest of the feature does not depend on it |
| Unread counts drift from what people see | Low | Computed, not stored; tested for asker, named person and department member |
| Embedded-message ceilings | Low at this size | §8 thresholds, measured |
