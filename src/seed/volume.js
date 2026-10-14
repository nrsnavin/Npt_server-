/**
 * A plant's worth of enquiries: a hundred of them, from drafts waiting to be checked to lots
 * delivered and the money chased — every stage, every department's queue, with the samples,
 * quotations, sales orders, consignments and receivables the stages imply.
 *
 *   npm run seed:demo            # includes this (the full set)
 *   npm run seed:volume          # adds the hundred to a database already seeded, keeping everything there
 *
 * On the buyers already on the customer master and the models already on the mould register and
 * trading master — nothing is invented: a demo database gets them on its seeded buyers, a working
 * one on its own. Driven through the app's own services rather than written as records — `moveEnquiry` raises
 * each department's task the way the enquiry screen does, `setTaskStatus` walks it through that
 * department's own statuses, a sample request opens a sample, a quotation request a costing —
 * so what a dashboard shows here is what it shows on a working Tuesday, not a tableau. A step
 * the app refuses (a payment gate, a form that wants an answer) is skipped and said so at the
 * end, never forced.
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import BuyerCard from '../models/BuyerCard.js';
import Customer from '../models/Customer.js';
import Dispatch from '../models/Dispatch.js';
import Enquiry from '../models/Enquiry.js';
import Mould from '../models/Mould.js';
import Quotation from '../models/Quotation.js';
import Receivable from '../models/Receivable.js';
import SalesOrder, { VERIFICATION_KEYS } from '../models/SalesOrder.js';
import Sample from '../models/Sample.js';
import Todo from '../models/Todo.js';
import TradedItem from '../models/TradedItem.js';
import User from '../models/User.js';
import { findHandoff } from '../config/handoffs.js';
import { nextNumber } from '../services/numbering.service.js';
import { put } from '../services/storage.service.js';
import {
  ensureHolder, finishQuotationTasks, finishSampleTasks, moveEnquiry, sendHandoff, setTaskStatus, taskPrefill,
} from '../services/handoff.service.js';
import { answersFor } from './departmentTasks.js';

const DAY = 86400000;
const days = (offset, hour = 11) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  date.setHours(hour, 0, 0, 0);
  return date;
};
const iso = (date) => date.toISOString().slice(0, 10);
const pick = (list, n) => list[n % list.length];

const COLOURS = ['White', 'Black', 'Ivory', 'Navy', 'Charcoal', 'Beige', 'Grey', 'Natural', 'Transparent', 'Maroon'];
const QUANTITIES = [2000, 5000, 8000, 10000, 12000, 15000, 20000, 25000, 30000, 50000];
const PRICES = [4.2, 4.9, 5.6, 6.3, 7.4, 8.4, 9.8, 11.8, 14.5, 19.5];
const SOURCES = ['phone', 'whatsapp', 'email', 'referral', 'trade_show', 'walk_in', 'indiamart'];

/* ------------------------------------ The hundred ------------------------------------ */

/**
 * One row per enquiry: where it is, and how it got there. Each walk is a list of statuses the
 * department's own task moves through — the keys from config/departmentTaskForms.js — with a
 * date where the status asks one. The stage column is what the funnel shows for it.
 */
const PLAN = [
  /* 1 Enquiry — half of them read off a chat and not checked yet. */
  ...Array.from({ length: 10 }, (_, i) => ({ stage: 'enquiry', unchecked: i % 2 === 0 })),
  /* 2 Sample — on the bench at every point of a request's life. */
  ...['checking_stock', 'production_required', 'printing_required', 'sample_available', 'sample_ready', 'sample_ready', 'dispatched', 'dispatched', 'delivered', 'approved']
    .map((sample) => ({ stage: 'sample', kind: 'sample_request', sample })),
  /* 3 Pricing — costing, up for approval, sent, and two the buyer is arguing. */
  ...[['received'], ['costing'], ['costing'], ['approval'], ['approval'], ['sent'], ['sent'], ['sent']]
    .map((walk) => ({ stage: 'pricing_quote', kind: 'create_quotation', walk })),
  { stage: 'pricing_quote', kind: 'price_negotiation', walk: ['received'] },
  { stage: 'pricing_quote', kind: 'price_negotiation', walk: ['costing'] },
  /* 4 PO & SO — waiting, being prepared, and one Order Confirmation sent back with a question. */
  ...[['waiting'], ['waiting'], ['preparing'], ['preparing'], ['preparing'], ['clarification'], ['waiting'], ['preparing']]
    .map((walk) => ({ stage: 'po_so', kind: 'po_so', walk })),
  /* 5 Production — every status on the floor, two of them with an advance already in. */
  ...[['received'], ['accepted'], ['planning'], ['ready_on_date'], ['started'], ['started'], ['raw_material'], ['machine_not_allotted'], ['completed'], ['ready_dispatch']]
    .map((walk, i) => ({ stage: 'production_edd', kind: 'ask_edd', walk, order: 'production_running', advance: i < 2 })),
  /* 6 Mould — a tool under development, under rework, and one just declared ready. */
  ...[['development'], ['development_edr'], ['rework'], ['rework_edr'], ['mould_ready']]
    .map((walk) => ({ stage: 'mould', kind: 'mould_issue', walk, order: 'production_running' })),
  /* 5A Assembly. */
  ...[['asked'], ['started'], ['spares_ready'], ['part_ready'], ['full_ready']]
    .map((walk) => ({ stage: 'assembling', kind: 'ask_assembling_edd', walk, order: 'production_running' })),
  /* 8 Invoice & Dispatch — waiting for a vehicle, the party collecting, part gone, all gone. */
  ...[['received'], ['waiting_vehicle'], ['waiting_vehicle'], ['party_collect'], ['not_ready'], ['part_dispatched'], ['dispatched']]
    .map((walk) => ({ stage: 'invoice_dispatch', kind: 'invoice_dispatch', walk, order: 'production_completed', consignment: walk[0].includes('dispatched') }))
  ,
  /* 9 LR Copy — Reception waiting for the docket, sending it, the lot on the road, delivered. */
  ...[['awaiting'], ['awaiting'], ['sent'], ['in_transit'], ['delivered'], ['delivered']]
    .map((walk) => ({ stage: 'lr_copy', kind: 'lr_copy', walk, order: 'fully_dispatched', consignment: true })),
  /* 10 Quality — three routine checks and two complaints. */
  ...[['quality_check', 0], ['quality_check', 1], ['quality_check', 2], ['quality_issue', 1], ['quality_issue', 2]]
    .map(([kind, step]) => ({ stage: 'quality', kind, step, order: 'production_completed', brief: kind === 'quality_issue' ? { problem: 'Hooks pulling out under load in the buyer’s store' } : undefined })),
  /* 11A Audit. */
  ...[['received'], ['checking'], ['correction'], ['corrected']]
    .map((walk) => ({ stage: 'audit', kind: 'gst_invoice_audit', walk, order: 'fully_dispatched', consignment: true })),
  /* 11 A/C Clarify. */
  ...[['approval_required'], ['confirmation_pending'], ['statement_required'], ['hold']]
    .map((walk) => ({ stage: 'ac_clarify', kind: 'ac_clarify', walk, order: 'fully_dispatched', consignment: true })),
  /* 7 Team Payment Follow-up — Payment Collection on overdue invoices. */
  ...[['assigned'], ['contacted'], ['promised'], ['not_reachable'], ['promise_broken']]
    .map((walk) => ({ stage: 'team_payment_followup', kind: 'team_payment_followup', walk, order: 'fully_dispatched', consignment: true, owed: true })),
  /* PRT — the field team on balances nobody could collect by phone. */
  ...[['assigned'], ['visit_planned'], ['visited'], ['promised']]
    .map((walk) => ({ stage: 'team_payment_followup', kind: 'prt_recovery', walk, order: 'fully_dispatched', consignment: true, owed: true, prt: true })),
  /* 12 My Payment Follow-up — the salesperson chasing their own buyer. */
  ...Array.from({ length: 3 }, () => ({ stage: 'my_payment_followup', kind: 'my_payment_followup', walk: [], order: 'fully_dispatched', consignment: true, owed: true })),
  /* Closed — delivered and paid, lost on price, lost on lead time, on hold. */
  { stage: 'closed', closed: 'won', order: 'closed', consignment: true },
  { stage: 'closed', closed: 'won', order: 'closed', consignment: true },
  { stage: 'closed', closed: 'lost', lostReason: 'price' },
  { stage: 'closed', closed: 'lost', lostReason: 'lead_time' },
];

/* -------------------------------------- Helpers -------------------------------------- */

const verifiedBy = (user, when) => Object.fromEntries(VERIFICATION_KEYS.map((key) => [key, { by: user._id, at: when }]));

/** A one-pixel PNG, so a draft has a picture behind it the screen can open. */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

/** What each department writes when it moves a task along. */
const REMARKS = {
  plant: ['Spoke to the floor — on track', 'Material arrived this morning', 'Machine 3 allotted from tomorrow', 'Checked and noted'],
  production: ['Material arrived this morning', 'Machine 3 allotted from tomorrow', 'Running two shifts on it', 'Short of 2,000 pcs — rest by Friday'],
  mould: ['Cavity 2 polished, trial shot tomorrow', 'Hook boss rebuilt — awaiting hardening', 'Trial shot fine; cleared for the lot', 'EDR moved: insert came late'],
  assembling: ['Clips arrived, started on the line', 'Half the lot assembled and packed', 'Spares ready, waiting on cartons', 'Full quantity packed'],
  despatch: ['Lorry booked for the evening', 'Party’s vehicle expected at 4 PM', 'Half the lot gone on VRL; rest tomorrow', 'Invoice cut, e-way bill done'],
  reception: ['LR copy asked from the transporter', 'LR sent to the buyer on WhatsApp', 'Tracked — out for delivery', 'Buyer confirmed delivery'],
  quality: ['Lot pulled for inspection', 'Hook pull test passed on 32 pcs', 'Two cartons repacked — flash on the face', 'Checked and noted'],
  audit: ['Invoice pulled for checking', 'GST rate confirmed at 18%', 'HSN corrected on the invoice', 'Corrected copy sent to Accounts'],
  accounts: ['Statement requested from the buyer', 'Waiting on the bank advice', 'Receipt matched to the second invoice', 'On hold till the buyer clarifies'],
  payment_collection: ['Spoke to their accounts — promised by Friday', 'Called twice, no answer on either number', 'Says the cheque is signed and in the post', 'Promised date passed — nothing received'],
  payment_recovery: ['Visit fixed with the buyer for Thursday', 'Visited — owner was away, spoke to accounts', 'Collected part in cash on the visit', 'Promised the balance on the next visit'],
  order_confirmation: ['PO checked against the quotation', 'Preparing the SO — rate matches', 'Which colour for the second line?', 'SO sent for release'],
  quotation: ['Costing from the register — resin at today’s rate', 'Costed at ₹7.40; sent up for approval', 'Approved and sent to the buyer', 'Buyer asking for ₹0.30 less'],
  sampling: ['Checking the bench stock', 'Making six pieces on the tool', 'Samples packed for courier', 'Sent by Blue Dart'],
};

/** The statuses of a department's task, as the form lists them. */
const statusesOf = (kind) => findHandoff(kind)?.form?.statuses || [];

export async function seedVolume({ byEmail, log = console.log }) {
  const admin = byEmail['rsnavin1@gmail.com'];
  /* The salespeople: whoever holds the buyers; the demo accounts only when nobody does. */
  const sellers = ['marketing@npthangers.com', 'marketing2@npthangers.com', 'marketing3@npthangers.com']
    .map((email) => byEmail[email]).filter(Boolean);
  const who = (department) => Object.values(byEmail).find((user) => user.department === department || user.extraDepartments?.includes(department)) || admin;
  const people = {
    sampling: who('sampling'), quotation: who('quotation'), orders: who('order_confirmation'), production: who('production'),
    mould: who('mould'), assembling: who('assembling'), despatch: who('despatch'), reception: who('reception'),
    quality: who('quality'), audit: who('audit'), accounts: who('accounts'), collections: who('payment_collection'),
    recovery: who('payment_recovery'),
  };

  const moulds = await Mould.find({ isActive: { $ne: false } }).sort({ mouldCode: 1 }).lean();
  const traded = await TradedItem.find({ isActive: { $ne: false } }).limit(6).lean();
  if (!moulds.length) throw new Error('Seed the mould register first — an enquiry names a tool');

  /* The buyers already on the master, and whoever on the marketing team holds them. */
  const customers = await Customer.find({ status: { $ne: 'blacklisted' } }).sort({ createdAt: 1 });
  if (!customers.length) throw new Error('No customers on the master — add the buyers first; the enquiries are raised on them');
  const owners = new Map();
  for (const customer of customers) {
    const owner = Object.values(byEmail).find((user) => String(user._id) === String(customer.assignedTo));
    if (owner && !owners.has(String(owner._id))) owners.set(String(owner._id), owner);
  }
  if (owners.size) sellers.splice(0, sellers.length, ...owners.values());
  if (!sellers.length) sellers.push(admin);

  const made = { customers: customers.length, drafts: 0, enquiries: 0, tasks: 0, samples: 0, quotations: 0, orders: 0, consignments: 0, receivables: 0 };
  const stages = {};
  const skipped = [];
  let turn = 0;

  /* ------------------------------------ Drafts ------------------------------------ */

  const DRAFTS = [
    ['chat', 'ready', 'Sri Murugan Garments', 'Senthil', '9840011223', 'ncp 25 black 5000 pcs, and the velvet suit one'],
    ['card', 'ready', 'Kavin Garments', 'R. Kavin', '9843000111', 'Visiting card from the Tiruppur fair'],
    ['chat', 'ready', 'Nalli Fabrics', 'Priya', '9840022334', 'Need 400mm shirt hangers, white, 10k'],
    ['card', 'ready', 'Zyra Apparels', 'Mohan', '9840033445', ''],
    ['other', 'unreadable', '', '', '', 'Blurry photo of a hanger'],
    ['chat', 'unreadable', '', '', '', 'Screenshot cut off before the name'],
  ];
  for (const [index, [kind, status, company, contactName, mobile, notes]] of DRAFTS.entries()) {
    const sender = pick(sellers, index);
    const imageKey = await put({ buffer: PIXEL, mimeType: 'image/png' });
    const matched = company ? await Customer.findOne({ name: company }).select('_id') : null;
    const models = kind === 'chat' && company
      ? [{ asked: 'ncp 25', quantity: 5000, colour: 'Black', code: moulds[0].mouldCode, mould: moulds[0]._id, matchedBy: 'code' }, { asked: 'the velvet suit one' }]
      : undefined;
    await BuyerCard.create({
      sender: sender._id, via: index % 2 ? 'upload' : 'whatsapp', from: index % 2 ? undefined : `+91${sender.phone || '9876500002'}`,
      imageKey, mimeType: 'image/png', kind, status, readBy: status === 'ready' ? 'model' : 'none',
      caption: notes || undefined,
      reading: status === 'ready' ? { company, contactName, mobile, city: 'Tiruppur', state: 'Tamil Nadu', productInterest: notes || undefined, models } : {},
      problem: status === 'unreadable' ? 'The picture could not be read — fill the details in from the photo.' : undefined,
      matchedCustomer: matched?._id,
      createdAt: days(-index, 9 + index),
    });
    made.drafts += 1;
  }

  /* ----------------------------------- Enquiries ----------------------------------- */

  /** An enquiry as marketing raised it: a buyer, one to three models, a date it came in. */
  async function raise(row, n) {
    /* Round the buyers, so the work spreads over them; the enquiry is its buyer's salesperson's. */
    const customer = pick(customers, n);
    const owner = owners.get(String(customer.assignedTo)) || pick(sellers, n);
    const ago = 2 + (n * 7) % 85;
    const lines = 1 + (n % 3 === 0 ? 2 : n % 2);
    /* The models: a tool off the mould register, or every seventh line a bought-in item off the trading master. */
    const items = Array.from({ length: lines }, (_, i) => {
      const useTraded = traded.length && (n + i) % 7 === 3;
      const mould = useTraded ? null : pick(moulds, n + i);
      return {
        ...(mould ? { mould: mould._id, modelNumber: mould.mouldCode, category: mould.category, sizeMm: mould.sizeMm } : {}),
        ...(useTraded ? { modelNumber: traded[(n + i) % traded.length].modelNumber } : {}),
        material: 'plastic',
        colour: pick(COLOURS, n + i),
        quantity: pick(QUANTITIES, n + i),
        packing: `${pick([100, 200, 250], n)} pcs per carton`,
      };
    });
    const value = items.reduce((sum, item) => sum + item.quantity * pick(PRICES, n), 0);
    const closed = row.closed;
    const status = closed === 'lost' ? 'lost' : closed === 'won' || row.order ? 'won' : row.stage === 'sample' ? 'sample_required' : row.stage === 'pricing_quote' ? 'pricing_required' : row.stage === 'po_so' ? 'po_expected' : 'new';
    const enquiry = await Enquiry.create({
      number: await nextNumber('ENQ'),
      customer: customer._id,
      assignedTo: owner._id,
      items,
      targetPrice: Math.round((pick(PRICES, n) - 0.3) * 100) / 100,
      requiredDeliveryDate: days(ago < 30 ? 30 : 10),
      status,
      ...(closed === 'lost' ? { lostReason: row.lostReason, lostNote: row.lostReason === 'price' ? 'A local moulder quoted ₹0.40 under us.' : 'Wanted the lot in ten days; the tool was on another job.' } : {}),
      nextAction: row.stage === 'enquiry' ? pick(['Call back with the rate card', 'Send photos of the 400mm range', 'Visit the unit next week'], n) : undefined,
      nextActionType: row.stage === 'enquiry' ? pick(['call', 'whatsapp', 'visit'], n) : undefined,
      nextFollowUpDate: days((n % 5) - 2, 15),
      estimatedValue: Math.round(value),
      probability: row.order ? 100 : closed === 'lost' ? 0 : 25 + (n % 4) * 15,
      enquiryDate: days(-ago),
      source: pick(SOURCES, n),
      remarks: row.unchecked ? 'From a WhatsApp chat screenshot — check the details before raising work on it.' : undefined,
      checkedAt: row.unchecked ? undefined : days(-ago, 12),
      checkedBy: row.unchecked ? undefined : owner._id,
      statusHistory: [{ to: 'new', at: days(-ago), by: owner._id }, ...(status !== 'new' ? [{ from: 'new', to: status, at: days(-ago + 1), by: owner._id }] : [])],
    });
    await Enquiry.updateOne({ _id: enquiry._id }, { $set: { createdAt: days(-ago) } }, { timestamps: false });
    await ensureHolder(enquiry, { user: owner });
    return { enquiry, owner, customer, items, n, ago };
  }

  /** The sales order behind an enquiry that was won, with the plant's progress on each line. */
  async function book({ enquiry, owner, customer, items, n, ago }, status, { advance = false } = {}) {
    const when = days(-Math.max(1, ago - 3), 10);
    const order = await SalesOrder.create({
      number: await nextNumber('SO'),
      orderDate: when,
      customer: customer._id,
      enquiry: enquiry._id,
      assignedTo: owner._id,
      customerPo: { number: `PO/${enquiry.number.slice(-4)}/${customer.code.slice(-4)}`, date: when },
      lines: items.map((item, i) => ({
        mould: item.mould,
        modelNumber: item.modelNumber,
        colour: item.colour,
        quantity: item.quantity,
        unitPrice: pick(PRICES, n + i),
        deliveryDate: days(ago > 40 ? -5 : 12),
        production: {
          status: status === 'production_running' ? 'running' : 'completed',
          plannedQty: item.quantity,
          producedQty: status === 'production_running' ? Math.round(item.quantity * 0.4) : item.quantity,
          readyQty: status === 'production_running' ? Math.round(item.quantity * 0.3) : item.quantity,
          readyAt: status === 'production_running' ? undefined : days(-4, 11),
        },
      })),
      gstPercent: 18,
      paymentTerms: advance ? '50% advance, 50% before dispatch' : customer.paymentTerms || '30 days from invoice',
      paymentPlan: advance ? { advancePercent: 50, beforeDispatchPercent: 100 } : { advancePercent: 0, beforeDispatchPercent: 0 },
      verification: verifiedBy(people.orders, when),
      releasedBy: people.orders._id,
      releasedAt: when,
      status,
      statusHistory: [
        { to: 'po_received', at: when, by: people.orders._id },
        { to: 'approved_for_production', at: when, by: people.orders._id, note: 'All eight checks passed' },
        { to: status, at: days(-Math.max(1, ago - 5), 9), by: people.production._id },
      ],
    });
    made.orders += 1;
    if (advance) {
      /* The advance, in and confirmed by Accounts — what lets Production start. */
      const value = order.totalValue || order.lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
      await Receivable.create({
        number: await nextNumber('RCV'), kind: 'advance', customer: customer._id, order: order._id, assignedTo: owner._id,
        invoice: { value: Math.round(value), date: when }, dueBy: when,
        receipts: [{ amount: Math.round(value / 2), receivedAt: when, mode: 'neft', reference: `NEFT${100000 + n}`, recordedBy: people.accounts._id, confirmed: { by: people.accounts._id, at: when } }],
      });
      made.receivables += 1;
    }
    return order;
  }

  /** What left the yard against the order, invoiced — and, when asked, what the buyer still owes. */
  async function load(order, { enquiry, owner, customer, n, ago }, { owed = false, delivered = false } = {}) {
    const line = order.lines[0];
    const left = days(-Math.max(1, ago - 8), 10);
    const value = Math.round(line.quantity * line.unitPrice * 1.18);
    const consignment = await Dispatch.create({
      number: await nextNumber('DSP'),
      order: order._id,
      customer: customer._id,
      assignedTo: owner._id,
      raisedBy: people.despatch._id,
      lines: [{ orderLine: line._id, mould: line.mould, modelNumber: line.modelNumber, colour: line.colour, quantity: line.quantity, cartons: Math.ceil(line.quantity / 200) }],
      invoice: { number: `INV/26-27/${String(300 + n).padStart(4, '0')}`, date: left, value },
      ewayBillNumber: `${161000000000 + n * 37}`,
      lrNumber: `LR${48000 + n}`,
      transporter: pick(['VRL Logistics', 'TCI Express', 'Safexpress', 'Professional Couriers'], n),
      dispatchDate: left,
      expectedDeliveryDate: new Date(left.getTime() + 3 * DAY),
      deliveredAt: delivered ? new Date(left.getTime() + 3 * DAY) : undefined,
      status: delivered ? 'delivered' : 'dispatched',
      statusHistory: [
        { to: 'dispatch_request_received', at: new Date(left.getTime() - DAY), by: people.despatch._id },
        { to: 'dispatched', at: left, by: people.despatch._id },
        ...(delivered ? [{ to: 'delivered', at: new Date(left.getTime() + 3 * DAY), by: people.despatch._id }] : []),
      ],
    });
    made.consignments += 1;
    if (owed) {
      const overdueBy = 5 + (n % 4) * 9;
      await Receivable.create({
        number: await nextNumber('RCV'), kind: 'invoice', customer: customer._id, order: order._id, dispatch: consignment._id, assignedTo: owner._id,
        invoice: { number: consignment.invoice.number, date: left, value },
        dueBy: days(-overdueBy, 23),
        receipts: n % 3 === 0 ? [{ amount: Math.round(value * 0.4), receivedAt: days(-2, 11), mode: 'neft', reference: `NEFT${200000 + n}`, recordedBy: people.accounts._id, confirmed: { by: people.accounts._id, at: days(-2, 12) } }] : [],
        followUps: n % 2 ? [{ at: days(-3, 11), by: owner._id, spokeTo: 'Accounts', note: 'Says the invoice is in their approval queue.' }] : [],
      });
      made.receivables += 1;
    }
    return consignment;
  }

  /** The department's task on the enquiry, raised as the screen raises it, walked to a status. */
  async function work(made0, row) {
    const { enquiry: raw, owner, n } = made0;
    const enquiry = await Enquiry.findById(raw._id).populate('customer', 'code name');
    const prefill = await taskPrefill(enquiry._id);
    const extra = row.kind === 'prt_recovery'
      ? { visitor: String(people.recovery._id), visitDate: iso(days(2)) }
      : row.kind === 'invoice_dispatch' ? { schedule: pick(['Today Dispatch', 'Tomorrow Dispatch', 'Today Evening Dispatch', 'Top Most Urgent Dispatch'], n), booking: pick(['Normal Booking', 'Book Before 4 PM', 'Party Will Collect', 'Local Delivery'], n) }
        : row.kind === 'team_payment_followup' ? { status: pick(['Promised to pay', 'Asked us to call back', 'Called — no answer', 'Says payment is sent'], n), commitment: pick(['This Week', 'Next Week', 'This Month'], n), vigorous: n % 2 === 0 }
          : row.kind === 'my_payment_followup' ? { status: 'Asked us to call back', commitment: 'Next Week' }
            : row.kind === 'mould_issue' ? { problem: pick(['Short shots on cavity 2', 'Flash on the hook boss', 'Ejector pin marks on the face'], n) }
              : row.brief;
    const note = {
      sample_request: 'Buyer wants to see the finish before the bulk order',
      create_quotation: `Cost at the buyer’s target, ${enquiry.items[0]?.quantity?.toLocaleString('en-IN')} pcs`,
      price_negotiation: 'Buyer says the competitor is ₹0.30 lower',
      po_so: 'PO received on mail — raise the SO',
      ask_edd: 'Buyer needs a delivery date for the store opening',
      ask_assembling_edd: 'Clip assembly for the trouser lot — when will it finish?',
      mould_issue: 'The tool needs attention before the lot can run',
      invoice_dispatch: 'Lot is packed — invoice and send',
      lr_copy: 'Lot left this morning — upload the LR and send it to the buyer',
      quality_check: 'First lot packed — check before invoicing',
      quality_issue: 'Buyer reported loose hooks in the last lot',
      gst_invoice_audit: 'Check the GST rate on the invoice before it goes',
      ac_clarify: 'Two receipts against one invoice — which order is the second for?',
      team_payment_followup: 'Invoice is over the credit period',
      prt_recovery: 'Collect the overdue balance on the visit',
      my_payment_followup: 'Call the buyer’s accounts about the balance',
    }[row.kind];
    const task = await moveEnquiry({
      enquiry, kind: row.kind, note, user: owner, system: true,
      brief: answersFor(row.kind, prefill, extra), priority: n % 4 === 0 ? 'high' : 'normal',
    });
    made.tasks += 1;
    /* Dated across the past week, so the queues show late work beside today's. */
    await Todo.updateOne({ _id: task._id }, { $set: { createdAt: days(-(n % 6), 10), dueDate: days((n % 5) - 2, 18) } }, { timestamps: false });
    return task;
  }

  /** The task moved along its department's statuses, by somebody in that department. */
  async function walk(task, row, by) {
    const list = statusesOf(task.kind);
    const keys = row.walk || (row.step != null ? list.slice(1, row.step + 1).map((entry) => entry.key) : []);
    let current = task;
    for (const key of keys) {
      const step = list.find((entry) => entry.key === key);
      if (!step || step.pdf || step.done || step.raises === 'prt_recovery') continue;
      const fresh = await Todo.findById(current._id);
      if (!fresh || fresh.completed) break;
      const needsDate = step.date || (step.key.includes('edr') || step.key === 'ready_on_date');
      try {
        current = await setTaskStatus(fresh, by, {
          status: key,
          note: pick(REMARKS[findHandoff(task.kind)?.department] || REMARKS.plant, (current.notes?.length || 0) + keys.indexOf(key)),
          date: needsDate ? iso(days(3 + (keys.length % 5))) : undefined,
        });
      } catch (error) {
        skipped.push(`${task.kind} → ${key}: ${error.message}`);
        break;
      }
    }
    return current;
  }

  const byDepartment = {
    sample_request: people.sampling, create_quotation: people.quotation, price_negotiation: people.quotation, po_so: people.orders,
    ask_edd: people.production, mould_issue: people.mould, ask_assembling_edd: people.assembling, invoice_dispatch: people.despatch,
    lr_copy: people.reception, quality_check: people.quality, quality_issue: people.quality, gst_invoice_audit: people.audit,
    ac_clarify: people.accounts, team_payment_followup: people.collections, prt_recovery: people.recovery,
  };

  for (const row of PLAN) {
    const n = turn;
    turn += 1;
    try {
      const raised = await raise(row, n);
      made.enquiries += 1;
      stages[row.stage] = (stages[row.stage] || 0) + 1;

      let order = null;
      if (row.order) order = await book(raised, row.order, { advance: row.advance });
      if (row.consignment && order) await load(order, raised, { owed: row.owed, delivered: row.stage === 'closed' || row.walk?.[0] === 'delivered' });

      if (row.closed === 'won') {
        await sendHandoff({ enquiry: await Enquiry.findById(raised.enquiry._id).populate('customer', 'code name'), kind: 'task_closed', note: 'Delivered and paid in full', user: admin });
        continue;
      }
      if (row.closed === 'lost') {
        await sendHandoff({ enquiry: await Enquiry.findById(raised.enquiry._id).populate('customer', 'code name'), kind: 'task_closed', note: `Lost — ${row.lostReason === 'price' ? 'price' : 'lead time'}`, user: admin });
        continue;
      }
      if (!row.kind) continue;

      const task = await work(raised, row);
      const by = byDepartment[row.kind] || raised.owner;

      if (row.kind === 'sample_request') {
        const sample = await Sample.findOne({ enquiry: raised.enquiry._id }).sort({ createdAt: -1 });
        if (sample) {
          made.samples += 1;
          const steps = ['checking_stock', 'production_required', 'printing_required', 'sample_available', 'sample_ready', 'dispatched', 'delivered', 'approved'];
          const upto = steps.indexOf(row.sample);
          const history = steps.slice(0, upto + 1).filter((step) => step !== 'printing_required' || row.sample === 'printing_required')
            .map((step, i) => ({ from: i ? undefined : 'request_received', to: step, at: days(-raised.ago + 1 + i, 12) }));
          Object.assign(sample, {
            status: row.sample, assignedTo: people.sampling._id, requiredDate: days(-raised.ago + 7, 17),
            ...(upto >= 5 ? { courier: 'Blue Dart', awbNumber: `7721${String(400000 + n)}`, dispatchedAt: days(-raised.ago + 6, 11), dispatchedQuantity: 6 } : {}),
            ...(upto >= 6 ? { deliveredAt: days(-raised.ago + 8, 14) } : {}),
            ...(upto >= 7 ? { feedbackAt: days(-raised.ago + 10, 10), feedbackBy: raised.owner._id, feedbackNote: 'Buyer approved the shade and the hook. Proceed to pricing.' } : {}),
            statusHistory: [{ to: 'request_received', at: days(-raised.ago + 1) }, ...history],
          });
          await sample.save();
          if (upto >= 5) await finishSampleTasks(sample, people.sampling);
        }
      } else if (row.kind === 'create_quotation' || row.kind === 'price_negotiation') {
        const quotation = await Quotation.findOne({ enquiry: raised.enquiry._id }).sort({ createdAt: -1 });
        if (quotation) {
          made.quotations += 1;
          const sent = row.walk[0] === 'sent';
          quotation.lines.forEach((line, i) => {
            line.unitPrice = pick(PRICES, n + i);
            line.moq = line.moq || 5000;
            line.status = sent ? 'approved' : 'costed';
          });
          if (sent) {
            quotation.status = 'sent';
            quotation.sentAt = days(-raised.ago + 3, 16);
            quotation.validUntil = days(30);
            quotation.statusHistory = [...(quotation.statusHistory || []), { to: 'approved', at: days(-raised.ago + 2) }, { to: 'sent', at: days(-raised.ago + 3, 16), by: people.quotation._id }];
          } else if (row.walk[0] === 'approval') {
            quotation.status = 'approval_pending';
            quotation.statusHistory = [...(quotation.statusHistory || []), { to: 'approval_pending', at: days(-raised.ago + 2), by: people.quotation._id }];
          }
          await quotation.save();
          if (sent) await finishQuotationTasks(quotation, people.quotation);
          else await walk(task, row, by);
        }
      } else {
        await walk(task, row, by);
      }
    } catch (error) {
      skipped.push(`${row.stage}${row.kind ? ` (${row.kind})` : ''}: ${error.message}`);
    }
  }

  const departments = await Todo.distinct('department', { kind: { $exists: true }, completed: false, enquiry: { $exists: true } });
  return { ...made, stages, departments: departments.length, skipped };
}

/* Standalone: `npm run seed:volume` adds the hundred to whatever is already there. */
const runDirectly = process.argv[1] && /[\\/]volume\.js$/.test(process.argv[1]);
if (runDirectly) {
  if (process.env.NODE_ENV === 'production' && !process.argv.includes('--i-mean-production')) {
    console.error('NODE_ENV is production. This adds a hundred demo enquiries. If that is really what you want: npm run seed:volume -- --i-mean-production');
    process.exit(1);
  }
  (async () => {
    await connectDatabase();
    const users = await User.find({ isActive: { $ne: false } });
    const byEmail = Object.fromEntries(users.map((user) => [user.email, user]));
    if (!byEmail['rsnavin1@gmail.com']) byEmail['rsnavin1@gmail.com'] = users.find((user) => user.role === 'admin') || users[0];
    for (const key of ['marketing@npthangers.com', 'marketing2@npthangers.com', 'marketing3@npthangers.com']) {
      if (!byEmail[key]) byEmail[key] = users.find((user) => user.department === 'marketing' && !Object.values(byEmail).includes(user)) || byEmail['rsnavin1@gmail.com'];
    }
    console.log(`Connected to "${mongoose.connection.name}". Adding a hundred enquiries across every stage...`);
    const result = await seedVolume({ byEmail });
    console.log(`  ${result.enquiries} enquiries on the ${result.customers} buyers already on the master (+${result.drafts} drafts), ${result.tasks} department tasks across ${result.departments} departments.`);
    console.log(`  ${result.samples} samples, ${result.quotations} quotations, ${result.orders} sales orders, ${result.consignments} consignments, ${result.receivables} receivables.`);
    console.log(`  By stage: ${Object.entries(result.stages).map(([stage, count]) => `${stage} ${count}`).join(', ')}.`);
    for (const reason of result.skipped) console.log(`    (skipped — ${reason})`);
    await disconnectDatabase();
  })().catch(async (error) => {
    console.error('Seed failed:', error);
    await mongoose.connection.close();
    process.exit(1);
  });
}
