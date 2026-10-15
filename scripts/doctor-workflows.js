/**
 * Read-only: where the workflow records disagree with each other.
 *
 *   npm run doctor:workflows              # a report, worst first
 *   npm run doctor:workflows -- --json    # the same as JSON, for a ticket
 *
 * Each check is an invariant the department workflows are meant to keep — one open holder per
 * open enquiry, a task for the stage the enquiry shows, the owner's work on the owner's list, a
 * sample gone out finishing its request, goods gone raising the LR copy, money owed being
 * chased, nothing open on a closed enquiry. A finding is not always a bug: an enquiry whose
 * department finished and whose next step nobody has raised is idle, not broken. It is a list
 * for Admin to walk on a Monday, and for a release to be judged by.
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import Customer from '../src/models/Customer.js';
import Dispatch from '../src/models/Dispatch.js';
import Enquiry from '../src/models/Enquiry.js';
import Quotation from '../src/models/Quotation.js';
import Receivable from '../src/models/Receivable.js';
import SalesOrder from '../src/models/SalesOrder.js';
import Sample from '../src/models/Sample.js';
import Todo from '../src/models/Todo.js';
import User from '../src/models/User.js';
import { findHandoff, KIND_FOR_STAGE } from '../src/config/handoffs.js';
import { CLOSED_STAGE, STAGE_KEYS } from '../src/config/enquiryStages.js';
import { STAGE_FOR_MARKETING } from '../src/config/marketingStatuses.js';
import { COLLECTION_KINDS } from '../src/services/collections.service.js';
import { applyPaymentPositions } from '../src/services/paymentPosition.service.js';

const id = (value) => String(value?._id || value || '');
const GONE_SAMPLE = ['dispatched', 'delivered', 'approved', 'rejected', 'modification_required', 'cancelled'];
const SIDE = ['team_payment_followup', 'my_payment_followup', 'ac_clarify', 'audit'];

async function main() {
  await connectDatabase();
  const [enquiries, todos, customers, users, samples, quotations, orders, dispatches, receivables] = await Promise.all([
    Enquiry.find().select('number customer assignedTo status stage heldBy marketingStatus checkedAt').lean(),
    Todo.find({ kind: { $exists: true } }).select('kind department user enquiry customer order holds completed completedAt dueDate status title').lean(),
    Customer.find().select('name assignedTo credit').lean(),
    User.find().select('name role department extraDepartments').lean(),
    Sample.find().select('number enquiry status').lean(),
    Quotation.find().select('number enquiry status').lean(),
    SalesOrder.find().select('number enquiry status').lean(),
    Dispatch.find().select('number order status').lean(),
    Receivable.find().select('number customer order dueBy invoice receipts judgement').lean(),
  ]);
  const E = new Map(enquiries.map((row) => [id(row), row]));
  const C = new Map(customers.map((row) => [id(row), row]));
  const U = new Map(users.map((row) => [id(row), row]));
  const tasksOf = new Map();
  for (const task of todos) {
    if (!task.enquiry) continue;
    const key = id(task.enquiry);
    if (!tasksOf.has(key)) tasksOf.set(key, []);
    tasksOf.get(key).push(task);
  }
  const findings = {};
  const note = (check, what) => { (findings[check] = findings[check] || []).push(what); };
  const departmentsOf = (user) => (user ? [user.department, ...(user.extraDepartments || [])] : []);
  const isAdmin = (user) => user?.role === 'admin' || departmentsOf(user).includes('management');
  const openDepartment = (task) => !task.completed && !task.holds;
  const stageRank = (stage) => STAGE_KEYS.indexOf(stage);

  for (const enquiry of enquiries) {
    const tasks = tasksOf.get(id(enquiry)) || [];
    const holders = tasks.filter((task) => task.holds && !task.completed);
    const closed = enquiry.stage === CLOSED_STAGE;
    if (!closed && !holders.length) note('Open enquiry with no holding task (run migrate-enquiry-holders)', enquiry.number);
    if (holders.length > 1) note('More than one open holding task', `${enquiry.number} ${holders.map((task) => task.kind).join(' + ')}`);
    if (closed && tasks.some(openDepartment)) note('Closed enquiry with department tasks still open', `${enquiry.number}: ${tasks.filter(openDepartment).map((task) => task.kind).join(', ')}`);
    if (closed && holders.length) note('Closed enquiry still held', enquiry.number);
    const stageKind = KIND_FOR_STAGE[enquiry.stage];
    if (!closed && stageKind && enquiry.stage !== 'enquiry' && !SIDE.includes(enquiry.stage)
      && !tasks.some((task) => openDepartment(task) && findHandoff(task.kind)?.stage === enquiry.stage)) {
      note('Idle: the stage shown has no open task — the next step has not been raised', `${enquiry.number} at ${enquiry.stage}`);
    }
    for (const holder of holders) {
      if (holder.user && id(holder.user) !== id(enquiry.assignedTo)) note('Holding task on somebody other than the owner', `${enquiry.number}: ${U.get(id(holder.user))?.name} holds, ${U.get(id(enquiry.assignedTo))?.name} owns`);
    }
    if (enquiry.heldBy && holders[0] && holders[0].department !== enquiry.heldBy) note('heldBy disagrees with the holding task', `${enquiry.number} ${enquiry.heldBy} vs ${holders[0].department}`);
    const buyer = C.get(id(enquiry.customer));
    if (buyer && id(buyer.assignedTo) !== id(enquiry.assignedTo)) note('Enquiry owner is not the buyer’s salesperson', `${enquiry.number}: ${U.get(id(enquiry.assignedTo))?.name} vs ${U.get(id(buyer.assignedTo))?.name} (delegate the customer, or the enquiry)`);
    for (const task of tasks) if (task.customer && enquiry.customer && id(task.customer) !== id(enquiry.customer)) note('Task names a different buyer from its enquiry', `${enquiry.number} ${task.kind}`);
    const counts = {};
    for (const task of tasks.filter(openDepartment)) counts[task.kind] = (counts[task.kind] || 0) + 1;
    for (const [kind, count] of Object.entries(counts)) if (count > 1 && !findHandoff(kind)?.toRaiser) note('Duplicate open tasks of one kind on an enquiry', `${enquiry.number} ${kind} ×${count}`);
    if (!enquiry.checkedAt && enquiry.marketingStatus === 'enquiry_received' && tasks.some(openDepartment)) note('Department work on an enquiry nobody has checked', enquiry.number);
    const stageOfWord = STAGE_FOR_MARKETING[enquiry.marketingStatus];
    if (!closed && stageOfWord && enquiry.stage !== stageOfWord && !SIDE.includes(enquiry.stage)) note('Marketing status and stage disagree', `${enquiry.number} ${enquiry.marketingStatus} vs ${enquiry.stage}`);
    const itsOrders = orders.filter((order) => id(order.enquiry) === id(enquiry));
    if (enquiry.status === 'won' && !itsOrders.length) note('Won with no sales order', enquiry.number);
    if (!['won', 'lost'].includes(enquiry.status) && itsOrders.some((order) => order.status !== 'cancelled')) note('A sales order on an enquiry not marked Won', `${enquiry.number} (${enquiry.status})`);
    if (enquiry.status === 'lost' && !closed) note('Lost but not closed', enquiry.number);
  }
  for (const task of todos) {
    const form = findHandoff(task.kind)?.form;
    if (task.status && form?.statuses?.length && !form.statuses.some((entry) => entry.key === task.status)) note('Task status not in its workflow', `${task.title}: ${task.status}`);
    if (!task.completed && !task.dueDate) note('Open task with no due date', task.title);
    if (task.completed && !task.completedAt) note('Completed task with no completion time', task.title);
    const person = task.user && U.get(id(task.user));
    if (person && !task.completed && !isAdmin(person) && !departmentsOf(person).includes(task.department)) note('Task held by somebody outside its department', `${task.title}: ${person.name} on ${task.department}`);
    if (task.enquiry && !E.has(id(task.enquiry))) note('Task on an enquiry that no longer exists', task.title);
  }
  for (const sample of samples) {
    const enquiry = E.get(id(sample.enquiry));
    if (!enquiry) { note('Sample with no enquiry', sample.number); continue; }
    const open = (tasksOf.get(id(enquiry)) || []).some((task) => task.kind === 'sample_request' && !task.completed);
    if (GONE_SAMPLE.includes(sample.status) && open) note('Sample gone out but its request is still open', `${sample.number} (${sample.status})`);
    if (!GONE_SAMPLE.includes(sample.status) && enquiry.stage === CLOSED_STAGE) note('Open sample on a closed enquiry', sample.number);
  }
  for (const quotation of quotations) {
    const enquiry = E.get(id(quotation.enquiry));
    if (!enquiry) { note('Quotation with no enquiry', quotation.number); continue; }
    const open = (tasksOf.get(id(enquiry)) || []).some((task) => ['create_quotation', 'price_negotiation'].includes(task.kind) && !task.completed);
    if (['sent', 'accepted', 'rejected'].includes(quotation.status) && open) note('Quotation sent but its pricing task is still open', `${quotation.number} (${quotation.status})`);
  }
  for (const order of orders) {
    const enquiry = E.get(id(order.enquiry));
    if (!enquiry) { note('Sales order with no enquiry', order.number); continue; }
    const loads = dispatches.filter((row) => id(row.order) === id(order));
    if (['fully_dispatched', 'payment_pending', 'closed'].includes(order.status) && !loads.length) note('Order dispatched with no consignment', order.number);
    if (['fully_dispatched', 'part_dispatched'].includes(order.status) && stageRank(enquiry.stage) < stageRank('invoice_dispatch') && enquiry.stage !== CLOSED_STAGE) note('Goods gone but the enquiry still reads an earlier stage', `${order.number}: ${enquiry.number} at ${enquiry.stage}`);
    const lr = (tasksOf.get(id(enquiry)) || []).some((task) => task.kind === 'lr_copy');
    if (loads.some((row) => ['dispatched', 'delivered'].includes(row.status)) && !lr && enquiry.stage !== CLOSED_STAGE) note('Consignment left but no LR Copy task was ever raised', `${order.number} on ${enquiry.number}`);
  }
  for (const task of todos.filter((row) => row.kind === 'lr_copy' && !row.completed && row.order)) {
    if (!dispatches.some((row) => id(row.order) === id(task.order))) note('LR Copy task open with no consignment on its order', task.title);
  }
  await applyPaymentPositions(receivables);
  const now = Date.now();
  for (const row of receivables) {
    const balance = row.balance ?? ((row.invoice?.value || 0) - (row.receipts || []).reduce((sum, receipt) => sum + (receipt.amount || 0), 0));
    const overdue = balance > 0 && !row.judgement && new Date(row.dueBy) < now;
    const chased = todos.some((task) => COLLECTION_KINDS.includes(task.kind) && !task.completed
      && (id(task.order) === id(row.order) || (!task.order && !task.enquiry && id(task.customer) === id(row.customer))));
    if (overdue && !chased) note('Overdue and nobody has a collection case on it (the due-date rung opens one on the next sweep)', `${row.number} ${Math.floor((now - new Date(row.dueBy)) / 86400000)} days · ${C.get(id(row.customer))?.name || ''}`);
    if (balance <= 0 && todos.some((task) => ['team_payment_followup', 'prt_recovery'].includes(task.kind) && !task.completed && id(task.order) === id(row.order))) note('Paid in full but a collection case is still open', row.number);
  }
  for (const buyer of customers) {
    const prt = todos.some((task) => task.kind === 'prt_recovery' && !task.completed && id(task.customer) === id(buyer));
    if (prt && buyer.credit?.status !== 'hold' && !buyer.credit?.override) note('With PRT but credit not on hold (the morning sweep derives it)', buyer.name);
  }

  const summary = { checked: { enquiries: enquiries.length, tasks: todos.length, orders: orders.length, consignments: dispatches.length, receivables: receivables.length }, findings };
  if (process.argv.includes('--json')) console.log(JSON.stringify(summary, null, 2));
  else {
    const keys = Object.keys(findings).sort((a, b) => findings[b].length - findings[a].length);
    if (!keys.length) console.log('Nothing to report: every workflow record agrees with the others.');
    for (const key of keys) {
      const list = findings[key];
      console.log(`\n${key} — ${list.length}`);
      for (const line of list.slice(0, 8)) console.log(`  ${line}`);
      if (list.length > 8) console.log(`  … ${list.length - 8} more (--json for all)`);
    }
    console.log(`\nChecked ${enquiries.length} enquiries, ${todos.length} department tasks, ${orders.length} orders, ${dispatches.length} consignments, ${receivables.length} receivables.`);
  }
  await disconnectDatabase();
}

main().catch(async (error) => {
  console.error(error.message);
  await mongoose.connection.close();
  process.exitCode = 1;
});
