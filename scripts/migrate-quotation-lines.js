/**
 * Folds legacy single-line quotations into the `lines` array.
 *
 * A quotation used to hold one model, one quantity and one price at the top of the document.
 * It now holds a list, because the plant's own quotations carry eight models under one number.
 * Records written before that change still have the old shape, and nothing reads it any more —
 * so on an unmigrated database a quotation renders with no lines, no value and no models: the
 * data is all still there, and every screen says the quote is empty.
 *
 * What this does, per quotation that has no lines yet:
 *
 *   lines: [{ product, pricing, modelNumber, quantity, moq, unitPrice }]   from the old fields
 *   revisions[].lines: [ ... ]                                            from each old revision
 *
 * and then unsets the legacy fields, so there is one place the offer lives rather than two that
 * can disagree.
 *
 * **Idempotent.** A quotation that already has lines is skipped, so running it twice is safe and
 * a half-finished run can simply be run again.
 *
 * **Dry run by default.** Prints what it would do and changes nothing. Pass `--confirm` to write.
 *
 *   node scripts/migrate-quotation-lines.js            # show me
 *   node scripts/migrate-quotation-lines.js --confirm  # do it
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';

const confirm = process.argv.includes('--confirm');

/** One line built from whatever the old document carried. */
const lineFrom = (source) => ({
  _id: new mongoose.Types.ObjectId(),
  product: source.product,
  pricing: source.pricing,
  modelNumber: source.modelNumber,
  quantity: source.quantity ?? 0,
  moq: source.moq ?? 0,
  unitPrice: source.unitPrice ?? 0,
});

async function migrate() {
  await connectDatabase();

  /*
   * The raw collection rather than the model. Mongoose would apply the *new* schema on read and
   * silently drop every legacy field before this code could see it — the migration would report
   * a tidy zero and leave the data exactly as it was.
   */
  const collection = mongoose.connection.collection('quotations');

  const legacy = await collection
    .find({ $or: [{ lines: { $exists: false } }, { lines: { $size: 0 } }] })
    .toArray();

  if (!legacy.length) {
    console.log('Nothing to migrate — every quotation already carries lines.');
    await disconnectDatabase();
    return;
  }

  console.log(`${legacy.length} quotation(s) still in the single-line shape:\n`);

  let written = 0;
  let empty = 0;

  for (const quotation of legacy) {
    const priced = quotation.unitPrice != null || quotation.quantity != null;

    if (!priced) {
      /*
       * Nothing to fold. Left alone rather than given a zero-priced line: an empty quotation is
       * a data problem somebody should look at, and inventing a ₹0 line for one hides it behind
       * a document that now renders perfectly and offers a hanger for nothing.
       */
      empty += 1;
      console.log(`  ${quotation.number}  — no price on it at all, left untouched for review`);
      continue;
    }

    const lines = [lineFrom(quotation)];
    const revisions = (quotation.revisions || []).map((revision) =>
      revision.lines?.length
        ? revision
        : {
            ...revision,
            lines: [
              lineFrom({
                product: quotation.product,
                pricing: quotation.pricing,
                modelNumber: quotation.modelNumber,
                quantity: revision.quantity,
                moq: revision.moq,
                unitPrice: revision.unitPrice,
              }),
            ],
          }
    );

    console.log(
      `  ${quotation.number}  ${quotation.modelNumber || '(no model)'}  ` +
        `${quotation.quantity} × ₹${quotation.unitPrice}  · ${revisions.length} revision(s)`
    );

    if (confirm) {
      await collection.updateOne(
        { _id: quotation._id },
        {
          $set: { lines, revisions },
          /* The old fields go, so the offer lives in exactly one place from here on. */
          $unset: {
            product: '',
            pricing: '',
            modelNumber: '',
            quantity: '',
            moq: '',
            unitPrice: '',
          },
        }
      );
      written += 1;
    }
  }

  console.log('');
  if (confirm) {
    console.log(`Migrated ${written} quotation(s).${empty ? ` ${empty} left for review.` : ''}`);
  } else {
    console.log(`Dry run — nothing was changed. Re-run with --confirm to migrate ${legacy.length - empty}.`);
  }

  await disconnectDatabase();
}

migrate().catch(async (error) => {
  console.error(error);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
