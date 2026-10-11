import Enquiry from '../models/Enquiry.js';
import Material from '../models/Material.js';
import Component from '../models/Component.js';
import Todo from '../models/Todo.js';
import { findHandoff } from '../config/handoffs.js';
import { completeHandoff, moveEnquiry, returnHandoff, taskPrefill } from '../services/handoff.service.js';
import { backfillHolders } from '../../scripts/migrate-enquiry-holders.js';

/**
 * The last of the seed: every department with work on its dashboard, raised exactly the way the
 * enquiry screen raises it — the department's form filled from the enquiry
 * [config/departmentTaskForms.js, handoff.service `taskPrefill`].
 *
 * First the enquiry rows are linked to the registers — a resin of the right family and colour,
 * a hook, a clip for bottoms, a print where one was asked — so the forms have mould, material,
 * hook, clip and print to fill from. Then every open enquiry is held by its marketing person,
 * and each department gets tasks: some due today, some late, one done this week and one sent
 * back, so every tab on every dashboard has something in it.
 */

const CLIPPED = ['trouser', 'skirt', 'bottom', 'kids'];
const day = (offset) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date;
};

/** Each enquiry row given the register entries that describe it, where it names none. */
async function linkRegisters() {
  const [resins, hooks, clips, prints] = await Promise.all([
    Material.find().lean(),
    Component.find({ kind: 'hook' }).sort({ ratePerPiece: 1 }).lean(),
    Component.find({ kind: 'clip' }).sort({ ratePerPiece: 1 }).lean(),
    Component.find({ kind: 'print' }).sort({ ratePerPiece: 1 }).lean(),
  ]);
  /* A resin of the row's colour — of its family where the register has one — or none at all:
     a white resin on a black hanger is worse than a blank the person fills in. */
  const resinFor = (row) => {
    const sameColour = (resin) => row.colour && resin.colour && resin.colour.toLowerCase() === row.colour.toLowerCase();
    const family = resins.filter((resin) => resin.type === row.material);
    return family.find(sameColour) || resins.find(sameColour) || (!row.colour ? family[0] : null) || null;
  };
  let linked = 0;
  for (const enquiry of await Enquiry.find()) {
    let changed = false;
    enquiry.items.forEach((row, index) => {
      const set = {};
      const resin = !row.materialRef && resinFor(row);
      if (resin) set.materialRef = resin._id;
      if (!row.hookRef && hooks.length) set.hookRef = hooks[(row.category === 'coat' || row.category === 'suit') ? hooks.length - 1 : 0]._id;
      if (!row.clipRef && clips.length && CLIPPED.includes(row.category)) set.clipRef = clips[0]._id;
      if (!row.printRef && prints.length && row.printing) set.printRef = prints[0]._id;
      if (Object.keys(set).length) {
        Object.assign(enquiry.items[index], set);
        changed = true;
      }
    });
    if (changed) {
      enquiry.markModified('items');
      await enquiry.save();
      linked += 1;
    }
  }
  return linked;
}

/** The form's answers, filled from the enquiry the way the screen fills them. */
function answersFor(kind, prefill, extra = {}) {
  const read = (path) => path?.split('.').reduce((value, key) => (value == null ? undefined : value[key]), prefill);
  const brief = {};
  for (const field of findHandoff(kind)?.asks || []) {
    if (field.type === 'kind' || field.type === 'info') continue;
    const value = read(field.from);
    if (field.type === 'choice' && field.options && !field.options.includes(value)) continue;
    if (value != null && value !== '') brief[field.key] = value;
  }
  return { ...brief, ...extra };
}

/** What each department is asked, and the answers only a person would give. */
const PLAN = [
  ['sample_request', 'Buyer wants to see the finish before the bulk order'],
  ['sample_request', 'Two models for the store trial', { lateBy: 2 }],
  ['create_quotation', 'Cost at the buyer’s target, 10,000 pcs'],
  ['price_negotiation', 'Buyer says the competitor is ₹0.30 lower', { lateBy: 1 }],
  ['po_so', 'PO received on mail — raise the SO today'],
  ['ask_edd', 'Buyer needs a delivery date for the store opening'],
  ['ask_assembling_edd', 'Clip assembly for the trouser lot — when will it finish?'],
  ['mould_issue', 'Short shots on cavity 2 since Monday', { brief: { problem: 'Cavity 2 fills short; flash on the hook boss' }, lateBy: 1 }],
  ['quality_check', 'First lot packed — check before invoicing'],
  ['quality_issue', 'Buyer reported loose hooks in the last lot', { brief: { problem: 'Hooks pulling out under 2 kg' } }],
  ['team_payment_followup', 'Invoice is 12 days over the credit period', { brief: { status: 'Promised to pay', commitment: 'This Week', vigorous: true } }],
  ['my_payment_followup', 'Call the buyer’s accounts about the advance', { brief: { status: 'Asked us to call back', commitment: 'Next Week' } }],
  ['gst_invoice_audit', 'GSTIN on the invoice does not match the PO'],
  ['gst_invoice_audit', 'Check the GST rate on the export invoice before it goes'],
  ['ac_clarify', 'Two receipts against one invoice — which order is the second for?'],
  ['request_prt_visit', 'Buyer wants the MD at the factory before the big order'],
];

export async function seedDepartmentTasks(people) {
  const linked = await linkRegisters();
  await backfillHolders({ write: true, log: () => {} });

  const enquiries = await Enquiry.find({ stage: { $ne: 'closed' } }).populate('customer', 'code name').sort({ createdAt: 1 });
  const raised = [];
  const skipped = [];
  let turn = 0;
  for (const [kind, note, options = {}] of PLAN) {
    let task = null;
    /* Round the enquiries, so the work is spread across buyers rather than piled on one. */
    for (let tries = 0; tries < enquiries.length && !task; tries += 1) {
      const enquiry = enquiries[(turn + tries) % enquiries.length];
      const owner = people.ownerOf(enquiry);
      try {
        const prefill = await taskPrefill(enquiry._id);
        task = await moveEnquiry({
          enquiry, kind, note, user: owner, system: true, openRecords: kind !== 'sample_request',
          brief: answersFor(kind, prefill, options.brief),
          priority: options.lateBy ? 'high' : 'normal',
        });
        turn += tries + 1;
      } catch (error) {
        if (tries === enquiries.length - 1) skipped.push(`${kind}: ${error.message}`);
      }
    }
    if (!task) continue;
    if (options.lateBy) await Todo.updateOne({ _id: task._id }, { $set: { dueDate: day(-options.lateBy) } });
    raised.push(task);
  }

  /*
   * Quality passes one job, and Dispatch is asked for it — the gate the app enforces, walked the
   * way the plant walks it. Then one task done this week, and one sent back, for those tabs.
   */
  const check = raised.find((task) => task.kind === 'quality_check');
  if (check) {
    await completeHandoff(await Todo.findById(check._id), people.quality, {
      note: '1,000 pcs checked — hooks, finish and print all fine', fields: { result: 'Passed', passedQty: '1000' },
    });
    const enquiry = await Enquiry.findById(check.enquiry).populate('customer', 'code name');
    try {
      const prefill = await taskPrefill(enquiry._id);
      raised.push(await moveEnquiry({
        enquiry, kind: 'invoice_dispatch', note: 'Quality passed — invoice and send the first lot', user: people.ownerOf(enquiry), system: true,
        brief: answersFor('invoice_dispatch', prefill, { schedule: 'Today Dispatch', booking: 'Normal Booking' }),
      }));
    } catch (error) {
      skipped.push(`invoice_dispatch: ${error.message}`);
    }
  }
  const quote = raised.find((task) => task.kind === 'create_quotation');
  if (quote && people.quotation) {
    await completeHandoff(await Todo.findById(quote._id), people.quotation, {
      note: 'Costed at ₹7.40 — quotation sent for approval', fields: { price: '7.40' },
    });
  }
  const audit = raised.find((task) => task.kind === 'gst_invoice_audit');
  if (audit && people.audit) {
    await returnHandoff(await Todo.findById(audit._id), people.audit, { reason: 'Attach the PO copy — the GSTIN cannot be checked without it' });
  }

  const departments = new Set(raised.map((task) => task.department));
  return { linked, tasks: raised.length, departments: departments.size, skipped };
}
