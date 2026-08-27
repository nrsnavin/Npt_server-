# Sample analytics

`GET /api/samples/analytics` and the screen on top of it. Separate from the sampling
dashboard on purpose: the dashboard answers **what is late right now**, this answers **how
long we take and why**, over a period.

Two reports, two jobs. Anything the dashboard already answers is not repeated here.

## What the report contains

| Block | Question it answers |
| --- | --- |
| Headline | How many were fulfilled, how long they took, how often the promise was kept |
| Trend | Is this month better or worse than the ones before it |
| Where the days go | Which stage the time is actually spent in |
| By purpose | Does a new development cost more than a repeat |
| Printed against plain | What printing adds |
| By hook, material, category | Which of the plant's own capabilities are slow |
| By quantity | Does asking for twelve cost more than asking for two |

## The measurement decisions

These are the parts that would be wrong if someone changed them without knowing why.

### Fulfilment is request → ready

Not request → delivered. That is the span the bench controls. A courier sitting on a parcel
is a real delay but not this team's, and mixing the two produces a number nobody can act on
— when it moves you cannot tell which of two organisations caused it.

Request → dispatched is reported alongside it, in the footnote, as what the customer
actually experienced. Both are true; they are just answers to different questions.

### A missing ready tick does not remove a sample from the average

Nothing forces the bench to tick `sample_ready` — the status route accepts any status, and
in practice a sample is sometimes marked dispatched the moment the parcel is handed over.
Reading only the ready tick would silently drop every such sample, leaving an average
computed over whoever was diligent about the boxes rather than over the work.

So when the tick is missing, `readyTime()` falls back to the earliest status that could only
have been reached *after* the sample existed. It is an upper bound on ready, which is the
honest reading. The sampling dashboard imports the same function rather than recomputing:
two screens quoting a different average turnaround for the same bench is worse than either
being wrong on its own.

### Every mean travels with its tail

Average, median, p90 **and the worst case**, everywhere — headline and every breakdown row.

The worst case is there as well as p90 because at this plant's volumes p90 is not enough.
Nearest-rank p90 over twelve samples is the eleventh-fastest, so a single disaster sits
above it and disappears. The one that took forty days is the one worth a conversation, and
it has to be on the page.

Percentiles are nearest-rank rather than interpolated: these are durations of real samples,
so p90 should be a duration something actually took, not a blend of two that did not.

### Every segment carries its sample size

An average over two samples is noise dressed as insight. Each row reports `fulfilled` as its
`n` and is flagged `reliable: false` below `RELIABLE_SAMPLE_SIZE` (5); the screen renders
those rows dimmed and marked **thin**. Marked rather than hidden — a thin row is still the
only thing known about that segment, it just must not be read as equal to a row over forty.

### The trend always covers the trailing year

Whatever period the rest of the report is on. Asking for this month is the common case, and
a chart one column wide is not a trend — the question it answers is whether this month is
better than the ones before it, which needs the ones before it on the page.

### Stage time is split at ready

`timeInStage` tags each row `beforeReady`. The headline stops at ready, so a reader adding
the stages up would otherwise reach a larger number and conclude one of the two figures is
wrong, when the extra days are the courier's and the customer's. Flagged rather than
dropped: how long a buyer sits on a sample is worth knowing, it is just not the bench's to
fix.

### A sample counts in the period it was fulfilled in

That is what "fulfilled this month" means. Raised-in-period is reported separately as
`headline.raised`, and `openAtEnd` is the queue — the two answer different questions, and a
queue that grows while the average holds steady is the warning neither figure gives alone.

## Parameters

    ?months=N        the last N calendar months including this one (default 1, max 24)
    ?from=&to=       explicit ISO dates, either or both

Ownership applies: marketing analyses what it asked for, the bench analyses the bench, on
the same `requestedBy` scope the rest of the module uses.

## Deliberately not built yet

Named here so they are decisions rather than omissions:

- **Per-person turnaround.** The data supports it (`assignedTo` is on every sample). Left
  out until there is enough volume per person for it to be measurement rather than blame.
- **Cost per sample.** Waits on the pricing module; material and machine time are not
  recorded against a sample yet.
- **Approval rate by segment.** `reworkPercent` is reported, but first-time-right by hook or
  material needs more history than the register currently holds.
- **Export.** No CSV or PDF. Worth adding when someone actually needs to send the report
  outside the console.
