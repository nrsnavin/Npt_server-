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
 * **And it lowers the tool onto the first row**, which is the second job and the urgent one. An
 * enquiry row carries its own `mould` and `isNewDevelopment` now; before, one tool was named on
 * the enquiry and belonged to model one by convention. Every record written under the old rule
 * has a tool up on the enquiry and a first row that does not mention it — and the model takes
 * the list as the truth when somebody edits it, so the first save through the new form would
 * read "row one names no tool" and quietly clear the enquiry's. That is a mould disappearing
 * off a live record for no reason anybody could see, which is why this runs before the deploy
 * rather than after it.
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

/** The tool as it should sit on the first row, where the enquiry has one and the row does not. */
const toolFor = (enquiry) => {
  const row = {
    mould: enquiry.mould,
    isNewDevelopment: enquiry.isNewDevelopment,
  };
  return Object.fromEntries(
    Object.entries(row).filter(([, value]) => value !== undefined && value !== null)
  );
};

/**
 * Puts the enquiry's tool on its first row, for the records written before a row had one.
 *
 * Only where the row is silent about it. A row that already names a tool is a row somebody
 * entered through the new form, and the enquiry's own field follows *it*.
 */
async function lowerTheToolOntoTheFirstRow(enquiries) {
  const behind = await enquiries
    .find({
      'items.0': { $exists: true },
      $and: [
        { $or: [{ 'items.0.mould': { $exists: false } }, { 'items.0.mould': null }] },
        { $or: [{ mould: { $ne: null } }, { isNewDevelopment: true }] },
      ],
    })
    .toArray();

  console.log(`${behind.length} enquiry(ies) name a tool the first row does not.\n`);

  let written = 0;
  for (const enquiry of behind) {
    const tool = toolFor(enquiry);
    if (!Object.keys(tool).length) continue;

    const said = enquiry.mould ? String(enquiry.mould) : 'new development';
    console.log(`  ${enquiry.number}  →  row 1 gets ${said}`);

    if (confirm) {
      await enquiries.updateOne(
        { _id: enquiry._id },
        { $set: Object.fromEntries(Object.entries(tool).map(([key, value]) => [`items.0.${key}`, value])) }
      );
      written += 1;
    }
  }

  return { found: behind.length, written };
}

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

    /* The tool goes on with the rest of it, so a record seeded here does not then need the
       second pass below. */
    const row = { ...rowFrom(enquiry.requirement), ...toolFor(enquiry) };
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

  console.log('');
  const tools = await lowerTheToolOntoTheFirstRow(enquiries);
  if (confirm) {
    console.log(`Put the tool on ${tools.written} first row(s).`);
  } else if (tools.found) {
    console.log(`Dry run — re-run with --confirm to put the tool on ${tools.found} first row(s).`);
  }

  await disconnectDatabase();
}

backfill().catch(async (error) => {
  console.error(error);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
