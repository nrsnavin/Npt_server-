/**
 * Gives every enquiry already on the system the list it now answers with.
 *
 * An enquiry carries `items` as well as `requirement`, and the two are one fact: the first row
 * and the requirement are the same thing, kept in step by the model. New records get both
 * because the model seeds whichever is missing on save — but it only does that *on save*, and
 * the enquiries already in the database are not going to be saved just because a field arrived.
 *
 * So until this runs, an old enquiry answers `items: []` while its requirement says NPT-400S,
 * and a screen that reads the list shows an enquiry about nothing. That is the whole job here:
 * copy the requirement into the first row, once, for the records written before the field
 * existed.
 *
 * **It never touches an enquiry that already has a row.** A record somebody has since edited
 * has the list it should have, and overwriting it from `requirement` would undo a re-ordering —
 * the first row is whichever the person put first, and the requirement follows *it*, not the
 * other way round.
 *
 * Idempotent, so a half-finished run is simply run again. Dry run by default.
 *
 *   node scripts/backfill-enquiry-items.js            # show me
 *   node scripts/backfill-enquiry-items.js --confirm  # do it
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { hasRequirement } from '../src/models/requirement.schema.js';

const confirm = process.argv.includes('--confirm');

/** The fields a row carries. Named rather than spread, so a `_id` cannot travel with them. */
const rowFrom = (requirement = {}) => {
  const row = {
    modelNumber: requirement.modelNumber,
    category: requirement.category,
    sizeMm: requirement.sizeMm,
    materialRef: requirement.materialRef,
    hookRef: requirement.hookRef,
    clipRef: requirement.clipRef,
    printRef: requirement.printRef,
    material: requirement.material,
    colour: requirement.colour,
    colourMandatory: requirement.colourMandatory,
    printing: requirement.printing,
    packing: requirement.packing,
    quantity: requirement.quantity,
  };

  /* Undefined keys would be stored as nulls and read back as "somebody cleared this". */
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
};

async function backfill() {
  await connectDatabase();
  const enquiries = mongoose.connection.collection('enquiries');

  /* Written straight through the collection rather than through the model: this is a copy of
     what is already stored, and running it through validation would refuse the older records
     that predate a rule and change nothing about the copy. */
  const behind = await enquiries
    .find({ $or: [{ items: { $exists: false } }, { items: { $size: 0 } }] })
    .toArray();

  console.log(`${behind.length} enquiry(ies) have no list yet.\n`);

  let written = 0;
  let skipped = 0;

  for (const enquiry of behind) {
    if (!hasRequirement(enquiry.requirement)) {
      /* Nothing to copy. Left alone rather than given an empty row, which would read as an
         item somebody entered and left blank. */
      skipped += 1;
      continue;
    }

    const row = rowFrom(enquiry.requirement);
    console.log(`  ${enquiry.number}  →  ${row.modelNumber || '(no model)'}${row.colour ? `, ${row.colour}` : ''}`);

    if (confirm) {
      await enquiries.updateOne({ _id: enquiry._id }, { $set: { items: [row] } });
      written += 1;
    }
  }

  console.log('');
  if (skipped) console.log(`${skipped} had nothing in their requirement to copy.`);

  if (confirm) {
    console.log(`Gave ${written} enquiry(ies) their first row.`);
  } else {
    console.log(`Dry run — nothing was changed. Re-run with --confirm to fill ${behind.length - skipped}.`);
  }

  await disconnectDatabase();
}

backfill().catch(async (error) => {
  console.error(error);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
