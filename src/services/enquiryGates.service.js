import Todo from '../models/Todo.js';
import SalesOrder from '../models/SalesOrder.js';
import Inspection from '../models/Inspection.js';
import { stockFor } from './dispatchStock.service.js';

/**
 * The two places an enquiry may not simply move on [workflow plan, phase 1].
 *
 *   Quality before Dispatch   Invoice & Dispatch is refused until Quality has passed the job.
 *   Dispatch keeps the balance  Dispatch cannot hand the enquiry on while one of its sales
 *                               orders still has pieces to send.
 *
 * Both are answered from the enquiry's own records, so a refusal can say exactly what is missing.
 */

/** The holding tasks that make the goods — Quality has to look again after any of them. */
const MAKING = ['ask_edd', 'ask_assembling_edd', 'mould_issue'];

const passed = (value) => /^pass/i.test(String(value || '').trim());

/** The open (not closed, not cancelled) sales orders raised on this enquiry. */
const openOrders = (enquiryId) =>
  SalesOrder.find({ enquiry: enquiryId, status: { $nin: ['closed', 'cancelled'] } });

/**
 * Whether Quality has passed the job since it was last made.
 *
 * Passed by the Quality Check task being closed right now (`closing` + its `fields`), by an
 * earlier Quality Check marked Passed after the last production task, or by a final or
 * pre-dispatch inspection in the Quality module on one of the enquiry's orders.
 */
export async function qualityPassed(enquiryId, { closing, fields } = {}) {
  if (closing?.kind === 'quality_check' && passed(fields?.result)) return true;

  const [check, made] = await Promise.all([
    Todo.findOne({ enquiry: enquiryId, kind: 'quality_check', completed: true }).sort({ completedAt: -1 }).lean(),
    Todo.findOne({ enquiry: enquiryId, kind: { $in: MAKING } }).sort({ createdAt: -1 }).lean(),
  ]);
  const checkPassed = check && passed(check.outcome?.fields?.result);
  if (checkPassed && (!made || check.completedAt > made.createdAt)) return true;

  const orders = await SalesOrder.find({ enquiry: enquiryId }).select('_id').lean();
  if (!orders.length) return false;
  return Boolean(await Inspection.exists({
    order: { $in: orders.map((order) => order._id) },
    stage: { $in: ['final', 'pre_dispatch'] },
    verdict: { $in: ['passed', 'passed_with_deviation'] },
  }));
}

/**
 * What is still to be sent on the enquiry's open orders: `[{ number, pieces }]`, empty when
 * everything has gone. A line the plant called finished and shipped in full counts as sent
 * (`stockOf.fullyShipped`), so the ±5% a quotation allows never leaves a balance for ever.
 */
export async function dispatchBalance(enquiryId) {
  const orders = await openOrders(enquiryId);
  const left = [];
  for (const order of orders) {
    const stock = await stockFor(order);
    const pieces = stock
      .filter((line) => !line.fullyShipped)
      .reduce((sum, line) => sum + Math.max(0, (line.quantity || 0) - (line.dispatched || 0)), 0);
    if (pieces > 0) left.push({ number: order.number, pieces });
  }
  return left;
}

export const describeBalance = (left) =>
  left.map((row) => `${row.number} has ${row.pieces.toLocaleString('en-IN')} pcs`).join(', ');
