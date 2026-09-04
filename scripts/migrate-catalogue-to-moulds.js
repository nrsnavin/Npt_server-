/**
 * Folds the product catalogue into the mould register [BLUEPRINT §28].
 *
 * There used to be two masters describing one steel tool. The catalogue held a model code, a
 * name, a size, a category, a hook type, a minimum, a packing quantity — and `mouldAvailable`,
 * a hand-ticked boolean sitting beside the register that already knew the answer. The register
 * held the measured facts and a `products` array pointing back at the catalogue. They agreed
 * only for as long as somebody kept them in step, which is not long.
 *
 * The tool is the thing that exists on the floor, so the tool is the record. This moves what
 * the catalogue knew onto the register and re-points every transaction at it:
 *
 *   Mould                  gains category, sizeMm, hookType, moq, packingQty from its model,
 *                          and loses the `products` array
 *   Enquiry.product     →  Enquiry.mould
 *   Pricing.product     →  (dropped — the sheet already carries `mould`)
 *   Sample.product      →  Sample.mould
 *   Quotation lines     →  lines[].mould, on the document and on every revision
 *
 * **A model with no tool keeps its name and loses its reference**, which is correct rather than
 * lossy: five of the twenty-five models on the plant's own 26-27 sheet are bought in and
 * resold, and a traded piece has no steel of ours to point at. Wherever that happens the
 * record's `modelNumber` is filled in from the catalogue code first, so nothing loses the model
 * it was about — it simply stops claiming a tool it never had.
 *
 * **A model on two tools is not guessed at.** The old register allowed one geometry to carry
 * several catalogue entries and, read backwards, that means a model can name two moulds. There
 * is no right answer to pick — the second tool is usually a newer or differently-cavitied
 * version — so those are reported and left for a person, again with the model number kept.
 *
 * **Idempotent.** A record already carrying `mould` and no `product` is skipped, so a
 * half-finished run can simply be run again.
 *
 * **Dry run by default.** Prints what it would do and changes nothing. Pass `--confirm` to write.
 *
 *   node scripts/migrate-catalogue-to-moulds.js            # show me
 *   node scripts/migrate-catalogue-to-moulds.js --confirm  # do it
 *
 * The `products` collection is left in place either way. Dropping it is a separate decision and
 * an unrecoverable one; once this has run and the screens look right, it can go by hand.
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';

const confirm = process.argv.includes('--confirm');

const id = (value) => (value ? String(value) : null);

async function migrate() {
  await connectDatabase();

  /*
   * Raw collections throughout. Mongoose applies the *new* schema on read, which would drop
   * every legacy field before this code could see it — the migration would report a tidy zero
   * and leave the data exactly as it was.
   */
  const db = mongoose.connection;
  const products = db.collection('products');
  const moulds = db.collection('moulds');
  const enquiries = db.collection('enquiries');
  const pricings = db.collection('pricings');
  const samples = db.collection('samples');
  const quotations = db.collection('quotations');

  const catalogue = new Map();
  for (const product of await products.find({}).toArray()) {
    catalogue.set(id(product._id), product);
  }

  if (!catalogue.size) {
    console.log('\nNo product catalogue found — nothing to fold in.\n');
    return;
  }

  console.log(`\n${confirm ? 'Migrating' : 'Would migrate'} in ${db.name}:\n`);
  console.log(`  ${catalogue.size} catalogue model(s)\n`);

  /* ------------------------- The register takes the model ------------------------- */

  /** product id → the moulds that claim it. More than one is a case nobody should guess at. */
  const toolsFor = new Map();

  for (const mould of await moulds.find({}).toArray()) {
    for (const productId of (mould.products || []).map(id)) {
      if (!toolsFor.has(productId)) toolsFor.set(productId, []);
      toolsFor.get(productId).push(mould);
    }
  }

  let enriched = 0;
  for (const [productId, tools] of toolsFor) {
    const product = catalogue.get(productId);
    if (!product) continue;

    for (const mould of tools) {
      /*
       * Only what the register is missing. A tool that already carries a size is a tool
       * somebody has corrected since, and the catalogue is the older of the two answers.
       *
       * `mould` is the snapshot read before any of this ran, so what has already been filled
       * in on a previous pass of this loop is merged onto it rather than re-read. The old
       * register let one tool carry several models — the same steel in virgin and recycled PP
       * — so a tool can be visited twice here. Without this the second model would overwrite
       * the first's size and minimum with its own and the log would claim both were empty,
       * which is the quiet kind of wrong: the write succeeds and the wrong number sticks.
       */
      const fill = {};
      if (mould.category == null && product.category != null) fill.category = product.category;
      if (mould.sizeMm == null && product.sizeMm != null) fill.sizeMm = product.sizeMm;
      if (mould.hookType == null && product.hookType != null) fill.hookType = product.hookType;
      if (!mould.moq && product.moq) fill.moq = product.moq;
      if (!mould.packingQty && product.packingQty) fill.packingQty = product.packingQty;
      if (mould.developedFromEnquiry == null && product.developedFromEnquiry != null) {
        fill.developedFromEnquiry = product.developedFromEnquiry;
      }

      if (!Object.keys(fill).length) continue;
      Object.assign(mould, fill);

      enriched += 1;
      console.log(
        `  ${mould.mouldCode}  ← ${product.modelCode}  ${Object.keys(fill).join(', ')}`
      );
      if (confirm) await moulds.updateOne({ _id: mould._id }, { $set: fill });
    }
  }

  console.log(`\n  ${enriched} tool(s) ${confirm ? 'took' : 'would take'} fields from their model.`);

  /* ----------------------------- Re-pointing the work ----------------------------- */

  /**
   * The one tool a model is made on, or nothing.
   *
   * Deliberately refuses to choose where there are two. Quietly picking one produces a record
   * that looks entirely correct and points at a tool the job may never run on — which is the
   * kind of error that never announces itself.
   */
  const soleTool = (productId) => {
    const tools = toolsFor.get(productId) || [];
    return tools.length === 1 ? tools[0]._id : null;
  };

  /** What a record should carry instead of its `product`, and why. */
  const resolve = (productId) => {
    const product = catalogue.get(id(productId));
    if (!product) return { mould: null, note: 'model no longer in the catalogue' };

    const tool = soleTool(id(productId));
    if (tool) return { mould: tool, modelCode: product.modelCode };

    const count = (toolsFor.get(id(productId)) || []).length;
    return {
      mould: null,
      modelCode: product.modelCode,
      note: count ? `${count} tools claim it — left for a person` : 'no tool: traded, or not cut',
    };
  };

  const unresolved = [];

  /** Moves one collection's `product` onto `mould`, keeping the model number either way. */
  const repoint = async (collection, label, { keepMould = true } = {}) => {
    const rows = await collection.find({ product: { $ne: null } }).toArray();
    let moved = 0;

    for (const row of rows) {
      const { mould, modelCode, note } = resolve(row.product);

      const set = {};
      if (keepMould && mould) set.mould = mould;
      /* The model keeps its name whatever happens to the reference. */
      if (!row.modelNumber && modelCode) set.modelNumber = modelCode;

      if (note) unresolved.push(`${label} ${row.number || row._id}: ${modelCode || '?'} — ${note}`);

      moved += 1;
      if (confirm) {
        await collection.updateOne(
          { _id: row._id },
          { ...(Object.keys(set).length ? { $set: set } : {}), $unset: { product: '' } }
        );
      }
    }

    console.log(`  ${String(moved).padStart(6)}  ${label}`);
    return moved;
  };

  console.log(`\n${confirm ? 'Re-pointed' : 'Would re-point'}:\n`);
  await repoint(enquiries, 'enquiries');
  await repoint(samples, 'samples');
  /*
   * The costing already has its own `mould`, set when the sheet was raised off a tool. Filling
   * it in from the catalogue now would overwrite a deliberate answer with a derived one, so
   * this only drops the dead reference.
   */
  await repoint(pricings, 'costings (reference dropped only)', { keepMould: false });

  /* ------------------------------ Quotation lines ------------------------------ */

  const quoted = await quotations.find({ 'lines.product': { $ne: null } }).toArray();
  let lineCount = 0;

  for (const quotation of quoted) {
    const move = (lines = []) =>
      lines.map((line) => {
        if (!line.product) return line;
        const { mould, modelCode, note } = resolve(line.product);
        lineCount += 1;
        if (note) {
          unresolved.push(`quotation ${quotation.number}: ${modelCode || '?'} — ${note}`);
        }
        const { product: dropped, ...rest } = line;
        return {
          ...rest,
          ...(mould ? { mould } : {}),
          modelNumber: line.modelNumber || modelCode,
        };
      });

    if (confirm) {
      await quotations.updateOne(
        { _id: quotation._id },
        {
          $set: {
            lines: move(quotation.lines),
            revisions: (quotation.revisions || []).map((revision) => ({
              ...revision,
              lines: move(revision.lines),
            })),
          },
        }
      );
    }
  }

  console.log(`  ${String(lineCount).padStart(6)}  quotation lines`);

  /* ------------------------ The register's back-reference ------------------------ */

  const withProducts = await moulds.countDocuments({ products: { $exists: true } });
  console.log(`\n  ${withProducts} tool(s) ${confirm ? 'lost' : 'would lose'} the products array.`);
  if (confirm && withProducts) {
    await moulds.updateMany({ products: { $exists: true } }, { $unset: { products: '' } });
  }

  /* --------------------------------- What is left --------------------------------- */

  if (unresolved.length) {
    console.log(`\n${unresolved.length} record(s) kept their model number and no tool:\n`);
    for (const line of unresolved.slice(0, 40)) console.log(`  ${line}`);
    if (unresolved.length > 40) console.log(`  … and ${unresolved.length - 40} more`);
    console.log(
      '\nThat is the expected answer for anything bought in and resold. Attach a tool by hand\n' +
        'where one exists — the model number on each record says which.'
    );
  }

  if (!confirm) {
    console.log('\nThis was a dry run — nothing has changed.');
    console.log('Re-run with --confirm to actually migrate it.\n');
  } else {
    console.log('\nDone. The `products` collection is untouched — drop it by hand once the');
    console.log('screens look right.\n');
  }
}

migrate()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(disconnectDatabase);
