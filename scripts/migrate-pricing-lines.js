/**
 * Folds legacy single-model costings into the `lines` array — and points the quotations at them.
 *
 * A costing sheet used to price one model: the mould, the registers, the cost breakdown, the
 * margin, the three prices and §9's decision all sat at the top of the document. It holds a list
 * now, because a conversation with a buyer is about four hangers and not one, and because the
 * floor a price is checked against is a fact about *a model* rather than about a sheet.
 *
 * Nothing reads the old shape any more. Those fields are virtuals over the first line today, so
 * on an unmigrated database every costing renders with no model, no cost and no price — the data
 * is all still there and every screen says the sheet is empty. Worse, a sheet with no lines rolls
 * up to `requested`, so an approved price would look like one nobody has worked out yet.
 *
 * What this does, per costing that has no lines yet:
 *
 *   lines: [{ mould, the four registers, modelNumber, material, procurement, printing,
 *             cost, markupPercent, the three prices, minimumOverride,
 *             status, approvedBy, approvedAt, rejectionNote }]        from the old fields
 *
 * and then unsets them, so a price lives in exactly one place rather than two that can disagree.
 * `status` stays on the sheet as well, because the sheet still stores its own roll-up — the line
 * gets a copy of it, which on a one-model sheet is the same decision either way.
 *
 * Then, per quotation line that names a costing but no line of it: `pricingLine`, pointing at
 * the line just built. Without it every floor check downstream falls back to the sheet's first
 * line — which is right on a migrated sheet and would quietly stop being right the first time
 * somebody adds a second model to one.
 *
 * **Idempotent.** A costing that already has lines is skipped, as is a quotation line that
 * already names one, so running it twice is safe and a half-finished run can simply be re-run.
 *
 * **Dry run by default.** Prints what it would do and changes nothing. Pass `--confirm` to write.
 *
 *   node scripts/migrate-pricing-lines.js            # show me
 *   node scripts/migrate-pricing-lines.js --confirm  # do it
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';

const confirm = process.argv.includes('--confirm');

/** Everything that used to sit on the sheet and now belongs to one model on it. */
const LINE_FIELDS = [
  'mould', 'materialRef', 'hookRef', 'clipRef', 'printRef',
  'modelNumber', 'quantity', 'material', 'procurement', 'printing',
  'cost', 'markupPercent', 'calculatedSellingPrice', 'approvedSellingPrice', 'minimumOverride',
  'approvedBy', 'approvedAt', 'rejectionNote',
];

/**
 * Whether there is anything on this sheet worth folding.
 *
 * A costing raised and never built has a number, a customer and nothing else, and it should stay
 * that way: giving it an empty line would turn "nobody has costed this yet" into a line with no
 * cost on it, which reads on a screen as a model priced at nothing.
 */
const hasSomething = (pricing) => LINE_FIELDS.some((field) => pricing[field] != null);

const lineFrom = (pricing) => {
  const line = { _id: new mongoose.Types.ObjectId() };
  for (const field of LINE_FIELDS) {
    if (pricing[field] != null) line[field] = pricing[field];
  }
  /* The decision travels with the price it was made about — that is the point of the move. */
  line.status = pricing.status || 'requested';
  return line;
};

async function migrate() {
  await connectDatabase();

  /*
   * The raw collections rather than the models. Mongoose would apply the *new* schema on read
   * and drop every legacy field before this code could see it — the migration would report a
   * tidy zero and leave the data exactly as it was.
   */
  const pricings = mongoose.connection.collection('pricings');
  const quotations = mongoose.connection.collection('quotations');

  const legacy = await pricings
    .find({ $or: [{ lines: { $exists: false } }, { lines: { $size: 0 } }] })
    .toArray();

  if (!legacy.length) {
    console.log('Nothing to migrate — every costing already carries lines.');
  } else {
    console.log(`${legacy.length} costing(s) still in the single-model shape:\n`);
  }

  let written = 0;
  let bare = 0;
  /** The line each migrated sheet now carries, so the quotations below can point at it. */
  const lineOf = new Map();

  for (const pricing of legacy) {
    if (!hasSomething(pricing)) {
      bare += 1;
      console.log(`  ${pricing.number}  — raised and never costed, left as it is`);
      continue;
    }

    const line = lineFrom(pricing);
    lineOf.set(String(pricing._id), line._id);

    console.log(
      `  ${pricing.number}  ${line.modelNumber || '(no model)'}` +
        `${line.approvedSellingPrice != null ? `  ₹${line.approvedSellingPrice}` : ''}` +
        `  · ${line.status}`
    );

    if (confirm) {
      await pricings.updateOne(
        { _id: pricing._id },
        {
          $set: { lines: [line] },
          $unset: Object.fromEntries(LINE_FIELDS.map((field) => [field, ''])),
        }
      );
      written += 1;
    }
  }

  /* ------------------------- And the quotations that read them ------------------------- */

  /*
   * Every quotation line naming a costing, not only the ones migrated above: a sheet that
   * already had lines when this ran still has quotation lines from before `pricingLine` existed,
   * and those need the same pointer. Where the sheet holds one line there is exactly one answer;
   * where it holds several, the model number is what the two records have in common.
   */
  const quoting = await quotations
    .find({ 'lines.pricing': { $exists: true }, 'lines.pricingLine': { $exists: false } })
    .toArray();

  let pointed = 0;
  let unmatched = 0;

  for (const quotation of quoting) {
    const lines = [...(quotation.lines || [])];
    let touched = false;

    for (const [index, line] of lines.entries()) {
      if (!line.pricing || line.pricingLine) continue;

      let id = lineOf.get(String(line.pricing));

      if (!id) {
        const sheet = await pricings.findOne({ _id: line.pricing }, { projection: { lines: 1 } });
        const rows = sheet?.lines || [];
        const named = rows.filter((row) => row.modelNumber === line.modelNumber);
        id = named.length === 1 ? named[0]._id : rows.length === 1 ? rows[0]._id : undefined;
      }

      if (!id) {
        unmatched += 1;
        console.log(
          `  ${quotation.number} line ${index + 1} (${line.modelNumber || 'no model'})` +
            ' — its costing has several models and none of them matches by name; left for review'
        );
        continue;
      }

      lines[index] = { ...line, pricingLine: id };
      touched = true;
      pointed += 1;
    }

    if (touched && confirm) await quotations.updateOne({ _id: quotation._id }, { $set: { lines } });
  }

  console.log('');
  if (confirm) {
    console.log(
      `Migrated ${written} costing(s)${bare ? `, ${bare} left as raised` : ''}` +
        `, and pointed ${pointed} quotation line(s) at theirs` +
        `${unmatched ? `. ${unmatched} left for review.` : '.'}`
    );
  } else {
    console.log(
      `Dry run — nothing was changed. Re-run with --confirm to migrate ` +
        `${legacy.length - bare} costing(s) and ${pointed} quotation line(s).`
    );
  }

  await disconnectDatabase();
}

migrate().catch(async (error) => {
  console.error(error);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
