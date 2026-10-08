import Todo from '../models/Todo.js';
import Enquiry from '../models/Enquiry.js';
import { CLOSED_STAGE, STAGES, stageLabel } from '../config/enquiryStages.js';
import { findDepartment } from '../config/modules.js';
import { KIND_FOR_STAGE, findHandoff, movesEnquiry } from '../config/handoffs.js';
import { canRead } from './access.service.js';
import { isOwnershipScoped, ownsRecord } from './ownership.service.js';
import { EVENTS, publish } from './events.service.js';
import ApiError from '../utils/ApiError.js';

/**
 * One department asking another for something about an enquiry — the buttons on the enquiry
 * screen [config/handoffs.js].
 *
 *   send       a task lands on the department's queue, due by the end of today, and anyone in
 *              the department may pick it up. The enquiry moves to the button's stage.
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
const isAdmin = (user) => user?.role === 'admin' || user?.department === 'management';

const idOf = (value) => String(value?._id || value || '');

/** The enquiry's open holding task — the department that has it now. */
export const holderOf = (enquiryId) =>
  Todo.findOne({ enquiry: enquiryId, holds: true, completed: false });

/** Whether this person is the one holding a task: its department, or it is theirs by name. */
export function mayWorkOnHandoff(user, task) {
  if (isAdmin(user)) return true;
  if (task.user && idOf(task.user) === idOf(user._id)) return true;
  return Boolean(task.department && task.department === user.department);
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
  return Boolean(user.department && (await Todo.exists({
    enquiry: enquiry._id, department: user.department, kind: { $exists: true },
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

/** Keep the details a button records, and nothing else. */
function keptFields(kind, fields = {}) {
  const allowed = new Set((findHandoff(kind)?.records || []).map((field) => field.key));
  return Object.fromEntries(
    Object.entries(fields || {})
      .filter(([key, value]) => allowed.has(key) && String(value ?? '').trim())
      .map(([key, value]) => [key, String(value).trim().slice(0, 200)])
  );
}

/** Opens the holding task: this department now has the enquiry. Saves nothing on the enquiry. */
async function openHolder({ enquiry, kind, note, user, title }) {
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
    fromDepartment: user?.department || undefined,
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
 * The work record a button opens, so the department finds it waiting: Sample Request raises the
 * sample, Create Quotation the costing sheet. Both are one-per-enquiry, so pressing again (or a
 * status change doing the same) reuses the open one.
 */
async function openWorkRecord(kind, enquiry) {
  if (kind === 'sample_request') {
    const { createSampleForEnquiry } = await import('./sampling.service.js');
    await createSampleForEnquiry(enquiry, {}, { autoCreated: true });
  }
  if (kind === 'create_quotation') {
    const { ensureCostingFor } = await import('./costingRequest.service.js');
    await ensureCostingFor(enquiry);
  }
}

/**
 * The first holding task, for a new enquiry (and for one that has none — see the migration).
 * Marketing holds it at Enquiry unless it is already somewhere else.
 */
export async function ensureHolder(enquiry, { user } = {}) {
  if (enquiry.stage === CLOSED_STAGE) return null;
  const existing = await holderOf(enquiry._id);
  if (existing) return existing;
  const kind = KIND_FOR_STAGE[enquiry.stage] || 'new_enquiry';
  const task = await openHolder({ enquiry, kind, user });
  await moveStage(enquiry, null, { heldBy: task.department });
  return task;
}

/**
 * Moves the enquiry on: the department that had it is done with it, and the button's department
 * has it now, at the button's stage. The one door every stage change goes through.
 *
 * `fields` are what the department that had it records about its work (the courier and AWB
 * when a sample goes out), kept on its task. `system` skips the who-may check (the caller has
 * already made it, or it is moving on someone's behalf). `openRecords: false` is for the moves
 * made by the automations, which raise the sample or costing themselves.
 */
export async function moveEnquiry({ enquiry, kind, note, fields, user, system = false, openRecords = true }) {
  const handoff = findHandoff(kind);
  if (!movesEnquiry(handoff)) fail('That button does not move the enquiry');
  if (enquiry.stage === CLOSED_STAGE) fail('This enquiry is closed. Nothing more can be sent on it.');

  const current = await holderOf(enquiry._id);
  if (!system && !(await mayMove(user, enquiry, current))) {
    throw ApiError.forbidden(current
      ? `${departmentName(current.department)} has this enquiry. Only they, the marketing person or Admin can move it on.`
      : 'Only the marketing person or Admin can move this enquiry on.');
  }
  if (current && current.kind === kind) {
    const who = current.user ? await current.populate('user', 'name') : current;
    throw ApiError.conflict(
      `${handoff.label} is already with ${departmentName(current.department)}`
        + `${who.user?.name ? ` (${who.user.name})` : ''}. Add to that one, or wait for it to come back.`
    );
  }

  const text = String(note || '').trim();
  const now = new Date();
  let closedAsDone = false;
  let closed = null;
  if (current) {
    const kept = keptFields(current.kind, fields);
    /* Done when the department that had it moves it on; "moved" when someone else took it. */
    closedAsDone = Boolean(user && mayWorkOnHandoff(user, current) && !isAdminOverride(user, current));
    /*
     * Claimed, not saved: two moves at once (a status change and the sample it raised, or two
     * people pressing) must not both close it — the second finds it already closed and stops.
     */
    const claimed = await Todo.updateOne({ _id: current._id, completed: false }, {
      $set: {
        completed: true,
        completedAt: now,
        ...(user ? { completedBy: user._id } : {}),
        ...(!current.user && user && closedAsDone ? { user: user._id } : {}),
        outcome: {
          result: closedAsDone ? 'done' : 'moved',
          note: text || `Moved on: ${handoff.label}`,
          ...(Object.keys(kept).length ? { fields: kept } : {}),
          ...(user ? { by: user._id } : {}),
          at: now,
          next: kind,
        },
      },
    });
    if (!claimed.modifiedCount) throw ApiError.conflict('Someone has just moved this enquiry on. Reload to see where it is.');
    closed = await Todo.findById(current._id);
  }

  const task = await openHolder({ enquiry, kind, note: text, user });
  await moveStage(enquiry, handoff.stage, { user, task, note: text || handoff.label, heldBy: task.department });
  if (openRecords) await openWorkRecord(kind, enquiry);

  await publish(EVENTS.HANDOFF_SENT, { task, enquiry, by: user });
  /* The sender hears it was done — unless the next task is theirs, which already says so. */
  if (closed && closedAsDone && idOf(closed.createdBy) !== idOf(task.user)) {
    await publish(EVENTS.HANDOFF_DONE, { task: closed, by: user });
  }
  return task;
}

/** Admin moving a department's enquiry is taking it, not doing it — unless Admin is the holder. */
const isAdminOverride = (user, task) =>
  isAdmin(user) && task.department !== user.department && idOf(task.user) !== idOf(user._id);

/**
 * One button pressed on the enquiry screen. Returns the task (or the record, for the buttons
 * that only record). `enquiry` must be a document with `customer` populated or an id.
 */
export async function sendHandoff({ enquiry, kind, note, fields, user }) {
  const handoff = findHandoff(kind);
  if (!handoff || handoff.hidden) fail('That is not one of the buttons');

  const text = String(note || '').trim();
  if (enquiry.stage === CLOSED_STAGE && kind !== 'task_closed') {
    fail('This enquiry is closed. Nothing more can be sent on it.');
  }

  if (movesEnquiry(handoff)) return moveEnquiry({ enquiry, kind, note: text, fields, user });

  if (!(await mayHandOff(user, enquiry))) throw ApiError.notFound('Enquiry not found');

  const base = {
    enquiry: enquiry._id,
    customer: enquiry.customer?._id || enquiry.customer,
    kind,
    fromDepartment: user.department || undefined,
    createdBy: user._id,
    link: `/enquiries/${enquiry._id}`,
  };

  /* The buttons that record rather than ask: nothing lands on anybody's queue. */
  if (!handoff.department) {
    if (kind === 'task_closed') {
      if (text.length < 3) fail('Say why it is being closed');
      if (!(await mayMove(user, enquiry))) throw ApiError.forbidden('Only whoever has the enquiry, its marketing person or Admin can close it.');
    }
    const record = await Todo.create({
      ...base,
      department: user.department || 'management',
      user: user._id,
      title: `${handoff.label} — ${aboutOf(enquiry)}`,
      notes: text || undefined,
      completed: true,
      completedAt: new Date(),
      completedBy: user._id,
      outcome: { result: 'done', note: text || undefined, by: user._id, at: new Date() },
    });

    if (kind === 'task_closed') {
      /* Closing ends everything still open on it, the holding task included, and says so. */
      const open = await Todo.find({ enquiry: enquiry._id, kind: { $exists: true }, completed: false });
      for (const task of open) {
        task.completed = true;
        task.completedAt = new Date();
        task.completedBy = user._id;
        task.outcome = { result: 'done', note: `Closed with the enquiry: ${text}`, by: user._id, at: new Date() };
        await task.save();
      }
    }
    await moveStage(enquiry, handoff.stage, {
      user, task: record, note: text || handoff.label, heldBy: kind === 'task_closed' ? null : undefined,
    });
    return record;
  }

  /* A side request (a PRT visit): asked of a department without moving the enquiry. */
  const already = await Todo.findOne({ enquiry: enquiry._id, kind, completed: false }).populate('user', 'name');
  if (already) {
    throw ApiError.conflict(
      `${handoff.label} is already with ${departmentName(already.department)}`
        + `${already.user?.name ? ` (${already.user.name})` : ''}. Add to that one, or wait for it to come back.`
    );
  }
  const task = await Todo.create({
    ...base,
    department: handoff.department,
    title: `${handoff.label} — ${aboutOf(enquiry)}`,
    notes: text || undefined,
    dueDate: endOfDayIST(),
    priority: 'normal',
  });
  await publish(EVENTS.HANDOFF_SENT, { task, enquiry, by: user });
  return task;
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

  if (task.holds) {
    if (!next) fail('Say where it goes next');
    if (!movesEnquiry(findHandoff(next)) || findHandoff(next).hidden) fail('That is not a next step');
    const enquiry = await enquiryOfTask(task);
    await moveEnquiry({ enquiry, kind: next, note: text, fields, user, system: true });
    return Todo.findById(task._id);
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
  await backToSender(task, {
    user,
    title: `Done: ${task.title} — next step?`,
    notes: [`${user.name}: ${text}`, ...details].join('\n'),
  });
  await publish(EVENTS.HANDOFF_DONE, { task, by: user });
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
    const enquiry = await enquiryOfTask(task);
    const previous = await Todo.findOne({
      enquiry: enquiry._id, holds: true, completed: true, _id: { $ne: task._id }, createdAt: { $lte: task.createdAt },
    }).sort({ createdAt: -1 });
    const kind = previous?.kind && movesEnquiry(findHandoff(previous.kind)) ? previous.kind : 'back_to_marketing';
    const back = await openHolder({
      enquiry, kind, user, note: `${user.name}: ${why}`,
      title: `Sent back: ${findHandoff(kind).label} — ${aboutOf(enquiry)}`,
    });
    /* The same department, and the same person if it was theirs by name. */
    if (previous && previous.department && previous.kind === kind) {
      back.department = previous.department;
      back.user = previous.user || undefined;
      await back.save();
    }
    await moveStage(enquiry, findHandoff(kind).stage, { user, task: back, note: `Sent back: ${why}`, heldBy: back.department });
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

/** The numbers a department is run by, from its own tasks. */
export async function departmentFigures(department, { now = new Date() } = {}) {
  const tonight = endOfDayIST(now);
  const week = new Date(now.getTime() - 7 * DAY_MS);
  const month = new Date(now.getTime() - 30 * DAY_MS);
  const mine = { kind: { $exists: true }, department };
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
