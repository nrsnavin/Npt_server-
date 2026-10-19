/**
 * Links every receivable (RCV) to the enquiry its order came from [models/Receivable.js
 * `enquiry`], so an advance or an invoice raised before the link existed shows on its enquiry.
 *
 * Only from the order's own enquiry — an order with none leaves its RCV as it is. Idempotent: an
 * RCV already linked is skipped. Dry run by default; pass `--confirm` to write.
 *
 *   node scripts/backfill-receivable-enquiries.js            # show me
 *   node scripts/backfill-receivable-enquiries.js --confirm
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';

const confirm = process.argv.includes('--confirm');

async function backfill() {
  await connectDatabase();
  const receivables = mongoose.connection.collection('receivables');
  const orders = mongoose.connection.collection('salesorders');
  const unlinked = await receivables.find({ enquiry: { $exists: false } }, { projection: { number: 1, order: 1 } }).toArray();
  const enquiryOf = new Map((await orders.find({ _id: { $in: [...new Set(unlinked.map((row) => String(row.order)))].map((id) => new mongoose.Types.ObjectId(id)) }, enquiry: { $exists: true } }, { projection: { enquiry: 1 } }).toArray())
    .map((order) => [String(order._id), order.enquiry]));
  let linked = 0;
  for (const row of unlinked) {
    const enquiry = enquiryOf.get(String(row.order));
    if (!enquiry) continue;
    linked += 1;
    if (confirm) await receivables.updateOne({ _id: row._id, enquiry: { $exists: false } }, { $set: { enquiry } });
  }
  console.log(`${unlinked.length} receivable(s) without an enquiry; ${linked} ${confirm ? 'linked' : 'would be linked'} through their order; ${unlinked.length - linked} have an order with no enquiry.`);
  await disconnectDatabase();
}

backfill().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await disconnectDatabase().catch(() => {});
});
