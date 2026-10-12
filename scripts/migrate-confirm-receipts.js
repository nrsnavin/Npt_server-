/**
 * Marks every receipt recorded before receipts needed Accounts' confirmation as confirmed.
 *
 * A receipt now carries `confirmed: { by, at }` [models/Receivable.js]: a collector's or PRT
 * member's receipt stops the chase, but the payment gates (the advance before production, the
 * money before dispatch) open only on what Accounts has confirmed. Receipts written before that
 * field existed were all Accounts' own — the only people who could record one — so they are
 * confirmed as of when they were recorded. Without this, every order already paid for would
 * refuse its next step the morning after the deploy.
 *
 * Idempotent: a receipt with `confirmed.at` is left alone. Dry run by default.
 *
 *   node scripts/migrate-confirm-receipts.js             # show me
 *   node scripts/migrate-confirm-receipts.js --confirm   # do it
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';

const confirm = process.argv.includes('--confirm');

async function migrate() {
  await connectDatabase();
  const receivables = mongoose.connection.collection('receivables');
  const rows = await receivables.find({ 'receipts.0': { $exists: true } }).toArray();

  let receipts = 0;
  let written = 0;
  for (const row of rows) {
    const pending = (row.receipts || []).filter((receipt) => !receipt.confirmed?.at);
    if (!pending.length) continue;
    receipts += pending.length;
    console.log(`  ${row.number}  ${pending.length} receipt(s) to confirm as of when recorded`);
    if (!confirm) continue;
    const updated = (row.receipts || []).map((receipt) => (receipt.confirmed?.at
      ? receipt
      : { ...receipt, confirmed: { by: receipt.recordedBy, at: receipt.createdAt || receipt.receivedAt || new Date() } }));
    await receivables.updateOne({ _id: row._id }, { $set: { receipts: updated } });
    written += 1;
  }

  console.log('');
  if (!receipts) console.log('Every receipt is already confirmed — nothing to do.');
  else if (confirm) console.log(`Confirmed ${receipts} receipt(s) on ${written} receivable(s).`);
  else console.log(`Dry run — nothing was changed. Re-run with --confirm to confirm ${receipts} receipt(s).`);

  await disconnectDatabase();
}

migrate().catch(async (error) => {
  console.error(error);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
