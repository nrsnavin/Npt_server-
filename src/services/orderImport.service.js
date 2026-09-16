import ApiError from '../utils/ApiError.js';
import SalesOrder, { PRE_RELEASE_STATUSES } from '../models/SalesOrder.js';
import OrderQuery, { dueFrom } from '../models/OrderQuery.js';
import { matchOrder } from './importMatching.service.js';
import { nextNumber } from './numbering.service.js';

/**
 * Bringing an outside system's sales orders in, without bringing any of them in twice
 * [BLUEPRINT §12, §13].
 *
 * `importMatching` answers "which buyer, which tool, whose order". This answers the question
 * that comes after it and is the one an integration actually fails on: **have we seen this
 * before?** Everything here exists to make the answer cheap and the wrong answer impossible.
 *
 * ## Why de-duplication is the whole problem
 *
 * A poller re-reads. It re-reads because `modifiedSince` is a timestamp from somebody else's
 * clock and clocks disagree, so the only safe window is one that overlaps the last; it re-reads
 * after a request times out on our side and succeeds on theirs; it re-reads when somebody
 * restarts the process and the cursor resets. An importer that treats every row it is handed as
 * a new order will therefore book the same job twice in ordinary operation — not as an edge
 * case, but on a normal Tuesday — and the plant will make it twice.
 *
 * So the rule is: **the feed's identifier decides, and the database enforces it.** Not a
 * `findOne` followed by a `create`, which is two statements with a gap in the middle that two
 * overlapping polls will both walk through. A single upsert keyed on the pair `(source, id)`,
 * backed by the unique index on those fields, so the second writer loses at the storage layer
 * where losing is safe.
 *
 * ## What an amendment is allowed to do
 *
 * Recognising a row as one we already have is only half of it. The other half is what to do
 * about a row that has *changed*, and §12's answer depends on whether the plant has started:
 *
 *   **Before release** an amendment is applied. Nothing has been cut, nothing scheduled; the
 *   order is still a piece of paper being checked, and the buyer's latest paperwork is the
 *   truth. The §13 checks that were already ticked are cleared, because they were ticked
 *   against the figures that just changed — a "correct model" tick from before the model
 *   changed is worse than no tick, since it reads as somebody having checked.
 *
 *   **After release** an amendment is *never* applied. A quantity quietly rewritten under a
 *   running press is how the wrong quantity gets made, and it is the failure this whole design
 *   exists to avoid. The order is left exactly as the plant is running it, and a query is
 *   raised to its owner saying what Chirix now says and what the order says. A person decides.
 *
 *   **A cancellation** follows the same split, and for the same reason: before release it is
 *   applied, after release it is a question. A press already running a cancelled order is a
 *   conversation, not a status change.
 *
 * ## What a failed import must not do
 *
 * Stop the batch. Twenty orders arrive, one names a buyer whose GSTIN is malformed; refusing
 * the batch loses nineteen good orders to one bad row, and an import that does that is one
 * people stop trusting and start double-checking by hand — at which point it has saved nothing.
 * So each row is caught, counted and reported, and the poll goes on.
 */

/** What an import run reports back. Counts first, because that is what a log line wants. */
const emptyResult = () => ({
  created: [],
  amended: [],
  queried: [],
  unchanged: [],
  failed: [],
});

/**
 * The fields an amendment is allowed to move.
 *
 * A deliberate list rather than a spread of whatever arrived, because the feed's row and our
 * order are not the same shape and never will be: ours carries the §13 checks, the release
 * stamp, the production status per line, the priority marketing set, and the query thread. A
 * blind `Object.assign` from a normalised feed row would erase every one of them, and it would
 * do it silently on an order that was merely re-read.
 */
const AMENDABLE = ['customerPo', 'orderDate', 'gstPercent', 'isExport', 'paymentTerms', 'deliveryTerms', 'freightTerms', 'remarks'];

/**
 * Is this row saying anything new?
 *
 * Compared on the feed's own revision where they give us one, because that is what it is for and
 * it is the only comparison that stays right when a field we do not read changes. Where they do
 * not, we fall back to comparing the parts of the order this importer would actually write —
 * which is not as good, and the guide says so, but it beats treating every re-read as an
 * amendment and raising a query per poll.
 */
export function hasChanged(order, incoming) {
  const theirs = incoming.externalRef?.revision;
  const ours = order.externalRef?.revision;
  if (theirs || ours) return String(theirs ?? '') !== String(ours ?? '');

  /* No revision on either side: compare what we would write. */
  const sameTerms = AMENDABLE.every((key) => {
    if (incoming[key] === undefined) return true;
    const before = order[key];
    if (key === 'customerPo') {
      return String(before?.number ?? '') === String(incoming[key]?.number ?? '');
    }
    if (before instanceof Date || incoming[key] instanceof Date) {
      return new Date(before ?? 0).getTime() === new Date(incoming[key] ?? 0).getTime();
    }
    return String(before ?? '') === String(incoming[key] ?? '');
  });

  const sameLines =
    (order.lines || []).length === (incoming.lines || []).length &&
    (incoming.lines || []).every((line, at) => {
      const before = order.lines[at];
      return (
        before &&
        Number(before.quantity) === Number(line.quantity) &&
        Number(before.unitPrice) === Number(line.unitPrice) &&
        String(before.modelNumber ?? '') === String(line.modelNumber ?? '')
      );
    });

  return !(sameTerms && sameLines);
}

/**
 * One row, imported.
 *
 * Returns what happened rather than throwing, so the caller can count it. The one thing it does
 * throw on is a row with no usable identifier: without `(source, id)` there is nothing to be
 * idempotent *on*, and importing it would create a duplicate on the very next poll. That is a
 * bug in the adapter rather than a bad row, and it should be loud.
 */
export async function importOne(row, { source, mapping = {}, fallback, by } = {}) {
  const id = String(row?.externalId ?? '').trim();
  if (!source || !id) {
    throw ApiError.badRequest(
      'An imported order needs the source and the identifier it has there — without them the ' +
        'next poll cannot tell it apart from a new order'
    );
  }

  const existing = await SalesOrder.findOne({ 'externalRef.source': source, 'externalRef.id': id });

  /* ------------------------------ Already here ------------------------------ */
  if (existing) {
    if (!hasChanged(existing, row)) {
      return { outcome: 'unchanged', order: existing };
    }

    /*
     * Changed, and the plant has started. The order is left alone and a person is asked — see
     * the note at the top. The query carries both sides, because "Chirix has changed this
     * order" without saying what changed is a message that sends somebody to another system to
     * find out.
     */
    if (!PRE_RELEASE_STATUSES.includes(existing.status)) {
      const changes = describeChanges(existing, row);
      /*
       * Asked of marketing, because they are the ones who can ring the buyer and find out which
       * of the two documents is the real one. `urgent` rather than the default: the four-hour
       * clock is the point — a press is running the old quantity while this waits.
       *
       * `raisedBy` is the import's own user, which is why one has to be configured. A query with
       * no asker cannot be saved, and a query that claims to be from whoever last logged in
       * would put a name against a question nobody asked.
       */
      await OrderQuery.create({
        number: await nextNumber('QRY'),
        order: existing._id,
        raisedBy: by,
        askedOf: 'marketing',
        urgency: 'urgent',
        dueBy: dueFrom('urgent'),
        question:
          `${source} has amended ${id} since this order was released: ${changes}. ` +
          'The order here is unchanged and the plant is still running it — confirm what should happen.',
      });
      /* The revision is recorded even though nothing else is, so the next poll does not raise
         the same question again every five minutes until somebody answers it. */
      if (row.externalRef?.revision) {
        existing.externalRef.revision = String(row.externalRef.revision);
        await existing.save();
      }
      return { outcome: 'queried', order: existing, changes };
    }

    /* Changed, and nothing has been cut. Apply it, and un-tick what was checked against the
       old figures. */
    const changes = describeChanges(existing, row);
    for (const key of AMENDABLE) {
      if (row[key] !== undefined) existing[key] = row[key];
    }
    if (row.lines) existing.lines = row.lines;
    existing.verification = {};
    existing.externalRef.revision = row.externalRef?.revision
      ? String(row.externalRef.revision)
      : existing.externalRef.revision;
    existing.importReview = row.importReview || [];
    existing.statusHistory.push({
      from: existing.status,
      to: 'order_verification',
      by,
      note: `Amended by ${source}: ${changes}. The §13 checks have been cleared.`,
    });
    existing.status = 'order_verification';
    await existing.save();

    return { outcome: 'amended', order: existing, changes };
  }

  /* -------------------------------- New to us -------------------------------- */
  const matched = await matchOrder(row, { mapping, fallback });
  if (!matched.owner) {
    throw ApiError.badRequest(
      `${id} could not be given an owner — set a fallback user for the ${source} import`
    );
  }

  /*
   * `findOneAndUpdate` with `upsert`, not `create`.
   *
   * Two polls overlapping is the ordinary case, not the rare one, and between a `findOne` that
   * found nothing and a `create` there is a window both of them fit through. The upsert closes
   * it: the pair is the filter, so the second writer updates the row the first inserted instead
   * of inserting a second. `$setOnInsert` for everything, because on the losing side of that
   * race we want the winner's order left exactly as it is — this call is an insert or it is
   * nothing.
   */
  const number = await nextNumber('SO');
  const order = await SalesOrder.findOneAndUpdate(
    { 'externalRef.source': source, 'externalRef.id': id },
    {
      $setOnInsert: {
        number,
        customer: matched.customer._id,
        assignedTo: matched.owner,
        customerPo: row.customerPo,
        orderDate: row.orderDate,
        lines: matched.lines,
        gstPercent: row.gstPercent,
        isExport: row.isExport,
        paymentTerms: row.paymentTerms,
        deliveryTerms: row.deliveryTerms,
        freightTerms: row.freightTerms,
        remarks: row.remarks,
        externalRef: {
          source,
          id,
          revision: row.externalRef?.revision ? String(row.externalRef.revision) : undefined,
          importedAt: new Date(),
        },
        importReview: matched.review,
        status: 'po_received',
        statusHistory: [{ to: 'po_received', by, note: `Imported from ${source} as ${id}` }],
      },
    },
    /* `includeResultMetadata`, not the `rawResult` this was first written with: Mongoose 8
       renamed it, and the old name is simply ignored — so the result came back as a plain
       document, `lastErrorObject` was undefined, and every genuine insert reported itself as
       `unchanged`. An importer that says it changed nothing while creating orders is worse than
       one that double-counts, because the log agrees with it. */
    { upsert: true, new: true, setDefaultsOnInsert: true, includeResultMetadata: true }
  );

  /*
   * Which side of that race we were on. A row that was matched rather than inserted means
   * another poll got there first — which is not an error and not an import: it is the duplicate
   * being prevented, and it should be counted as such rather than reported as a new order that
   * nobody created.
   */
  const inserted = Boolean(order.lastErrorObject?.upserted);
  return { outcome: inserted ? 'created' : 'unchanged', order: order.value };
}

/**
 * What moved between the order we hold and the row that arrived, in a sentence.
 *
 * Written for the query a person reads, so it names figures rather than field paths: "quantity
 * 20,000 → 24,000" is something somebody can take to the floor, and `lines.0.quantity changed`
 * is not.
 */
export function describeChanges(order, incoming) {
  const notes = [];

  if (incoming.customerPo?.number && incoming.customerPo.number !== order.customerPo?.number) {
    notes.push(`PO ${order.customerPo?.number || '—'} → ${incoming.customerPo.number}`);
  }

  for (const [at, line] of (incoming.lines || []).entries()) {
    const before = order.lines?.[at];
    const name = line.modelNumber || before?.modelNumber || `line ${at + 1}`;
    if (!before) {
      notes.push(`${name} is a new line of ${Number(line.quantity).toLocaleString('en-IN')}`);
      continue;
    }
    if (Number(before.quantity) !== Number(line.quantity)) {
      notes.push(
        `${name} quantity ${Number(before.quantity).toLocaleString('en-IN')} → ${Number(line.quantity).toLocaleString('en-IN')}`
      );
    }
    if (Number(before.unitPrice) !== Number(line.unitPrice)) {
      notes.push(`${name} rate ₹${before.unitPrice} → ₹${line.unitPrice}`);
    }
  }

  if ((order.lines || []).length > (incoming.lines || []).length) {
    notes.push(`${order.lines.length - incoming.lines.length} line(s) removed`);
  }

  /* A revision bump with nothing we read having moved is still worth saying, because it means
     something changed in a field this importer does not carry. */
  return notes.length ? notes.join('; ') : 'something outside the fields this import carries';
}

/**
 * A whole batch.
 *
 * Every row is attempted. A row that throws is recorded against its identifier and the next one
 * runs, because one malformed buyer must not cost nineteen good orders — see the note at the
 * top of the file.
 */
export async function importBatch(rows, options = {}) {
  const result = emptyResult();

  for (const row of rows || []) {
    try {
      const { outcome, order, changes } = await importOne(row, options);
      result[outcome].push({
        externalId: row?.externalId,
        number: order?.number,
        id: order?._id,
        ...(changes ? { changes } : {}),
      });
    } catch (error) {
      result.failed.push({ externalId: row?.externalId, reason: error.message });
    }
  }

  return result;
}

/** A one-line summary for the log, so a poll that did nothing still says so. */
export const summarise = (result) =>
  `imported ${result.created.length} new, ${result.amended.length} amended, ` +
  `${result.queried.length} queried, ${result.unchanged.length} unchanged, ${result.failed.length} failed`;
