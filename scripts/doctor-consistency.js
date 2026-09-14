import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import OperationLock from '../src/models/OperationLock.js';
import Dispatch from '../src/models/Dispatch.js';
import SalesOrder from '../src/models/SalesOrder.js';
import Receivable from '../src/models/Receivable.js';
import { stockFor } from '../src/services/dispatchStock.service.js';
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
async function main() {
  await connectDatabase();
  if (args.includes('--release')) {
    if (!args.includes('--writers-stopped') || !option('--token') || !option('--release')) throw new Error('Release requires --release KEY --token TOKEN --writers-stopped. Stop every API, worker and database writer first.');
    const result = await OperationLock.deleteOne({ _id: option('--release'), token: option('--token') });
    if (!result.deletedCount) throw new Error('No matching lock. Inspect the current report first.');
  }
  const locks = await OperationLock.find().lean(), findings = [];
  for await (const order of SalesOrder.find().cursor()) {
    for (const line of await stockFor(order)) if (line.reserved + line.dispatched > line.readyQty) findings.push({ order: order.number, line: line.modelNumber, issue: 'Stock overclaimed', ready: line.readyQty, claimed: line.reserved + line.dispatched });
  }
  for await (const dispatch of Dispatch.find().cursor()) {
    if (dispatch.orderSyncPending || dispatch.accountingPending) findings.push({ dispatch: dispatch.number, issue: 'Completion pending' });
    if (!dispatch.hasLeft) continue;
    const receivable = await Receivable.findOne({ dispatch: dispatch._id, kind: 'invoice' });
    if (!receivable) findings.push({ dispatch: dispatch.number, issue: 'Missing receivable' });
    else if (receivable.invoice.value !== dispatch.invoice?.value || receivable.invoice.number !== dispatch.invoice?.number || +new Date(receivable.invoice.date) !== +new Date(dispatch.invoice?.date)) findings.push({ dispatch: dispatch.number, issue: 'Invoice mismatch — accounts review required' });
  }
  console.log(JSON.stringify({ locks, findings }, null, 2));
  await disconnectDatabase();
}
main().catch(async error => { console.error(error.message); await mongoose.connection.close(); process.exitCode = 1; });
