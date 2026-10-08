import Todo from '../models/Todo.js';
import Enquiry from '../models/Enquiry.js';
import { CLOSED_STAGE, STAGES, stageLabel } from '../config/enquiryStages.js';
import { findDepartment } from '../config/modules.js';
import { findHandoff } from '../config/handoffs.js';
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

/**
 * Whether this person may send a task about this enquiry: whoever holds the enquiry, an
 * administrator, or a department that has been asked about it before — dispatch passing a
 * quality issue on does not need the whole enquiry module to do it.
 */
export async function mayHandOff(user, enquiry) {
  if (user.role === 'admin') return true;
  /* Marketing only their own enquiries; a department with the grant that is not scoped, any. */
  if (canRead(user, 'enquiries') && ownsRecord(user, enquiry)) return true;
  if (isOwnershipScoped(user)) return false;
  /* A department that was sent a task about it — not one that merely got a reply back. */
  return Boolean(user.department && (await Todo.exists({
    enquiry: enquiry._id, department: user.department, kind: { $exists: true },
  })));
}

/** Where a sender's "it came back" task goes: to them, on their own department's list. */
async function backToSender(task, { title, notes, user }) {
  if (!task.createdBy || String(task.createdBy) === String(user._id)) return null;
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

/** Moves the enquiry to a stage, with the task that moved it on the record. */
function moveStage(enquiry, to, { user, task, note }) {
  if (!to || enquiry.stage === to) return;
  enquiry.stageHistory.push({ from: enquiry.stage, to, by: user._id, task: task?._id, note });
  enquiry.stage = to;
}

/**
 * Sends one task. Returns the task (or the record, for the buttons that only record).
 * `enquiry` must be a document with `customer` populated or an id.
 */
export async function sendHandoff({ enquiry, kind, note, user }) {
  const handoff = findHandoff(kind);
  if (!handoff) fail('That is not one of the buttons');
  if (!(await mayHandOff(user, enquiry))) throw ApiError.notFound('Enquiry not found');

  const text = String(note || '').trim();
  if (enquiry.stage === CLOSED_STAGE && kind !== 'task_closed') {
    fail('This enquiry is closed. Nothing more can be sent on it.');
  }

  const customerId = enquiry.customer?._id || enquiry.customer;
  const customerName = enquiry.customer?.name;
  const about = `${enquiry.number}${customerName ? ` · ${customerName}` : ''}`;
  const base = {
    enquiry: enquiry._id,
    customer: customerId,
    kind,
    fromDepartment: user.department || undefined,
    createdBy: user._id,
    link: `/enquiries/${enquiry._id}`,
  };

  /* The two buttons that record rather than ask: nothing lands on anybody's queue. */
  if (!handoff.department) {
    if (kind === 'task_closed' && text.length < 3) fail('Say why it is being closed');
    const record = await Todo.create({
      ...base,
      department: user.department || 'management',
      user: user._id,
      title: `${handoff.label} — ${about}`,
      notes: text || undefined,
      completed: true,
      completedAt: new Date(),
      completedBy: user._id,
      outcome: { result: 'done', note: text || undefined, by: user._id, at: new Date() },
    });

    if (kind === 'task_closed') {
      /* Closing ends everything still open on it, and says so on each task. */
      const open = await Todo.find({ enquiry: enquiry._id, kind: { $exists: true }, completed: false });
      for (const task of open) {
        task.completed = true;
        task.completedAt = new Date();
        task.completedBy = user._id;
        task.outcome = { result: 'done', note: `Closed with the enquiry: ${text}`, by: user._id, at: new Date() };
        await task.save();
      }
    }
    moveStage(enquiry, handoff.stage, { user, task: record, note: text || handoff.label });
    await enquiry.save();
    return record;
  }

  /*
   * The same ask twice is one task. A double press, or two people asking production for the
   * same date, would otherwise put two copies on the queue and have two people answer it.
   */
  const already = await Todo.findOne({ enquiry: enquiry._id, kind, completed: false }).populate('user', 'name');
  if (already) {
    throw ApiError.conflict(
      `${handoff.label} is already with ${departmentName(already.department)}`
        + `${already.user?.name ? ` (${already.user.name})` : ''} — sent ${already.createdAt.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}.`
        + ' Add to that one, or wait for it to come back.'
    );
  }

  /* "My Payment Follow-up" is for whoever holds the enquiry, personally. */
  const forOwner = handoff.department === 'owner';
  const ownerId = enquiry.assignedTo?._id || enquiry.assignedTo;
  let department = handoff.department;
  if (forOwner) {
    const { default: User } = await import('../models/User.js');
    const owner = await User.findById(ownerId).select('department');
    department = owner?.department || 'marketing';
  }

  const task = await Todo.create({
    ...base,
    department,
    user: forOwner ? ownerId : undefined,
    title: `${handoff.label} — ${about}`,
    notes: text || undefined,
    dueDate: endOfDayIST(),
    priority: 'normal',
  });

  moveStage(enquiry, handoff.stage, { user, task, note: handoff.label });
  await enquiry.save();

  await publish(EVENTS.HANDOFF_SENT, { task, enquiry, by: user });
  return task;
}

/** Whether this person may act on a task: its department, whoever holds it, or an administrator. */
export function mayWorkOnHandoff(user, task) {
  if (user.role === 'admin') return true;
  if (task.user && String(task.user._id || task.user) === String(user._id)) return true;
  return Boolean(task.department && task.department === user.department);
}

function openHandoff(task, user) {
  if (!task.kind || !task.enquiry) fail('That is not a task sent about an enquiry');
  if (task.completed) throw ApiError.conflict('That task is already finished');
  if (!mayWorkOnHandoff(user, task)) {
    throw ApiError.forbidden(`This task is on the ${departmentName(task.department)} queue`);
  }
}

/** Done: what they did, and the details worth keeping. The sender gets the next step. */
export async function completeHandoff(task, user, { note, fields = {} }) {
  openHandoff(task, user);
  const text = String(note || '').trim();
  if (text.length < 2) fail('Say what was done');

  const handoff = findHandoff(task.kind);
  const allowed = new Set((handoff?.records || []).map((field) => field.key));
  const kept = Object.fromEntries(
    Object.entries(fields || {})
      .filter(([key, value]) => allowed.has(key) && String(value ?? '').trim())
      .map(([key, value]) => [key, String(value).trim().slice(0, 200)])
  );

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

/** Sent back to whoever asked, with why. */
export async function returnHandoff(task, user, { reason }) {
  openHandoff(task, user);
  const why = String(reason || '').trim();
  if (why.length < 5) fail('Say why it is being sent back');

  task.completed = true;
  task.completedAt = new Date();
  task.completedBy = user._id;
  task.outcome = { result: 'returned', note: why, by: user._id, at: new Date() };
  await task.save();

  await backToSender(task, { user, title: `Sent back: ${task.title}`, notes: `${user.name}: ${why}` });
  await publish(EVENTS.HANDOFF_RETURNED, { task, by: user });
  return task;
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
