/**
 * Fills in the delivery address every consignment should have been raised with.
 *
 * §19 gates despatch on `destination.address`, and until recently nothing could supply one:
 * `createDispatch` claimed to prefill it "from the address the customer master already holds"
 * and the customer register had no address field at all. So every consignment written before
 * that fix is one paperwork item short, and will sit refusing to leave until somebody types an
 * address into it by hand.
 *
 * This does what creation would have done, for the ones where the answer is now knowable.
 *
 * **Only consignments that have not left.** A consignment that is dispatched, delivered or
 * closed has a delivery note and often a POD sitting in a file, and its address is a record of
 * where a lorry actually went. Writing one onto it now would not be a correction — it would be
 * inventing history, and the invented address could disagree with the paperwork. Those are
 * counted and left exactly as they are. This is the same rule the feature itself follows: the
 * address on a consignment is a frozen copy, not a live pointer at the customer.
 *
 * **Only from the customer's own record.** The address is copied off the buyer, which is the
 * one answer that is not a guess. A consignment whose destination was deliberately somewhere
 * else — a buying house's goods going to a garment unit, an exporter's to a CFS — will have had
 * a name or a town typed on it; the copy fills the blank address beside whatever is already
 * there and never overwrites a field that has something in it.
 *
 * **Buyers with no address are listed, not invented.** Nothing can fill an address the plant has
 * never recorded. Those customers are printed with how many consignments are waiting on each, so
 * the list is worth working through longest-queue-first, and the consignment's own page can now
 * take an address directly.
 *
 * **Idempotent.** A consignment that already has an address is skipped, so running it twice is
 * safe and a half-finished run can simply be run again.
 *
 * **Dry run by default.** Prints what it would do and changes nothing. Pass `--confirm` to write.
 *
 *   npm run backfill:addresses            # show me
 *   npm run backfill:addresses -- --confirm
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { GONE_DISPATCH_STATUSES } from '../src/models/Dispatch.js';

const confirm = process.argv.includes('--confirm');

/** Blank, whitespace, or never written. All three mean "no address". */
const blank = (value) => !String(value || '').trim();

async function backfill() {
  await connectDatabase();

  const dispatches = mongoose.connection.collection('dispatches');
  const customers = mongoose.connection.collection('customers');

  const pending = await dispatches
    .find({
      $or: [
        { 'destination.address': { $exists: false } },
        { 'destination.address': null },
        { 'destination.address': '' },
      ],
    })
    .project({ number: 1, status: 1, customer: 1, destination: 1 })
    .toArray();

  if (!pending.length) {
    console.log('Every consignment already carries a delivery address. Nothing to do.');
    await disconnectDatabase();
    return;
  }

  /* Gone is gone: its address is a record of where a lorry went, not a field to fill in now. */
  const stillHere = pending.filter((row) => !GONE_DISPATCH_STATUSES.includes(row.status));
  const alreadyGone = pending.filter((row) => GONE_DISPATCH_STATUSES.includes(row.status));

  const buyers = new Map(
    (
      await customers
        .find({ _id: { $in: [...new Set(stillHere.map((row) => row.customer).filter(Boolean))] } })
        .project({ name: 1, code: 1, address: 1, city: 1, state: 1, pincode: 1 })
        .toArray()
    ).map((customer) => [String(customer._id), customer])
  );

  const fillable = [];
  const stuck = new Map();

  for (const row of stillHere) {
    const buyer = buyers.get(String(row.customer));
    if (buyer && !blank(buyer.address)) {
      fillable.push({ row, buyer });
      continue;
    }
    const key = buyer ? String(buyer._id) : 'unknown';
    if (!stuck.has(key)) stuck.set(key, { buyer, consignments: [] });
    stuck.get(key).consignments.push(row.number);
  }

  console.log(`${pending.length} consignment(s) with no delivery address.\n`);

  if (alreadyGone.length) {
    console.log(
      `${alreadyGone.length} of them have already left and are left alone — their address is a ` +
        'record of where the lorry went, not a blank to fill:'
    );
    for (const row of alreadyGone.slice(0, 10)) console.log(`   ${row.number} · ${row.status}`);
    if (alreadyGone.length > 10) console.log(`   …and ${alreadyGone.length - 10} more`);
    console.log('');
  }

  if (fillable.length) {
    console.log(`${fillable.length} can be filled from the buyer's own record:`);
    for (const { row, buyer } of fillable.slice(0, 15)) {
      console.log(`   ${row.number} · ${buyer.name} → ${buyer.address}`);
    }
    if (fillable.length > 15) console.log(`   …and ${fillable.length - 15} more`);
    console.log('');
  }

  if (stuck.size) {
    const waiting = [...stuck.values()].sort((a, b) => b.consignments.length - a.consignments.length);
    const total = waiting.reduce((sum, entry) => sum + entry.consignments.length, 0);
    console.log(
      `${total} cannot be filled, because ${stuck.size} buyer(s) have no address on record ` +
        '— longest queue first, so the most useful one to fill in is at the top:'
    );
    for (const { buyer, consignments } of waiting) {
      const who = buyer ? `${buyer.name} (${buyer.code})` : 'a customer that no longer exists';
      console.log(`   ${String(consignments.length).padStart(3)} waiting · ${who}`);
      console.log(`        ${consignments.slice(0, 6).join(', ')}${consignments.length > 6 ? ', …' : ''}`);
    }
    console.log(
      '\n   Add an address on each of those customers and run this again, or type one straight ' +
        "onto a consignment from its own page."
    );
    console.log('');
  }

  if (!confirm) {
    console.log('Dry run — nothing was written. Pass --confirm to fill the ones that can be filled.');
    await disconnectDatabase();
    return;
  }

  let written = 0;
  for (const { row, buyer } of fillable) {
    /*
     * Only the blanks. A consignment sent somewhere other than the buyer's own premises will
     * already have a name or a town typed on it, and that is somebody's deliberate answer — the
     * address goes in beside it rather than over it.
     */
    const patch = { 'destination.address': buyer.address };
    if (blank(row.destination?.name)) patch['destination.name'] = buyer.name;
    if (blank(row.destination?.city) && !blank(buyer.city)) patch['destination.city'] = buyer.city;
    if (blank(row.destination?.state) && !blank(buyer.state)) patch['destination.state'] = buyer.state;
    if (blank(row.destination?.pincode) && !blank(buyer.pincode)) {
      patch['destination.pincode'] = buyer.pincode;
    }

    await dispatches.updateOne({ _id: row._id }, { $set: patch });
    written += 1;
  }

  console.log(`Filled ${written} consignment(s) from their buyer's record.`);
  if (stuck.size) {
    console.log(
      `${[...stuck.values()].reduce((sum, e) => sum + e.consignments.length, 0)} still need an ` +
        'address, listed above.'
    );
  }

  await disconnectDatabase();
}

backfill().catch(async (error) => {
  console.error('Backfill failed:', error.message);
  await disconnectDatabase().catch(() => {});
  process.exitCode = 1;
});
