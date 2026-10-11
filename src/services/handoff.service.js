import Todo, { PRIORITIES } from '../models/Todo.js';
import Enquiry from '../models/Enquiry.js';
import { CLOSED_STAGE, STAGES, stageLabel } from '../config/enquiryStages.js';
import { findDepartment } from '../config/modules.js';
import { findHandoff } from '../config/handoffs.js';
import { canRead } from './access.service.js';
import { isOwnershipScoped, ownsRecord } from './ownership.service.js';
import { departmentsOf, inDepartment, isManagement } from '../utils/departments.js';
import { EVENTS, publish } from './events.service.js';
import ApiError from '../utils/ApiError.js';
import { describeBalance, dispatchBalance, qualityPassed } from './enquiryGates.service.js';
import * as paymentPresets from './paymentGates.service.js';
import { assertEnquiryPaidFor } from './paymentGates.service.js';
import { MATERIALS } from '../models/Mould.js';

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
function startOfDayIST(now = new Date()) {
  const local = new Date(now.getTime() + IST_OFFSET_MS);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - IST_OFFSET_MS);
}

const departmentName = (key) => findDepartment(key)?.label || String(key || '').replace(/_/g, ' ');

const fail = (message) => { throw ApiError.badRequest(message); };

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
  if (isOwnershipScoped(user)) return false;
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
async function moveStage(enquiry, to, { user, task, note, heldBy }) {
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
  if (!Object.keys(update).length) return;
  await Enquiry.updateOne({ _id: enquiry._id }, update, { timestamps: false, keepVersion: true });

  /* Mirrored on the document without marking it changed, so a later save cannot write it twice. */
  if (entry) {
    enquiry.stage = to;
    enquiry.unmarkModified('stage');
  }
  if (heldBy !== undefined) {
    enquiry.heldBy = heldBy || undefined;
    enquiry.unmarkModified('heldBy');
  }
}

const aboutOf = (enquiry) => {
  const customerName = enquiry.customer?.name;
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
  if (!row) return {};
  const said = {};
  const material = row.material && row.material.toLowerCase().replace(/\s+/g, '_');
  if (material && MATERIALS.includes(material)) said.material = material;
  if (row.colour) said.colour = row.colour;
  if (row.colourType) said.colourMandatory = row.colourType === 'Compulsory colour';
  if (Number(row.quantity) > 0) said.quantity = Number(row.quantity);
  return said;
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
function keptBrief(kind, brief = {}, { strict = true } = {}) {
  const asks = findHandoff(kind)?.asks || [];
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
export async function moveEnquiry({
  enquiry, kind, note, fields, brief, priority, requiredDate, user, system = false, openRecords = true, finishes = [], parentTask,
}) {
  const handoff = findHandoff(kind);
  if (!handoff?.department || handoff.stage === CLOSED_STAGE) fail('That button does not raise a department task');
  if (enquiry.stage === CLOSED_STAGE) fail('This enquiry is closed. Nothing more can be sent on it.');
  if (kind === 'back_to_marketing') return returnToMarketing({ enquiry, note, fields, user, system });
  if (!system && !(await mayHandOff(user, enquiry))) throw ApiError.notFound('Enquiry not found');

  const already = await Todo.findOne({ enquiry: enquiry._id, kind, completed: false }).populate('user', 'name');
  if (already) {
    throw ApiError.conflict(
      `${handoff.label} is already with ${departmentName(already.department)}`
        + `${already.user?.name ? ` (${already.user.name})` : ''}. Add to that one, or wait for it to come back.`
    );
  }
  const asked = keptBrief(kind, brief, { strict: !system });
  if (!system) assertNote(kind, asked, note);
  const form = handoff.form || {};
  const due = requiredDue(requiredDate) || (form.dueFrom && requiredDue(asked[form.dueFrom], 'That date'));

  /*
   * The gates [services/enquiryGates.service.js, services/paymentGates.service.js]. Dispatch only
   * once Quality has passed the job; Production only once the advance is in, Dispatch only once
   * the money due before dispatch is in — refused with the shortfall, and Payment Collection is
   * asked for it.
   */
  if (kind === 'invoice_dispatch' && !(await qualityPassed(enquiry._id, {}))) {
    fail('Quality has not passed this job yet. Send it to Quality Check first; Dispatch can be asked once it passes.');
  }
  if (kind === 'ask_edd') await assertEnquiryPaidFor(enquiry._id, 'production', { by: user });
  if (kind === 'invoice_dispatch') await assertEnquiryPaidFor(enquiry._id, 'dispatch', { by: user });

  const text = String(note || '').trim();
  if (finishes.length) await finishOpenTasks(enquiry._id, finishes, { fields, note: text, user });

  let department = handoff.department;
  let assignee;
  if (department === 'owner') ({ userId: assignee, department } = await ownerOf(enquiry));
  const holder = await holderOf(enquiry._id);
  const task = await Todo.create({
    enquiry: enquiry._id,
    customer: enquiry.customer?._id || enquiry.customer,
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
  await moveStage(enquiry, handoff.stage, { user, task, note: text || handoff.label });
  if (openRecords) await openWorkRecord(kind, enquiry, asked);

  await publish(EVENTS.HANDOFF_SENT, { task, enquiry, by: user });
  return task;
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

/** Closing ends everything still open on the enquiry, the holding task included, and says so. */
async function closeOpenTasks(enquiryId, why, user) {
  const open = await Todo.find({ enquiry: enquiryId, kind: { $exists: true }, completed: false });
  for (const task of open) {
    task.completed = true;
    task.completedAt = new Date();
    if (user) task.completedBy = user._id;
    task.outcome = { result: 'done', note: `Closed with the enquiry: ${why}`, by: user?._id, at: new Date() };
    await task.save();
  }
}

/**
 * Closes an enquiry on nobody's behalf — paid in full with nothing left to send. Recorded as a
 * Task Closed like the button, by the system, with why.
 */
export async function closeEnquiryAutomatically({ enquiry, note }) {
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
  await closeOpenTasks(enquiry._id, note);
  await moveStage(enquiry, CLOSED_STAGE, { task: record, note, heldBy: null });
  return record;
}

/**
 * One button pressed on the enquiry screen. Returns the task (or the record, for the buttons
 * that only record). `enquiry` must be a document with `customer` populated or an id.
 */
export async function sendHandoff({ enquiry, kind, note, fields, brief, priority, requiredDate, user }) {
  const handoff = findHandoff(kind);
  if (!handoff || handoff.hidden) fail('That is not one of the buttons');

  const text = String(note || '').trim();
  if (enquiry.stage === CLOSED_STAGE && kind !== 'task_closed') {
    fail('This enquiry is closed. Nothing more can be sent on it.');
  }

  /* Every button that names a department raises that department's task. */
  if (handoff.department) return moveEnquiry({ enquiry, kind, note: text, fields, brief, priority, requiredDate, user });

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

  if (kind === 'task_closed') await closeOpenTasks(enquiry._id, text, user);
  await moveStage(enquiry, handoff.stage, {
    user, task: record, note: text || handoff.label, heldBy: kind === 'task_closed' ? null : undefined,
  });
  return record;
}

function openHandoff(task, user) {
  if (!task.kind || !task.enquiry) fail('That is not a task sent about an enquiry');
  if (task.completed) throw ApiError.conflict('That task is already finished');
  if (!mayWorkOnHandoff(user, task)) {
    throw ApiError.forbidden(`This task is on the ${departmentName(task.department)} queue`);
  }
}

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
export async function completeHandoff(task, user, { note, fields = {}, next }) {
  openHandoff(task, user);
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

  /* A task finished by uploading the work (the sales order) is not ticked off without it. */
  const byUpload = (findHandoff(task.kind)?.form?.statuses || []).find((entry) => entry.pdf && entry.done);
  if (byUpload && !task.resultFile) fail(`Upload the PDF to finish this task — it is marked ${byUpload.label} then`);

  /* Dispatch's task is done when the balance has gone, lot by lot as Updates until then. */
  if (task.kind === 'invoice_dispatch') {
    const left = await dispatchBalance(task.enquiry?._id || task.enquiry);
    if (left.length) {
      fail(`${describeBalance(left)} still to send. Post each lot as an Update and mark it done once the balance has gone — or short-close the order first.`);
    }
  }

  const handoff = findHandoff(task.kind);
  const kept = keptFields(task.kind, fields);
  task.completed = true;
  task.completedAt = new Date();
  task.completedBy = user._id;
  if (!task.user) task.user = user._id;
  task.outcome = {
    result: 'done', note: text, fields: Object.keys(kept).length ? kept : undefined, by: user._id, at: new Date(),
  };
  await task.save();

  const details = (handoff?.records || []).filter((field) => kept[field.key]).map((field) => `${field.label}: ${kept[field.key]}`);
  /* A clarification's answer goes back onto the task that asked; anything else, to its sender. */
  if (task.parentTask) await answerParent(task, user, text);
  else {
    await backToSender(task, {
      user,
      title: `Done: ${task.title} — next step?`,
      notes: [`${user.name}: ${text}`, ...details].join('\n'),
    });
  }
  await publish(EVENTS.HANDOFF_DONE, { task, by: user });
  return task;
}

/* ------------------------------ A department's own workflow ------------------------------ */

const statusesOf = (task) => findHandoff(task.kind)?.form?.statuses || [];

/** The answer to a clarification, on the task that asked — and that task back where it was. */
async function answerParent(clarification, user, text) {
  const parent = await Todo.findById(clarification.parentTask);
  if (!parent || parent.completed) return;
  const asking = statusesOf(parent).find((entry) => entry.raises === clarification.kind);
  parent.updates = [...(parent.updates || []), { note: `Clarified by ${user.name}: ${text}`, by: user._id, at: new Date() }];
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
export async function setTaskStatus(task, user, { status, note }) {
  openHandoff(task, user);
  const step = statusesOf(task).find((entry) => entry.key === status);
  if (!step) fail('That is not one of this task’s statuses');
  if (step.pdf) fail(`Upload the PDF to mark it ${step.label}`);
  const text = String(note || '').trim();
  if (step.comment && text.length < 3) fail(`Say what is needed — ${step.label} asks for a comment`);
  if (task.status === status) return task;

  if (step.raises) {
    const enquiry = await enquiryOfTask(task);
    await moveEnquiry({
      enquiry, kind: step.raises, note: `${user.name}: ${text}`, user, system: true, openRecords: false,
      requiredDate: new Date(), parentTask: task._id,
    });
  }
  task.status = status;
  task.statusHistory = [...(task.statusHistory || []), { status, note: text || undefined, by: user._id, at: new Date() }];
  task.updates = [...(task.updates || []), { note: text ? `${step.label}: ${text}` : step.label, by: user._id, at: new Date() }];
  if (!task.user) task.user = user._id;
  await task.save();
  await publish(EVENTS.HANDOFF_UPDATED, { task, by: user });
  return task;
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
export async function finishWithResult(task, user, { attachmentId, note }) {
  const step = resultStepFor(task, user);
  task.resultFile = attachmentId;
  task.status = step.key;
  task.statusHistory = [...(task.statusHistory || []), { status: step.key, note: note || undefined, by: user._id, at: new Date() }];
  await task.save();
  const done = step.done
    ? await completeHandoff(task, user, { note: String(note || '').trim() || `${step.label} — PDF uploaded` })
    : task;
  let next = null;
  let nextProblem = null;
  if (step.next) {
    const enquiry = await enquiryOfTask(task);
    try {
      next = await moveEnquiry({ enquiry, kind: step.next, note: `${step.label} by ${user.name}`, user, system: true });
    } catch (error) {
      if (error?.statusCode !== 400 && error?.statusCode !== 409) throw error;
      nextProblem = error.message;
    }
  }
  return { task: done, next, nextProblem };
}

/** The department corrects what it was told — the questions marked `editable` (contact details). */
export async function editTaskBrief(task, user, { brief = {} }) {
  openHandoff(task, user);
  const editable = (findHandoff(task.kind)?.asks || []).filter((field) => field.editable);
  if (!editable.length) fail('Nothing on this task can be corrected here');
  const current = { ...(task.brief || {}) };
  const changed = [];
  for (const field of editable) {
    if (!(field.key in brief)) continue;
    const value = keptAnswer(field, brief[field.key]);
    if ((current[field.key] || '') === value) continue;
    if (value) current[field.key] = value;
    else delete current[field.key];
    changed.push(field.label);
  }
  if (!changed.length) return task;
  task.brief = current;
  task.markModified('brief');
  task.updates = [...(task.updates || []), { note: `Corrected: ${changed.join(', ')}`, by: user._id, at: new Date() }];
  await task.save();
  return task;
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
    note: text, fields: Object.keys(kept).length ? kept : undefined, by: user._id, at: new Date(),
  }];
  if (!task.user) task.user = user._id;
  await task.save();
  await publish(EVENTS.HANDOFF_UPDATED, { task, by: user });
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

const MATERIAL_WORDS = { pp: 'PP', hips: 'HIPS', recycled_pp: 'Recycled PP' };
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
    enquiry.customer ? Customer.findById(enquiry.customer).select('name mobile whatsapp contacts address city state pincode').lean() : null,
    newest(SalesOrder, 'number lines paymentTerms paymentPlan', parts('lines').filter((entry) => !/hookRef|clipRef|printRef/.test(entry.path))),
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
  const items = rows.map((row) => {
    const filled = { ...row };
    for (const other of others.filter((entry) => sameModel(entry, row))) {
      for (const key of ['material', 'colour', 'hook', 'clip', 'print']) {
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
      colourType: filled.colour ? (filled.mandatory ? 'Compulsory colour' : 'Preferred colour') : '',
      /* A sample is three pieces unless somebody says why it is more. */
      quantity: '3',
    };
  });
  const modelList = [...new Set(items.map((row) => row.model).filter(Boolean))];
  const enquiryQuantity = source.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);
  const orderQuantity = (order?.lines || []).reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);

  const primary = customer?.contacts?.find((contact) => contact.isPrimary) || customer?.contacts?.[0];
  const phone = primary?.mobile || customer?.mobile || '';
  const place = [customer?.address, customer?.city, customer?.state, customer?.pincode].filter(Boolean).join(', ');

  return {
    customer: {
      name: customer?.name || '',
      contactPerson: primary?.name || '',
      mobile: phone,
      whatsapp: primary?.whatsapp || customer?.whatsapp || phone,
      delivery: `${primary?.name || 'Not added'} · ${phone || 'No number'} · ${place || 'Road not selected'}`,
    },
    items,
    modelList,
    models: modelList.join(', '),
    /* "PP Black" — but "HIPS White", not "HIPS White White", when the resin's name already says it. */
    materials: items.map((row) => (row.colour && !row.material.toLowerCase().includes(row.colour.toLowerCase())
      ? [row.material, row.colour].filter(Boolean).join(' ')
      : row.material || row.colour)).filter(Boolean).join(', '),
    /* Enquiries carry no quantity; the order on it does. */
    quantity: String(orderQuantity || enquiryQuantity || ''),
    targetPrice: enquiry.targetPrice != null ? String(enquiry.targetPrice) : '',
    order: order
      ? { number: order.number, paymentTerms: termsWords(order), invoiceNumber: consignment?.invoice?.number || '' }
      : { paymentTerms: '', invoiceNumber: '' },
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

const LIST_POPULATE = [
  { path: 'attachment', select: 'key filename size' },
  { path: 'resultFile', select: 'key filename size' },
  { path: 'createdBy', select: 'name department' },
  { path: 'user', select: 'name' },
  { path: 'outcome.by', select: 'name' },
  { path: 'updates.by', select: 'name' },
  { path: 'customer', select: 'code name' },
  { path: 'enquiry', select: 'number stage requirement.modelNumber requirement.colour' },
];

/**
 * One department's dashboard: its figures, the work on its queue (late first, then by due
 * time), what it finished lately, and — the marketing question, asked by every department —
 * what it is waiting on from others and what came back.
 */
export async function departmentDashboard(department, { now = new Date() } = {}) {
  const figures = await departmentFigures(department, { now });
  const { openFilter, ...numbers } = figures;
  const week = new Date(now.getTime() - 7 * DAY_MS);

  const [queue, recentlyDone, waitingOnOthers, cameBack] = await Promise.all([
    Todo.find(openFilter).sort({ dueDate: 1, createdAt: 1 }).limit(100).populate(LIST_POPULATE),
    Todo.find({ kind: { $exists: true }, department, completed: true, completedAt: { $gte: week } })
      .sort({ completedAt: -1 }).limit(20).populate(LIST_POPULATE),
    Todo.find({ kind: { $exists: true }, fromDepartment: department, department: { $ne: department }, completed: false })
      .sort({ dueDate: 1 }).limit(50).populate(LIST_POPULATE),
    Todo.find({
      kind: { $exists: true }, fromDepartment: department, department: { $ne: department },
      completed: true, completedAt: { $gte: week },
    }).sort({ completedAt: -1 }).limit(20).populate(LIST_POPULATE),
  ]);

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
  const filter = { kind: { $exists: true }, completed: false, department, ...NOT_THE_ENQUIRY };
  /* Marketing's desk is each person's own buyers; any other desk is the department's. */
  if (department === 'marketing' && isOwnershipScoped(user)) filter.user = user._id;

  const tasks = await Todo.find(filter)
    .sort({ dueDate: 1, createdAt: 1 })
    .limit(limit)
    .populate([
      ...LIST_POPULATE.filter((entry) => entry.path !== 'enquiry'),
      {
        path: 'enquiry',
        select: 'number stage status customer assignedTo requirement.modelNumber requirement.colour items.modelNumber nextFollowUpDate nextAction targetPrice',
        populate: [{ path: 'customer', select: 'code name' }, { path: 'assignedTo', select: 'name' }],
      },
    ]);

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

  return tasks.filter((task) => task.enquiry).map((task) => {
    const key = String(task.enquiry._id);
    const pick = (row) => (row ? { _id: row._id, number: row.number, status: row.status } : null);
    return {
      task,
      enquiry: { ...task.enquiry.toObject(), stageLabel: stageLabel(task.enquiry.stage) },
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
