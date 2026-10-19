import { withCreateLocks } from './operationLock.service.js';
import { afterCommit } from '../utils/transaction.js';
import Todo, { PRIORITIES } from '../models/Todo.js';
import Enquiry from '../models/Enquiry.js';
import { CLOSED_STAGE, SALES_STAGE_KEYS, SIDE_STAGES, STAGES, stageLabel } from '../config/enquiryStages.js';
import { followTask, marketingRank, marketingStatusOf } from '../config/marketingStatuses.js';
import { findDepartment } from '../config/modules.js';
import { HANDOFFS, findHandoff } from '../config/handoffs.js';
import { canRead } from './access.service.js';
import { isOwnershipScoped, ownsRecord } from './ownership.service.js';
import { departmentsOf, inDepartment, isManagement, MANAGEMENT_QUERY } from '../utils/departments.js';
import { EVENTS, publish } from './events.service.js';
import ApiError from '../utils/ApiError.js';
import { dispatchBalance } from './enquiryGates.service.js';
import * as paymentPresets from './paymentGates.service.js';
import { afterPayment, assertEnquiryPaidFor, confirmInwardFromTask } from './paymentGates.service.js';
import { COLLECTION_KINDS, receivablesOf } from './collections.service.js';
import { MATERIALS } from '../models/Mould.js';
import { HANDOVER_CHOICES } from '../config/departmentTaskForms.js';
import { askToRecordReceipt, endOfIndiaDay, logCollectionCall } from './collections.service.js';
import { chainOf, jobFilter } from './journey.service.js';
import mongoose from 'mongoose';

/**
 * One department asking another for something about an enquiry — the buttons on the enquiry
 * screen [config/handoffs.js].
 *
 *   send       a department task lands on the department's queue, due by the end of today,
 *              with the answers to the questions it asks; anyone in the department may pick
 *              it up. The enquiry stays with its marketing person; its stage label follows.
 *   done       whoever did it says what they did; the sender gets a task back to take the next
 *              step, so the enquiry is never left with nobody holding it.
 *   send back  the department returns it with a reason; the sender gets that as a task too.
 *   re-date    the due date moves, with a reason on the record.
 *
 * Any department may send to any other (a mould issue raised by production, a quality issue
 * raised by dispatch). Who is told — WhatsApp and the installed app — is the subscriber's job,
 * after the commit, so a message never goes out about a task that was rolled back.
 */

const IST_OFFSET_MS = 330 * 60 * 1000;

/** The end of the day in India, as an instant: the due date every task starts with. */
export function endOfDayIST(now = new Date()) {
  const local = new Date(now.getTime() + IST_OFFSET_MS);
  local.setUTCHours(23, 59, 59, 999);
  return new Date(local.getTime() - IST_OFFSET_MS);
}

/** The start of the day in India — the earliest a task may be re-dated to. */
export function startOfDayIST(now = new Date()) {
  const local = new Date(now.getTime() + IST_OFFSET_MS);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - IST_OFFSET_MS);
}

const departmentName = (key) => findDepartment(key)?.label || String(key || '').replace(/_/g, ' ');

const fail = (message) => { throw ApiError.badRequest(message); };

/** Work that belongs to one sales order: with several open on the enquiry, the person raising it names which. */
export const ORDER_BOUND_KINDS = ['ask_edd', 'ask_assembling_edd', 'invoice_dispatch', 'lr_copy', 'quality_check', 'quality_issue'];

/** Admin, or the Admin department: sees and may act on everything. */
const isAdmin = isManagement;

/*
 * The department a person is acting for: the one the task is on when they work in it (their
 * main department or an extra one), else their main department.
 */
const actingFor = (user, task) => (task && inDepartment(user, task.department) ? task.department : user?.department);

const idOf = (value) => String(value?._id || value || '');

/** The enquiry's open holding task — the department that has it now. */
export const holderOf = (enquiryId) =>
  Todo.findOne({ enquiry: enquiryId, holds: true, completed: false });

/** Whether this person is the one holding a task: its department, or it is theirs by name. */
export function mayWorkOnHandoff(user, task) {
  if (isAdmin(user)) return true;
  if (task.user && idOf(task.user) === idOf(user._id)) return true;
  return inDepartment(user, task.department);
}

/**
 * Who may move an enquiry on: whoever has it now (the holding department, or the person it is
 * with by name), the marketing person who owns the buyer, and Admin. Nobody else can take it
 * from the department that has it — they can ask, through a query.
 */
export async function mayMove(user, enquiry, holder) {
  if (isAdmin(user)) return true;
  if (idOf(enquiry.assignedTo) === idOf(user._id)) return true;
  const current = holder === undefined ? await holderOf(enquiry._id) : holder;
  /* Marketing's holding task is its marketing person's by name — not every marketing colleague's. */
  if (current && findHandoff(current.kind)?.department === 'owner') return false;
  return Boolean(current && mayWorkOnHandoff(user, current));
}

/**
 * Whether this person may send a side request or record something on the enquiry: anyone who
 * may move it, or a department that has held it before (dispatch asking Admin for a visit).
 */
export async function mayHandOff(user, enquiry) {
  if (await mayMove(user, enquiry)) return true;
  if (isOwnershipScoped(user)) {
    /*
     * A salesperson who also sits in another department — quotation, sampling — opens another
     * salesperson's enquiry only for that department's work on it, never as a salesperson.
     */
    const other = departmentsOf(user).filter((key) => key !== 'marketing');
    return Boolean(other.length && (await Todo.exists({
      enquiry: enquiry._id, department: { $in: other }, kind: { $exists: true },
    })));
  }
  if (canRead(user, 'enquiries') && ownsRecord(user, enquiry)) return true;
  const mine = departmentsOf(user);
  return Boolean(mine.length && (await Todo.exists({
    enquiry: enquiry._id, department: { $in: mine }, kind: { $exists: true },
  })));
}

/** Where a sender's "it came back" task goes: to them, on their own department's list. */
async function backToSender(task, { title, notes, user }) {
  if (!task.createdBy || idOf(task.createdBy) === idOf(user._id)) return null;
  return Todo.create({
    user: task.createdBy,
    department: task.fromDepartment || 'marketing',
    title,
    notes,
    dueDate: endOfDayIST(),
    enquiry: task.enquiry,
    customer: task.customer,
    link: task.link,
    createdBy: user._id,
    system: true,
  });
}

/**
 * Moves the enquiry to a stage, with the task that moved it on the record, and says who has it.
 *
 * Written as one atomic update rather than a save of the whole enquiry, and without touching its
 * updatedAt: a department moving the enquiry on is workflow, not an edit of what the enquiry
 * says — and the moves made in the background (a status change, a sample raised) must never
 * collide with, or make stale, the copy a marketing person has open. The document in hand is
 * brought up to date too, for whoever replies with it.
 */
async function moveStage(enquiry, to, { user, task, note, heldBy, marketing: said, won: wins = false }) {
  const set = {};
  const unset = {};
  if (heldBy === null) unset.heldBy = 1;
  else if (heldBy) set.heldBy = heldBy;
  const entry = to && enquiry.stage !== to
    ? { from: enquiry.stage, to, at: new Date(), by: user?._id, task: task?._id, note }
    : null;
  if (entry) set.stage = to;

  const update = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;
  if (entry) update.$push = { stageHistory: entry };
  /*
   * Marketing's words follow the task raised — Sample requested … Production, Mould, QC, LR Copy
   * — or are said outright by the rule that moved the enquiry [config/handoffs.js `whenDone`].
   */
  const current = marketingStatusOf(enquiry);
  const follows = said ? (said !== current ? said : null) : task?.kind && followTask(task.kind, current);
  const marketing = follows
    ? { from: enquiry.marketingStatus || null, to: follows, at: new Date(), by: user?._id, note: task?.title || note }
    : null;
  if (marketing) {
    update.$set = { ...(update.$set || {}), marketingStatus: follows };
    update.$push = { ...(update.$push || {}), marketingStatusHistory: marketing };
  }
  /*
   * The order is won on its own evidence alone — the SO uploaded [config/handoffs.js po_so
   * `whenDone.won`]. Not because Production was asked for a date, and not because an LR was
   * uploaded: an LR says the goods left, not that the order was booked.
   */
  const won = wins && !['won', 'lost'].includes(enquiry.status)
    ? { from: enquiry.status, to: 'won', by: user?._id, note: `${task?.title || 'Order booked'}` }
    : null;
  if (won) {
    update.$set = { ...(update.$set || {}), status: 'won' };
    update.$push = { ...(update.$push || {}), statusHistory: won };
  }
  if (!Object.keys(update).length) return;
  await Enquiry.updateOne({ _id: enquiry._id }, update, { timestamps: false, keepVersion: true });

  /* Mirrored on the document without marking it changed, so a later save cannot write it twice. */
  if (entry) {
    enquiry.stage = to;
    enquiry.unmarkModified('stage');
  }
  if (marketing) {
    enquiry.marketingStatus = marketing.to;
    enquiry.unmarkModified('marketingStatus');
  }
  if (won) {
    enquiry.status = 'won';
    enquiry.unmarkModified('status');
  }
  if (heldBy !== undefined) {
    enquiry.heldBy = heldBy || undefined;
    enquiry.unmarkModified('heldBy');
  }
}

const aboutOf = (enquiry) => {
  const customerName = enquiry.customer?.name || enquiry.prospect?.name;
  return `${enquiry.number}${customerName ? ` · ${customerName}` : ''}`;
};

/** The marketing person who owns the buyer, and their department. */
async function ownerOf(enquiry) {
  const userId = enquiry.assignedTo?._id || enquiry.assignedTo;
  const { default: User } = await import('../models/User.js');
  const owner = userId ? await User.findById(userId).select('department') : null;
  return { userId, department: owner?.department || 'marketing' };
}

/**
 * When the task is due: the end of today — except while marketing holds it, when it is due on
 * the enquiry's follow-up date, which marketing already keeps.
 */
function dueFor(handoff, enquiry, now = new Date()) {
  const followUp = enquiry.nextFollowUpDate && new Date(enquiry.nextFollowUpDate);
  if (handoff.department === 'owner' && followUp && followUp > now) return endOfDayIST(followUp);
  return endOfDayIST(now);
}

/** Keep the details a button records, and nothing else; a choice must be one of its options. */
function keptFields(kind, fields = {}) {
  const records = new Map((findHandoff(kind)?.records || []).map((field) => [field.key, field]));
  return Object.fromEntries(
    Object.entries(fields || {})
      .filter(([key, value]) => records.has(key) && String(value ?? '').trim())
      .map(([key, value]) => {
        const field = records.get(key);
        const text = String(value).trim().slice(0, 200);
        if (field.type === 'choice' && !field.options.includes(text)) {
          fail(`${field.label} is one of: ${field.options.join(', ')}`);
        }
        return [key, text];
      })
  );
}

/** Opens the holding task: this department now has the enquiry. Saves nothing on the enquiry. */
async function openHolder({ enquiry, kind, note, user, title, from }) {
  const handoff = findHandoff(kind);
  /* The buyer's name goes in the title; a freshly created enquiry carries only its id. */
  let about = aboutOf(enquiry);
  if (enquiry.customer && !enquiry.customer.name) {
    const { default: Customer } = await import('../models/Customer.js');
    const buyer = await Customer.findById(idOf(enquiry.customer)).select('name');
    if (buyer?.name) about = `${enquiry.number} · ${buyer.name}`;
  }
  let department = handoff.department;
  let assignee;
  if (department === 'owner') ({ userId: assignee, department } = await ownerOf(enquiry));

  const task = await Todo.create({
    enquiry: enquiry._id,
    customer: enquiry.customer?._id || enquiry.customer,
    kind,
    holds: true,
    department,
    user: assignee || undefined,
    fromDepartment: from || user?.department || undefined,
    createdBy: user?._id,
    system: !user,
    title: title || `${handoff.label} — ${about}`,
    notes: note || undefined,
    dueDate: dueFor(handoff, enquiry),
    priority: 'normal',
    link: `/enquiries/${enquiry._id}`,
  });
  return task;
}

/**
 * What the Sample Request's first row says, in the sample's own fields [models/Sample.js]. The
 * sample inherits the enquiry's models, hooks, clips and prints itself; the task adds what only
 * the person asking knows — the colour rule and how many pieces.
 */
function sampleFromBrief(brief = {}) {
  const row = brief.items?.[0];
  const said = {};
  /* How it reaches the buyer, as the form's words [HANDOVER_CHOICES] — the sample's own mode. */
  const handover = HANDOVER_CHOICES.find((choice) => choice.label === brief.handover)?.key;
  if (handover) said.handover = handover;
  if (!row) return said;
  const material = row.material && row.material.toLowerCase().replace(/\s+/g, '_');
  if (material && MATERIALS.includes(material)) said.material = material;
  if (row.colour) said.colour = row.colour;
  if (row.colourType) said.colourMandatory = row.colourType === 'Compulsory colour';
  if (Number(row.quantity) > 0) said.quantity = Number(row.quantity);
  /* Every model's line, for its own row on the sample [sampling.service `statedOnEachRow`]. */
  if (brief.items.length > 1) said.rows = brief.items;
  return said;
}

const COLLECT_LABEL = HANDOVER_CHOICES.find((choice) => choice.key === 'collect')?.label;

/**
 * A Sample Request the buyer collects at reception [HANDOVER_CHOICES `collect`]: the sample is
 * raised as an internal one (closed to the bench from the start) and Reception gets the task —
 * Noted → Sample ready → Sample handed → Task closed. A sample already open on the enquiry for the
 * bench is taken off the bench and moved to the desk instead of raising a second one.
 */
async function raiseInternalSample({ enquiry, asked, note, priority, requiredDate, user }) {
  const { createSampleForEnquiry } = await import('./sampling.service.js');
  const { sample, created } = await createSampleForEnquiry(enquiry, sampleFromBrief(asked), { autoCreated: true });
  if (!created && sample.handover !== 'collect') {
    sample.handover = 'collect';
    if (!sample.benchClosedAt) {
      sample.benchClosedAt = new Date();
      sample.benchClosedBy = user?._id;
    }
    sample.statusHistory.push({ from: sample.status, to: sample.status, by: user?._id, note: 'Changed to an internal sample the buyer collects at reception' });
    await sample.save();
  }
  return raiseCollection(sample, user, { note, priority, requiredDate });
}

/** "ENQ-2026-0012 · SCM Garments", reading the buyer's name when only its id is in hand. */
async function aboutWithName(enquiry) {
  if (enquiry.customer && !enquiry.customer.name) {
    const { default: Customer } = await import('../models/Customer.js');
    const buyer = await Customer.findById(idOf(enquiry.customer)).select('name');
    if (buyer?.name) return `${enquiry.number} · ${buyer.name}`;
  }
  return aboutOf(enquiry);
}

/**
 * The work record a button opens, so the department finds it waiting: Sample Request raises the
 * sample, Create Quotation the costing sheet. Both are one-per-enquiry, so pressing again (or a
 * status change doing the same) reuses the open one.
 */
async function openWorkRecord(kind, enquiry, brief = {}) {
  if (kind === 'sample_request') {
    const { createSampleForEnquiry } = await import('./sampling.service.js');
    await createSampleForEnquiry(enquiry, sampleFromBrief(brief), { autoCreated: true });
  }
  if (kind === 'create_quotation') {
    const { ensureCostingFor } = await import('./costingRequest.service.js');
    await ensureCostingFor(enquiry);
  }
}

/**
 * The holding task, for a new enquiry (and for one that has none — see the migration): the
 * enquiry is its marketing person's, wherever its work is. Departments get tasks, not the enquiry.
 */
export async function ensureHolder(enquiry, { user } = {}) {
  if (enquiry.stage === CLOSED_STAGE) return null;
  const existing = await holderOf(enquiry._id);
  if (existing) return existing;
  const task = await openHolder({ enquiry, kind: 'new_enquiry', user });
  await moveStage(enquiry, null, { heldBy: task.department });
  return task;
}

/**
 * The person a `member` question names — an active member of its department — and the brief with
 * their name in place of their id. Refused when it names anyone else.
 */
async function pickedMember(kind, brief = {}) {
  const field = (findHandoff(kind)?.asks || []).find((entry) => entry.type === 'member');
  const id = field && brief?.[field.key];
  if (!field || !id) return { brief, member: null };
  const { default: User } = await import('../models/User.js');
  const member = /^[0-9a-f]{24}$/i.test(String(id))
    ? await User.findOne({ _id: id, isActive: { $ne: false }, $or: [{ department: field.department }, { extraDepartments: field.department }] }).select('name department')
    : null;
  if (!member) fail(`${field.label}: pick someone from ${departmentName(field.department)}`);
  return { brief: { ...brief, [field.key]: member.name }, member };
}

/** Who a form may pick for each `member` question: the active people of that department. */
export async function membersFor(departments) {
  const keys = [...new Set(departments)].filter(Boolean);
  if (!keys.length) return {};
  const { default: User } = await import('../models/User.js');
  const people = await User.find({ isActive: { $ne: false }, $or: [{ department: { $in: keys } }, { extraDepartments: { $in: keys } }] })
    .select('name department extraDepartments').sort({ name: 1 }).lean();
  return Object.fromEntries(keys.map((key) => [key, people
    .filter((person) => person.department === key || (person.extraDepartments || []).includes(key))
    .map((person) => ({ _id: String(person._id), name: person.name }))]));
}

/** One answer, checked against its question: a number is a number, a date a date, a choice one of its options. */
function keptAnswer(field, value) {
  if (field.type === 'check') return value === true || value === 'true' || value === 'Yes' ? 'Yes' : '';
  const text = String(value ?? '').trim().slice(0, 300);
  if (!text) return '';
  if (field.type === 'number') {
    const number = Number(text.replace(/,/g, ''));
    if (!Number.isFinite(number) || number < 0) fail(`${field.label} must be a number`);
    return String(number);
  }
  if (field.type === 'date' && Number.isNaN(new Date(text).getTime())) fail(`${field.label} is not a date`);
  if (field.type === 'choice' && field.options && !field.options.includes(text)) {
    fail(`${field.label} is one of: ${field.options.join(', ')}`);
  }
  return text;
}

/**
 * The answers to the form a department task opens with [config/departmentTaskForms.js]: kept as
 * the task's brief. Only the questions the form asks are kept, each checked by its type; a table
 * keeps its rows (twenty at most) and the columns it asks; a required one must be answered —
 * unless the system raises it (a status change), when there is nobody to ask and the department
 * reads the enquiry instead.
 */
/**
 * A quotation request in the shape it had before it took a row per model — "NH-400, NH-420",
 * one material, a quantity and a target price — as rows: one per model named, the material and
 * target price on each, the quantity where only one model shares it. Callers still sending it
 * (a card confirmed from an older screen) are understood, not refused.
 */
function rowsFromFlat(field, brief = {}) {
  if (Array.isArray(brief?.[field.key]) || !field.columns.some((column) => column.key === 'targetPrice')) return brief;
  const models = String(brief.models || brief.model || '').split(',').map((model) => model.trim()).filter(Boolean);
  if (!models.length) return brief;
  const rows = models.map((model) => ({
    model,
    ...(brief.material ? { material: brief.material } : {}),
    ...(brief.targetPrice ? { targetPrice: brief.targetPrice } : {}),
    ...(models.length === 1 && brief.quantity ? { quantity: brief.quantity } : {}),
  }));
  return { ...brief, [field.key]: rows };
}

function keptBrief(kind, brief = {}, { strict = true } = {}) {
  const asks = findHandoff(kind)?.asks || [];
  for (const field of asks.filter((entry) => entry.type === 'items')) brief = rowsFromFlat(field, brief);
  const kept = {};
  for (const field of asks) {
    if (field.type === 'info' || field.type === 'kind') continue;
    if (field.type === 'items') {
      const rows = (Array.isArray(brief?.[field.key]) ? brief[field.key] : []).slice(0, 20)
        .map((row) => Object.fromEntries(field.columns
          .map((column) => [column.key, keptAnswer(column, row?.[column.key])])
          .filter(([, value]) => value)))
        .filter((row) => Object.keys(row).length);
      if (strict) {
        if (field.required && !rows.length) fail(`${field.label}: add at least one row`);
        for (const column of field.columns.filter((entry) => entry.required)) {
          if (rows.some((row) => !row[column.key])) fail(`${column.label} is needed on every row of ${field.label}`);
        }
      }
      if (rows.length) kept[field.key] = rows;
      continue;
    }
    const answer = keptAnswer(field, brief?.[field.key]);
    if (!answer) {
      if (strict && field.required) fail(`${field.label} is needed for this task`);
      continue;
    }
    kept[field.key] = answer;
  }
  return kept;
}

/**
 * A task's answers checked before anything is made — the same checks raising it makes, for a
 * caller that creates the enquiry first and must not leave it behind when the form is short
 * [buyerCard.controller `confirmBuyerCard`].
 */
export function assertTaskAnswers(kind, brief, note) {
  assertNote(kind, keptBrief(kind, brief), note);
}

/** A form that needs the instruction filled in some cases — Sampling, beyond three pieces. */
function assertNote(kind, asked, note) {
  const rule = findHandoff(kind)?.form?.noteRequired;
  if (!rule || String(note || '').trim().length >= 3) return;
  const rows = asked[rule.items] || [];
  if (rows.some((row) => Number(row[rule.column]) > rule.above)) fail(rule.message);
}

/** The due date a person asked for — the end of that day in India, never in the past. */
function requiredDue(value, label = 'The required date') {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) fail(`${label} is not a date`);
  if (date < startOfDayIST()) fail(`${label} cannot be in the past`);
  return endOfDayIST(date);
}

/** The open department tasks of these kinds on an enquiry, finished with what the record says. */
async function finishOpenTasks(enquiryId, kinds, { fields = {}, note, user }) {
  const open = await Todo.find({ enquiry: enquiryId, kind: { $in: kinds }, completed: false, holds: { $ne: true } });
  const now = new Date();
  for (const task of open) {
    if (task.kind === 'invoice_dispatch' && (await dispatchBalance(enquiryId)).length) continue;
    const kept = keptFields(task.kind, fields);
    const claimed = await Todo.updateOne({ _id: task._id, completed: false }, {
      $set: {
        completed: true,
        completedAt: now,
        ...(user ? { completedBy: user._id } : {}),
        outcome: {
          result: 'done', note: note || 'Done', ...(Object.keys(kept).length ? { fields: kept } : {}),
          ...(user ? { by: user._id } : {}), at: now,
        },
      },
    });
    if (claimed.modifiedCount) await publish(EVENTS.HANDOFF_DONE, { task: await Todo.findById(task._id), by: user });
  }
}

/**
 * Raises a department task on the enquiry — what clicking a department does. The enquiry stays
 * with its marketing person (Admin sees every one); the department gets a task on its queue,
 * due by the end of today, with the answers to the questions the task asks (its brief), and
 * that task is what the department's dashboard shows. The enquiry's stage follows the latest
 * department asked, as a label of where the work is.
 *
 * Named for what it used to do, because every door that hands work on comes through here: the
 * buttons, a department's "done, and next", and the automations (a status change, an order
 * released, goods gone). `finishes` closes the open tasks of those kinds first, with `fields`
 * — Sales / SO's task is done when the order is released. `system` skips the who-may check and
 * the required questions. `openRecords: false` is for the automations, which raise the sample
 * or costing themselves.
 */
export function moveEnquiry(request) {
  /*
   * One request per enquiry and kind at a time. The check below ("already with Production?") and
   * the create after it were two steps, so a double tap — or two people at once — both passed the
   * check and opened twin tasks. The second now waits, finds the first, and is told it is open.
   */
  return withCreateLocks([`handoff:${request.enquiry?._id || request.enquiry}:${request.kind}`], () => moveEnquiryChecked(request));
}

async function moveEnquiryChecked({
  enquiry, kind, note, fields, brief, priority, requiredDate, user, system = false, openRecords = true, finishes = [], parentTask, addToOpen = false, keepStage = false, order: pickedOrder,
}) {
  const handoff = findHandoff(kind);
  if (!handoff?.department || handoff.stage === CLOSED_STAGE) fail('That button does not raise a department task');
  if (enquiry.stage === CLOSED_STAGE) fail('This enquiry is closed. Nothing more can be sent on it.');
  if (kind === 'back_to_marketing') return returnToMarketing({ enquiry, note, fields, user, system });
  if (!system && !(await mayHandOff(user, enquiry))) throw ApiError.notFound('Enquiry not found');
  /* A Production Holded Order goes on to Production only by Admin or its marketing person. */
  if (!system && enquiry.stage === 'production_hold' && kind === 'ask_edd' && !mayReleaseHeld(user, enquiry)) {
    throw ApiError.forbidden('Only Admin or this enquiry’s marketing person can move a Production Holded Order to Production');
  }

  /* One open request per enquiry and kind — except a "My" task, which is each person's own: a
     second person's payment follow-up on the same buyer is theirs, not an add-on to a colleague's. */
  const already = await Todo.findOne({
    enquiry: enquiry._id, kind, completed: false,
    ...(handoff.toRaiser && user?._id && !system ? { user: user._id } : {}),
  }).populate('user', 'name');
  if (already && !addToOpen) {
    throw ApiError.conflict(
      `${handoff.label} is already with ${departmentName(already.department)}`
        + `${already.user?.name ? ` (${already.user.name})` : ''}. Add to that one, or wait for it to come back.`
    );
  }
  /*
   * Raised by the app with nothing asked — a status that moves the enquiry on (sample approved →
   * Create Quotation), the next team after a status: the form's answers as the enquiry gives them,
   * a table's rows included, so the department sees the models it would have seen on the form.
   */
  if (system && !Object.keys(brief || {}).length) brief = briefFromPrefill(kind, await taskPrefill(enquiry._id));
  /* A member picked on the form (the PRT visitor): theirs by name, kept on the brief by name. */
  const picked = await pickedMember(kind, brief);
  const asked = keptBrief(kind, picked.brief, { strict: !system });
  if (!system) assertNote(kind, asked, note);
  if (already) return addToOpenTask(already, { handoff, note, asked, priority, requiredDate, user });
  /* The buyer collects it at reception: an internal sample — Reception's task, never the sampling queue. */
  if (kind === 'sample_request' && asked.handover === COLLECT_LABEL) {
    return raiseInternalSample({ enquiry, asked, note, priority, requiredDate, user });
  }
  const form = handoff.form || {};
  const due = requiredDue(requiredDate) || (form.dueFrom && requiredDue(asked[form.dueFrom], 'That date'));

  /*
   * The payment gates [services/paymentGates.service.js]: Production only once the advance is
   * in, Dispatch only once the money due before dispatch is in — refused with the shortfall, and
   * Payment Collection is asked for it. Dispatch is not held for a Quality pass: the plant asks
   * Quality when it wants the goods checked (Quality Check), not as a lock on Dispatch.
   */
  if (kind === 'ask_edd') await assertEnquiryPaidFor(enquiry._id, 'production', { by: user });
  if (kind === 'invoice_dispatch') await assertEnquiryPaidFor(enquiry._id, 'dispatch', { by: user });

  const text = String(note || '').trim();
  if (finishes.length) await finishOpenTasks(enquiry._id, finishes, { fields, note: text, user });

  let department = handoff.department;
  let assignee = picked.member?._id;
  if (department === 'owner') {
    /* My Payment Follow-up is the raiser's own; anything else for the owner is the enquiry's marketing person's. */
    /* Raised by a person: on their own list, whoever they are. Raised by a flow (a step's "next"),
       nobody chose it — it goes to the enquiry's marketing person, not to whoever pressed Done. */
    ({ userId: assignee, department } = handoff.toRaiser && user?._id && !system
      ? { userId: user._id, department: user.department || 'marketing' }
      : await ownerOf(enquiry));
  }
  const holder = await holderOf(enquiry._id);
  /* The enquiry's sales order, carried on the task: what a dispatch, an LR or a QC sheet is for. */
  const { default: SalesOrder, OPEN_ORDER_STATUSES } = await import('../models/SalesOrder.js');
  /*
   * The SO the task is for. Picked on the form: it must be this enquiry's. Raised by another task
   * (Dispatched → LR copy): that task's SO. Otherwise the enquiry's only open SO — and with several
   * open, a person raising work that belongs to one SO is asked which, rather than the newest being
   * assumed and the dispatch or the QC sheet landing on the wrong order.
   */
  let order = null;
  if (pickedOrder) {
    order = await SalesOrder.findOne({ _id: pickedOrder, enquiry: enquiry._id }).select('_id').lean();
    if (!order) fail('That sales order is not on this enquiry');
  } else {
    const open = await SalesOrder.find({ enquiry: enquiry._id, status: { $in: OPEN_ORDER_STATUSES } }).sort({ createdAt: -1 }).select('_id number').lean();
    if (open.length > 1 && ORDER_BOUND_KINDS.includes(kind) && !system) {
      fail(`This enquiry has ${open.length} open sales orders (${open.map((row) => row.number).join(', ')}) — pick which one this is for`);
    }
    order = open[0] || await SalesOrder.findOne({ enquiry: enquiry._id }).sort({ createdAt: -1 }).select('_id').lean();
  }
  const task = await Todo.create({
    enquiry: enquiry._id,
    customer: enquiry.customer?._id || enquiry.customer,
    ...(order ? { order: order._id } : {}),
    kind,
    department,
    user: assignee || undefined,
    fromDepartment: actingFor(user, holder) || undefined,
    createdBy: user?._id,
    system: !user,
    title: `${handoff.label} — ${await aboutWithName(enquiry)}`,
    notes: text || undefined,
    ...(Object.keys(asked).length ? { brief: asked } : {}),
    /* A department with its own workflow starts the task on its first status. */
    ...(form.statuses?.length ? { status: form.statuses[0].key, statusHistory: [{ status: form.statuses[0].key, by: user?._id, at: new Date() }] } : {}),
    ...(parentTask ? { parentTask } : {}),
    dueDate: due || dueFor(handoff, enquiry),
    priority: PRIORITIES.includes(priority) ? priority : 'normal',
    link: `/enquiries/${enquiry._id}`,
  });
  /* Asked from another department's task (Dispatch asking Production), the enquiry stays where it is. */
  /* Work alongside the order (money, account, audit) does not take over the stage once the order is under way. */
  const aside = SIDE_STAGES.includes(handoff.stage) && enquiry.stage && !SALES_STAGE_KEYS.includes(enquiry.stage);
  if (!keepStage) await moveStage(enquiry, aside ? null : handoff.stage, { user, task, note: text || handoff.label });
  if (openRecords) await openWorkRecord(kind, enquiry, asked);

  await publish(EVENTS.HANDOFF_SENT, { task, enquiry, by: user });
  return task;
}

/**
 * A department task with no enquiry behind it — Admin or a marketing person asking a team for
 * something on its own (a mould trial, a statement for a buyer, a PRT visit on an old balance).
 * The same form as from an enquiry, without the enquiry's answers to fill it: a customer may be
 * named, a member picked, a priority and date set; it lands on the team's queue and works the
 * same way, except for the steps that only make sense on an enquiry (asking its marketing
 * person, raising the next department's task on it), which say so.
 */
export async function raiseTeamTask({ kind, note, brief, priority, requiredDate, customer, user }) {
  if (!(isAdmin(user) || inDepartment(user, 'marketing'))) {
    throw ApiError.forbidden('Only Admin and the marketing team raise team tasks without an enquiry');
  }
  const handoff = findHandoff(kind);
  if (!handoff?.department || handoff.hidden) fail('That is not a department task');
  const picked = await pickedMember(kind, brief);
  const asked = keptBrief(kind, picked.brief, { strict: true });
  assertNote(kind, asked, note);
  /*
   * With no enquiry, the model is all Production, Printing and Assembly have to plan by — the
   * printing and assembly decided for it, the dates given for it [decideRouting].
   */
  if (['ask_edd', 'ask_printing', 'ask_assembling_edd'].includes(kind) && !String(asked.model || asked.models || '').trim()) {
    fail('Name the model — with no enquiry, the team plans by it');
  }
  /* The instruction is optional when the form's answers — the model, the material, the quantity — say what the team should do. */
  const text = String(note || '').trim();
  if (text.length < 3 && !Object.keys(asked).length) fail('Say what the team should do, or fill in what it is about');
  const form = handoff.form || {};
  const due = requiredDue(requiredDate) || (form.dueFrom && requiredDue(asked[form.dueFrom], 'That date')) || endOfDayIST(new Date());

  let buyer = null;
  if (customer) {
    const { default: Customer } = await import('../models/Customer.js');
    buyer = /^[0-9a-f]{24}$/i.test(String(customer)) ? await Customer.findById(customer).select('code name assignedTo') : null;
    /* A marketing person names their own buyers, as everywhere else; Admin any. */
    if (!buyer || (isOwnershipScoped(user) && !ownsRecord(user, buyer))) fail('That customer is not on the register');
  }
  let department = handoff.department;
  let assignee = picked.member?._id;
  if (department === 'owner') ({ userId: assignee, department } = { userId: user._id, department: user.department || 'marketing' });

  /* The first task of its own job: the teams it goes on to carry its id [Todo `chain`]. */
  const _id = new mongoose.Types.ObjectId();
  const task = await Todo.create({
    _id,
    chain: _id,
    customer: buyer?._id,
    kind,
    department,
    user: assignee || undefined,
    fromDepartment: user.department || undefined,
    createdBy: user._id,
    title: `${handoff.label} — ${buyer ? buyer.name : 'team task'}`,
    notes: text || undefined,
    ...(Object.keys(asked).length ? { brief: asked } : {}),
    ...(form.statuses?.length ? { status: form.statuses[0].key, statusHistory: [{ status: form.statuses[0].key, by: user._id, at: new Date() }] } : {}),
    dueDate: due,
    priority: PRIORITIES.includes(priority) ? priority : 'normal',
    link: '/departments/mine',
  });
  await publish(EVENTS.HANDOFF_SENT, { task, enquiry: null, by: user });
  return task;
}

/** What a team task's form can fill without an enquiry: the members to pick, and the named customer's contact. */
export async function teamTaskPrefill(customerId, user) {
  /* The same people who may raise a team task — and a customer's contact only if theirs to see. */
  if (user && !(isAdmin(user) || inDepartment(user, 'marketing'))) {
    throw ApiError.forbidden('Only Admin and the marketing team raise team tasks without an enquiry');
  }
  const members = await membersFor(HANDOFFS.flatMap((handoff) => (handoff.asks || []).filter((field) => field.type === 'member').map((field) => field.department)));
  let customer = { name: '', contactPerson: '', mobile: '', whatsapp: '', delivery: '' };
  if (customerId && /^[0-9a-f]{24}$/i.test(String(customerId))) {
    const { default: Customer } = await import('../models/Customer.js');
    const found = await Customer.findById(customerId).lean();
    if (found && user && isOwnershipScoped(user) && !ownsRecord(user, found)) throw ApiError.notFound('Customer not found');
    if (found) {
      const order = orderContactOf(found);
      const place = [found.address, found.area, found.landmark && `near ${found.landmark}`, found.city, found.state, found.pincode].filter(Boolean).join(', ');
      customer = {
        name: found.name, contactPerson: order.name, mobile: order.phone, whatsapp: order.whatsapp,
        delivery: `${order.name || 'Not added'} · ${order.phone || 'No number'} · ${place || 'Road not selected'}`,
      };
    }
  }
  return {
    customer, items: [], orderItems: [], quoteItems: [], modelList: [], models: '', materials: '', quantity: '', targetPrice: '', order: { paymentTerms: '', invoiceNumber: '' }, members,
    /* No enquiry to fill the models and parts from: the registers, as dropdowns. */
    registers: await registerLists(),
  };
}

/**
 * The buyer's order contact — who places the orders, the person the SO team calls for the SO and
 * the GST: the contact the enquiry names, else the primary contact, else the first; with no name
 * on the customer, the person taken down when it was a prospect. Their number, else the company's
 * — a contact saved from the enquiry check has only a WhatsApp number.
 */
export function orderContactOf(customer, enquiry = null) {
  const contacts = customer?.contacts || [];
  const named = enquiry?.contact ? contacts.find((contact) => String(contact._id) === String(enquiry.contact)) : null;
  const person = named || contacts.find((contact) => contact.isPrimary) || contacts[0] || null;
  const prospect = enquiry?.prospect || {};
  const phone = person?.mobile || person?.whatsapp || customer?.mobile || customer?.whatsapp || prospect.mobile || prospect.whatsapp || '';
  return {
    name: person?.name || prospect.contactPerson || '',
    phone,
    whatsapp: person?.whatsapp || customer?.whatsapp || prospect.whatsapp || phone,
  };
}

/** The registers a team task's form picks from: hanger models (moulds), materials, hooks, clips, prints. */
export async function registerLists() {
  const [{ default: Mould }, { default: Material }, { default: Component }] = await Promise.all([
    import('../models/Mould.js'), import('../models/Material.js'), import('../models/Component.js'),
  ]);
  const [moulds, materials, parts] = await Promise.all([
    Mould.find({ isActive: { $ne: false }, status: { $ne: 'retired' } }).select('mouldCode name').sort({ mouldCode: 1 }).lean(),
    Material.find({ isActive: { $ne: false } }).select('name colour').sort({ name: 1 }).lean(),
    Component.find({ isActive: { $ne: false }, kind: { $in: ['hook', 'clip', 'print'] } }).select('kind name').sort({ name: 1 }).lean(),
  ]);
  const unique = (list) => [...new Set(list.filter(Boolean))];
  /* "PP Black" — but "HIPS White", not "HIPS White White", when the resin's name already says it. */
  const materialName = (row) => (row.colour && !row.name.toLowerCase().includes(row.colour.toLowerCase()) ? `${row.name} ${row.colour}` : row.name);
  const ofKind = (kind) => unique(parts.filter((row) => row.kind === kind).map((row) => row.name));
  return {
    /* "M-101 · 380mm slim shirt hanger" — the code the plant uses, and what the hanger is. */
    moulds: unique(moulds.map((row) => [row.mouldCode, row.name].filter(Boolean).join(' · '))),
    materials: unique(materials.map(materialName)),
    hooks: ofKind('hook'),
    clips: ofKind('clip'),
    prints: ofKind('print'),
  };
}

/**
 * Somebody raises a task the department already has open (Production asked for the EDD by the
 * SO going through, then marketing asks again): the new request goes onto the open task as an
 * update — the note, the answers, an earlier date or a higher priority — and the department is
 * told again, rather than refusing or opening a second task for the same work.
 */
async function addToOpenTask(task, { handoff, note, asked, priority, requiredDate, user }) {
  const answers = describeAnswers(handoff, asked);
  const text = [String(note || '').trim(), answers].filter(Boolean).join(' — ') || 'Asked again';
  task.updates = [...(task.updates || []), {
    kind: 'asked_again', text: String(note || '').trim() || undefined,
    note: `${user?.name || 'Someone'} asked again: ${text}`, by: user?._id, at: new Date(),
  }];
  if (Object.keys(asked).length) {
    task.brief = { ...(task.brief || {}), ...asked };
    task.markModified('brief');
  }
  const due = requiredDue(requiredDate);
  if (due && (!task.dueDate || due < task.dueDate)) task.dueDate = due;
  const rank = { low: 0, normal: 1, high: 2 };
  if (PRIORITIES.includes(priority) && rank[priority] > rank[task.priority || 'normal']) task.priority = priority;
  await task.save();
  task.$locals.addedTo = true;
  await publish(EVENTS.HANDOFF_SENT, { task, enquiry: task.enquiry, by: user });
  return task;
}

/** The form's answers in a line, for an update: "Model name: NPT-410V · Quantity: 5000". */
function describeAnswers(handoff, asked) {
  return (handoff.asks || [])
    .filter((field) => asked[field.key] != null && !Array.isArray(asked[field.key]))
    .map((field) => `${field.label}: ${asked[field.key]}`)
    .join(' · ');
}

/**
 * Hands an enquiry a department still holds (from before department tasks) back to its
 * marketing person: that department is done with it.
 */
async function returnToMarketing({ enquiry, note, fields, user, system }) {
  const current = await holderOf(enquiry._id);
  const owners = current && findHandoff(current.kind)?.department === 'owner';
  if (!current || owners) fail('The enquiry is already with its marketing person');
  if (!system && !(await mayMove(user, enquiry, current))) {
    throw ApiError.forbidden('Only the marketing person, the department that has it or Admin can hand it back.');
  }
  const text = String(note || '').trim();
  const kept = keptFields(current.kind, fields);
  const claimed = await Todo.updateOne({ _id: current._id, completed: false }, {
    $set: {
      completed: true,
      completedAt: new Date(),
      ...(user ? { completedBy: user._id } : {}),
      outcome: {
        result: 'done', note: text || 'Back to marketing', ...(Object.keys(kept).length ? { fields: kept } : {}),
        ...(user ? { by: user._id } : {}), at: new Date(), next: 'back_to_marketing',
      },
    },
  });
  if (!claimed.modifiedCount) throw ApiError.conflict('Someone has just changed this enquiry. Reload to see where it is.');
  const task = await openHolder({ enquiry, kind: 'back_to_marketing', note: text, user, from: actingFor(user, current) });
  await moveStage(enquiry, 'enquiry', { user, task, note: text || 'Back to marketing', heldBy: task.department });
  await publish(EVENTS.HANDOFF_SENT, { task, enquiry, by: user });
  return task;
}

/**
 * Closing ends everything still open on the enquiry, the holding task included, and says so —
 * except an LR task whose copy is in: Reception still says In Transit and Delivered on it, and
 * except a collection or PRT case while money is still owed: the enquiry's work is over, the
 * chase is not, and it closes on its own when the money comes [collections `settleCollectionTasks`].
 *
 * The enquiry's samples still on the bench go the same way [sampling `cancelOpenSamples`]: a
 * sample nobody will collect must not stay on the queue and escalate at five. One the buyer
 * already holds is left alone — its verdict is still worth recording.
 */
async function closeOpenTasks(enquiry, why, user, { except } = {}) {
  const enquiryId = enquiry._id;
  const { cancelOpenSamples } = await import('./sampling.service.js');
  await cancelOpenSamples(enquiry, { note: `${enquiry.number} closed: ${why}`, by: user });
  /* And its quotation [costingRequest `withdrawQuotationsFor`]: Admin is not asked to sign a price on an enquiry that is over. */
  const { withdrawQuotationsFor } = await import('./costingRequest.service.js');
  await withdrawQuotationsFor(enquiry, { note: `${enquiry.number} closed: ${why}`, by: user });
  const open = await Todo.find({
    enquiry: enquiryId, kind: { $exists: true }, completed: false,
    $nor: [{ kind: 'lr_copy', resultFile: { $exists: true } }],
    ...(except ? { _id: { $ne: except } } : {}),
  });
  for (const task of open) {
    if (COLLECTION_KINDS.includes(task.kind) && (await receivablesOf(task)).length) {
      task.updates = [...(task.updates || []), { kind: 'notice', statusLabel: 'Enquiry closed', text: why, note: `The enquiry was closed (${why}) — this case stays open until the money is in.`, by: user?._id, at: new Date() }];
      await task.save();
      continue;
    }
    task.completed = true;
    task.completedAt = new Date();
    if (user) task.completedBy = user._id;
    task.outcome = { result: 'done', note: `Closed with the enquiry: ${why}`, by: user?._id, at: new Date() };
    await task.save();
  }
}

/**
 * Something another record says about the enquiry, written on it: the order booked (won), or
 * what marketing's word for it now is. `forward` keeps a marketing status from pulling the
 * enquiry back — an accepted quotation reads Price approved only on an enquiry not past it.
 */
export async function markEnquiry(enquiry, { marketing, won = false, user, note, forward = false } = {}) {
  if (!enquiry || enquiry.stage === CLOSED_STAGE) return;
  let said = marketing;
  if (said && forward && marketingRank(said) <= marketingRank(marketingStatusOf(enquiry))) said = undefined;
  if (!said && !won) return;
  await moveStage(enquiry, null, { user, note, marketing: said, won });
}

/**
 * Closes an enquiry on nobody's behalf — paid in full with nothing left to send. Recorded as a
 * Task Closed like the button, by the system, with why.
 */
export async function closeEnquiryAutomatically({ enquiry, note, marketing, except }) {
  if (enquiry.stage === CLOSED_STAGE) return null;
  const record = await Todo.create({
    enquiry: enquiry._id,
    customer: enquiry.customer?._id || enquiry.customer,
    kind: 'task_closed',
    department: enquiry.heldBy || 'management',
    system: true,
    title: `${findHandoff('task_closed').label} — ${aboutOf(enquiry)}`,
    notes: note,
    completed: true,
    completedAt: new Date(),
    outcome: { result: 'done', note, at: new Date() },
    link: `/enquiries/${enquiry._id}`,
  });
  await closeOpenTasks(enquiry, note, undefined, { except });
  await moveStage(enquiry, CLOSED_STAGE, { task: record, note, heldBy: null, marketing });
  return record;
}

/**
 * Where a task's own rule moves the enquiry [config/handoffs.js `whenDone`, `whenResult`]: the
 * SO uploaded reads Production, Production finished reads Dispatch, the LR uploaded reads LR
 * Sent — and is closed by a person, with the Close the enquiry screen offers once an LR is in.
 * A closed enquiry is left closed.
 */
async function reachEnquiry(task, user, reach, note) {
  if (!reach || !task.enquiry) return;
  const enquiry = await enquiryOfTask(task);
  if (!enquiry || enquiry.stage === CLOSED_STAGE) return;
  /*
   * Only ever forward. Production closing its task after the goods have gone must not pull an
   * enquiry at LR Copy back to Dispatch; what it still says — an SO uploaded late is still the
   * order booked — stands.
   */
  const current = marketingStatusOf(enquiry);
  if (reach.marketing && marketingRank(reach.marketing) < marketingRank(current)) {
    await moveStage(enquiry, null, { user, task, note: note || task.title, marketing: current, won: Boolean(reach.won) });
    return;
  }
  if (reach.close) {
    await closeEnquiryAutomatically({ enquiry, note: note || task.title, marketing: reach.marketing, except: task._id });
    return;
  }
  await moveStage(enquiry, reach.stage || null, { user, task, note: note || task.title, marketing: reach.marketing, won: Boolean(reach.won) });
}

/**
 * One button pressed on the enquiry screen. Returns the task (or the record, for the buttons
 * that only record). `enquiry` must be a document with `customer` populated or an id.
 */
export async function sendHandoff({ enquiry, kind, note, fields, brief, priority, requiredDate, addToOpen, order, user }) {
  const handoff = findHandoff(kind);
  if (!handoff || handoff.hidden) fail('That is not one of the buttons');

  const text = String(note || '').trim();
  if (enquiry.stage === CLOSED_STAGE && kind !== 'task_closed') {
    fail('This enquiry is closed. Nothing more can be sent on it.');
  }

  /* Every button that names a department raises that department's task. */
  if (handoff.department) {
    const wasHeld = enquiry.stage === 'production_hold';
    const raised = await moveEnquiry({ enquiry, kind, note: text, fields, brief, priority, requiredDate, addToOpen, order, user });
    /* A Production Holded Order moved to Production: the order booked from its SO request goes to the plant too. */
    if (wasHeld && kind === 'ask_edd') {
      const { releaseHeldOrders } = await import('./soFromTask.service.js');
      for (const result of await releaseHeldOrders(enquiry._id, user)) {
        const said = result.released ? `${result.order.number} released to production` : `${result.order.number} not released yet: ${result.problem || 'not ready'}`;
        await Todo.updateOne({ _id: raised._id }, { $push: { updates: { kind: 'notice', statusLabel: 'Sales order', text: said, note: said, by: user._id, at: new Date() } } }, { keepVersion: true });
        if (result.released && !raised.order) await Todo.updateOne({ _id: raised._id }, { $set: { order: result.order._id } }, { keepVersion: true });
      }
    }
    return raised;
  }

  if (!(await mayHandOff(user, enquiry))) throw ApiError.notFound('Enquiry not found');

  /* Sent for the department that has the enquiry when the sender works there too. */
  const sender = actingFor(user, await holderOf(enquiry._id));
  const base = {
    enquiry: enquiry._id,
    customer: enquiry.customer?._id || enquiry.customer,
    kind,
    fromDepartment: sender || undefined,
    createdBy: user._id,
    link: `/enquiries/${enquiry._id}`,
  };

  /* The buttons that record rather than ask: nothing lands on anybody's queue. */
  if (kind === 'task_closed') {
    if (text.length < 3) fail('Say why it is being closed');
    if (!(await mayMove(user, enquiry))) throw ApiError.forbidden('Only whoever has the enquiry, its marketing person or Admin can close it.');
  }
  const record = await Todo.create({
    ...base,
    department: sender || 'management',
    user: user._id,
    title: `${handoff.label} — ${aboutOf(enquiry)}`,
    notes: text || undefined,
    completed: true,
    completedAt: new Date(),
    completedBy: user._id,
    outcome: { result: 'done', note: text || undefined, by: user._id, at: new Date() },
  });

  if (kind === 'task_closed') await closeOpenTasks(enquiry, text, user);
  await moveStage(enquiry, handoff.stage, {
    user, task: record, note: text || handoff.label, heldBy: kind === 'task_closed' ? null : undefined,
  });
  return record;
}

function openHandoff(task, user) {
  /* A department task — about an enquiry, or raised for the team without one [raiseTeamTask]. */
  if (!task.kind) fail('That is not a department task');
  if (task.completed) throw ApiError.conflict('That task is already finished');
  if (!mayWorkOnHandoff(user, task)) {
    throw ApiError.forbidden(`This task is on the ${departmentName(task.department)} queue`);
  }
}

/**
 * Whether this task's order waits with marketing instead of going on to Production: the SO
 * request was sent without Production confirmed ticked [config/handoffs.js po_so `holdUnless`].
 */
export const heldBack = (task) => {
  const flag = findHandoff(task?.kind)?.holdUnless;
  return Boolean(flag && task.brief?.[flag] !== 'Yes');
};

/**
 * Who may send a Production Holded Order on to Production: Admin, or the enquiry's marketing
 * person — whoever it is with now, so a delegated enquiry is its new owner's to move.
 */
export const mayReleaseHeld = (user, enquiry) => isAdmin(user) || idOf(enquiry.assignedTo) === idOf(user?._id);

const enquiryOfTask = async (task) => {
  const enquiry = await Enquiry.findById(task.enquiry?._id || task.enquiry).populate('customer', 'code name');
  if (!enquiry) throw ApiError.notFound('Enquiry not found');
  return enquiry;
};

/**
 * Done. On the enquiry's holding task, done means "moved on": say what was done, and where it
 * goes next — the next department has it from here. A side request is simply done, and the
 * sender gets it back.
 */
export async function completeHandoff(task, user, { note, fields = {}, next, system = false, quiet = false }) {
  /* `system`: the app closing it because the work is recorded elsewhere (the sample sent). */
  if (system) {
    if (task.completed) return task;
  } else openHandoff(task, user);
  const text = String(note || '').trim();
  if (text.length < 2) fail('Say what was done');

  /*
   * A department that still holds an enquiry (from before department tasks) is done with it: it
   * goes back to its marketing person — and on to the next department's task, when one is named.
   * Marketing's own holding task is the enquiry itself; it ends with Task Closed.
   */
  if (task.holds) {
    if (findHandoff(task.kind)?.department === 'owner') {
      fail('The enquiry stays with its marketing person. Raise a department task, or close it with Task Closed.');
    }
    if (next && (!findHandoff(next)?.department || findHandoff(next).hidden)) fail('That is not a next step');
    const enquiry = await enquiryOfTask(task);
    await returnToMarketing({ enquiry, note: text, fields, user, system: true });
    if (next && next !== 'back_to_marketing') await moveEnquiry({ enquiry, kind: next, note: text, user, system: true });
    return Todo.findById(task._id);
  }

  /* The app closing it (the consignment left) is not held back; a person's Done is. */
  if (!system) await assertNotWaiting(task);
  await assertMayFinish(task);

  const handoff = findHandoff(task.kind);
  const kept = keptFields(task.kind, fields);
  /* A collection finished from Done rather than "Buyer collected" still says who took the sample — before anything is saved. */
  if (task.kind === 'sample_collect' && task.brief?.sample && !String(kept.collectorName || '').trim() && !String(kept.collectorPhone || '').trim()
    && (await sampleOfTask(task))?.status !== 'delivered') {
    fail('Mark it Sample handed first — say who received the sample, their name or phone');
  }
  /*
   * Done on a task with its own workflow is that workflow's last status (Task Closed): the card
   * shows it, and the enquiry's marketing person and Admin are told, as when it is chosen from
   * the list — not "done" beside whatever status it last had.
   */
  const closing = !system && statusesOf(task).find((entry) => entry.done && !entry.pdf);
  const closesNow = Boolean(closing && task.status !== closing.key);
  if (closesNow) {
    task.status = closing.key;
    task.statusHistory = [...(task.statusHistory || []), { status: closing.key, note: text, by: user._id, at: new Date() }];
  }
  task.completed = true;
  task.completedAt = new Date();
  task.completedBy = user._id;
  if (!task.user) task.user = user._id;
  task.outcome = {
    result: 'done', note: text, fields: Object.keys(kept).length ? kept : undefined, by: user._id, at: new Date(),
  };
  await task.save();

  /* The sample collected at the desk is with the buyer now; the record says who took it. */
  if (task.kind === 'sample_collect') await collectedAtDesk(task, user, kept);

  /* The enquiry moves where this task's finishing says it does — before anybody is told. */
  await reachEnquiry(task, user, heldBack(task) ? handoff.whenHeld : handoff?.whenDone, text);
  if (closesNow && handoff?.form?.notifyStatus) await noticeStatus(task, user, { step: closing, note: text });
  const details = (handoff?.records || []).filter((field) => kept[field.key]).map((field) => `${field.label}: ${kept[field.key]}`);
  /* A clarification's answer goes back onto the task that asked; anything else, to its sender. */
  if (task.parentTask) await answerParent(task, user, text);
  /* `quiet`: whoever asked is already told another way (the sample's own feedback task). */
  else if (!quiet) {
    await backToSender(task, {
      user,
      title: `Done: ${task.title} — next step?`,
      notes: [`${user.name}: ${text}`, ...details].join('\n'),
    });
  }
  await publish(EVENTS.HANDOFF_DONE, { task, by: user });
  /* The journey goes on: the last finishing team done → Quality; Quality done → Dispatch [journey.service]. */
  await nextOnJourney(task, user, text);
  return task;
}

/** The next step of the order's journey, once a finishing team or Quality is through [journey.service]. */
async function nextOnJourney(task, user, why) {
  const { advanceJourney } = await import('./journey.service.js');
  return advanceJourney(task, user, why);
}

/** What has to be true before a task is finished — checked before anything about it changes. */
/**
 * Asked Production or Assembling for its readiness [`askFromTask`]: the answer is theirs to
 * give, so this task stays at "Asked …" — no other status, not done — until that task is
 * closed; then it moves on from here.
 */
async function assertNotWaiting(task) {
  /* Only an ask the task waits on (Dispatch's readiness asks) holds its status; Production's asks do not. */
  const actions = (findHandoff(task.kind)?.form?.actions || []).filter((action) => action.waits);
  if (!actions.length) return;
  const waiting = await Todo.findOne({ askedFrom: task._id, completed: false, kind: { $in: actions.map((action) => action.kind) } }).select('kind department');
  if (!waiting) return;
  const action = actions.find((entry) => entry.kind === waiting.kind);
  fail(`Waiting on ${departmentName(waiting.department)} — ${action?.label || 'the task asked'} is still open. The status changes once that task is closed.`);
}

async function assertMayFinish(task) {
  /* A task finished by uploading the work (the sales order) is not ticked off without it. */
  const byUpload = (findHandoff(task.kind)?.form?.statuses || []).find((entry) => entry.pdf && entry.done);
  if (byUpload && !task.resultFile) fail(`Upload the PDF to finish this task — it is marked ${byUpload.label} then`);
  /*
   * Dispatch closes its task when it says the goods have gone. The plant runs dispatch from the
   * task's own statuses and updates, not from consignments on the Dispatch screen, so an order's
   * consignment balance is not a reason to refuse — it would count lots the team never records
   * there. (A consignment leaving still finishes the task by itself once nothing is left.)
   */
}

/**
 * The sample has gone out [sample.dispatched]: the Sample Request task on its enquiry is done,
 * with the despatch details the sample team entered — the courier and AWB, or who it was
 * handed to, and how many pieces. Marketing already gets "Chase feedback" from the sample
 * itself, so no second "done — next step?" task.
 */
export async function finishSampleTasks(sample, by) {
  const enquiryId = sample?.enquiry?._id || sample?.enquiry;
  if (!enquiryId) return [];
  const tasks = await Todo.find({ enquiry: enquiryId, kind: 'sample_request', completed: false, holds: { $ne: true } });
  if (!tasks.length) return [];
  const direct = sample.deliveryMethod === 'direct';
  const count = sample.dispatchedQuantity || sample.piecesToMake;
  const pieces = count ? String(count) : undefined;
  const fields = direct
    ? { courier: 'Direct handover', pieces }
    : { courier: sample.courier, awbNumber: sample.awbNumber, pieces };
  const how = direct
    ? `handed over to ${[sample.handedTo, sample.recipientPhone].filter(Boolean).join(' · ') || 'the buyer'}`
    : `by ${sample.courier || 'courier'}${sample.awbNumber ? ` · AWB ${sample.awbNumber}` : ''}`;
  const note = `Sample ${sample.number} sent ${how}${pieces ? ` · ${pieces} pcs` : ''}`;
  return finishAll(tasks, by, { note, fields });
}

/** Each task done by the app, with what was recorded elsewhere; whoever asked hears it as done. */
async function finishAll(tasks, by, { note, fields }) {
  const done = [];
  for (const task of tasks) {
    done.push(await completeHandoff(task, by || {}, { note, fields, system: true, quiet: true }));
  }
  return done;
}

/**
 * The quotation has gone to the buyer [quotation.sent]: the pricing tasks on its enquiry — Create
 * Quotation and Price Negotiation — are done, with the quotation's number and price. Marketing
 * already gets "Follow up on …" from the quotation itself.
 */
export async function finishQuotationTasks(quotation, by) {
  const enquiryId = quotation?.enquiry?._id || quotation?.enquiry;
  if (!enquiryId) return [];
  const tasks = await Todo.find({
    enquiry: enquiryId, kind: { $in: ['create_quotation', 'price_negotiation'] }, completed: false, holds: { $ne: true },
  });
  if (!tasks.length) return [];
  const price = quotation.soleLine?.unitPrice;
  const fields = { quotationNumber: quotation.number, ...(price != null ? { price: String(price) } : {}) };
  const note = `${quotation.number}${quotation.revision ? ` rev ${quotation.revision}` : ''} sent to the buyer${price != null ? ` at ₹${price}` : ''}`;
  return finishAll(tasks, by, { note, fields });
}

/* ------------------------------ A department's own workflow ------------------------------ */

const statusesOf = (task) => findHandoff(task.kind)?.form?.statuses || [];

/** The answer to a clarification, on the task that asked — and that task back where it was. */
async function answerParent(clarification, user, text) {
  const parent = await Todo.findById(clarification.parentTask);
  if (!parent || parent.completed) return;
  const asking = statusesOf(parent).find((entry) => entry.raises === clarification.kind);
  parent.updates = [...(parent.updates || []), { note: `Clarified by ${user.name}: ${text}`, by: user._id, at: new Date() }];
  /* At the top of the asking department's dashboard until somebody there acts on it. */
  parent.attention = { kind: 'reply', note: text, by: user._id, at: new Date() };
  if (asking && parent.status === asking.key) {
    /* Back to whatever it was before the question was asked. */
    const before = [...(parent.statusHistory || [])].reverse().find((entry) => entry.status !== asking.key)?.status
      || statusesOf(parent)[0]?.key;
    parent.status = before;
    parent.statusHistory = [...(parent.statusHistory || []), { status: before, note: 'Clarification answered', by: user._id, at: new Date() }];
  }
  await parent.save();
  await publish(EVENTS.HANDOFF_UPDATED, { task: parent, by: user });
}

/**
 * The department moves its task along its own workflow [config/departmentTaskForms.js
 * `statuses`]. A status that needs a comment asks for one; one that raises a task asks the
 * enquiry's marketing person, due today, with the comment. The status reached by uploading the
 * work (SO Prepared) is not chosen here — see `finishWithResult`.
 */
export async function setTaskStatus(task, user, { status, note, date, fields, models }) {
  openHandoff(task, user);
  const form = findHandoff(task.kind)?.form || {};
  const step = statusesOf(task).find((entry) => entry.key === status);
  if (!step) fail('That is not one of this task’s statuses');
  if (step.pdf) fail(`Upload the PDF to mark it ${step.label}`);
  const text = String(note || '').trim();
  /* What the status asks for beside the remark — who collected the sample, how many pieces. */
  const asked = stepFields(step, fields);
  if (step.comment && text.length < 3) fail(`Say what is needed — ${step.label} asks for a comment`);
  if (form.remarkRequired && text.length < 3) fail(`Add a remark to move it to ${step.label}`);
  const readyDate = statusDate(form, step, date);
  /* Production says what follows it before it gives any date [decideRouting]. */
  if (readyDate) assertRouted(task);
  /* A task of several models moves model by model: the ones named, or every one [Todo `modelStatuses`]. */
  const { byModel, moving, partial, after, overall, finishes } = modelMove(task, step, models);
  const unchanged = byModel ? task.status === overall && after.every((row, at) => row.status === modelStatusesOf(task)[at].status) : task.status === status;
  /* The same status again says nothing new — except money confirmed in, which is more money each time. */
  if (unchanged && !readyDate && !step.confirmsInward) return task;
  await assertNotWaiting(task);
  /* Refused before the status moves, so a refusal leaves the task where it was. */
  if (finishes) await assertMayFinish(task);
  /* Handed to Printing / Assembly only where a model was routed there [decideRouting]. */
  if (step.handsTo && !handsOnOf(task).includes(step.handsTo)) {
    fail(`Nothing on this order goes to ${ROUTE_LABEL[step.handsTo] || step.handsTo} — ${task.kind === 'ask_edd' ? 'change the printing / assembly decision first' : 'Production did not route it there'}`);
  }
  if (step.handsTo && partial) {
    const routes = await modelRoutes(task);
    const off = moving.filter((model) => routes.size && !goesTo(task, routes.get(model), step.handsTo));
    if (off.length) fail(`${off.join(', ')} ${off.length > 1 ? 'do' : 'does'} not go to ${ROUTE_LABEL[step.handsTo] || step.handsTo} — Production routed ${off.length > 1 ? 'them' : 'it'} elsewhere`);
  }
  /* "Part 1 Ready · CRF25" — the move said with the models it was for. */
  const label = partial ? `${step.label} · ${moving.join(', ')}` : step.label;

  if (step.raises) await raiseFromStatus(task, user, step, text);
  /* The sample handed at the desk: written onto the sample first, so a refusal leaves the task where it was. */
  if (step.handsOver) await handedAtDesk(task, user, asked);
  /* Payment Collection confirms the money in: the receipt first, so a refusal (more than owed) leaves the task where it was. */
  if (step.confirmsInward && task.kind !== 'team_payment_followup') fail('Payment Collection confirms the payment inward, on its own task');
  const inward = step.confirmsInward ? await confirmInwardFromTask(task, user, { ...asked, note: text }) : null;
  task.status = overall;
  /* Each model's own status is kept once one has moved on its own; the task reads its slowest. */
  if (byModel && (partial || task.modelStatuses?.length)) {
    const now = new Date();
    task.modelStatuses = after.map((row) => (partial && !moving.includes(row.model)
      ? row
      : { model: row.model, status, note: text || undefined, by: user._id, at: now }));
  }
  task.attention = undefined;
  /* The suggestion was about what to do next; a move is somebody doing it. */
  if (task.suggestion) task.suggestion = undefined;
  task.statusHistory = [...(task.statusHistory || []), { status, note: text || undefined, date: readyDate || undefined, ...(partial ? { models: moving } : {}), by: user._id, at: new Date() }];
  /* A promise is when the money is due next, a visit is when PRT goes: the task falls due that day [collections.service]. */
  if ((step.promise || step.visit) && readyDate) task.dueDate = endOfIndiaDay(readyDate);
  /* A team that hands on gives a hand-over date, not the EDD [decideRouting]. */
  const handsOn = handsOnOf(task);
  const dateText = handsOn.length ? dateLabelOf(task) : form.statusDate?.label || 'Ready date';
  const said = [label, readyDate && `${dateText} ${readyDate}`].filter(Boolean).join(' · ');
  /* A ready date is the enquiry's EDD (Production) or ERD (the mould) from here on [enquiryProgress]. */
  const dateField = handsOn.length ? 'handover' : form.statusDate?.field || 'edd';
  task.updates = [...(task.updates || []), {
    kind: 'status', status: step.key, statusLabel: label, text: text || undefined,
    ...(readyDate ? { date: readyDate, dateLabel: handsOn.length ? 'Hand-over' : form.statusDate?.label || 'Ready date' } : {}),
    note: text ? `${said}: ${text}` : said, ...(readyDate ? { fields: { [dateField]: readyDate } } : {}), by: user._id, at: new Date(),
  }];
  if (!task.user) task.user = user._id;
  await task.save();
  /* A ready date with a status counts for every model on the task; each model's EDD is its teams' latest. */
  if (readyDate && (dateField === 'edd' || dateField === 'handover') && EDD_TASK_KINDS.includes(task.kind)) {
    recordModelDates(task, user, (partial ? moving : modelsOfTask(task).length ? modelsOfTask(task) : ['All models']).map((model) => ({ model, date: readyDate })));
    await task.save();
    if (dateField === 'handover') await passHandover(task, user, readyDate, text);
    if (task.enquiry) await refreshModelEdds(task.enquiry, user, text);
  } else if (readyDate && dateField === 'edd' && task.enquiry) {
    await writeEnquiryEdd(task.enquiry, { day: readyDate, user, department: task.department, note: text });
  }
  if (form.notifyStatus) await noticeStatus(task, user, { step: partial ? { ...step, label } : step, note: text, date: readyDate });
  await publish(EVENTS.HANDOFF_UPDATED, { task, by: user });
  /* A status that hands on (Dispatched → Reception's LR copy) raises the next task, once. */
  if (step.next && !step.pdf) {
    if (task.enquiry) await raiseNextFrom(task, user, step, text);
    /* A job with no enquiry goes on the same way: Dispatched gives Reception the LR copy. */
    else await raiseNextOnChain(task, user, step, text);
  }
  /* Goods said to have gone from the task alone: the consignment and its invoice still have to be recorded. */
  if (step.next === 'lr_copy' && task.order) await remindConsignment(task, user, step);
  /* Production or Assembly saying the goods are ready reaches the Dispatch request waiting on them. */
  if (step.readyForDispatch) await tellDispatchReady(task, user, { ...step, label }, text, { partial });
  /* The goods handed to the next team: its task hears it, with the day they came [handOn]. */
  if (step.handsTo) {
    await handOn(task, user, step, text, partial ? moving : null);
    await nextOnJourney(task, user, `${label}${text ? ` — ${text}` : ''}`);
  }
  /* Goods ready from the last finishing team: Quality, then Dispatch, are asked [journey.service]. */
  if (step.readyForDispatch && !step.done) await nextOnJourney(task, user, `${label}${text ? ` — ${text}` : ''}`);
  /* Some models closed, others still going: a model done may be enough to go on [Enquiry `dispatchPlan`]. */
  if (step.done && !finishes) await nextOnJourney(task, user, `${label}${text ? ` — ${text}` : ''}`);
  /* The Mould team saying the tool is ready reaches Production. */
  if (step.tells && task.enquiry) await tellOpenTasks(task, user, step, text, step.tells);
  /* Accounts confirming a payment the order is still held for: somebody has to record it. */
  if (step.recordsPayment && task.enquiry) await askToRecordPayment(task, user, step);
  /* A collection case: the move is a call on the receivable's log, a promise its promised date. */
  if (step.followUp || step.promise) await logCollectionCall(task, user, step, text, readyDate);
  /* Money taken: whoever took it records the receipt in Payments; Accounts confirms it there. */
  if (step.recordsReceipt) await askToRecordReceipt(task, user, step);
  /* The sample is at the desk: it reads ready before the buyer is told so. */
  if (step.sampleReady) await readyAtDesk(task, user);
  /* Money confirmed in: a stage now covered closes this task and tells marketing to release the order [paymentGates `afterPayment`]. */
  if (inward && !inward.again) {
    await afterPayment(inward.order._id);
    return (await Todo.findById(task._id)) || task;
  }
  /* A status that tells the buyer something — "your sample is ready to collect" — sends it from here. */
  if (step.tellBuyer) await tellBuyerFromTask(task, user, step);
  /* The last status finishes the task (Task Closed), and its sender hears it is done. */
  if (finishes) return completeHandoff(task, user, { note: text || step.label, fields: { ...asked, ...(readyDate ? { [dateField]: readyDate } : {}) } });
  return task;
}

/**
 * Where each model of a Production, Printing or Assembly task of several models is: its own
 * status once it has moved on its own, else the task's. Empty for a task of one model.
 */
export function modelStatusesOf(task) {
  const models = modelsOfTask(task);
  if (models.length < 2 || !EDD_TASK_KINDS.includes(task.kind)) return [];
  const kept = new Map((task.modelStatuses || []).map((row) => [row.model, row]));
  const fallback = task.status || statusesOf(task)[0]?.key;
  return models.map((model) => {
    const row = kept.get(model);
    return row ? { model, status: row.status, note: row.note, by: row.by, at: row.at } : { model, status: fallback };
  });
}

/** The task's status from its models': a model at an issue first, else the one least far on. */
export function slowestStatus(task, rows) {
  const statuses = statusesOf(task);
  const rank = (key) => {
    const at = statuses.findIndex((entry) => entry.key === key);
    return statuses[at]?.issue ? -1 : at;
  };
  return rows.reduce((low, row) => (rank(row.status) < rank(low) ? row.status : low), rows[0]?.status);
}

/** What a move does to a task's models: which move, each model's status after, and the task's. */
function modelMove(task, step, models) {
  const own = modelStatusesOf(task);
  if (!own.length) return { byModel: false, moving: [], partial: false, after: [], overall: step.key, finishes: Boolean(step.done) };
  const names = own.map((row) => row.model);
  const named = [...new Set((Array.isArray(models) ? models : []).map((model) => String(model || '').trim()).filter(Boolean))];
  const stray = named.filter((model) => !names.includes(model));
  if (stray.length) fail(`${stray.join(', ')} is not one of this task’s models (${names.join(', ')})`);
  const moving = named.length ? named : names;
  const partial = moving.length < names.length;
  const after = own.map((row) => (moving.includes(row.model) ? { ...row, status: step.key } : row));
  const isDone = (key) => Boolean(statusesOf(task).find((entry) => entry.key === key)?.done);
  const finishes = Boolean(step.done) && after.every((row) => isDone(row.status));
  return { byModel: true, moving, partial, after, overall: finishes ? step.key : slowestStatus(task, after), finishes };
}

/** Production's routing rows by model — on its own task, or the enquiry's latest Production task. */
async function modelRoutes(task) {
  const rows = task.kind === 'ask_edd'
    ? task.routing?.models
    : (await Todo.findOne({ ...jobFilter(task), kind: 'ask_edd' }).sort({ createdAt: -1 }).select('routing').lean())?.routing?.models;
  return new Map((rows || []).filter((row) => row?.model).map((row) => [row.model, row]));
}

/** Whether this team hands a model to `team`: Production to Printing, or to Assembly when not printed; Printing to Assembly. */
const goesTo = (task, row, team) => {
  if (!row) return false;
  if (team === 'printing') return task.kind === 'ask_edd' && Boolean(row.printing);
  if (team === 'assembling') return Boolean(row.assembly) && (task.kind === 'ask_printing' || !row.printing);
  return false;
};

/** The answers a status asks for [departmentTaskForms `statuses[].fields`], required ones refused when blank. */
function stepFields(step, fields = {}) {
  const kept = {};
  for (const field of step.fields || []) {
    const raw = fields?.[field.key];
    const text = raw == null ? '' : String(raw).trim().slice(0, 200);
    if (!text) {
      if (field.required) fail(`${field.label} is needed to mark it ${step.label}`);
      continue;
    }
    if (field.type === 'number' && !(Number(text) >= 0)) fail(`${field.label} must be a number`);
    if (field.options && !field.options.includes(text)) fail(`${field.label} is one of ${field.options.join(', ')}`);
    kept[field.key] = text;
  }
  return kept;
}

/** The sample a desk task is about: on its brief, by id. */
async function sampleOfTask(task) {
  const id = task.brief?.sample;
  if (!id) return null;
  const { default: Sample } = await import('../models/Sample.js');
  return Sample.findById(id);
}

/**
 * Reception telling the buyer the sample is waiting at the desk [departmentTaskForms
 * `sample_collect` → `informed`]: the customer message goes on every channel the buyer accepts,
 * from the company number, and the moment is kept on the sample. Never fails the move.
 */
async function tellBuyerFromTask(task, user, step) {
  const sample = await sampleOfTask(task);
  if (!sample) return;
  try {
    const { notifyCustomer } = await import('./customerMessage.service.js');
    await notifyCustomer({ sample, event: step.tellBuyer, user });
    sample.collection = { ...(sample.collection?.toObject?.() || sample.collection || {}), informedAt: new Date() };
    await sample.save();
  } catch (error) {
    console.error(`[sample-collect] buyer notice for ${sample.number} not sent: ${error.message}`);
  }
}

/**
 * A sample the buyer collects at reception: Reception gets the task on the enquiry — the bag, the
 * pieces, the buyer to call. Raised when such a sample is asked for (an internal sample, which
 * the bench never sees), or when the bench marks an older one ready [sample.controller
 * `setSampleStatus`]. Any bench task on it closes — the desk has it now. Idempotent: the open
 * desk task is returned rather than a second raised.
 */
export async function raiseCollection(sample, user, { note, priority, requiredDate } = {}) {
  if (sample.handover !== 'collect') return null;
  const enquiryId = sample.enquiry?._id || sample.enquiry;
  if (!enquiryId) return null;
  const enquiry = await Enquiry.findById(enquiryId).populate('customer', 'name mobile whatsapp email contacts');
  if (!enquiry) return null;
  const open = await Todo.findOne({ enquiry: enquiry._id, kind: 'sample_collect', completed: false, 'brief.sample': String(sample._id) });
  if (open) return open;
  const buyer = enquiry.customer;
  const primary = buyer?.contacts?.find((contact) => contact.isPrimary) || buyer?.contacts?.[0];
  const models = (sample.items?.length ? sample.items : [sample]).map((row) => [row.modelNumber, row.colour, row.quantity ? `${row.quantity} pcs` : null].filter(Boolean).join(' · ')).filter(Boolean).join('; ');
  const ready = sample.status === 'sample_ready';
  const said = String(note || '').trim();
  const task = await moveEnquiry({
    enquiry, kind: 'sample_collect', user, system: true, openRecords: false, addToOpen: true,
    /* Asked for at the desk, the enquiry is at the sample stage now; a bench sample reaching the desk keeps it where it is. */
    keepStage: ready,
    note: [
      ready
        ? `Sample ${sample.number} is ready — the buyer collects it at reception. Tell them, hand it over, and record who took it.`
        : `Internal sample ${sample.number} — the buyer collects it at reception. Note it, get it ready, hand it over, and record who took it.`,
      said,
    ].filter(Boolean).join(' — '),
    brief: {
      sample: String(sample._id), sampleNumber: sample.number, models: models || sample.modelNumber || '—',
      pieces: String(sample.quantity || sample.items?.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0) || 1),
      buyerContact: [buyer?.name, primary?.name, primary?.phone || buyer?.whatsapp || buyer?.mobile].filter(Boolean).join(' · ') || '—',
    },
    priority: PRIORITIES.includes(priority) ? priority : 'normal',
    requiredDate,
  });
  if (task?._id) await Todo.updateOne({ _id: task._id }, { $set: { link: `/samples/${sample._id}` } }, { keepVersion: true });
  /* The bench is done with it: its task closes with where the piece went, and the row leaves its queue. */
  const benchTasks = await Todo.find({ enquiry: enquiry._id, kind: 'sample_request', completed: false, holds: { $ne: true } });
  if (benchTasks.length) await finishAll(benchTasks, user, { note: `Sample ${sample.number} — with reception for the buyer to collect`, fields: { courier: 'Collected at reception', pieces: String(sample.quantity || '') } });
  if (ready) sample.collection = { ...(sample.collection?.toObject?.() || sample.collection || {}), readyAt: new Date() };
  if (!sample.benchClosedAt) {
    sample.benchClosedAt = new Date();
    sample.benchClosedBy = user?._id;
  }
  await sample.save();
  return task;
}

/** Reception has the piece at the desk [`sample_collect` → Sample ready]: the sample reads ready. */
async function readyAtDesk(task, user) {
  const sample = await sampleOfTask(task);
  if (!sample || CLOSED_DESK_STATUSES.includes(sample.status)) return;
  const from = sample.status;
  if (from !== 'sample_ready') {
    sample.status = 'sample_ready';
    sample.statusHistory.push({ from, to: 'sample_ready', by: user._id, note: `Ready at reception for the buyer to collect (${task.number || 'desk task'})` });
  }
  sample.collection = { ...(sample.collection?.toObject?.() || sample.collection || {}), readyAt: sample.collection?.readyAt || new Date() };
  await sample.save();
}
const CLOSED_DESK_STATUSES = ['delivered', 'dispatched', 'feedback_received', 'approved', 'rejected', 'closed', 'cancelled'];

/**
 * Reception handed it over [`sample_collect` → Sample handed]: who received it, how many, the
 * slip photo where one was uploaded — onto the sample, which is with the buyer from here.
 */
async function handedAtDesk(task, user, asked = {}) {
  const sample = await sampleOfTask(task);
  if (!sample || sample.status === 'delivered') return;
  try {
    await collectedAtDesk(task, user, asked);
  } catch (error) {
    fail(error.message);
  }
}

/**
 * Reception finished its collection task [`sample_collect` → Buyer collected]: the hand-over goes
 * onto the sample — who took it, how many, the photo of the slip where one was uploaded — and the
 * sample is with the buyer from here [sampling.service `recordHandover`].
 */
async function collectedAtDesk(task, user, kept = {}) {
  const sample = await sampleOfTask(task);
  if (!sample || sample.status === 'delivered') return;
  const { recordHandover } = await import('./sampling.service.js');
  const { default: Attachment } = await import('../models/Attachment.js');
  const photo = await Attachment.findOne({ task: task._id, docType: 'handover_photo' }).sort({ createdAt: -1 }).select('_id');
  await recordHandover(sample, user, {
    receivedBy: kept.collectorName, phone: kept.collectorPhone, pieces: kept.pieces,
    note: task.outcome?.note, photo: photo?._id, via: 'desk',
  });
}

/**
 * Dispatch marked the goods gone on its task, but the order has no consignment behind it: the
 * invoice, the receivable Payment Collection chases and the order's dispatched quantity all come
 * from the consignment [controllers/dispatch.controller], so whoever said it has gone is asked to
 * record it — once per order.
 */
async function remindConsignment(task, user, step) {
  const { default: Dispatch } = await import('../models/Dispatch.js');
  const { default: SalesOrder } = await import('../models/SalesOrder.js');
  const { raiseTask } = await import('./task.service.js');
  const orderId = task.order?._id || task.order;
  if (await Dispatch.exists({ order: orderId, status: { $ne: 'cancelled' } })) return;
  const order = await SalesOrder.findById(orderId).select('number');
  await raiseTask({
    user: user._id,
    title: `Record the consignment for ${order?.number || 'the order'} — ${step.label} on the task, nothing on the Dispatch screen`,
    notes: 'The invoice, what the buyer owes and the order\'s dispatched quantity all come from the consignment. Raise it on the Dispatch screen with the invoice number, date and value, and mark it dispatched there.',
    priority: 'high',
    dueDate: new Date(),
    link: `/orders/${orderId}`,
    originKey: `record-consignment:${orderId}`,
  }).catch(() => null);
}

/**
 * The task a status raises [config/departmentTaskForms.js `raises`]: on the enquiry when the
 * task has one — a clarification's answer comes back onto this task — and otherwise, for a team
 * task raised on a buyer alone, straight onto the other department's queue with the same
 * customer and order. A status that also finishes this task (Escalated to PRT) hands the case
 * on rather than asking a question, so the new task is not a child of a closed one.
 */
async function raiseFromStatus(task, user, step, text) {
  const target = findHandoff(step.raises);
  const brief = {};
  /* What this task knew that the next asks for too — the payment contact onto the PRT case. */
  for (const field of target?.asks || []) {
    if (task.brief?.[field.key] && !['member', 'info', 'kind', 'items'].includes(field.type)) brief[field.key] = task.brief[field.key];
  }
  if (task.enquiry) {
    const enquiry = await enquiryOfTask(task);
    return moveEnquiry({
      enquiry, kind: step.raises, note: `${user.name}: ${text}`, user, system: true, openRecords: false,
      requiredDate: new Date(), parentTask: step.done ? undefined : task._id, order: task.order, brief,
    });
  }
  if (!target?.department || target.department === 'owner') {
    fail(`${step.label} asks the enquiry's marketing person — this task has no enquiry. Ask whoever raised it instead.`);
  }
  const form = target.form || {};
  const { default: Customer } = await import('../models/Customer.js');
  const buyer = task.customer?.name ? task.customer : await Customer.findById(task.customer?._id || task.customer).select('name').lean();
  return Todo.create({
    customer: task.customer?._id || task.customer || undefined,
    order: task.order?._id || task.order || undefined,
    kind: step.raises,
    department: target.department,
    fromDepartment: actingFor(user, task) || undefined,
    createdBy: user._id,
    title: `${target.label} — ${buyer?.name || 'team task'}`,
    notes: `${user.name}: ${text}`,
    ...(Object.keys(brief).length ? { brief } : {}),
    ...(form.statuses?.length ? { status: form.statuses[0].key, statusHistory: [{ status: form.statuses[0].key, by: user._id, at: new Date() }] } : {}),
    ...(step.done ? {} : { parentTask: task._id }),
    dueDate: endOfDayIST(new Date()),
    priority: task.priority === 'high' ? 'high' : 'normal',
    link: '/departments/mine',
  });
}

/**
 * A department asks another from its own task — Dispatch's "Ask Production" [config/
 * departmentTaskForms.js `actions`]: that department's task is raised on the enquiry (or the
 * request added to the one it already has), this task says so, and — where the action names a
 * status — moves to it, with the enquiry's marketing person and Admin told as for any move.
 */
export async function askFromTask(task, user, { kind, note, brief, priority, requiredDate }) {
  openHandoff(task, user);
  const form = findHandoff(task.kind)?.form || {};
  const action = (form.actions || []).find((entry) => entry.kind === kind);
  if (!action) fail('This task does not ask that department');
  const text = String(note || '').trim();
  if (text.length < 3) fail(`Say what you need — ${action.label}`);
  if (!task.enquiry) fail(`${action.label} raises a task on the enquiry — this task has no enquiry. Raise a team task instead.`);
  const enquiry = await enquiryOfTask(task);
  const asking = departmentName(task.department);
  const raised = await moveEnquiry({
    enquiry, kind, note: `${asking} asks (${user.name}): ${text}`, user, system: true, openRecords: false,
    brief, priority, requiredDate, addToOpen: true, keepStage: true, order: task.order,
  });
  /* The task asked remembers who asked, so its moves are told back here [noticeStatus]. */
  if (raised?._id) await Todo.updateOne({ _id: raised._id }, { $addToSet: { askedFrom: task._id } }, { keepVersion: true });
  const step = action.status && statusesOf(task).find((entry) => entry.key === action.status);
  const said = `${action.label}: ${text}`;
  task.updates = [...(task.updates || []), { kind: 'asked', statusLabel: action.label, text, note: said, by: user._id, at: new Date() }];
  if (step) {
    task.status = step.key;
    task.statusHistory = [...(task.statusHistory || []), { status: step.key, note: said, by: user._id, at: new Date() }];
  }
  if (!task.user) task.user = user._id;
  await task.save();
  if (step && form.notifyStatus) await noticeStatus(task, user, { step, note: said });
  await publish(EVENTS.HANDOFF_UPDATED, { task, by: user });
  return { task, raised, addedTo: Boolean(raised.$locals?.addedTo) };
}

/**
 * A hanger that needs assembly is tasked to Assembly as it goes to the press: the Production task
 * raised with "Needs assembly" ticked raises Assembly's on the same enquiry, with the same model,
 * material and quantity, told back to Production as it moves [config/departmentTaskForms.js
 * ask_edd `asks`]. Once: an Assembly task already open on the enquiry is added to, not doubled.
 */
export async function raiseAssemblyWith(task, user) {
  if (task.kind !== 'ask_edd' || !task.enquiry) return null;
  const asked = task.brief?.assembly;
  if (!(asked === true || asked === 'true' || asked === 'Yes')) return null;
  const enquiry = await enquiryOfTask(task);
  const { assembly: _a, ...brief } = task.brief?.toObject?.() ?? { ...(task.brief || {}) };
  const raised = await moveEnquiry({
    enquiry, kind: 'ask_assembling_edd', user, system: true, openRecords: false, addToOpen: true, keepStage: true, order: task.order,
    note: `Needs assembly — tasked with Production by ${user.name}${task.notes ? `: ${task.notes}` : ''}`,
    brief, priority: task.priority,
  });
  if (raised?._id) await Todo.updateOne({ _id: raised._id }, { $addToSet: { askedFrom: task._id } }, { keepVersion: true });
  return raised;
}

/**
 * The next department's task, raised from a status (Dispatch marking it Dispatched gives
 * Reception the LR copy) — filled from the enquiry the way the form is, with what this task
 * knows on top: the quantity sent, and today as the dispatch date. Once only: a second
 * Dispatched does not raise a second LR task. A refusal (a payment gate) is left as a note.
 */
/**
 * A task's form answered from the enquiry's prefill [taskPrefill] — what the app writes when it
 * raises a task nobody filled in: each question from its `from`, a table's rows with only the
 * columns it asks. A member to pick, an info line and the My / Team switch are left for a person.
 */
export function briefFromPrefill(kind, prefill) {
  const read = (path) => path?.split('.').reduce((value, key) => (value == null ? undefined : value[key]), prefill);
  const brief = {};
  for (const field of findHandoff(kind)?.asks || []) {
    if (['info', 'kind', 'member'].includes(field.type) || !field.from) continue;
    const value = read(field.from);
    if (field.type === 'items') {
      const rows = (Array.isArray(value) ? value : [])
        .map((row) => Object.fromEntries(field.columns.filter((column) => row?.[column.key] != null && row[column.key] !== '').map((column) => [column.key, String(row[column.key])])))
        .filter((row) => Object.keys(row).length);
      if (rows.length) brief[field.key] = rows;
    } else if (value != null && value !== '' && typeof value !== 'object') {
      brief[field.key] = value;
    }
  }
  return brief;
}

/** The pieces a request asks for: its quantity, or the sum of its rows (the SO request's lines). */
function briefQuantity(brief) {
  if (brief?.quantity) return brief.quantity;
  const total = (Array.isArray(brief?.items) ? brief.items : []).reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);
  return total ? String(total) : '';
}

/** What the SO request said, for Production's task: the first model, its material, and all the pieces. */
function carriedBrief(task) {
  const [first] = Array.isArray(task.brief?.items) ? task.brief.items : [];
  const quantity = briefQuantity(task.brief);
  return {
    ...(first?.model ? { model: first.model } : {}),
    ...(first?.material ? { material: first.material } : {}),
    ...(quantity ? { quantity } : {}),
  };
}

/** The next team task on a job without an enquiry, once — Dispatched → Reception's LR copy. */
async function raiseNextOnChain(task, user, step, text) {
  const { raiseNextTeamTask } = await import('./journey.service.js');
  const asked = briefQuantity(task.brief);
  return raiseNextTeamTask(task, step.next, user, `${step.label}${text ? ` — ${text}` : ''}`, {
    brief: {
      ...(asked ? { quantity: asked } : {}),
      ...(findHandoff(step.next)?.asks?.some((field) => field.key === 'dispatchedOn') ? { dispatchedOn: indiaDay(new Date()) } : {}),
    },
  });
}

async function raiseNextFrom(task, user, step, text) {
  const enquiryId = task.enquiry?._id || task.enquiry;
  const open = await Todo.findOne({ enquiry: enquiryId, kind: step.next, completed: false }).select('_id');
  if (open) {
    /* Already raised — a second part load, or the last of them: the open task is told, not doubled. */
    await Todo.updateOne(
      { _id: open._id },
      { $push: { updates: { note: `${step.label} by ${user.name}${briefQuantity(task.brief) ? ` · ${briefQuantity(task.brief)} pcs on the request` : ''}${text ? ` — ${text}` : ''}`, by: user._id, at: new Date() } } },
      { keepVersion: true }
    );
    return null;
  }
  const enquiry = await enquiryOfTask(task);
  const brief = briefFromPrefill(step.next, await taskPrefill(enquiryId));
  const asked = briefQuantity(task.brief);
  if (asked) brief.quantity = asked;
  if (findHandoff(step.next)?.asks?.some((field) => field.key === 'dispatchedOn')) brief.dispatchedOn = indiaDay(new Date());
  try {
    return await moveEnquiry({
      enquiry, kind: step.next, note: `${step.label} by ${user.name}${text ? ` — ${text}` : ''}`, user, system: true, openRecords: false, brief, order: task.order,
    });
  } catch (error) {
    if (error?.statusCode !== 400 && error?.statusCode !== 409) throw error;
    task.updates = [...(task.updates || []), { kind: 'notice', statusLabel: `${findHandoff(step.next)?.label || 'Next task'} not raised`, text: error.message, note: `${findHandoff(step.next)?.label || 'Next task'} not raised: ${error.message}`, by: user._id, at: new Date() }];
    await task.save();
    return null;
  }
}

const indiaDay = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);

/** The people to tell about a task: whoever has it, or everyone in its department when nobody does. */
export async function peopleOn(task) {
  if (task.user) return [task.user?._id || task.user];
  const { default: User } = await import('../models/User.js');
  return (await User.find({ $or: [{ department: task.department }, { extraDepartments: task.department }], isActive: { $ne: false } }).select('_id').lean())
    .map((person) => person._id);
}

/**
 * One department's move told on another's open task on the same enquiry — the Mould team's
 * Mould Ready on Production's task. Nothing is moved: what the news means is the other
 * department's call. Its person (or its team) hears it under "Needs your action".
 */
async function tellOpenTasks(task, user, step, text, kind) {
  const said = `${departmentName(task.department)}: ${step.label}${text ? ` — ${text}` : ''}`;
  const open = await Todo.find({ enquiry: task.enquiry?._id || task.enquiry, kind, completed: false });
  for (const other of open) {
    other.updates = [...(other.updates || []), { note: said, by: user._id, at: new Date() }];
    await other.save();
    await noticeStatus(other, user, { step: { key: other.status, label: said }, note: text, also: await peopleOn(other), onlyAlso: true });
    await publish(EVENTS.HANDOFF_UPDATED, { task: other, by: user });
  }
}

/**
 * Accounts marked a payment confirmed (or credit approved). If an order on the enquiry is still
 * held at Production or Dispatch for the money due, the confirmation alone will not release it —
 * the receipt has to be recorded against the order. So whoever confirmed gets a task saying so,
 * once per order, with what is short.
 */
async function askToRecordPayment(task, user, step) {
  const { default: SalesOrder } = await import('../models/SalesOrder.js');
  const { raiseTask } = await import('./task.service.js');
  const orders = await SalesOrder.find({ enquiry: task.enquiry?._id || task.enquiry, status: { $nin: ['closed', 'cancelled'] } });
  for (const order of orders) {
    const standing = await paymentPresets.paymentStanding(order);
    const held = ['production', 'dispatch'].filter((stage) => !standing[stage].met && !standing[stage].waived);
    if (!held.length) continue;
    const short = Math.max(...held.map((stage) => standing[stage].short));
    await raiseTask({
      user: user._id,
      title: `Record the receipt for ${order.number} — ${held.map((stage) => (stage === 'production' ? 'Production' : 'Dispatch')).join(' and ')} is waiting on it`,
      notes: `${step.label} on the A/C Clarify task, but the order still shows ₹${Math.round(short).toLocaleString('en-IN')} short. Record the payment against the order in Payments so the work can go on.`,
      priority: 'high',
      dueDate: new Date(),
      link: `/orders/${order._id}`,
      originKey: `record-receipt:${order._id}`,
    });
  }
}

/* The Dispatch statuses that mean "still waiting on the goods" — a ready signal moves these on. */
const WAITING_ON_GOODS = ['received', 'asked_production', 'not_ready'];

/**
 * Production (or Assembly) says Ready for Dispatch: every open Dispatch request on the enquiry is
 * told on its own task, and one still waiting on the goods moves to Goods Ready — Waiting for
 * Vehicle, so it appears in the trip planner's ready groups without anyone re-typing it. The
 * Dispatch person on it, or the whole team when nobody has taken it, is told under "Needs your
 * action", as are the enquiry's marketing person and Admin.
 */
async function tellDispatchReady(task, user, step, text, { partial = false } = {}) {
  const asking = departmentName(task.department);
  const requests = await Todo.find({ ...jobFilter(task), kind: 'invoice_dispatch', completed: false });
  if (!requests.length) return;
  const said = `${asking}: ${step.label}${text ? ` — ${text}` : ''}`;
  const ready = statusesOf({ kind: 'invoice_dispatch' }).find((entry) => entry.key === 'waiting_vehicle');
  /* Some models ready: the request moves on only when the order goes out model by model. */
  const goesByModel = partial && Boolean(task.enquiry) && (await Enquiry.findById(idOf(task.enquiry)).select('dispatchPlan').lean())?.dispatchPlan?.mode === 'by_model';
  for (const request of requests) {
    request.updates = [...(request.updates || []), { note: said, by: user._id, at: new Date() }];
    const moves = ready && WAITING_ON_GOODS.includes(request.status) && (!partial || goesByModel);
    if (moves) {
      request.status = ready.key;
      request.statusHistory = [...(request.statusHistory || []), { status: ready.key, note: said, by: user._id, at: new Date() }];
    }
    await request.save();
    await noticeStatus(request, user, { step: moves ? ready : { key: request.status, label: `${asking} — ${step.label}` }, note: said, also: await peopleOn(request) });
    await publish(EVENTS.HANDOFF_UPDATED, { task: request, by: user });
  }
}

/** The ready date going with a status move, as YYYY-MM-DD — or null when there is none. */
function statusDate(form, step, date) {
  const given = String(date || '').trim();
  if (given) {
    if (!form.statusDate && !step.date) fail('This task does not take a date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(given) || Number.isNaN(Date.parse(given))) fail('Give the date as a calendar date');
    if (given < indiaDay(new Date())) fail('The ready date cannot be in the past');
    return given;
  }
  if (step.date === 'tomorrow') return indiaDay(new Date(Date.now() + DAY_MS));
  if (step.date === 'required') fail(`Give the ${form.statusDate?.label || 'ready date'} for ${step.label}`);
  return null;
}

/**
 * The move, shown to the enquiry's marketing person and every Admin — not to whoever made it —
 * under "Needs your action" until they read and dismiss it [models/TaskNotice.js].
 */
export async function noticeStatus(task, user, { step, note, date, also = [], onlyAlso = false }) {
  const [{ default: TaskNotice }, { default: User }] = await Promise.all([
    import('../models/TaskNotice.js'), import('../models/User.js'),
  ]);
  const enquiry = task.enquiry ? await Enquiry.findById(task.enquiry?._id || task.enquiry).select('assignedTo customer').lean() : null;
  const admins = await User.find({ ...MANAGEMENT_QUERY, isActive: { $ne: false } }).select('_id').lean();
  /* The enquiry's marketing person — or, on a team task with no enquiry, whoever raised it. */
  const asker = enquiry ? enquiry.assignedTo : task.createdBy;
  /* The departments whose tasks asked for this one hear its moves too [Todo `askedFrom`]. */
  const askers = [];
  if (task.askedFrom?.length) {
    for (const asking of await Todo.find({ _id: { $in: task.askedFrom }, completed: false }).select('user department').lean()) askers.push(...(await peopleOn(asking)));
  }
  const recipients = new Set((onlyAlso ? also : [asker, ...admins.map((person) => person._id), ...also, ...askers]).filter(Boolean).map(String));
  if (user?._id) recipients.delete(String(user._id));
  if (!recipients.size) return;
  await TaskNotice.insertMany([...recipients].map((recipient) => ({
    recipient, task: task._id, enquiry: enquiry?._id, customer: task.customer?._id || task.customer || enquiry?.customer,
    department: task.department, kind: task.kind, status: step.key, statusLabel: step.label,
    note: note || undefined, date: date || undefined, by: user?._id || undefined, at: new Date(),
  })));
  /*
   * And on their phones: the notice alone was only seen with the app open. Sent once the move
   * is committed, so a move rolled back rings nobody; never holds up the move.
   */
  const title = `${departmentName(task.department)}: ${step.label}`;
  const body = [task.title, note, user?.name && `by ${user.name}`].filter(Boolean).join(' — ').slice(0, 200);
  const link = enquiry ? `/enquiries/${enquiry._id}` : task.link || '/departments/mine';
  afterCommit(() => import('./push.service.js')
    .then(({ sendPush }) => sendPush([...recipients], { title, body, link, kind: 'task-status', taskId: String(task._id) }))
    .catch((error) => console.error(`[handoff] status push not sent: ${error.message}`)));
}

const sampleWords = (status) => {
  const text = String(status || '').replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/**
 * A sample's status moved on the bench: Admin, the enquiry's marketing person and the marketer
 * who owns the buyer hear it under "Needs your action" and on their phones [noticeStatus] —
 * "Sampling: Sample S-0042 — Not available", with the reason. Hung on the enquiry's Sampling
 * task, as every department move is. Never fails the move that called it.
 */
export async function noticeSampleMove(sample, user, { to, note } = {}) {
  const enquiryId = sample.enquiry?._id || sample.enquiry;
  if (!enquiryId) return null;
  /* The Sampling task, else the desk's, else whatever task holds the enquiry — a sample raised by the automation has no Sampling task. */
  const task = await Todo.findOne({ enquiry: enquiryId, kind: 'sample_request' }).sort({ completed: 1, createdAt: -1 })
    || await Todo.findOne({ enquiry: enquiryId, kind: 'sample_collect' }).sort({ completed: 1, createdAt: -1 })
    || await Todo.findOne({ enquiry: enquiryId }).sort({ completed: 1, holds: -1, createdAt: -1 });
  if (!task) return null;
  const { default: Customer } = await import('../models/Customer.js');
  const buyer = sample.customer ? await Customer.findById(sample.customer?._id || sample.customer).select('assignedTo').lean() : null;
  const label = `Sample ${sample.number} — ${sampleWords(to)}`;
  await noticeStatus(task, user, { step: { key: to, label }, note: String(note || '').trim() || undefined, also: [buyer?.assignedTo, sample.requestedBy].filter(Boolean).map(idOf) });
  return task;
}

/* Unread, or read within the last day — a notice clears itself a day after it is read. */
const liveNotices = (user) => ({
  recipient: user._id,
  $or: [{ readAt: null }, { expireAt: { $gt: new Date() } }],
});

/** This person's notices of department moves, newest first. */
export async function noticesFor(user) {
  const { default: TaskNotice } = await import('../models/TaskNotice.js');
  return TaskNotice.find(liveNotices(user)).sort({ at: -1 }).limit(50)
    .populate([
      { path: 'by', select: 'name department' },
      { path: 'customer', select: 'code name' },
      { path: 'enquiry', select: 'number' },
    ]).lean();
}

/** Read: it can be dismissed now, and it clears itself a day later. */
export async function readNotice(user, id) {
  const { default: TaskNotice, READ_NOTICE_KEPT_MS } = await import('../models/TaskNotice.js');
  const notice = await TaskNotice.findOne({ _id: id, recipient: user._id });
  if (!notice) throw ApiError.notFound('Notice not found');
  if (!notice.readAt) {
    notice.readAt = new Date();
    notice.expireAt = new Date(notice.readAt.getTime() + READ_NOTICE_KEPT_MS);
    await notice.save();
  }
  return notice;
}

/** Dismissed — only once read, so nobody clears what they have not looked at. */
export async function dismissNotice(user, id) {
  const { default: TaskNotice } = await import('../models/TaskNotice.js');
  const notice = await TaskNotice.findOne({ _id: id, recipient: user._id });
  if (!notice) throw ApiError.notFound('Notice not found');
  if (!notice.readAt) fail('Read it first — then it can be dismissed');
  await notice.deleteOne();
  return { dismissed: true };
}

/** The status reached by uploading the work, checked before the file is stored. */
export function resultStepFor(task, user) {
  openHandoff(task, user);
  const step = statusesOf(task).find((entry) => entry.pdf);
  if (!step) fail('This task does not take a PDF of the work');
  return step;
}

/**
 * The work uploaded (the sales order as a PDF): the task reaches that status and is done, and
 * the department task that follows is raised — the enquiry moves on to Production. When the
 * next one is refused (the advance not in yet), the task is still done and the reason returned;
 * Payment Collection has been asked for the money.
 */
export async function finishWithResult(task, user, { attachmentId, note, reading = null, readProblem = null }) {
  const step = resultStepFor(task, user);
  task.resultFile = attachmentId;
  task.attention = undefined;
  task.status = step.key;
  task.statusHistory = [...(task.statusHistory || []), { status: step.key, note: note || undefined, by: user._id, at: new Date() }];
  if (!step.done) {
    task.updates = [...(task.updates || []), {
      kind: 'status', status: step.key, statusLabel: step.label, text: String(note || '').trim() || undefined,
      note: [step.label, String(note || '').trim()].filter(Boolean).join(': '), by: user._id, at: new Date(),
    }];
    if (!task.user) task.user = user._id;
  }
  await task.save();
  if (findHandoff(task.kind)?.form?.notifyStatus) await noticeStatus(task, user, { step, note: String(note || '').trim() });
  const done = step.done
    ? await completeHandoff(task, user, { note: String(note || '').trim() || `${step.label} — PDF uploaded` })
    : task;
  let next = null;
  let nextProblem = null;
  /* Production not confirmed on the request: the order waits with marketing, nothing is raised. */
  const held = Boolean(step.next && task.enquiry && heldBack(task));
  /* The SO prepared books the sales order from the request's lines, released when Production is confirmed. */
  const order = await bookOrderFor(task, user, { held, reading, readProblem });
  if (held) {
    nextProblem = 'Production was not confirmed on the request — the order is with marketing under Production Holded Orders until Admin or its marketing person moves it to Production.';
  } else if (step.next && !task.enquiry) {
    /* A team task: the next team's task for the same buyer, on the same journey [journey.service]. */
    if (heldBack(task)) {
      nextProblem = `Production was not confirmed on the request, so ${findHandoff(step.next)?.label || 'the next step'} was not raised.`;
    } else {
      const { raiseNextTeamTask } = await import('./journey.service.js');
      next = await raiseNextTeamTask(task, step.next, user, `${step.label} by ${user.name}`);
    }
  } else if (step.next) {
    const enquiry = await enquiryOfTask(task);
    try {
      next = await moveEnquiry({ enquiry, kind: step.next, note: `${step.label} by ${user.name}`, user, system: true, order: task.order, brief: carriedBrief(task) });
    } catch (error) {
      if (error?.statusCode !== 400 && error?.statusCode !== 409) throw error;
      nextProblem = error.message;
    }
  }
  /* The work uploaded is itself a move for the enquiry — the LR reads LR Sent and closes it. */
  await reachEnquiry(task, user, findHandoff(task.kind)?.whenResult, String(note || '').trim() || `${step.label} — uploaded`);
  return { task: done, next, nextProblem, held, order };
}

/**
 * The sales order behind an SO task [services/soFromTask.service.js]: booked from the request's
 * lines (or the enquiry's open order linked), released at once when Production was confirmed, and
 * said on the task either way. Returns what the screen shows about it.
 */
async function bookOrderFor(task, user, { held, reading, readProblem }) {
  if (!findHandoff(task.kind)?.booksOrder || !task.enquiry) return null;
  const { bookOrderFromTask, releaseFromTask, noteOrderOnTask } = await import('./soFromTask.service.js');
  const booked = await bookOrderFromTask(task, user, { reading, readProblem });
  if (!booked.order) {
    if (booked.problem) await noteOrderOnTask(task, user, `not booked — ${booked.problem}. Book it on the Sales orders screen.`);
    return booked.problem ? { problem: booked.problem } : null;
  }
  const order = booked.order;
  task.order = order._id;
  await Todo.updateOne({ _id: task._id }, { $set: { order: order._id } }, { keepVersion: true });
  const pieces = (order.lines || []).reduce((sum, line) => sum + (line.quantity || 0), 0);
  const drafted = booked.drafted || {};
  const differences = drafted.differences || [];
  const source = drafted.from === 'so_pdf' ? `read from the SO PDF${drafted.soNumber ? ` (${drafted.soNumber})` : ''}` : 'drafted from the request';
  let said = booked.linked
    ? `linked to ${order.number}, already on the Sales orders screen`
    : `${order.number} ${source} — ${order.lines.length} line${order.lines.length === 1 ? '' : 's'}, ${pieces.toLocaleString('en-IN')} pcs`;
  if (!booked.linked && drafted.readProblem) said += ` (SO PDF not used: ${drafted.readProblem})`;
  if (differences.length) said += `. The SO differs from the request: ${differences.join('; ')}`;
  let released = false;
  if (booked.linked) {
    said += held ? '' : ' — release it there once its checks are done';
  } else if (held) {
    said += ' — waits for Move to Production';
  } else if (differences.length) {
    /* The SO and the request disagree: a person settles which is right before the plant starts on it. */
    said += ` — not released: check ${order.number} on Sales orders and release it`;
  } else {
    const result = await releaseFromTask(order, user, `Released from the SO request — Production confirmed (${user.name})`);
    released = result.released;
    said += released ? ' and released to production' : result.problem ? ` — not released yet: ${result.problem}` : '';
  }
  await noteOrderOnTask(task, user, said);
  return { _id: order._id, number: order.number, booked: Boolean(booked.booked), linked: Boolean(booked.linked), released, said, from: drafted.from || null, differences };
}

/**
 * The uploaded work has gone to the customer [services/taskResultMessage.service.js]: the task
 * moves to its `sent` status, saying on which channels — when at least one went. The enquiry's
 * marketing person and Admin are told, as for any move.
 */
export async function markResultSent(task, user, results) {
  const sent = results.filter((entry) => entry.status === 'sent');
  const step = statusesOf(task).find((entry) => entry.sent);
  const said = results.map((entry) => (entry.status === 'sent'
    ? `${entry.channel === 'email' ? 'Email' : 'WhatsApp'} to ${entry.recipient}`
    : `${entry.channel === 'email' ? 'Email' : 'WhatsApp'} not sent (${entry.skipReason || entry.error || entry.status})`)).join(' · ');
  if (!step || !sent.length) {
    if (said) {
      task.updates = [...(task.updates || []), { kind: 'notice', statusLabel: 'Not sent to the customer', text: said, note: `Not sent to the customer — ${said}`, by: user._id, at: new Date() }];
      await task.save();
    }
    return task;
  }
  task.status = step.key;
  task.statusHistory = [...(task.statusHistory || []), { status: step.key, note: said, by: user._id, at: new Date() }];
  task.updates = [...(task.updates || []), { kind: 'status', status: step.key, statusLabel: step.label, text: said, note: `${step.label}: ${said}`, by: user._id, at: new Date() }];
  await task.save();
  if (findHandoff(task.kind)?.form?.notifyStatus) await noticeStatus(task, user, { step, note: said });
  await publish(EVENTS.HANDOFF_UPDATED, { task, by: user });
  return task;
}

/** "Got it": the department has seen the answer on its task, and the highlight goes. */
export async function markAttentionSeen(task, user) {
  openHandoff(task, user);
  if (!task.attention?.kind) return task;
  task.attention = undefined;
  await task.save();
  return task;
}

/**
 * What needs this person now, at the top of their dashboard: the questions other departments
 * asked them (a clarification — answered right there), and the answers that came back on their
 * department's tasks. The first is theirs by name, or their department's when nobody is named.
 */
export async function attentionFor(user, department) {
  const populate = [
    { path: 'createdBy', select: 'name department' },
    { path: 'attention.by', select: 'name department' },
    { path: 'customer', select: 'code name' },
    { path: 'enquiry', select: 'number requirement.modelNumber' },
    { path: 'parentTask', select: 'kind department title status' },
  ];
  const [questions, replies] = await Promise.all([
    Todo.find({
      parentTask: { $exists: true }, completed: false,
      $or: [{ user: user._id }, { department: { $in: departmentsOf(user) }, user: null }],
    }).sort({ createdAt: 1 }).limit(50).populate(populate),
    Todo.find({ 'attention.kind': 'reply', completed: false, department: Array.isArray(department) ? { $in: department } : department }).sort({ 'attention.at': -1 }).limit(50).populate(populate),
  ]);
  /* And what departments did on this person's enquiries — Admin's, every enquiry's. */
  return { questions, replies, notices: await noticesFor(user) };
}

/** The department corrects what it was told — the questions marked `editable` (contact details). */
export async function editTaskBrief(task, user, { brief = {} }) {
  const handoff = findHandoff(task.kind);
  const details = handoff?.details || [];
  /*
   * The department working the task corrects what its form marks editable and fills the hanger's
   * details; whoever raised it, the enquiry's marketing person and Admin may fill those details too
   * — a task sent without the model or material is completed where it stands.
   */
  let works = true;
  try {
    openHandoff(task, user);
  } catch (error) {
    if (!details.length || task.completed || !(await mayFillDetails(task, user))) throw error;
    works = false;
  }
  const editable = works ? (handoff?.asks || []).filter((field) => field.editable) : [];
  const fields = [...editable, ...details.filter((field) => !editable.some((entry) => entry.key === field.key))];
  if (!fields.length) fail('Nothing on this task can be corrected here');
  const current = { ...(task.brief?.toObject?.() ?? task.brief ?? {}) };
  const filled = [];
  const changed = [];
  for (const field of fields) {
    if (!(field.key in brief)) continue;
    const value = keptAnswer(field, brief[field.key]);
    const before = current[field.key] == null ? '' : String(current[field.key]);
    if (before === value) continue;
    if (value) current[field.key] = value;
    else delete current[field.key];
    (before ? changed : filled).push(field.label);
  }
  if (!filled.length && !changed.length) return task;
  task.brief = current;
  task.attention = undefined;
  task.markModified('brief');
  const said = [filled.length && `Filled: ${filled.join(', ')}`, changed.length && `Corrected: ${changed.join(', ')}`].filter(Boolean).join(' · ');
  task.updates = [...(task.updates || []), { kind: 'corrected', statusLabel: filled.length && !changed.length ? 'Details filled' : 'Corrected', text: [...filled, ...changed].join(', '), note: said, by: user._id, at: new Date() }];
  await task.save();
  /* The other side hears it: the department when marketing filled it, marketing and Admin when the department did. */
  if (handoff?.form?.notifyStatus || !works) {
    await noticeStatus(task, user, {
      step: { key: task.status || 'details', label: 'Hanger details filled' },
      note: `${said}${current.model ? ` — ${current.model}` : ''}${current.material ? `, ${current.material}` : ''}`,
      ...(works ? {} : { also: await peopleOn(task) }),
    });
  }
  await publish(EVENTS.HANDOFF_UPDATED, { task, by: user });
  return task;
}

/** Whoever raised the task, the enquiry's marketing person (or its delegate) and Admin may fill its hanger details. */
async function mayFillDetails(task, user) {
  if (isAdmin(user)) return true;
  if (idOf(task.createdBy) === idOf(user._id)) return true;
  if (!task.enquiry) return false;
  const enquiry = await Enquiry.findById(task.enquiry?._id || task.enquiry).select('assignedTo').lean();
  return idOf(enquiry?.assignedTo) === idOf(user._id);
}

/**
 * An update without moving the enquiry: progress, a pending quantity, a call made. Kept on the
 * task, shown on the enquiry, and the marketing person who owns the buyer is told.
 */
export async function updateHandoff(task, user, { note, fields = {} }) {
  openHandoff(task, user);
  const text = String(note || '').trim();
  if (text.length < 2) fail('Say what the update is');
  const kept = keptFields(task.kind, fields);
  task.updates = [...(task.updates || []), {
    kind: 'note', text, note: text, fields: Object.keys(kept).length ? kept : undefined, by: user._id, at: new Date(),
  }];
  task.attention = undefined;
  /* The first person in the department to write on it has taken it. Admin writing from the
     board has not: the job stays on the department's queue for whoever picks it up. */
  if (!task.user && !isAdmin(user)) task.user = user._id;
  await task.save();
  await publish(EVENTS.HANDOFF_UPDATED, { task, by: user });
  /* Every update on an SO, dispatch, quality, assembling, printing or payment task reaches Admin
     and the enquiry's marketing person under "Needs your action", as a status move does. */
  if (findHandoff(task.kind)?.form?.notifyStatus) {
    const current = statusesOf(task).find((entry) => entry.key === task.status);
    await noticeStatus(task, user, { step: { key: task.status || 'update', label: current ? `Update — ${current.label}` : 'Update' }, note: text });
  }
  return task;
}

/**
 * Sent back, with why. The holding task goes back to whoever had the enquiry before — the same
 * department, at the stage it was at — so it is never left with nobody. A side request goes
 * back to its sender as before.
 */
export async function returnHandoff(task, user, { reason }) {
  openHandoff(task, user);
  const why = String(reason || '').trim();
  if (why.length < 5) fail('Say why it is being sent back');

  task.completed = true;
  task.completedAt = new Date();
  task.completedBy = user._id;
  task.outcome = { result: 'returned', note: why, by: user._id, at: new Date() };
  await task.save();
  if (findHandoff(task.kind)?.form?.notifyStatus) await noticeStatus(task, user, { step: { key: 'sent_back', label: 'Sent back' }, note: why });

  if (task.holds) {
    /* An enquiry a department still held goes back to its marketing person, with why. */
    const enquiry = await enquiryOfTask(task);
    const back = await openHolder({
      enquiry, kind: 'back_to_marketing', user, note: `${user.name}: ${why}`,
      title: `Sent back: ${findHandoff('back_to_marketing').label} — ${aboutOf(enquiry)}`,
    });
    await moveStage(enquiry, 'enquiry', { user, task: back, note: `Sent back: ${why}`, heldBy: back.department });
  } else {
    await backToSender(task, { user, title: `Sent back: ${task.title}`, notes: `${user.name}: ${why}` });
  }
  await publish(EVENTS.HANDOFF_RETURNED, { task, by: user });
  return task;
}

/** Marketing's holding task is due on the follow-up date; moving the date moves the task. */
export async function syncOwnerDueDate(enquiry) {
  const holder = await holderOf(enquiry._id);
  if (!holder || findHandoff(holder.kind)?.department !== 'owner') return;
  const due = endOfDayIST(new Date(enquiry.nextFollowUpDate));
  if (holder.dueDate && holder.dueDate.getTime() === due.getTime()) return;
  holder.dueDate = due;
  holder.lateNotifiedAt = undefined;
  await holder.save();
}

/** A new due date, with the reason on the record. */
export async function rescheduleHandoff(task, user, { dueDate, reason }) {
  openHandoff(task, user);
  const why = String(reason || '').trim();
  if (why.length < 5) fail('Say why the date is moving');
  const to = new Date(dueDate);
  if (Number.isNaN(to.getTime())) fail('That is not a date');
  if (to < startOfDayIST()) fail('The new date cannot be in the past');

  const due = endOfDayIST(to);
  task.reschedules = [...(task.reschedules || []), { from: task.dueDate, to: due, reason: why, by: user._id, at: new Date() }];
  task.dueDate = due;
  await task.save();
  if (findHandoff(task.kind)?.form?.notifyStatus) {
    const day = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }).format(due);
    await noticeStatus(task, user, { step: { key: 'rescheduled', label: `Date moved to ${day}` }, note: why, date: due });
  }
  return task;
}

/** For messages: what a task is, in a line. */
export const describeHandoff = (task) => {
  const handoff = findHandoff(task.kind);
  return {
    label: handoff?.label || 'Task',
    department: departmentName(task.department),
    stage: handoff?.stage ? stageLabel(handoff.stage) : null,
  };
};

/* ------------------------------ Task forms ------------------------------ */

const MATERIAL_WORDS = { pp: 'PP', hips: 'HIPS', gpps: 'GPPS', ld: 'LD', hd: 'HD', abs: 'ABS', eva: 'EVA', kresin: 'Kresin', recycled_pp: 'Recycled PP' };
const materialWord = (value) => (value ? MATERIAL_WORDS[value] || value.charAt(0).toUpperCase() + value.slice(1) : '');
const PRESET_WORDS = {
  credit: 'Credit — nothing before dispatch', advance_100: '100% advance',
  advance_50_delivery_50: '50% advance, 50% against delivery', advance_50_dispatch_50: '50% advance, 50% before dispatch',
  advance_30_dispatch_70: '30% advance, 70% before dispatch', dispatch_100: '100% against dispatch',
};

/** An order's payment plan in the words the SO form offers, when it is one of them. */
function termsWords(order) {
  const plan = order?.paymentPlan;
  if (plan && plan.advancePercent != null) {
    const { PAYMENT_PRESETS } = paymentPresets;
    const preset = PAYMENT_PRESETS.find((entry) => entry.advancePercent === plan.advancePercent
      && entry.beforeDispatchPercent === plan.beforeDispatchPercent);
    if (preset) return PRESET_WORDS[preset.key] || '';
  }
  return Object.values(PRESET_WORDS).includes(order?.paymentTerms) ? order.paymentTerms : '';
}

/**
 * What a department task's form is filled from [config/departmentTaskForms.js `from`]: the
 * enquiry's models with their mould, material, hook, clip and print by name, the buyer's contact
 * and delivery details, and the order on it — so nobody types again what the enquiry already
 * says. Every answer stays editable on the form.
 */
export async function taskPrefill(enquiryId) {
  const [{ default: Customer }, { default: SalesOrder }, { default: Dispatch }, { default: Quotation }, { default: Sample }] = await Promise.all([
    import('../models/Customer.js'), import('../models/SalesOrder.js'), import('../models/Dispatch.js'),
    import('../models/Quotation.js'), import('../models/Sample.js'),
  ]);
  /* The registers a row names, by name — the same on the enquiry, a quotation, an order or a sample. */
  const parts = (prefix) => [
    { path: `${prefix}.mould`, select: 'mouldCode name material' },
    { path: `${prefix}.materialRef`, select: 'name colour' },
    { path: `${prefix}.hookRef`, select: 'name' },
    { path: `${prefix}.clipRef`, select: 'name' },
    { path: `${prefix}.printRef`, select: 'name' },
  ];
  const enquiry = await Enquiry.findById(enquiryId).populate(parts('items')).lean();
  if (!enquiry) return null;
  const newest = (Model, select, populate) => Model.findOne({ enquiry: enquiry._id }).sort({ createdAt: -1 }).select(select).populate(populate).lean();
  const [customer, order, quotation, sample] = await Promise.all([
    enquiry.customer ? Customer.findById(enquiry.customer).select('name mobile whatsapp contacts address area landmark city state pincode').lean() : null,
    newest(SalesOrder, 'number lines paymentTerms paymentPlan customerPo', parts('lines').filter((entry) => !/hookRef|clipRef|printRef/.test(entry.path))),
    newest(Quotation, 'lines', parts('lines')),
    newest(Sample, 'items', parts('items')),
  ]);
  const consignment = order
    ? await Dispatch.findOne({ order: order._id, 'invoice.number': { $exists: true } }).sort({ createdAt: -1 }).select('invoice.number').lean()
    : null;

  /** One row — of the enquiry, a quotation, an order or a sample — in the form's words. */
  const described = (row) => ({
    model: row.modelNumber || row.mould?.mouldCode || '',
    mould: String(row.mould?._id || row.mould || ''),
    material: row.materialRef?.name || materialWord(row.material),
    /* The colour asked for; else the chosen resin's own colour. */
    colour: row.colour || row.materialRef?.colour || '',
    hook: row.hookRef?.name || '',
    clip: row.clipRef?.name || '',
    print: row.printRef?.name || row.printing || '',
    packing: row.packing || '',
    mandatory: row.colourMandatory,
    family: materialWord(row.mould?.material),
  });
  const sameModel = (a, b) => (a.model && b.model && a.model.toLowerCase() === b.model.toLowerCase())
    || (a.mould && b.mould && a.mould === b.mould);

  /*
   * The enquiry's own rows first. Where one leaves material, colour, a hook, a clip or a print
   * blank, the same model on the newest quotation, order or sample says it — in that order —
   * and the mould register's material family is the last word on material.
   */
  const others = [...(quotation?.lines || []), ...(order?.lines || []), ...(sample?.items || [])].map(described);
  const source = enquiry.items?.length ? enquiry.items : [enquiry.requirement || {}];
  let rows = source.map(described).filter((row) => row.model || row.material || row.colour);
  if (!rows.length) rows = others.filter((row, at) => row.model && others.findIndex((entry) => sameModel(entry, row)) === at);
  const filledRows = rows.map((row) => {
    const filled = { ...row };
    for (const other of others.filter((entry) => sameModel(entry, row))) {
      for (const key of ['material', 'colour', 'hook', 'clip', 'print', 'packing']) {
        if (!filled[key] && other[key]) filled[key] = other[key];
      }
      if (filled.mandatory == null && other.mandatory != null) filled.mandatory = other.mandatory;
    }
    if (!filled.material) filled.material = filled.family || others.find((entry) => sameModel(entry, row) && entry.family)?.family || '';
    return {
      model: filled.model,
      material: filled.material,
      colour: filled.colour,
      hook: filled.hook,
      clip: filled.clip,
      print: filled.print,
      packing: filled.packing,
      colourType: filled.colour ? (filled.mandatory ? 'Compulsory colour' : 'Preferred colour') : '',
      /* A sample is three pieces unless somebody says why it is more. */
      quantity: '3',
    };
  });
  /* The sample's rows; packing is the quotation's question, not the sample's. */
  const items = filledRows.map(({ packing, ...row }) => row);
  /* "PP Black" — but "HIPS White", not "HIPS White White", when the resin's name already says it. */
  const materialAndColour = (row) => (row.colour && !String(row.material || '').toLowerCase().includes(row.colour.toLowerCase())
    ? [row.material, row.colour].filter(Boolean).join(' ')
    : row.material || row.colour || '');
  const day = (value) => (value ? new Date(value).toISOString().slice(0, 10) : '');
  /*
   * The SO request's lines: the order's own lines when there is one; else each model with the
   * enquiry's quantity and the quotation's price for it (the buyer's target price failing that).
   */
  const quotedFor = (row) => (quotation?.lines || []).find((line) => sameModel(described(line), row) && line.unitPrice != null)?.unitPrice;
  /* The parts the enquiry (or its newest quotation or sample) gives the same model. */
  const partsOf = (row) => {
    const same = items.find((entry) => sameModel(entry, row)) || {};
    return { hook: row.hook || same.hook || '', clip: row.clip || same.clip || '', print: row.print || same.print || '' };
  };
  const orderItems = order?.lines?.length
    ? order.lines.map((line) => ({
      model: described(line).model,
      material: materialAndColour(described(line)),
      ...partsOf(described(line)),
      quantity: line.quantity ? String(line.quantity) : '',
      price: line.unitPrice != null ? String(line.unitPrice) : '',
      edd: day(line.promisedDate || line.deliveryDate),
    }))
    : items.map((row) => {
      const asked = source.find((entry) => sameModel(described(entry), row));
      const price = quotedFor(row) ?? enquiry.targetPrice;
      return {
        model: row.model,
        material: materialAndColour(row),
        ...partsOf(row),
        quantity: asked?.quantity ? String(asked.quantity) : '',
        price: price != null ? String(price) : '',
        edd: '',
      };
    });
  /*
   * The quotation request's lines: each model with its material and colour, parts and packing,
   * the pieces asked for on the enquiry, and the buyer's target price — the quotation's own price
   * for a price negotiation is on the quotation, not asked again.
   */
  const quoteItems = filledRows.map((row) => {
    const asked = source.find((entry) => sameModel(described(entry), row));
    return {
      model: row.model,
      material: materialAndColour(row),
      hook: row.hook,
      clip: row.clip,
      print: row.print,
      packing: row.packing,
      quantity: asked?.quantity ? String(asked.quantity) : '',
      targetPrice: enquiry.targetPrice != null ? String(enquiry.targetPrice) : '',
    };
  });
  const modelList = [...new Set(items.map((row) => row.model).filter(Boolean))];
  const enquiryQuantity = source.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);
  const orderQuantity = (order?.lines || []).reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);

  /* The order contact, for the SO team to call — a prospect's own person and number until it is a customer. */
  const contact = orderContactOf(customer, enquiry);
  const place = [customer?.address, customer?.area, customer?.landmark && `near ${customer.landmark}`, customer?.city || enquiry.prospect?.city, customer?.state, customer?.pincode].filter(Boolean).join(', ');

  return {
    customer: {
      name: customer?.name || enquiry.prospect?.name || '',
      contactPerson: contact.name,
      mobile: contact.phone,
      whatsapp: contact.whatsapp,
      delivery: `${contact.name || 'Not added'} · ${contact.phone || 'No number'} · ${place || 'Road not selected'}`,
    },
    items,
    orderItems,
    quoteItems,
    modelList,
    models: modelList.join(', '),
    materials: items.map(materialAndColour).filter(Boolean).join(', '),
    /* Enquiries carry no quantity; the order on it does. */
    quantity: String(orderQuantity || enquiryQuantity || ''),
    targetPrice: enquiry.targetPrice != null ? String(enquiry.targetPrice) : '',
    order: order
      ? { number: order.number, paymentTerms: termsWords(order), invoiceNumber: consignment?.invoice?.number || '', poNumber: order.customerPo?.number || '' }
      : { paymentTerms: '', invoiceNumber: '' },
    /* The people each `member` question may pick — the PRT members for a visit. */
    members: await membersFor(HANDOFFS.flatMap((handoff) => (handoff.asks || []).filter((field) => field.type === 'member').map((field) => field.department))),
    /* The registers, so a model, material, hook, clip or print is picked, not typed from memory. */
    registers: await registerLists(),
  };
}

/* ------------------------------ Production's dates ------------------------------ */

const EDD_KINDS = ['ask_edd', 'ask_assembling_edd'];
/** The tasks that give the enquiry its EDD from the shop floor: the ones whose ready date is it. */
export const EDD_TASK_KINDS = [...EDD_KINDS, 'ask_printing'];
/** The tasks that work to the EDD and show it: those, and the dispatch request. */
export const SHOWS_EDD_KINDS = [...EDD_TASK_KINDS, 'invoice_dispatch'];

/** "23 Oct 2026" — a calendar day as people read it, for a line on the task. */
const prettyDay = (day) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${day}T00:00:00.000+05:30`));

/** A date given as a calendar day, checked: today or later. */
export function eddDay(date) {
  const given = String(date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(given) || Number.isNaN(Date.parse(given))) fail('Give the EDD as a calendar date');
  if (given < indiaDay(new Date())) fail('The EDD cannot be in the past');
  return given;
}

/**
 * The enquiry's EDD written: the day, whose word it is and when [models/Enquiry.js `edd`]. One
 * place, so marketing's date and Production's go through the same door.
 */
export async function writeEnquiryEdd(enquiryId, { day, user, department, note }) {
  const text = String(note || '').trim();
  await Enquiry.updateOne({ _id: enquiryId?._id || enquiryId }, {
    $set: { edd: { date: day, by: user._id, at: new Date(), department, note: text || undefined } },
  });
}

/**
 * Production (or Assembly, Printing) gives the expected delivery date from its task, without
 * moving the status — the thing its task was raised for, asked for at the top of the task until
 * it is given [web: components/TaskEdd.jsx]. Written on the task, where its history is, and on
 * the enquiry, where every other screen reads it; marketing and Admin hear it as they hear a move.
 */
export async function setTaskEdd(task, user, { date, note, models }) {
  openHandoff(task, user);
  if (!EDD_TASK_KINDS.includes(task.kind)) fail('The EDD is given from the Production, Assembly or Printing task');
  assertRouted(task);
  /* A date for each model, or one date for all of them [Todo `modelDates`]. */
  const entries = datesForModels(task, { date, models });
  const day = entries.reduce((latest, entry) => (entry.date > latest ? entry.date : latest), '');
  const perModel = entries.length > 1 && new Set(entries.map((entry) => entry.date)).size > 1
    ? ` (${entries.map((entry) => `${entry.model} ${prettyDay(entry.date)}`).join(' · ')})`
    : '';
  recordModelDates(task, user, entries);
  const text = String(note || '').trim();
  /* A team that hands on gives the next team its hand-over date; the last team gives the EDD. */
  const handsOn = handsOnOf(task);
  if (handsOn.length) {
    const said = `Hand-over to ${teamWords(handsOn)} on ${prettyDay(day)}${perModel}`;
    task.updates = [...(task.updates || []), {
      kind: 'note', text: text ? `${said}: ${text}` : said, note: text ? `${said}: ${text}` : said,
      date: day, dateLabel: 'Hand-over', fields: { handover: day }, by: user._id, at: new Date(),
    }];
    task.attention = undefined;
    if (!task.user) task.user = user._id;
    await task.save();
    await passHandover(task, user, day, text);
    /* Its date counts towards each model's EDD — the latest of its teams' dates. */
    if (task.enquiry) await refreshModelEdds(task.enquiry, user, text);
    await publish(EVENTS.HANDOFF_UPDATED, { task, by: user });
    if (findHandoff(task.kind)?.form?.notifyStatus) {
      await noticeStatus(task, user, { step: { key: task.status || 'handover', label: `Hand-over date to ${teamWords(handsOn)}` }, note: text, date: day });
    }
    return task;
  }
  const said = `EDD ${prettyDay(day)}${perModel}`;
  task.updates = [...(task.updates || []), {
    kind: 'note', text: text || said, note: text ? `${said}: ${text}` : said,
    date: day, dateLabel: 'EDD', fields: { edd: day }, by: user._id, at: new Date(),
  }];
  task.attention = undefined;
  if (!task.user) task.user = user._id;
  await task.save();
  /* Each model's EDD is the latest its teams give; the enquiry's, the latest model's [refreshModelEdds]. */
  if (task.enquiry) await refreshModelEdds(task.enquiry, user, text);
  await publish(EVENTS.HANDOFF_UPDATED, { task, by: user });
  if (findHandoff(task.kind)?.form?.notifyStatus) {
    await noticeStatus(task, user, { step: { key: task.status || 'edd', label: 'EDD given' }, note: text, date: day });
  }
  return task;
}

/** The models a Production, Printing or Assembly task gives dates for: its routed models, else its brief's. */
export function modelsOfTask(task) {
  const routed = (task?.routing?.models || []).map((row) => (typeof row === 'string' ? row : row?.model)).filter(Boolean);
  if (routed.length) return [...new Set(routed.map((model) => String(model).trim()))];
  const listed = String(task?.brief?.models || '').split(',').map((model) => model.trim()).filter(Boolean);
  if (listed.length) return [...new Set(listed)];
  return task?.brief?.model ? [String(task.brief.model).trim()] : [];
}

/**
 * The dates a team gives, model by model: each model named with its own date, or one date for
 * every model the task has. A model the task does not have is refused.
 */
function datesForModels(task, { date, models }) {
  const own = modelsOfTask(task);
  if (Array.isArray(models) && models.length) {
    const seen = new Set();
    const entries = [];
    for (const row of models) {
      const model = String(row?.model || '').trim();
      if (!model || seen.has(model)) continue;
      if (own.length && !own.includes(model)) fail(`${model} is not one of this task’s models (${own.join(', ')})`);
      seen.add(model);
      entries.push({ model, date: eddDay(row.date) });
    }
    if (!entries.length) fail('Give a date for at least one model');
    return entries;
  }
  const day = eddDay(date);
  return (own.length ? own : ['All models']).map((model) => ({ model, date: day }));
}

/** Writes the team's date for each model onto its task, replacing any it gave before for that model. */
function recordModelDates(task, user, entries) {
  const kept = (task.modelDates || []).filter((row) => !entries.some((entry) => entry.model === row.model));
  task.modelDates = [...kept, ...entries.map((entry) => ({ ...entry, by: user._id, at: new Date() }))];
}

/**
 * Each model's EDD is the latest date its teams gave — moulded by 1 Oct, printed by 3 Oct,
 * assembled by 5 Oct reads 5 Oct — counted once the last team on the model's route (Assembly,
 * else Printing, else Production, as Production routed it) has given its date: before that a
 * hand-over date is not when the goods are ready. The enquiry's EDD is the latest of its models',
 * since the order goes when its last model is ready, and is written once every model has one.
 * Each model's EDD is also written on the open order's line as the plant's expected completion.
 * Only this run of the journey counts — dates given since the newest Production request — and
 * only the teams still on a model's route.
 */
export async function refreshModelEdds(enquiryId, user, note) {
  const id = enquiryId?._id || enquiryId;
  const start = await Todo.findOne({ enquiry: id, kind: 'ask_edd' }).sort({ createdAt: -1 }).select('createdAt routing').lean();
  const tasks = await Todo.find({ enquiry: id, kind: { $in: EDD_TASK_KINDS }, ...(start ? { createdAt: { $gte: start.createdAt } } : {}) })
    .select('kind department modelDates').lean();
  const TEAM_OF_KIND = { ask_edd: 'production', ask_printing: 'printing', ask_assembling_edd: 'assembling' };
  /* Each model's route, as Production decided it; a model Production never routed is moulded only. */
  const routes = new Map((start?.routing?.models || []).map((row) => [row.model, ['production', ...(row.printing ? ['printing'] : []), ...(row.assembly ? ['assembling'] : [])]]));
  const given = new Map();
  for (const task of tasks) {
    const team = TEAM_OF_KIND[task.kind];
    for (const row of task.modelDates || []) {
      const list = given.get(row.model) || [];
      list.push({ team, department: task.department, date: row.date });
      given.set(row.model, list);
    }
  }
  /* "All models" — a date given before the task knew its models — stands for each of them. */
  const every = given.get('All models') || [];
  const names = [...new Set([...routes.keys(), ...[...given.keys()].filter((model) => model !== 'All models')])];
  if (!names.length && !every.length) return null;
  const listed = (names.length ? names : ['All models']).map((model) => {
    const route = routes.get(model) || null;
    const dates = [...(given.get(model) || []), ...(model === 'All models' ? [] : every)]
      .filter((entry) => !route || route.includes(entry.team));
    /* One date per team: the one it gave for this model by name wins over its all-models date. */
    const perTeam = new Map();
    for (const entry of dates) if (!perTeam.has(entry.team)) perTeam.set(entry.team, entry);
    const teams = [...perTeam.values()];
    const latest = teams.reduce((best, entry) => (!best || entry.date > best.date ? entry : best), null);
    const lastTeam = route ? route[route.length - 1] : null;
    const complete = Boolean(latest) && (!lastTeam || perTeam.has(lastTeam));
    return {
      model, date: complete ? latest.date : undefined, department: complete ? latest.department : undefined,
      teams: teams.map(({ department, date }) => ({ department, date })),
      ...(complete || !lastTeam ? {} : { waitingOn: lastTeam }),
    };
  });
  /*
   * Marketing's final EDD for a model stands over the teams' dates [setModelEdds]; the teams'
   * latest is kept beside it as the suggestion, so a team moving its date is seen, not lost.
   */
  const before = await Enquiry.findById(id).select('eddByModel').lean();
  for (const entry of listed) {
    entry.suggested = entry.date;
    const final = (before?.eddByModel || []).find((row) => row.model === entry.model)?.final;
    if (final?.date) Object.assign(entry, { final, date: final.date, department: 'marketing' });
  }
  await Enquiry.updateOne({ _id: id }, { $set: { eddByModel: listed.map(({ waitingOn, ...row }) => row) } });
  const dated = listed.filter((entry) => entry.date);
  if (dated.length && dated.length === listed.length) {
    const last = dated.reduce((best, entry) => (entry.date > best.date ? entry : best), dated[0]);
    const words = dated.length > 1 ? `latest of ${dated.length} models (${last.model})` : '';
    await writeEnquiryEdd(id, { day: last.date, user, department: last.department, note: [words, String(note || '').trim()].filter(Boolean).join(' — ') });
  }
  const named = dated.filter((entry) => entry.model !== 'All models');
  const everyDated = dated.find((entry) => entry.model === 'All models');

  /* The open order's lines: each model's EDD as the plant's expected completion for it. */
  const { default: SalesOrder } = await import('../models/SalesOrder.js');
  const keyOf = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const orders = await SalesOrder.find({ enquiry: id, status: { $nin: ['cancelled', 'closed'] } });
  for (const order of orders) {
    let changed = false;
    for (const line of order.lines) {
      const match = named.find((entry) => keyOf(entry.model) === keyOf(line.modelNumber) || keyOf(String(entry.model).split(' · ')[0]) === keyOf(line.modelNumber)) || everyDated;
      if (!match?.date) continue;
      if (!line.production) line.production = {};
      line.production.expectedCompletion = new Date(`${match.date}T00:00:00.000+05:30`);
      changed = true;
    }
    if (changed) await order.save();
  }
  return listed;
}

/* ------------------------------ Production's routing ------------------------------ */

/*
 * After moulding a hanger may be printed, assembled (clips, hooks fitted), both — printing first —
 * or neither. Production decides, model by model, on its task before it gives any date. Each team
 * then gives a date: one that hands on gives the hand-over date to the next team, and the last
 * team in the chain gives the enquiry's EDD.
 *
 *   Production ──▶ Printing ──▶ Assembly      a model that is printed and assembled
 *   Production ──▶ Assembly                   assembled only
 *   Production ──▶ Printing                   printed only — Printing gives the EDD
 *   Production                                neither — Production gives the EDD, as before
 */

/** The task kind of each team that can follow Production. */
export const ROUTE_KINDS = { printing: 'ask_printing', assembling: 'ask_assembling_edd' };
const ROUTE_LABEL = { production: 'Production', printing: 'Printing', assembling: 'Assembly' };

/** The teams a task hands its goods to — empty for the last team, whose date is the EDD. */
export const handsOnOf = (task) => (Array.isArray(task?.routing?.handsTo) ? task.routing.handsTo : []);

/** "Printing and Assembly" — the teams a hand-over date goes to, as a person says them. */
const teamWords = (teams) => teams.map((team) => ROUTE_LABEL[team] || departmentName(team)).join(' and ');

/** The label of the date a task gives: a hand-over date while it hands on, the EDD otherwise. */
export const dateLabelOf = (task, fallback = 'Ready date') => {
  const teams = handsOnOf(task);
  return teams.length ? `Hand-over date to ${teamWords(teams)}` : fallback;
};

/** Production has to say what follows it before it gives any date. */
/*
 * The statuses at which a Production task's goods are already moulded — nothing left to queue.
 * Up to Part 1 / Part 2 Ready (some made, more to come) it may still be added.
 */
const MOULDED = ['completed', 'handed_printing', 'handed_assembly', 'assembling', 'ready_dispatch', 'closed'];
/* Where a task added to the queue starts its cycle, when it has not been planned yet. */
const UNPLANNED = ['received', 'accepted'];

/**
 * Production adds its task to the production queue [web: Production desk "Add to production
 * queue"; components/ProductionQueueList.jsx]. One step for what planning a job means here:
 *   - printing and assembly decided for each model — Printing's and Assembly's tasks raised, so the
 *     job runs Production → Printing → Assembly → Dispatch [decideRouting] (kept as it is when it
 *     was decided before and none is given);
 *   - a task not yet planned (EDD Request Received, EDD Accepted) moves to Planning, with the EDD
 *     if one is given; a task already planning or ready on a date takes the EDD as its date;
 *   - stamped as queued, and said on the task.
 * Refused for a task whose goods are already moulded, and for one already in the queue.
 */
export async function addToProductionQueue(task, user, { models, date, note } = {}) {
  openHandoff(task, user);
  if (task.kind !== 'ask_edd') fail('Only a Production task goes on the production queue');
  if (task.queuedAt) throw ApiError.conflict('This task is already in the production queue');
  if (MOULDED.includes(task.status)) fail('The goods are already moulded — there is nothing to queue');
  if (models?.length) task = (await decideRouting(task, user, { models })).task;
  assertRouted(task);
  const text = String(note || '').trim() || 'Added to the production queue';
  const day = String(date || '').trim();
  if (UNPLANNED.includes(task.status)) {
    task = await setTaskStatus(task, user, { status: 'planning', note: text, ...(day ? { date: day } : {}) });
  } else if (day) {
    task = await setTaskEdd(task, user, { date: day, note: text });
  }
  task.queuedAt = new Date();
  task.queuedBy = user._id;
  task.updates = [...(task.updates || []), { kind: 'note', text: 'Added to the production queue', note: `Added to the production queue: ${text}`, by: user._id, at: new Date() }];
  if (!task.user) task.user = user._id;
  await task.save();
  return task;
}

export function assertRouted(task) {
  if (task.kind !== 'ask_edd') return;
  if (!task.routing?.decidedAt) fail('Decide first which models need printing or assembly — then give the date');
}

/** The models on the enquiry, for Production's choice: the order's lines, or the enquiry's items. */
export async function routingFor(task, user) {
  if (task.kind !== 'ask_edd') fail('Only Production decides printing and assembly');
  if (!mayWorkOnHandoff(user, task)) throw ApiError.forbidden(`This task is on the ${departmentName(task.department)} queue`);
  const enquiryId = task.enquiry?._id || task.enquiry;
  /* Raised from the customer with no enquiry: the models the task names. */
  if (!enquiryId) {
    const said = (task.routing?.models || []).map((row) => row.model);
    const models = [...new Set([...said, ...modelsOfTask(task)].filter(Boolean).map((model) => String(model).trim()))];
    return { models: models.map((model) => ({ model })), routing: task.routing || null };
  }
  const prefill = await taskPrefill(enquiryId);
  const { default: SalesOrder } = await import('../models/SalesOrder.js');
  const order = task.order ? await SalesOrder.findById(task.order?._id || task.order).select('lines.modelNumber').lean() : null;
  const fromOrder = (order?.lines || []).map((line) => line.modelNumber).filter(Boolean);
  const said = (task.routing?.models || []).map((row) => row.model);
  const models = [...new Set([...fromOrder, ...(prefill.modelList || []), ...said, task.brief?.model].filter(Boolean).map((model) => String(model).trim()))];
  /* The print and the clip the enquiry carries, as a hint beside each model. */
  const hints = Object.fromEntries((prefill.items || []).map((row) => [row.model, {
    print: row.print || '', hook: row.hook || '', clip: row.clip || '',
  }]));
  return { models: models.map((model) => ({ model, ...(hints[model] || {}) })), routing: task.routing || null };
}

/**
 * Production's answer, model by model: which need printing, which need assembly. The teams that
 * follow get their tasks at once, with only the models they have and the hand-over date if one
 * was given; a team no longer needed has its untouched task closed, or is told. May be changed
 * while the task is open.
 */
export async function decideRouting(task, user, { models }) {
  openHandoff(task, user);
  if (task.kind !== 'ask_edd') fail('Only Production decides printing and assembly');
  const rows = [];
  for (const row of models || []) {
    const model = String(row?.model || '').trim();
    if (!model || rows.some((entry) => entry.model === model)) continue;
    rows.push({ model, printing: row.printing === true, assembly: row.assembly === true });
  }
  if (!rows.length) fail('Name at least one model');

  const printed = rows.filter((row) => row.printing);
  const assembled = rows.filter((row) => row.assembly);
  /* Production hands each model to the first team after it. */
  const handsTo = [
    ...(printed.length ? ['printing'] : []),
    ...(assembled.some((row) => !row.printing) ? ['assembling'] : []),
  ];
  const before = handsOnOf(task);
  const wasDecided = Boolean(task.routing?.decidedAt);
  const handOverDate = task.routing?.handOverDate;
  task.routing = { ...(task.routing || {}), models: rows, handsTo, decidedAt: new Date(), decidedBy: user._id };
  task.markModified('routing');
  const plan = rows.map((row) => `${row.model}: ${[row.printing && 'printing', row.assembly && 'assembly'].filter(Boolean).join(' then ') || 'no printing or assembly'}`).join(' · ');
  task.updates = [...(task.updates || []), {
    kind: 'note', text: `${wasDecided ? 'Changed' : 'Decided'} — ${plan}`, note: `${wasDecided ? 'Routing changed' : 'Routing'}: ${plan}`, by: user._id, at: new Date(),
  }];
  if (!task.user) task.user = user._id;
  await task.save();

  const enquiry = task.enquiry ? await enquiryOfTask(task) : null;
  const teams = {
    printing: printed.length ? {
      models: printed.map((row) => row.model),
      from: ['production'],
      handsTo: printed.some((row) => row.assembly) ? ['assembling'] : [],
    } : null,
    assembling: assembled.length ? {
      models: assembled.map((row) => row.model),
      from: [...(assembled.some((row) => !row.printing) ? ['production'] : []), ...(assembled.some((row) => row.printing) ? ['printing'] : [])],
      handsTo: [],
    } : null,
  };
  const raised = {};
  for (const [team, plan] of Object.entries(teams)) {
    const kind = ROUTE_KINDS[team];
    const open = await Todo.findOne({ ...jobFilter(task), kind, completed: false });
    if (!plan) {
      if (open?.routing?.byProduction) await dropRoute(open, user, team);
      continue;
    }
    const words = team === 'printing' ? 'Print' : 'Assemble';
    const note = `${words} ${plan.models.join(', ')} — routed by Production (${user.name}). ${plan.handsTo.length ? 'Give Assembly your hand-over date.' : 'Give the EDD once you know when it will be ready.'}`;
    const brief = {
      model: plan.models[0], models: plan.models.join(', '),
      ...(task.brief?.material ? { material: task.brief.material } : {}),
      ...(task.brief?.quantity ? { quantity: task.brief.quantity } : {}),
    };
    /* With no enquiry, the team's task joins this job's chain, for the same buyer [Todo `chain`]. */
    const task2 = open || (enquiry
      ? await moveEnquiry({ enquiry, kind, user, system: true, openRecords: false, addToOpen: true, keepStage: true, order: task.order, note, brief, priority: task.priority })
      : await raiseOnChain(task, kind, user, { note, brief }));
    const incoming = { ...(task2.routing?.incoming || {}) };
    if (plan.from.includes('production') && handOverDate) incoming.production = handOverDate;
    task2.routing = { ...(task2.routing || {}), ...plan, incoming, byProduction: true };
    task2.markModified('routing');
    task2.brief = { ...(task2.brief?.toObject?.() ?? task2.brief ?? {}), model: plan.models[0], models: plan.models.join(', ') };
    task2.markModified('brief');
    if (open) {
      task2.updates = [...(task2.updates || []), {
        kind: 'note', text: `Production (${user.name}): ${words.toLowerCase()} ${plan.models.join(', ')}`, note: `Routed by Production: ${plan.models.join(', ')}`, by: user._id, at: new Date(),
      }];
    }
    task2.askedFrom = [...new Set([...(task2.askedFrom || []).map(String), String(task._id)])];
    await task2.save();
    await publish(EVENTS.HANDOFF_UPDATED, { task: task2, by: user });
    raised[team] = task2;
  }
  /* A team added since Production gave its date hears it too. */
  if (handOverDate && handsTo.some((team) => !before.includes(team))) await passHandover(task, user, handOverDate, '');
  await publish(EVENTS.HANDOFF_UPDATED, { task, by: user });
  if (findHandoff(task.kind)?.form?.notifyStatus) {
    await noticeStatus(task, user, { step: { key: task.status || 'routing', label: wasDecided ? 'Routing changed' : 'Printing / assembly decided' }, note: plan });
  }
  return { task, raised };
}

/** A team's task on a job without an enquiry: the same buyer, on the same chain, told by the app. */
async function raiseOnChain(task, kind, user, { note, brief }) {
  const handoff = findHandoff(kind);
  const statuses = handoff.form?.statuses || [];
  const buyer = task.customer?.name ? task.customer : task.customer ? await (await import('../models/Customer.js')).default.findById(idOf(task.customer)).select('name').lean() : null;
  const raised = await Todo.create({
    customer: idOf(task.customer) || undefined,
    kind,
    department: handoff.department,
    fromDepartment: task.department,
    createdBy: task.createdBy || user._id,
    chain: chainOf(task),
    previousTask: task._id,
    title: `${handoff.label} — ${buyer?.name || 'team task'}`,
    notes: note,
    brief,
    ...(statuses.length ? { status: statuses[0].key, statusHistory: [{ status: statuses[0].key, by: user._id, at: new Date() }] } : {}),
    dueDate: endOfDayIST(new Date(Date.now() + 86400000)),
    priority: task.priority || 'normal',
    system: true,
    link: '/departments/mine',
  });
  await publish(EVENTS.HANDOFF_SENT, { task: raised, enquiry: null, by: user });
  return raised;
}

/** A team Production no longer sends goods to: closed if nobody has started, told otherwise. */
async function dropRoute(open, user, team) {
  const first = statusesOf(open)[0]?.key;
  const note = `Production (${user.name}) says no ${team === 'printing' ? 'printing' : 'assembly'} is needed on this order`;
  if (!open.status || open.status === first) {
    await finishAll([open], user, { note });
    return;
  }
  open.updates = [...(open.updates || []), { kind: 'note', text: `${note} — check with Production before going on`, note, by: user._id, at: new Date() }];
  open.routing = { ...(open.routing || {}), byProduction: false };
  open.markModified('routing');
  await open.save();
  await publish(EVENTS.HANDOFF_UPDATED, { task: open, by: user });
}

/**
 * A team gave its hand-over date: written on its own routing and on each next team's task — a
 * line there, and the date it can expect the goods from this team.
 */
export async function passHandover(task, user, day, text) {
  const from = task.kind === 'ask_edd' ? 'production' : task.kind === 'ask_printing' ? 'printing' : 'assembling';
  task.routing = { ...(task.routing || {}), handOverDate: day, handOverAt: new Date(), handOverBy: user._id };
  task.markModified('routing');
  await task.save();
  for (const team of handsOnOf(task)) {
    const next = await Todo.findOne({ ...jobFilter(task), kind: ROUTE_KINDS[team], completed: false });
    if (!next) continue;
    next.routing = { ...(next.routing || {}), incoming: { ...(next.routing?.incoming || {}), [from]: day } };
    next.markModified('routing');
    next.updates = [...(next.updates || []), {
      kind: 'note', text: `${ROUTE_LABEL[from]} hands over on ${prettyDay(day)}${text ? ` — ${text}` : ''}`,
      note: `${ROUTE_LABEL[from]} hands over on ${prettyDay(day)}`, date: day, dateLabel: `From ${ROUTE_LABEL[from]}`, by: user._id, at: new Date(),
    }];
    await next.save();
    await publish(EVENTS.HANDOFF_UPDATED, { task: next, by: user });
  }
}

/**
 * Marketing's final EDD for each model — by default the latest its teams gave, changed here when
 * marketing (the enquiry's marketing person or Admin) commits the buyer to another day. The
 * enquiry's EDD follows (the latest model's), the open order's lines get it, and every task
 * working to it — Production, Printing, Assembly, the dispatch request — is told, its people
 * under "Needs your action" and on their phones.
 */
export async function setModelEdds(enquiry, user, { models, note }) {
  if (enquiry.stage === CLOSED_STAGE) fail('The enquiry is closed');
  const known = (enquiry.eddByModel || []).map((row) => row.model);
  const rows = [];
  for (const row of models || []) {
    const model = String(row?.model || '').trim();
    if (!model || rows.some((entry) => entry.model === model)) continue;
    if (known.length && !known.includes(model)) fail(`${model} is not one of this enquiry’s models (${known.join(', ')})`);
    rows.push({ model, date: eddDay(row.date) });
  }
  if (!rows.length) fail('Give a final EDD for at least one model');
  const text = String(note || '').trim();
  const table = [...(enquiry.eddByModel || []).map((row) => (row.toObject ? row.toObject() : { ...row }))];
  for (const row of rows) {
    const entry = table.find((item) => item.model === row.model) || (table.push({ model: row.model }), table.at(-1));
    entry.final = { date: row.date, by: user._id, at: new Date(), note: text || undefined };
    entry.date = row.date;
    entry.department = 'marketing';
  }
  await Enquiry.updateOne({ _id: enquiry._id }, { $set: { eddByModel: table } });
  await refreshModelEdds(enquiry._id, user, text ? `final EDD by marketing — ${text}` : 'final EDD by marketing');
  const said = `Final EDD set by ${user.name}: ${rows.map((row) => `${row.model} ${prettyDay(row.date)}`).join(' · ')}${text ? ` — ${text}` : ''}`;
  const tasks = await Todo.find({ enquiry: enquiry._id, kind: { $in: SHOWS_EDD_KINDS }, completed: false });
  for (const task of tasks) {
    task.updates = [...(task.updates || []), { kind: 'note', text: said, note: said, by: user._id, at: new Date() }];
    await task.save();
    await noticeStatus(task, user, { step: { key: task.status || 'edd', label: 'Final EDD set by marketing' }, note: said, also: await peopleOn(task), onlyAlso: true });
    await publish(EVENTS.HANDOFF_UPDATED, { task, by: user });
  }
  return { models: (await Enquiry.findById(enquiry._id).select('eddByModel edd').lean()), told: tasks.length };
}

/**
 * Which of the enquiry's models are ready to go: a model is ready once the last team on its route
 * (Assembly, else Printing, else Production) says Ready for Dispatch or has finished. The rest are
 * waiting on that team.
 */
export async function modelReadiness(enquiryId) {
  const id = enquiryId?._id || enquiryId;
  const start = await Todo.findOne({ enquiry: id, kind: 'ask_edd' }).sort({ createdAt: -1 }).select('createdAt routing brief').lean();
  if (!start) return { ready: [], waiting: [] };
  const tasks = await Todo.find({ enquiry: id, kind: { $in: EDD_TASK_KINDS }, createdAt: { $gte: start.createdAt } }).select('kind status completed modelStatuses').lean();
  const KIND_OF_TEAM = { production: 'ask_edd', printing: 'ask_printing', assembling: 'ask_assembling_edd' };
  /* The model's own status on that team's task, where it moved on its own; else the task's. */
  const isDone = (task, model) => {
    if (!task) return false;
    if (task.completed) return true;
    const status = (task.modelStatuses || []).find((row) => row.model === model)?.status || task.status;
    const step = statusesOf(task).find((entry) => entry.key === status);
    return Boolean(step?.readyForDispatch || step?.done);
  };
  const routes = (start.routing?.models || []).length
    ? start.routing.models.map((row) => ({ model: row.model, last: row.assembly ? 'assembling' : row.printing ? 'printing' : 'production' }))
    : modelsOfTask(start).map((model) => ({ model, last: 'production' }));
  const ready = [];
  const waiting = [];
  for (const { model, last } of routes) {
    const task = tasks.find((entry) => entry.kind === KIND_OF_TEAM[last]);
    if (isDone(task, model)) ready.push(model);
    else waiting.push({ model, team: last });
  }
  return { ready, waiting };
}

/**
 * How an order of several models goes out — each model as it is ready, or all together — set by
 * the enquiry's marketing person or Admin. The dispatch request and the teams making the goods
 * hear it; with `by_model`, Quality and Dispatch are asked as soon as a model is ready.
 */
export async function setDispatchPlan(enquiry, user, { mode, note }) {
  if (!['together', 'by_model'].includes(mode)) fail('Say how it goes: each model as it is ready, or all together');
  const text = String(note || '').trim();
  await Enquiry.updateOne({ _id: enquiry._id }, { $set: { dispatchPlan: { mode, by: user._id, at: new Date(), note: text || undefined } } });
  const said = `Dispatch plan set by ${user.name}: ${mode === 'by_model' ? 'each model as it is ready' : 'all models together'}${text ? ` — ${text}` : ''}`;
  const tasks = await Todo.find({ enquiry: enquiry._id, kind: { $in: SHOWS_EDD_KINDS }, completed: false });
  for (const task of tasks) {
    task.updates = [...(task.updates || []), { kind: 'note', text: said, note: said, by: user._id, at: new Date() }];
    await task.save();
    await publish(EVENTS.HANDOFF_UPDATED, { task, by: user });
  }
  /* By model: a model already ready need not wait for the rest. */
  if (mode === 'by_model') {
    const ready = await Todo.findOne({ enquiry: enquiry._id, kind: { $in: EDD_TASK_KINDS } }).sort({ updatedAt: -1 });
    if (ready) {
      const { advanceJourney } = await import('./journey.service.js');
      await advanceJourney(ready, user, 'Dispatch plan: each model as it is ready');
    }
  }
  return { mode, told: tasks.length };
}

/**
 * A team hands its goods to the next — Production to Printing or Assembly, Printing to Assembly:
 * the next team's task hears it, and knows the day the goods came.
 */
async function handOn(task, user, step, text, only = null) {
  const from = task.kind === 'ask_edd' ? 'production' : task.kind === 'ask_printing' ? 'printing' : 'assembling';
  const next = await Todo.findOne({ ...jobFilter(task), kind: ROUTE_KINDS[step.handsTo], completed: false });
  if (!next) return null;
  const day = indiaDay(new Date());
  /* Only some models handed over: the next team hears which, and the day each came. */
  const handed = only?.length ? only : (next.routing?.models || []);
  const models = handed.join(', ');
  const said = `${ROUTE_LABEL[from]} handed the goods over${models ? ` (${models})` : ''} — ${user.name}${text ? `: ${text}` : ''}`;
  next.routing = {
    ...(next.routing || {}),
    received: { ...(next.routing?.received || {}), [from]: day },
    receivedModels: { ...(next.routing?.receivedModels || {}), ...Object.fromEntries(handed.map((model) => [model, day])) },
  };
  next.markModified('routing');
  next.updates = [...(next.updates || []), { kind: 'note', text: said, note: said, date: day, dateLabel: `From ${ROUTE_LABEL[from]}`, by: user._id, at: new Date() }];
  await next.save();
  await noticeStatus(next, user, { step: { key: next.status || 'received', label: `Goods from ${ROUTE_LABEL[from]}` }, note: said, also: await peopleOn(next), onlyAlso: true });
  await publish(EVENTS.HANDOFF_UPDATED, { task: next, by: user });
  return next;
}

/**
 * Marketing set the EDD on the enquiry: the departments working to it hear it on their open
 * tasks — Production's, Assembly's, Printing's and the dispatch request — as a line on each.
 */
export async function tellEddSet(enquiry, user, { day, note }) {
  const tasks = await Todo.find({ enquiry: enquiry._id, kind: { $in: SHOWS_EDD_KINDS }, completed: false });
  const text = String(note || '').trim();
  for (const task of tasks) {
    task.updates = [...(task.updates || []), {
      kind: 'note', text: `EDD ${prettyDay(day)} set by ${user.name} (marketing)${text ? `: ${text}` : ''}`,
      note: `EDD ${prettyDay(day)} set by marketing${text ? `: ${text}` : ''}`, date: day, dateLabel: 'EDD', by: user._id, at: new Date(),
    }];
    await task.save();
    await publish(EVENTS.HANDOFF_UPDATED, { task, by: user });
  }
  return tasks.length;
}

/** Kinds whose tasks are a problem in themselves — a complaint — until their workflow says otherwise. */
const ISSUE_KINDS = ['quality_issue'];
const MOULD_KINDS = ['mould_issue'];

/**
 * Where each enquiry is, for marketing's list [web: pages/Enquiries.jsx]: the mould's ready date
 * (ERD), Production's date (EDD) and the issues open on it — a department task at a problem
 * status (Mould Issue, Raw Material Not Available, Rework …) or a Quality issue still open.
 * One query for the page of enquiries, not one per row.
 */
export async function enquiryProgress(enquiryIds) {
  const ids = enquiryIds.filter(Boolean);
  const progress = new Map(ids.map((id) => [String(id), { erd: null, edd: null, issues: [] }]));
  if (!ids.length) return progress;
  /* Every kind that gives a date, or has a status that is an issue (Dispatch's Goods Not Yet Ready, Accounts' Hold …). */
  const withIssues = HANDOFFS.filter((handoff) => (handoff.form?.statuses || []).some((entry) => entry.issue)).map((handoff) => handoff.key);
  const kinds = [...new Set([...EDD_KINDS, ...MOULD_KINDS, ...ISSUE_KINDS, ...withIssues])];
  const [tasks, enquiries] = await Promise.all([
    Todo.find({ enquiry: { $in: ids }, kind: { $in: kinds } })
      .select('enquiry kind department status completed updates.fields updates.at outcome.fields outcome.at')
      .lean(),
    Enquiry.find({ _id: { $in: ids }, 'edd.date': { $ne: null } }).select('edd').lean(),
  ]);
  const latest = (row, field, date, at, department) => {
    if (!date || (row[field] && new Date(row[field].at || 0) >= new Date(at || 0))) return;
    row[field] = { date, at, department };
  };
  for (const task of tasks) {
    const row = progress.get(String(task.enquiry));
    if (!row) continue;
    const said = [...(task.updates || []), ...(task.outcome ? [task.outcome] : [])];
    for (const entry of said) {
      latest(row, 'edd', entry.fields?.edd, entry.at, task.department);
      latest(row, 'erd', entry.fields?.erd, entry.at, task.department);
    }
    if (task.completed) continue;
    const step = (findHandoff(task.kind)?.form?.statuses || []).find((entry) => entry.key === task.status);
    const kindLabel = findHandoff(task.kind)?.label || 'Issue';
    if (step?.issue) {
      /* A complaint says what it is and where it has got to: "Quality Issue — Under Checking". */
      row.issues.push({ department: task.department, label: ISSUE_KINDS.includes(task.kind) ? `${kindLabel} — ${step.label}` : step.label });
    } else if (!step && ISSUE_KINDS.includes(task.kind)) {
      /* One raised before Quality had its workflow: an issue until it is closed. */
      row.issues.push({ department: task.department, label: kindLabel });
    }
  }
  /* The enquiry's own EDD is the latest word, whoever gave it — marketing's or the shop floor's. */
  for (const enquiry of enquiries) {
    const row = progress.get(String(enquiry._id));
    if (row) row.edd = { date: enquiry.edd.date, at: enquiry.edd.at, department: enquiry.edd.department };
  }
  return progress;
}

/**
 * The open dispatch requests in baskets, for loading one vehicle with buyers at the same place
 * [web: Dispatch desk]. A basket is the buyers at the same landmark (the bus stop or mill a
 * driver asks for); without one, the same area; then the same PIN. Each basket also names the
 * other baskets in its PIN — near enough to add to the same trip. Buyers with no address yet
 * come last, so somebody fills it in.
 */
export async function dispatchBaskets() {
  const { default: Customer } = await import('../models/Customer.js');
  const tasks = await Todo.find({ kind: 'invoice_dispatch', completed: false })
    .select('enquiry customer title brief dueDate priority status user')
    .populate([{ path: 'enquiry', select: 'number customer' }, { path: 'user', select: 'name' }])
    .sort({ dueDate: 1 })
    .lean();
  const customerOf = (task) => String(task.customer || task.enquiry?.customer || '');
  const ids = [...new Set(tasks.map(customerOf).filter(Boolean))];
  const customers = new Map((await Customer.find({ _id: { $in: ids } }).select('name code address area landmark city pincode').lean())
    .map((customer) => [String(customer._id), customer]));
  const norm = (text) => String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const statuses = findHandoff('invoice_dispatch')?.form?.statuses || [];

  const baskets = new Map();
  for (const task of tasks) {
    const customer = customers.get(customerOf(task));
    const city = customer?.city || '';
    let key = 'none';
    let label = 'No address yet — add it on the customer';
    let by = 'none';
    if (customer?.landmark) {
      key = `landmark:${norm(customer.landmark)}|${norm(city)}`; by = 'landmark';
      label = `Near ${customer.landmark}${city ? `, ${city}` : ''}`;
    } else if (customer?.area) {
      key = `area:${norm(customer.area)}|${norm(city)}`; by = 'area';
      label = `${customer.area}${city ? `, ${city}` : ''}`;
    } else if (customer?.pincode) {
      key = `pin:${norm(customer.pincode)}`; by = 'pincode';
      label = `PIN ${customer.pincode}${city ? ` · ${city}` : ''}`;
    } else if (city) {
      key = `city:${norm(city)}`; by = 'city'; label = city;
    }
    if (!baskets.has(key)) baskets.set(key, { key, label, by, pincode: customer?.pincode || null, stops: [] });
    baskets.get(key).stops.push({
      task: task._id,
      enquiry: task.enquiry ? { _id: task.enquiry._id, number: task.enquiry.number } : null,
      customer: customer ? { _id: customer._id, name: customer.name } : null,
      address: [customer?.address, customer?.area, customer?.landmark && `near ${customer.landmark}`, customer?.city, customer?.pincode].filter(Boolean).join(', '),
      schedule: task.brief?.schedule || null,
      booking: task.brief?.booking || null,
      quantity: task.brief?.quantity || null,
      status: statuses.find((entry) => entry.key === task.status)?.label || null,
      due: task.dueDate || null,
      with: task.user?.name || null,
    });
  }
  const list = [...baskets.values()];
  /* Near enough to share the trip: the other baskets in the same PIN. */
  for (const basket of list) {
    basket.nearby = basket.pincode
      ? list.filter((other) => other !== basket && other.pincode === basket.pincode).map((other) => other.label)
      : [];
  }
  return list.sort((a, b) => (a.by === 'none') - (b.by === 'none') || b.stops.length - a.stops.length || a.label.localeCompare(b.label));
}

/**
 * When the goods will be ready — what the enquiry page shows while it is in Production
 * [web: components/DepartmentDesk.jsx]. Two answers, both kept:
 *
 *   edd     the latest date Production (or Assembly) gave on its task — in an update or when
 *           it said it was done — with who said it, when, and what was still pending
 *   lines   each sales order line's own expected completion, as the production board keeps it,
 *           beside what the buyer was promised and how much is made
 *
 * `asked` is the open Production / Assembly task, so the page can say a date has been asked
 * for and not given yet.
 */
export async function productionDates(enquiryId) {
  const { default: SalesOrder } = await import('../models/SalesOrder.js');
  const [tasks, orders, enquiry] = await Promise.all([
    Todo.find({ enquiry: enquiryId, kind: { $in: EDD_KINDS } })
      .sort({ createdAt: -1 })
      .populate([{ path: 'updates.by', select: 'name' }, { path: 'outcome.by', select: 'name' }])
      .lean(),
    SalesOrder.find({ enquiry: enquiryId, status: { $nin: ['cancelled'] } })
      .select('number lines.modelNumber lines.quantity lines.deliveryDate lines.revisedDeliveryDate lines.production')
      .sort({ createdAt: -1 })
      .lean(),
    Enquiry.findById(enquiryId).select('edd eddByModel').populate('edd.by', 'name').lean(),
  ]);
  const said = [];
  /* The enquiry's own EDD first: the latest word, marketing's or the shop floor's. */
  if (enquiry?.edd?.date) {
    said.push({ edd: enquiry.edd.date, by: enquiry.edd.by?.name, at: enquiry.edd.at, department: enquiry.edd.department, note: enquiry.edd.note });
  }
  for (const task of tasks) {
    const department = task.department;
    for (const update of task.updates || []) {
      if (update.fields?.edd) said.push({ edd: update.fields.edd, pending: update.fields.pending, by: update.by?.name, at: update.at, department });
    }
    if (task.outcome?.fields?.edd) {
      said.push({ edd: task.outcome.fields.edd, pending: task.outcome.fields.pending, by: task.outcome.by?.name, at: task.outcome.at, department });
    }
  }
  said.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  const open = tasks.find((task) => !task.completed);
  const lines = orders.flatMap((order) => (order.lines || []).map((line) => ({
    order: order.number,
    model: line.modelNumber,
    quantity: line.quantity,
    produced: line.production?.producedQty || 0,
    status: line.production?.status,
    expectedCompletion: line.production?.expectedCompletion || null,
    dueToBuyer: line.revisedDeliveryDate || line.deliveryDate || null,
  })));
  return {
    edd: said[0] || null,
    asked: open ? {
      department: open.department, at: open.createdAt, due: open.dueDate,
      /* Where Production has it on its own workflow — Planning, Part 1 Ready … */
      status: (findHandoff(open.kind)?.form?.statuses || []).find((entry) => entry.key === open.status)?.label || null,
    } : null,
    lines,
    /* Each model's EDD — the latest its teams gave — and each team's own date [refreshModelEdds]. */
    byModel: enquiry?.eddByModel || [],
  };
}

/* ------------------------------ Late tasks ------------------------------ */

/**
 * Department tasks that have passed their due time and nobody has been told about yet: each is
 * marked, once, and the event tells the department, the sender and Admin. Once — a late task is
 * something to act on, and a reminder every hour turns it into noise people learn to ignore.
 * The mark is claimed atomically, so two processes running the sweep never tell twice.
 */
export async function runLateTaskSweep({ now = new Date(), limit = 200 } = {}) {
  const late = await Todo.find({
    kind: { $exists: true },
    completed: false,
    dueDate: { $lt: now },
    lateNotifiedAt: { $exists: false },
  }).sort({ dueDate: 1 }).limit(limit);

  const told = [];
  for (const task of late) {
    const claimed = await Todo.updateOne(
      { _id: task._id, lateNotifiedAt: { $exists: false } },
      { $set: { lateNotifiedAt: now } }
    );
    if (!claimed.modifiedCount) continue;
    await publish(EVENTS.HANDOFF_LATE, { task });
    told.push(task);
  }
  return told;
}

/* ------------------------------ Dashboards ------------------------------ */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Marketing's holding task is the enquiry itself, not a task anybody was asked to do: it is left
 * out of the department-task lists and counts, which the marketing person reads as "My enquiries".
 */
const NOT_THE_ENQUIRY = { $nor: [{ holds: true, kind: { $in: ['new_enquiry', 'back_to_marketing', 'my_payment_followup'] } }] };

/** The numbers a department is run by, from its own tasks. */
export async function departmentFigures(department, { now = new Date() } = {}) {
  const tonight = endOfDayIST(now);
  const week = new Date(now.getTime() - 7 * DAY_MS);
  const month = new Date(now.getTime() - 30 * DAY_MS);
  const mine = { kind: { $exists: true }, department, ...NOT_THE_ENQUIRY };
  const open = { ...mine, completed: false };

  const [counts] = await Todo.aggregate([
    { $match: mine },
    {
      $facet: {
        open: [{ $match: { completed: false } }, { $count: 'n' }],
        unclaimed: [{ $match: { completed: false, user: null } }, { $count: 'n' }],
        late: [{ $match: { completed: false, dueDate: { $lt: now } } }, { $count: 'n' }],
        dueToday: [{ $match: { completed: false, dueDate: { $gte: now, $lte: tonight } } }, { $count: 'n' }],
        doneWeek: [{ $match: { 'outcome.result': 'done', completedAt: { $gte: week } } }, { $count: 'n' }],
        sentBackWeek: [{ $match: { 'outcome.result': 'returned', completedAt: { $gte: week } } }, { $count: 'n' }],
        speed: [
          { $match: { 'outcome.result': 'done', completedAt: { $gte: month } } },
          {
            $group: {
              _id: null,
              n: { $sum: 1 },
              hours: { $avg: { $divide: [{ $subtract: ['$completedAt', '$createdAt'] }, 3600000] } },
              onTime: { $sum: { $cond: [{ $lte: ['$completedAt', '$dueDate'] }, 1, 0] } },
            },
          },
        ],
      },
    },
  ]);
  const n = (key) => counts?.[key]?.[0]?.n || 0;
  const speed = counts?.speed?.[0];

  return {
    department,
    label: departmentName(department),
    open: n('open'),
    unclaimed: n('unclaimed'),
    late: n('late'),
    dueToday: n('dueToday'),
    doneThisWeek: n('doneWeek'),
    sentBackThisWeek: n('sentBackWeek'),
    /* Over the last thirty days, so one slow week does not define a department. */
    averageHoursToDone: speed ? Math.round(speed.hours * 10) / 10 : null,
    onTimePercent: speed?.n ? Math.round((speed.onTime / speed.n) * 100) : null,
    openFilter: open,
  };
}

/** What a task's open asks show: whose task, at what status. */
export const WAITING_ON_POPULATE = { path: 'waitingOn', select: 'kind department status title askedFrom', populate: { path: 'user', select: 'name' } };

const LIST_POPULATE = [
  WAITING_ON_POPULATE,
  { path: 'attachment', select: 'key filename size' },
  { path: 'resultFile', select: 'key filename size' },
  { path: 'createdBy', select: 'name department' },
  { path: 'user', select: 'name' },
  { path: 'outcome.by', select: 'name' },
  { path: 'updates.by', select: 'name' },
  { path: 'customer', select: 'code name' },
  { path: 'enquiry', select: 'number stage edd requirement.modelNumber requirement.colour' },
];

/*
 * The dashboards read tasks as plain objects — a desk of a few hundred tasks, each with nine
 * records joined in, spent most of its time building full documents nobody saves. The fields the
 * model works out are added back, so the reply reads exactly as it did.
 */
const plainTask = (row) => Object.assign(row, {
  id: String(row._id),
  isEscalated: Boolean(row.escalation?.at) && !row.completed,
  unclaimed: !row.user,
});
const plainTasks = (rows) => rows.map(plainTask);

/**
 * One department's dashboard: its figures, the work on its queue (late first, then by due
 * time), what it finished lately, and — the marketing question, asked by every department —
 * what it is waiting on from others and what came back.
 */
export async function departmentDashboard(department, { now = new Date() } = {}) {
  const figures = await departmentFigures(department, { now });
  const { openFilter, ...numbers } = figures;
  const week = new Date(now.getTime() - 7 * DAY_MS);

  const [queue, recentlyDone, waitingOnOthers, cameBack] = (await Promise.all([
    Todo.find(openFilter).sort({ dueDate: 1, createdAt: 1 }).limit(100).populate(LIST_POPULATE).lean(),
    Todo.find({ kind: { $exists: true }, department, completed: true, completedAt: { $gte: week } })
      .sort({ completedAt: -1 }).limit(20).populate(LIST_POPULATE).lean(),
    Todo.find({ kind: { $exists: true }, fromDepartment: department, department: { $ne: department }, completed: false })
      .sort({ dueDate: 1 }).limit(50).populate(LIST_POPULATE).lean(),
    Todo.find({
      kind: { $exists: true }, fromDepartment: department, department: { $ne: department },
      completed: true, completedAt: { $gte: week },
    }).sort({ completedAt: -1 }).limit(20).populate(LIST_POPULATE).lean(),
  ])).map(plainTasks);

  return { figures: numbers, queue, recentlyDone, waitingOnOthers, cameBack };
}

/**
 * The department tasks open on a department's queue — its dashboard [web: DepartmentDashboard].
 *
 * One row per task: the enquiry it is about, what was asked (its brief), how long it has been
 * here, whether it is late, and the work records behind it (the enquiry's sample, quotation and
 * order) so a row can take the reader straight to the thing they work on. Late first, then by
 * due time. A marketing person sees the tasks for their own buyers; everybody else sees the
 * department's.
 */
export async function enquiriesHeldBy(department, user, { now = new Date(), limit = 200 } = {}) {
  const queue = { kind: { $exists: true }, department, ...NOT_THE_ENQUIRY };
  /* Marketing's desk is each person's own buyers; any other desk is the department's. */
  if (department === 'marketing' && isOwnershipScoped(user)) queue.user = user._id;
  /* And this person's own payment follow-ups, whichever desk they read from: a "My" task belongs
     on its person's login, not only on the enquiry it is about. */
  const filter = { completed: false, $or: [queue, { kind: 'my_payment_followup', user: user._id }] };

  const tasks = await Todo.find(filter)
    .sort({ dueDate: 1, createdAt: 1 })
    .limit(limit)
    .populate([
      ...LIST_POPULATE.filter((entry) => entry.path !== 'enquiry'),
      {
        path: 'enquiry',
        select: 'number stage status customer assignedTo edd requirement.modelNumber requirement.colour items.modelNumber nextFollowUpDate nextAction targetPrice',
        populate: [{ path: 'customer', select: 'code name' }, { path: 'assignedTo', select: 'name' }],
      },
    ])
    .lean()
    .then(plainTasks);

  const ids = tasks.map((task) => task.enquiry?._id).filter(Boolean);
  const [{ default: Sample }, { default: Quotation }, { default: SalesOrder }] = await Promise.all([
    import('../models/Sample.js'), import('../models/Quotation.js'), import('../models/SalesOrder.js'),
  ]);
  /* The newest of each per enquiry. */
  const newest = async (Model, select) => {
    const rows = await Model.find({ enquiry: { $in: ids } }).select(`enquiry number status ${select}`).sort({ createdAt: -1 }).lean();
    const byEnquiry = new Map();
    for (const row of rows) if (!byEnquiry.has(String(row.enquiry))) byEnquiry.set(String(row.enquiry), row);
    return byEnquiry;
  };
  const [samples, quotations, orders] = ids.length
    ? await Promise.all([newest(Sample, ''), newest(Quotation, ''), newest(SalesOrder, '')])
    : [new Map(), new Map(), new Map()];

  return tasks.map((task) => {
    /* A team task raised without an enquiry [raiseTeamTask]: on the desk with the rest. */
    if (!task.enquiry) {
      return {
        task, enquiry: null, since: task.createdAt,
        late: Boolean(task.dueDate && task.dueDate < now),
        dueToday: Boolean(task.dueDate && task.dueDate >= now && task.dueDate <= endOfDayIST(now)),
        records: { sample: null, quotation: null, order: null },
      };
    }
    const key = String(task.enquiry._id);
    const pick = (row) => (row ? { _id: row._id, number: row.number, status: row.status } : null);
    return {
      task,
      enquiry: { ...task.enquiry, id: String(task.enquiry._id), stageLabel: stageLabel(task.enquiry.stage) },
      since: task.createdAt,
      late: Boolean(task.dueDate && task.dueDate < now),
      dueToday: Boolean(task.dueDate && task.dueDate >= now && task.dueDate <= endOfDayIST(now)),
      records: { sample: pick(samples.get(key)), quotation: pick(quotations.get(key)), order: pick(orders.get(key)) },
    };
  });
}

/**
 * How many enquiries sit at each of a department's stages right now — Sales / SO's "approved
 * enquiries" are the ones at PO & SO, Dispatch's are at Invoice & Dispatch and LR Copy.
 * `scope` is the viewer's ownership filter, so a marketing person counts only their own.
 */
export async function enquiriesAtStages(department, scope = {}) {
  const stages = STAGES.filter((stage) => stage.department === department);
  if (!stages.length) return [];

  const rows = await Enquiry.aggregate([
    { $match: { ...scope, stage: { $in: stages.map((stage) => stage.key) } } },
    { $group: { _id: '$stage', count: { $sum: 1 } } },
  ]);
  const counts = Object.fromEntries(rows.map((row) => [row._id, row.count]));

  return stages.map(({ key, number, label }) => ({ key, number, label, count: counts[key] || 0 }));
}

/** Every department's figures side by side — Admin's view of where work is stuck. */
export async function allDepartmentFigures(departments, { now = new Date() } = {}) {
  const rows = await Promise.all(departments.map((key) => departmentFigures(key, { now })));
  return rows.map(({ openFilter, ...numbers }) => numbers);
}

/**
 * A lot failed QC, or is held: the open dispatch request on its enquiry (and SO) hears it — a line on
 * the request, and a notice to Dispatch, the marketing person and Admin. **Dispatch is not held.**
 * The plant decides whether the goods go; this makes sure nobody sends them without knowing.
 * With no request open yet, the Quality task the sheet answers carries the notice instead.
 */
export async function warnDispatchOfQc(record, user) {
  const verdict = record.verdict === 'on_hold' ? 'on hold' : 'rejected';
  const failed = record.failedTests?.length ? ` — failed ${record.failedTests.join(', ')}` : '';
  const note = `QC ${record.number}: ${verdict}${failed}. Dispatch is not held — check with Quality before loading.`;
  const requests = await Todo.find({
    kind: 'invoice_dispatch', completed: false, enquiry: record.enquiry,
    ...(record.order ? { $or: [{ order: record.order }, { order: { $exists: false } }] } : {}),
  });
  const step = (task) => ({ key: task.status || 'qc', label: `QC ${verdict}` });
  for (const request of requests) {
    await Todo.updateOne({ _id: request._id }, { $push: { updates: { note, by: user._id, at: new Date() } } }, { keepVersion: true });
    await noticeStatus(request, user, { step: step(request), note, also: await peopleOn(request) });
  }
  if (!requests.length && record.task) {
    const task = await Todo.findById(record.task);
    if (task) await noticeStatus(task, user, { step: step(task), note });
  }
  return requests.length;
}
