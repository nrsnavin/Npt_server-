import mongoose from 'mongoose';
import FieldVisit from '../models/FieldVisit.js';
import FieldDay from '../models/FieldDay.js';
import Todo from '../models/Todo.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import { afterCommit } from '../utils/transaction.js';
import { km } from '../utils/geo.js';
import { nearestTown } from '../data/places.js';
import { MANAGEMENT_QUERY, isManagement } from '../utils/departments.js';
import { fieldVisitOf } from '../utils/fieldVisit.js';
import {
  CATEGORY_FOR_KIND, CATEGORY_KEYS, FIELD_RULES, MODE_LABELS, OPEN_VISIT_STATUSES, TASK_STATUS_FOR, VISIT_CATEGORIES, OUTCOME_FIELDS,
  categoryLabel, flagLabel, outcomesFor,
} from '../config/fieldVisits.js';
import { VISIT_KINDS, mayRecordVisit, recordVisit } from './taskVisit.service.js';
import { endOfDayIST, mayWorkOnHandoff, setTaskStatus } from './handoff.service.js';
import { findHandoff } from '../config/handoffs.js';

/**
 * Field visits [config/fieldVisits.js; models/FieldVisit.js, FieldDay.js].
 *
 * The day of a person who goes out, kept from the phone: Field Duty Start, the visits planned for
 * them checked into at the gate and out of with what came of it, lunch, Field Duty End — and on a
 * day in the office, Punch In and Punch Out instead. Every press carries the phone's fix; while
 * checked in the phone sends one every five minutes, and the checks below read them all: did the
 * person stay, was it the buyer's gate, did they leave and come back, is the clock right, is the
 * GPS real. What a check finds is a flag on the visit or the day, in words, for Admin's report —
 * never a refusal: the field is not the place to argue with the app.
 *
 * Who may do what is a mark Admin sets on the user [utils/fieldVisit.js]: goes out, plans for
 * others (and for whom), plans their own. A visit planned from a task is also the task's: the
 * check-in is recorded on it as a visit, with the satellite picture and the notice to Admin and
 * marketing [taskVisit.service `recordVisit`], and the words at check-out become its visit report.
 */

const IST_OFFSET_MS = 330 * 60 * 1000;
/** The calendar day in India, YYYY-MM-DD. */
export const dayIST = (at = new Date()) => new Date(new Date(at).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const hourIST = (at = new Date()) => new Date(new Date(at).getTime() + IST_OFFSET_MS).getUTCHours();
const isDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
const idOf = (value) => (value?._id ? String(value._id) : value ? String(value) : null);
const same = (a, b) => Boolean(a && b) && idOf(a) === idOf(b);
const minutesBetween = (from, to) => (from && to ? Math.max(0, Math.round((new Date(to) - new Date(from)) / 60_000)) : 0);
const metres = (a, b) => { const d = km(a, b); return d == null ? null : Math.round(d * 1000); };
const timeIST = (at) => new Date(at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });

/* ------------------------------------------------------------------ who may --------------- */

export const fieldPerms = (user) => fieldVisitOf(user);

/** The people this person may plan visits for: everyone who goes out for Admin, their list for an assigner, themselves when they may. */
export async function assignableFor(user) {
  const marks = fieldPerms(user);
  const filter = user.role === 'admin' ? { 'fieldVisit.allowed': true } : marks.mayAssign && marks.assignTo.length ? { _id: { $in: marks.assignTo }, 'fieldVisit.allowed': true } : null;
  const people = filter ? await User.find({ ...filter, isActive: { $ne: false } }).select('name department').sort({ name: 1 }).lean() : [];
  const list = people.map((person) => ({ _id: person._id, name: person.name, department: person.department }));
  if (marks.allowed && marks.maySelfPlan && !list.some((person) => same(person._id, user._id))) list.unshift({ _id: user._id, name: user.name, department: user.department, self: true });
  return list;
}

const mayPlanFor = (user, assigneeId) => {
  const marks = fieldPerms(user);
  if (user.role === 'admin') return true;
  if (same(assigneeId, user._id)) return marks.allowed && marks.maySelfPlan;
  return marks.mayAssign && marks.assignTo.includes(String(assigneeId));
};

/** Admin, the visitor, whoever planned it, or an assigner with the visitor on their list. */
const mayRead = (user, visit) => isManagement(user) || same(visit.user, user._id) || same(visit.assignedBy, user._id)
  || (fieldPerms(user).mayAssign && fieldPerms(user).assignTo.includes(idOf(visit.user)));
const assertVisitor = (user, visit) => {
  if (!same(visit.user, user._id)) throw ApiError.forbidden('Only the person the visit is planned for checks in and out of it');
};

/* ------------------------------------------------------------------ fixes & flags ---------- */

const cleanFix = (fix, { required = true } = {}) => {
  const lat = Number(fix?.lat);
  const lng = Number(fix?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    if (required) throw ApiError.badRequest('The phone gave no usable location — try again outside');
    return null;
  }
  const accuracyM = Number.isFinite(Number(fix.accuracyM)) ? Math.round(Number(fix.accuracyM)) : null;
  const capturedAt = fix.capturedAt ? new Date(fix.capturedAt) : new Date();
  const town = nearestTown({ lat, lng });
  return {
    lat, lng, accuracyM, capturedAt: Number.isNaN(capturedAt.getTime()) ? new Date() : capturedAt,
    place: town ? { name: town.name, state: town.state || undefined, distanceKm: Math.round(town.distanceKm * 10) / 10 } : undefined,
  };
};
const verifiedFix = (fix) => Boolean(fix) && fix.accuracyM != null && fix.accuracyM <= FIELD_RULES.preciseM;
/** How good a fix is [FIELD_RULES]: precise, approximate, rough — or none. */
const gradeOf = (fix) => (!fix ? 'none' : fix.accuracyM == null ? 'rough' : fix.accuracyM <= FIELD_RULES.preciseM ? 'precise' : fix.accuracyM <= FIELD_RULES.acceptableM ? 'approximate' : 'rough');
/** Metres between two fixes the error circles of both cannot explain — zero when they overlap. */
const effectiveM = (a, b) => {
  const distance = metres(a, b);
  if (distance == null) return null;
  return Math.max(0, distance - ((a?.accuracyM || 0) + (b?.accuracyM || 0)));
};
/** The place as best known: a later precise fix stands in for a rough check-in. */
const anchorOf = (visit) => (visit.checkIn?.anchor?.lat != null ? visit.checkIn.anchor : visit.checkIn);
const unflag = (record, key) => { record.flags = (record.flags || []).filter((entry) => entry.key !== key); };
const stampOf = (fix, extra = {}) => (fix
  ? { at: new Date(), lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM ?? undefined, verified: verifiedFix(fix), place: fix.place, ...extra }
  : { at: new Date(), verified: false, ...extra });

const flag = (record, key, detail) => {
  if ((record.flags || []).some((entry) => entry.key === key)) return false;
  record.flags = [...(record.flags || []), { key, label: flagLabel(key), detail: detail || undefined, at: new Date() }];
  return true;
};
/* Speed between two fixes — only once they are a real distance apart: GPS jitter over seconds reads as any speed at all. */
const kmh = (from, to) => {
  if (!from?.at || !to?.at || from.lat == null || to.lat == null) return null;
  const hours = (new Date(to.at) - new Date(from.at)) / 3_600_000;
  if (hours <= 0) return null;
  const distance = km(from, to);
  /* …and only beyond what the two fixes' error circles explain. */
  if (distance == null || distance * 1000 - ((from.accuracyM || 0) + (to.accuracyM || 0)) <= FIELD_RULES.leftSiteM) return null;
  return distance / hours;
};

/* ------------------------------------------------------------------ notices ---------------- */

/** A line for Admin (and whoever else is named) under "Needs your action", and on their phones. */
export async function fieldNotice({ recipients = [], toAdmin = true, label, note, link = '/field', customer = null, enquiry = null, task = null, by = null, kind = 'field_visit', status = 'field' }) {
  const admins = toAdmin ? await User.find({ ...MANAGEMENT_QUERY, isActive: { $ne: false } }).select('_id').lean() : [];
  const told = new Set([...recipients, ...admins.map((person) => person._id)].filter(Boolean).map(String));
  if (by) told.delete(String(by));
  if (!told.size) return;
  const { default: TaskNotice } = await import('../models/TaskNotice.js');
  await TaskNotice.insertMany([...told].map((recipient) => ({
    recipient, task: task || undefined, enquiry: enquiry || undefined, customer: customer || undefined,
    department: 'field', kind, status, statusLabel: label, note: note || undefined, link: link || undefined, by: by || undefined, at: new Date(),
  })));
  afterCommit(() => import('./push.service.js')
    .then(({ sendPush }) => sendPush([...told], { title: label, body: String(note || '').slice(0, 200), link, kind: 'field-visit' }))
    .catch((error) => console.error(`[field] push not sent: ${error.message}`)));
}

/** The buyer's marketing person, when the visit has a buyer. */
async function marketingOf(visit) {
  if (visit.enquiry) {
    const { default: Enquiry } = await import('../models/Enquiry.js');
    const enquiry = await Enquiry.findById(visit.enquiry).select('assignedTo').lean();
    if (enquiry?.assignedTo) return enquiry.assignedTo;
  }
  if (visit.customer) {
    const { default: Customer } = await import('../models/Customer.js');
    return (await Customer.findById(visit.customer).select('assignedTo').lean())?.assignedTo || null;
  }
  return null;
}

/* ------------------------------------------------------------------ the day ---------------- */

async function dayOf(userId, date, { create = false } = {}) {
  let day = await FieldDay.findOne({ user: userId, date });
  if (!day && create) {
    try {
      day = await FieldDay.create({ user: userId, date });
    } catch (error) {
      if (error.code !== 11000) throw error;
      day = await FieldDay.findOne({ user: userId, date });
    }
  }
  return day;
}

const DAY_ACTIONS = ['punch_in', 'punch_out', 'duty_start', 'duty_end', 'lunch_start', 'lunch_end'];
const DAY_LABELS = { punch_in: 'Punched in', punch_out: 'Punched out', duty_start: 'Field duty started', duty_end: 'Field duty ended', lunch_start: 'Lunch started', lunch_end: 'Lunch ended' };

/**
 * One press on the day: the office punch, or the field duty and its lunch. The rules are the
 * plan's — one attendance a day; no field duty end with a visit still open; no lunch while
 * checked in — and each refusal says what to do instead.
 */
export async function dayAction(user, action, { fix: rawFix } = {}) {
  if (!DAY_ACTIONS.includes(action)) throw ApiError.badRequest('Not a day action');
  const marks = fieldPerms(user);
  if (action.startsWith('duty') || action.startsWith('lunch')) {
    if (!marks.allowed) throw ApiError.forbidden('Field duty is for the people Admin marked as going out on visits');
  }
  const fix = cleanFix(rawFix, { required: false });
  const date = dayIST();
  const day = await dayOf(user._id, date, { create: true });
  const open = async () => FieldVisit.find({ user: user._id, status: 'checked_in' }).select('purpose').lean();
  const now = new Date();
  switch (action) {
    case 'punch_in':
      if (day.punchIn?.at) throw ApiError.conflict(`You punched in today at ${timeIST(day.punchIn.at)}`);
      if (day.dutyStart?.at) throw ApiError.conflict('Your field duty is already running today — one attendance a day. End field duty if you are back in the office for the day.');
      day.punchIn = stampOf(fix);
      break;
    case 'punch_out':
      if (!day.punchIn?.at) throw ApiError.conflict('Punch in first');
      if (day.punchOut?.at) throw ApiError.conflict(`You punched out today at ${timeIST(day.punchOut.at)}`);
      day.punchOut = stampOf(fix);
      break;
    case 'duty_start':
      if (day.dutyStart?.at) throw ApiError.conflict(`Field duty already started today at ${timeIST(day.dutyStart.at)}`);
      day.dutyStart = stampOf(fix);
      if (day.punchIn?.at) flag(day, 'office_and_field', `Punched in at ${timeIST(day.punchIn.at)}, field duty from ${timeIST(now)}`);
      break;
    case 'lunch_start': {
      if (!day.dutyStart?.at || day.dutyEnd?.at) throw ApiError.conflict('Lunch is recorded on a running field duty');
      if (day.lunchStart?.at) throw ApiError.conflict(`Lunch already ${day.lunchEnd?.at ? 'taken' : 'running'} today`);
      const checked = await open();
      if (checked.length) throw ApiError.conflict(`Check out of “${checked[0].purpose}” first — lunch is not part of a visit`);
      day.lunchStart = stampOf(fix);
      break;
    }
    case 'lunch_end':
      if (!day.lunchStart?.at) throw ApiError.conflict('Start lunch first');
      if (day.lunchEnd?.at) throw ApiError.conflict('Lunch already ended');
      day.lunchEnd = stampOf(fix);
      if (minutesBetween(day.lunchStart.at, now) > FIELD_RULES.lunchMaxMinutes) flag(day, 'long_lunch', `${minutesBetween(day.lunchStart.at, now)} min`);
      break;
    case 'duty_end': {
      if (!day.dutyStart?.at) throw ApiError.conflict('Start field duty first');
      if (day.dutyEnd?.at) throw ApiError.conflict(`Field duty already ended at ${timeIST(day.dutyEnd.at)}`);
      if (day.lunchStart?.at && !day.lunchEnd?.at) throw ApiError.conflict('End lunch first');
      const unsettled = await FieldVisit.find({ user: user._id, status: { $in: OPEN_VISIT_STATUSES }, plannedDate: { $lte: date } }).select('purpose status').lean();
      if (unsettled.length) {
        throw ApiError.conflict(`${unsettled.length === 1 ? 'One visit is' : `${unsettled.length} visits are`} still open: ${unsettled.map((row) => `${row.purpose} (${row.status === 'checked_in' ? 'checked in' : 'not visited'})`).join('; ')}. Check out, or mark each not completed or put off, then end the day.`, { code: 'VISITS_OPEN', visits: unsettled.map((row) => row._id) });
      }
      day.dutyEnd = stampOf(fix);
      if (minutesBetween(day.dutyStart.at, now) > FIELD_RULES.longDayHours * 60) flag(day, 'long_day', `${Math.round(minutesBetween(day.dutyStart.at, now) / 6) / 10} h`);
      day.summary = await summarise(day, await visitsOfDay(user._id, date));
      break;
    }
    default:
  }
  day.history.push({ by: user._id, action, note: fix ? `${fix.place?.name || ''} ±${fix.accuracyM ?? '?'} m`.trim() : 'no location' });
  await day.save();
  if (action === 'duty_end') {
    const s = day.summary;
    await fieldNotice({
      by: user._id, label: `Field day report: ${user.name}`, link: `/field/team?date=${date}&user=${user._id}`,
      note: `${date} · ${s.completed} completed, ${s.notCompleted} not completed, ${s.rescheduled} put off · on duty ${hours(s.dutyMinutes)}, at visits ${hours(s.visitMinutes)}, travel ${hours(s.travelMinutes)}${s.unrecordedMinutes ? `, unrecorded ${hours(s.unrecordedMinutes)}` : ''}${s.gpsNotVerified ? ` · ${s.gpsNotVerified} GPS not verified` : ''}${day.flags.length ? ` · flags: ${day.flags.map((entry) => entry.label).join(', ')}` : ''}`,
      recipients: await assignersOf(user._id),
    });
  }
  return day;
}

const hours = (minutes) => `${Math.floor((minutes || 0) / 60)}h ${String((minutes || 0) % 60).padStart(2, '0')}m`;

/** Whoever may plan this person's visits — they hear the day's report too. */
async function assignersOf(userId) {
  const people = await User.find({ 'fieldVisit.mayAssign': true, 'fieldVisit.assignTo': userId, isActive: { $ne: false } }).select('_id').lean();
  return people.map((person) => person._id);
}

const visitsOfDay = (userId, date) => FieldVisit.find({ user: userId, $or: [{ plannedDate: date }, { 'checkIn.at': { $gte: new Date(`${date}T00:00:00+05:30`), $lt: new Date(`${date}T23:59:59.999+05:30`) } }] }).sort({ createdAt: 1 }).lean();

/**
 * The day's arithmetic [the plan's formulas]. Duty is start to end less lunch. Visit time is the
 * sum of check-in to check-out. Travel is the time between one recorded event and the next —
 * duty start, check-ins and -outs, lunch, duty end — up to a limit; a gap longer than that is
 * unrecorded time, not travel, and is said as such.
 */
export async function summarise(day, visits) {
  const done = visits.filter((visit) => visit.checkIn?.at);
  const planned = visits.length;
  const completed = visits.filter((visit) => visit.status === 'completed').length;
  const notCompleted = visits.filter((visit) => visit.status === 'not_completed').length;
  const rescheduled = visits.filter((visit) => visit.status === 'rescheduled').length;
  const lunchMinutes = minutesBetween(day.lunchStart?.at, day.lunchEnd?.at);
  const dutyMinutes = Math.max(0, minutesBetween(day.dutyStart?.at, day.dutyEnd?.at || new Date()) - lunchMinutes);
  const visitMinutes = done.reduce((sum, visit) => sum + minutesBetween(visit.checkIn.at, visit.checkOut?.at || new Date()), 0);
  /* Travel: the gaps between events in order, lunch left out, long gaps unrecorded. */
  const events = [];
  if (day.dutyStart?.at) events.push({ at: day.dutyStart.at, kind: 'start' });
  for (const visit of done) {
    events.push({ at: visit.checkIn.at, kind: 'in' });
    if (visit.checkOut?.at) events.push({ at: visit.checkOut.at, kind: 'out' });
  }
  if (day.lunchStart?.at) events.push({ at: day.lunchStart.at, kind: 'lunch_start' });
  if (day.lunchEnd?.at) events.push({ at: day.lunchEnd.at, kind: 'lunch_end' });
  if (day.dutyEnd?.at) events.push({ at: day.dutyEnd.at, kind: 'end' });
  events.sort((a, b) => new Date(a.at) - new Date(b.at));
  let travelMinutes = 0;
  let unrecordedMinutes = 0;
  for (let i = 1; i < events.length; i += 1) {
    const previous = events[i - 1];
    const current = events[i];
    /* Time inside a visit or inside lunch is not travel. */
    if (previous.kind === 'in' || previous.kind === 'lunch_start') continue;
    const gap = minutesBetween(previous.at, current.at);
    if (gap > FIELD_RULES.travelMaxMinutes) unrecordedMinutes += gap;
    else travelMinutes += gap;
  }
  const gpsNotVerified = done.filter((visit) => !visit.checkIn?.verified).length + (day.dutyStart?.at && !day.dutyStart.verified ? 1 : 0) + (day.dutyEnd?.at && !day.dutyEnd.verified ? 1 : 0);
  const flags = [...(day.flags || []), ...visits.flatMap((visit) => visit.flags || [])];
  return { planned, completed, notCompleted, rescheduled, visited: done.length, dutyMinutes, lunchMinutes, visitMinutes, travelMinutes, unrecordedMinutes, gpsNotVerified, flags: flags.length, at: new Date() };
}

/* ------------------------------------------------------------------ the task's workflow ----- */

/**
 * A visit planned from a task moves the task as a move made from the task would [TASK_STATUS_FOR]:
 * the PRT desk reads Visit Planned, Visited, Cheque Collected; Payment Collection's chase log gets
 * the call; the sample is handed. The move is made by whoever may work the task — the visitor,
 * else Admin, else the planner where the task allows — and a move the task cannot take (a status
 * it does not have, a date it refuses) is said on the task rather than failing the visit, except
 * money and a hand-over, which are refused back to the person so nothing is half recorded.
 */
const statusOf = (task, key) => key && (findHandoff(task.kind)?.form?.statuses || []).some((entry) => entry.key === key);
const noteOnTask = async (taskId, user, text) => {
  const task = await Todo.findById(taskId);
  if (!task) return null;
  task.updates = [...(task.updates || []), { kind: 'note', text, note: text, by: user._id, at: new Date() }];
  await task.save();
  return task;
};
async function actorFor(task, user, visit) {
  if (mayWorkOnHandoff(user, task)) return user;
  const visitor = visit?.user ? await User.findById(idOf(visit.user)) : null;
  return visitor && mayWorkOnHandoff(visitor, task) ? visitor : user;
}
async function moveTask(visit, user, { step, note, date, fields }, { strict = false } = {}) {
  if (!visit.task) return null;
  const task = await Todo.findById(visit.task);
  if (!task || task.completed) return null;
  const status = TASK_STATUS_FOR[task.kind]?.[step];
  if (!statusOf(task, status)) return null;
  const actor = await actorFor(task, user, visit);
  try {
    return await setTaskStatus(task, actor, { status, note, date: date || undefined, fields });
  } catch (error) {
    if (strict) throw error;
    await noteOnTask(task._id, user, `Field visit: ${note || step} — the task was not moved to ${status.replace(/_/g, ' ')}: ${error.message}`);
    return null;
  }
}
/** The buyer's chase log on a payment task: a call that is not a status (Refused, Person Unavailable on PRT). */
async function logOnChase(visit, user, { key, label, followUp, text }) {
  if (!visit.task) return;
  const task = await Todo.findById(visit.task).lean();
  if (!task || !['prt_recovery', 'request_prt_visit', 'team_payment_followup', 'my_payment_followup'].includes(task.kind)) return;
  const { logCollectionCall } = await import('./collections.service.js');
  await logCollectionCall(task, user, { key, label, followUp, mode: 'visit' }, text);
}
/** The visit as a line on the task, whatever its kind. */
const sayOnTask = (visit, user, text) => (visit.task ? noteOnTask(visit.task, user, text) : Promise.resolve(null));

/** A due date the plan gives the task, where the task has no Visit Planned status of its own. */
async function dueOnTask(visit, user, date, text) {
  if (!visit.task) return;
  const task = await Todo.findById(visit.task);
  if (!task || task.completed) return;
  task.dueDate = endOfDayIST(new Date(`${date}T12:00:00+05:30`));
  task.updates = [...(task.updates || []), { kind: 'note', text, note: text, by: user._id, at: new Date() }];
  await task.save();
}

/** Planned: Visit Planned on a PRT task (its visitor and date on the brief too); the due date on any other. */
async function linkPlanned(visit, user, person, { note } = {}) {
  if (!visit.task) return;
  const text = `Visit planned: ${person.name} on ${visit.plannedDate}${visit.plannedTime ? ` ${visit.plannedTime}` : ''}${note ? ` — ${note}` : ''}`;
  const moved = await moveTask(visit, user, { step: 'planned', note: text, date: visit.plannedDate });
  if (moved) {
    if (findHandoff(moved.kind)?.asks?.some((entry) => entry.key === 'visitor')) {
      moved.brief = { ...(moved.brief || {}), visitor: person.name, visitDate: visit.plannedDate };
      moved.markModified('brief');
      await moved.save();
    }
    return;
  }
  await dueOnTask(visit, user, visit.plannedDate, text);
}

/** Checked in: Visited (PRT), Contacted (Payment Collection) — the chase log gets the call. */
const linkCheckedIn = (visit, user) => moveTask(visit, user, { step: 'visited', note: `Visited — field check-in${visit.checkIn?.place?.name ? ` near ${visit.checkIn.place.name}` : ''}` });

/**
 * Checked out: the outcome as the task's own move. Money and a hand-over are strict — a refusal
 * (more than owed, a cheque number already recorded, the sample already with the buyer) comes
 * back to the person at the gate, and nothing is half written.
 */
async function linkOutcome(visit, user, outcome, { next = null } = {}) {
  const task = visit.task ? await Todo.findById(visit.task).lean() : null;
  if (!task) return;
  const line = (words) => `Field visit — ${words}`;
  switch (outcome.key) {
    case 'collected': {
      const cheque = outcome.mode === 'cheque';
      const step = cheque ? 'cheque' : 'collected';
      const status = TASK_STATUS_FOR[task.kind]?.[step];
      if (!status || task.completed) {
        flag(visit, 'receipt_not_logged', `₹${outcome.amount} collected — ${task.kind === 'my_payment_followup' ? 'Payment Collection or PRT logs money for Accounts on their own task' : 'the task is closed; log it in Payments'}`);
        await sayOnTask(visit, user, line(`collected ₹${outcome.amount}${outcome.mode ? ` by ${MODE_LABELS[outcome.mode] || outcome.mode}` : ''}${outcome.reference ? ` (${outcome.reference})` : ''} — not logged for Accounts from here`));
        return;
      }
      const fields = status === 'cheque_collected'
        ? { amount: outcome.amount, reference: outcome.reference, bank: outcome.bank }
        : { amount: outcome.amount, mode: MODE_LABELS[outcome.mode] || 'Other', reference: outcome.reference };
      await moveTask(visit, user, { step, note: line(`collected at the buyer's place`), fields }, { strict: true });
      const { default: Receivable } = await import('../models/Receivable.js');
      const logged = await Receivable.findOne({ 'receipts.loggedFrom': task._id }).sort({ updatedAt: -1 }).select('_id').lean();
      if (logged) visit.outcome.receivable = logged._id;
      return;
    }
    case 'promised':
      if (!(await moveTask(visit, user, { step: 'promised', note: line(`promised for ${outcome.committedDate}`), date: outcome.committedDate }, { strict: true }))) {
        await sayOnTask(visit, user, line(`promised for ${outcome.committedDate}`));
      }
      return;
    case 'refused':
      await sayOnTask(visit, user, line(`refused — ${outcome.reason}`));
      await logOnChase(visit, user, { key: 'refused', label: 'Refused', followUp: 'other', text: `Refused on the visit — ${outcome.reason}` });
      return;
    case 'person_unavailable':
      if (!(await moveTask(visit, user, { step: 'unavailable', note: line(`person unavailable${next ? ` — visit again ${next.plannedDate}` : ''}`) }))) {
        await sayOnTask(visit, user, line(`person unavailable${next ? ` — visit again ${next.plannedDate}` : ''}`));
        await logOnChase(visit, user, { key: 'person_unavailable', label: 'Person Unavailable', followUp: 'no_answer', text: `Person unavailable on the visit${next ? ` — visit again ${next.plannedDate}` : ''}` });
      }
      return;
    case 'delivered':
      if (!(await handOverSample(visit, user, task, outcome))) {
        await sayOnTask(visit, user, line(`delivered — received by ${outcome.receivedBy}${outcome.pieces ? `, ${outcome.pieces} pieces` : ''}`));
      }
      return;
    case 'not_accepted':
      await sayOnTask(visit, user, line(`sample not accepted — ${outcome.reason}`));
      return;
    case 'met':
      await sayOnTask(visit, user, line(`met ${outcome.metWhom}${outcome.summary ? ` — ${outcome.summary}` : ''}${outcome.nextFollowUp ? ` · next follow-up ${outcome.nextFollowUp}` : ''}`));
      return;
    default:
      await sayOnTask(visit, user, line(`${outcome.label}${outcome.reason ? ` — ${outcome.reason}` : outcome.summary ? ` — ${outcome.summary}` : ''}`));
  }
}

/**
 * Delivered on a Sample Request: the hand-over goes onto the sample — who took it, how many — the
 * sample is with the buyer from here, and the request closes as it does when the bench sends one
 * [sampling.service `recordHandover`, handoff.service `finishSampleTasks`]. A refusal (the sample
 * already closed) comes back to the person at the gate.
 */
async function handOverSample(visit, user, task, outcome) {
  if (task.kind !== 'sample_request') return false;
  const { default: Sample, CLOSED_SAMPLE_STATUSES } = await import('../models/Sample.js');
  const sample = await Sample.findOne({ $or: [{ job: task._id }, ...(task.enquiry ? [{ enquiry: task.enquiry }] : [])], status: { $nin: CLOSED_SAMPLE_STATUSES } }).sort({ createdAt: -1 });
  if (!sample) return false;
  const { recordHandover } = await import('./sampling.service.js');
  const actor = await actorFor(task, user, visit);
  try {
    await recordHandover(sample, actor, { receivedBy: outcome.receivedBy, phone: outcome.receivedByPhone, pieces: outcome.pieces, note: `Handed over on a field visit by ${user.name}`, via: 'visit' });
  } catch (error) {
    throw ApiError.conflict(error.message);
  }
  const { finishSampleTasks } = await import('./handoff.service.js');
  await finishSampleTasks(sample, actor);
  return true;
}

/** The enquiry: every checked-out visit on one is an activity on it; a marketing visit's next follow-up is the enquiry's. */
async function linkEnquiry(visit, user, outcome) {
  if (!visit.enquiry) return;
  const { default: Enquiry } = await import('../models/Enquiry.js');
  const words = [outcome.label, outcome.amount && `₹${outcome.amount}`, outcome.committedDate && `promised ${outcome.committedDate}`, outcome.reason, outcome.receivedBy && `received by ${outcome.receivedBy}`, outcome.summary, visit.outcome?.report?.text].filter(Boolean).join(' · ');
  const update = { $push: { activities: { type: 'visit', spokeTo: outcome.metWhom || visit.outcome?.words?.met || undefined, note: `Field visit — ${visit.purpose}: ${words}`.slice(0, 2000), at: new Date(), by: user._id } } };
  if (outcome.nextFollowUp) update.$set = { nextFollowUpDate: endOfDayIST(new Date(`${outcome.nextFollowUp}T12:00:00+05:30`)) };
  await Enquiry.updateOne({ _id: visit.enquiry }, update, { keepVersion: true });
}

/** Put off or closed without going: the task hears it; a PRT task reads Visit Planned for the new day. */
async function linkSettled(visit, user, { status, reason, next = null }) {
  if (!visit.task) return;
  if (status === 'rescheduled' && next) {
    const person = await User.findById(idOf(next.user)).select('name').lean();
    await linkPlanned(next, user, person || { name: 'the visitor' }, { note: `put off from ${visit.plannedDate}: ${reason}` });
    return;
  }
  await sayOnTask(visit, user, `Field visit ${status === 'cancelled' ? 'cancelled' : 'not completed'}: ${reason}`);
}

/**
 * A PRT task raised with its visitor and visit date on the form [departmentTaskForms `prt_recovery`
 * asks]: the visit is planned onto that person's day from the form itself, so the brief and the
 * plan are one fact. Called as the task is raised [handoff.service]; never fails the raising.
 */
export async function planFromBrief(task, user, member) {
  try {
    if (!task?.kind || !TASK_STATUS_FOR[task.kind]?.planned || !member?._id) return null;
    const date = String(task.brief?.visitDate || '').slice(0, 10);
    if (!isDay(date) || date < dayIST()) return null;
    const person = await User.findById(member._id).select('name fieldVisit role isActive').lean();
    if (!person || person.isActive === false) return null;
    if (person.role !== 'admin' && !person.fieldVisit?.allowed) {
      await noteOnTask(task._id, user, `${person.name} is not marked as going out on field visits — Admin sets that on the Users page; the visit is not on their field day`);
      return null;
    }
    if (await FieldVisit.findOne({ task: task._id, status: { $in: OPEN_VISIT_STATUSES } }).select('_id').lean()) return null;
    const visit = await FieldVisit.create({
      user: person._id, assignedBy: user._id, category: CATEGORY_FOR_KIND[task.kind] || 'others', purpose: task.title, plannedDate: date,
      task: task._id, enquiry: task.enquiry || undefined, customer: task.customer || undefined,
      history: [{ by: user._id, action: 'planned', note: `from the task's form, for ${person.name} on ${date}` }],
    });
    if (!same(person._id, user._id)) {
      await fieldNotice({ recipients: [person._id], toAdmin: false, by: user._id, label: `Visit planned: ${categoryLabel(visit.category)}`, note: `${task.title} · ${date} · by ${user.name}`, customer: visit.customer, enquiry: visit.enquiry, task: task._id });
    }
    return visit;
  } catch (error) {
    console.error(`[field] visit not planned from the task's form: ${error.message}`);
    return null;
  }
}

/** A task closed or deleted: its visits still planned are cancelled, and the visitor told. */
export async function cancelVisitsOfTask(taskId, user, reason = 'Task closed') {
  const open = await FieldVisit.find({ task: taskId, status: 'planned' });
  for (const visit of open) {
    visit.status = 'cancelled';
    visit.settled = { reason, by: user?._id, at: new Date() };
    visit.history.push({ by: user?._id, action: 'cancelled', note: reason });
    await visit.save();
    await fieldNotice({ recipients: [visit.user], toAdmin: false, by: user?._id, label: 'Visit cancelled', note: `${visit.purpose} · ${visit.plannedDate} — ${reason}`, customer: visit.customer, enquiry: visit.enquiry, task: visit.task });
  }
  return open.length;
}

/** Visits whose task closed through a door with no hook [runFieldVisitSweep]. */
async function cancelOrphans(user = null) {
  const planned = await FieldVisit.find({ status: 'planned', task: { $ne: null } }).select('task').lean();
  if (!planned.length) return 0;
  const tasks = await Todo.find({ _id: { $in: planned.map((row) => row.task) } }).select('_id completed').lean();
  const live = new Set(tasks.filter((task) => !task.completed).map((task) => String(task._id)));
  let count = 0;
  for (const row of planned) {
    if (live.has(String(row.task))) continue;
    const gone = !tasks.some((task) => same(task._id, row.task));
    count += await cancelVisitsOfTask(row.task, user, gone ? 'Task deleted' : 'Task closed');
  }
  return count;
}

/* ------------------------------------------------------------------ planning --------------- */

const VISIT_POPULATE = [
  { path: 'user', select: 'name department' },
  { path: 'assignedBy', select: 'name' },
  { path: 'task', select: 'title kind department completed' },
  { path: 'customer', select: 'code name' },
  { path: 'enquiry', select: 'number' },
  { path: 'outcome.receivable', select: 'number' },
  { path: 'history.by', select: 'name' },
  { path: 'settled.by', select: 'name' },
];
export const loadVisit = async (id) => {
  const visit = await FieldVisit.findById(id);
  if (!visit) throw ApiError.notFound('Visit not found');
  return visit;
};
export const visitView = (visit) => FieldVisit.findById(visit._id).populate(VISIT_POPULATE).lean();

/**
 * A visit planned: for whom, what for, which day — from a task (the enquiry's or a customer's),
 * or on its own with a customer or enquiry named, or neither (the bank).
 */
export async function planVisit(user, { assignee, category, purpose, date, time, task: taskId, customer, enquiry, note } = {}) {
  const who = assignee || user._id;
  if (!mayPlanFor(user, who)) {
    throw ApiError.forbidden(same(who, user._id) ? 'You are not set to plan your own visits — ask Admin' : 'You may not plan visits for this person — ask Admin to add them to your list');
  }
  const person = await User.findById(who).select('name fieldVisit isActive role').lean();
  if (!person || person.isActive === false) throw ApiError.badRequest('That person is not on the users list');
  if (person.role !== 'admin' && !person.fieldVisit?.allowed) throw ApiError.badRequest(`${person.name} is not marked as going out on visits — Admin sets that on the Users page`);
  const plannedDate = isDay(date) ? date : dayIST();
  if (plannedDate < dayIST()) throw ApiError.badRequest('A visit is planned for today or later — a visit already made is entered with Add a visit I made');
  let task = null;
  let kind = null;
  if (taskId) {
    task = await Todo.findById(taskId);
    if (!task) throw ApiError.notFound('Task not found');
    if (task.completed) throw ApiError.badRequest('That task is done — plan the visit on an open one');
    kind = task.kind;
    const open = await FieldVisit.findOne({ task: task._id, status: { $in: OPEN_VISIT_STATUSES } }).populate('user', 'name').lean();
    if (open) throw ApiError.conflict(`A visit on this task is already planned for ${open.user?.name || 'someone'} on ${open.plannedDate}`, { code: 'VISIT_OPEN', visit: open._id });
  }
  const chosen = category || CATEGORY_FOR_KIND[kind] || 'others';
  if (!CATEGORY_KEYS.includes(chosen)) throw ApiError.badRequest('Pick a category');
  const what = String(purpose || task?.title || '').trim().slice(0, 300);
  if (!what) throw ApiError.badRequest('Say what the visit is for');
  const visit = await FieldVisit.create({
    user: who, assignedBy: user._id, category: chosen, purpose: what, plannedDate, plannedTime: /^\d{2}:\d{2}$/.test(String(time || '')) ? time : undefined,
    task: task?._id, enquiry: task?.enquiry || enquiry || undefined, customer: task?.customer || customer || undefined,
    history: [{ by: user._id, action: 'planned', note: [`for ${person.name} on ${plannedDate}`, note].filter(Boolean).join(' — ') }],
  });
  /* The task reads it: Visit Planned on a PRT task (its visitor and date on the brief), the due date on any other. */
  if (task) await linkPlanned(visit, user, person, { note });
  if (!same(who, user._id)) {
    await fieldNotice({ recipients: [who], toAdmin: false, by: user._id, label: `Visit planned: ${categoryLabel(chosen)}`, note: `${what} · ${plannedDate}${time ? ` ${time}` : ''} · by ${user.name}`, customer: visit.customer, enquiry: visit.enquiry, task: task?._id });
  }
  return visit;
}

/** Edit a planned visit: its day, time, purpose, who goes — by whoever may plan for that person. */
export async function editVisit(user, visit, { date, time, purpose, assignee, category } = {}) {
  if (visit.status !== 'planned') throw ApiError.conflict('Only a visit not yet made is changed — a visit made is corrected by Admin');
  if (!mayPlanFor(user, visit.user) && !(assignee && mayPlanFor(user, assignee))) throw ApiError.forbidden('You may not change this visit');
  const before = { date: visit.plannedDate, time: visit.plannedTime, purpose: visit.purpose, user: idOf(visit.user), category: visit.category };
  if (isDay(date)) {
    if (date < dayIST()) throw ApiError.badRequest('A visit is moved to today or later');
    visit.plannedDate = date;
  }
  if (time !== undefined) visit.plannedTime = /^\d{2}:\d{2}$/.test(String(time || '')) ? time : undefined;
  if (purpose && String(purpose).trim()) visit.purpose = String(purpose).trim().slice(0, 300);
  if (category && CATEGORY_KEYS.includes(category)) visit.category = category;
  if (assignee && !same(assignee, visit.user)) {
    if (!mayPlanFor(user, assignee)) throw ApiError.forbidden('You may not plan visits for that person');
    const person = await User.findById(assignee).select('fieldVisit role').lean();
    if (!person || (person.role !== 'admin' && !person.fieldVisit?.allowed)) throw ApiError.badRequest('That person is not marked as going out on visits');
    visit.user = assignee;
  }
  visit.history.push({ by: user._id, action: 'changed', from: before, to: { date: visit.plannedDate, time: visit.plannedTime, purpose: visit.purpose, user: idOf(visit.user), category: visit.category } });
  await visit.save();
  return visit;
}

/** A planned visit closed without a check-in: not completed (why), put off to another day, or cancelled. */
export async function settleVisit(user, visit, { status, reason, date } = {}) {
  if (visit.status !== 'planned') throw ApiError.conflict('This visit is not waiting — it was checked into or already closed');
  if (!same(visit.user, user._id) && !mayPlanFor(user, visit.user)) throw ApiError.forbidden('Only the visitor, whoever planned it or Admin closes a visit');
  const why = String(reason || '').trim();
  if (!why) throw ApiError.badRequest('Say why');
  if (status === 'rescheduled') return rescheduleVisit(user, visit, { date, reason: why });
  if (!['not_completed', 'cancelled'].includes(status)) throw ApiError.badRequest('Not completed, put off or cancelled');
  visit.status = status;
  visit.settled = { reason: why, by: user._id, at: new Date() };
  visit.history.push({ by: user._id, action: status, note: why });
  await visit.save();
  await linkSettled(visit, user, { status, reason: why });
  return visit;
}

/** Put off: a new visit on the new day carries the chain, this one reads Rescheduled and points to it. */
async function rescheduleVisit(user, visit, { date, reason }) {
  if (!isDay(date)) throw ApiError.badRequest('Give the new day');
  if (date < dayIST()) throw ApiError.badRequest('The new day is today or later');
  const next = await FieldVisit.create({
    user: visit.user, assignedBy: user._id, category: visit.category, purpose: visit.purpose, plannedDate: date,
    task: visit.task, enquiry: visit.enquiry, customer: visit.customer, rescheduledFrom: visit._id, reschedules: (visit.reschedules || 0) + 1,
    history: [{ by: user._id, action: 'planned', note: `put off from ${visit.plannedDate}: ${reason}` }],
  });
  visit.status = 'rescheduled';
  visit.rescheduledTo = next._id;
  visit.settled = { reason, by: user._id, at: new Date() };
  visit.history.push({ by: user._id, action: 'rescheduled', note: reason, to: { date } });
  await linkSettled(visit, user, { status: 'rescheduled', reason, next });
  if (next.reschedules >= FIELD_RULES.maxReschedules) {
    flag(next, 'rescheduled_often', `${next.reschedules} times`);
    await next.save();
    await fieldNotice({ by: user._id, label: `Visit put off ${next.reschedules} times`, note: `${visit.purpose} — now ${date}. ${reason}`, customer: visit.customer, enquiry: visit.enquiry, task: visit.task });
  }
  await visit.save();
  return visit;
}

/* ------------------------------------------------------------------ check-in --------------- */

/**
 * At the gate. The fix goes on the visit, the day starts if it has not, and the checks run: the
 * buyer's pinned gate, the clock, the distance from the last check-out against the time since.
 * A task's visit is recorded on the task too, with its picture and notice.
 */
export async function checkIn(user, visit, { fix: rawFix, device, enteredLater = false, reason, at } = {}, { fetchImpl } = {}) {
  assertVisitor(user, visit);
  if (visit.status === 'checked_in') throw ApiError.conflict('You are checked in here already');
  if (visit.status !== 'planned') throw ApiError.conflict('This visit is closed — plan another');
  const elsewhere = await FieldVisit.findOne({ user: user._id, status: 'checked_in', _id: { $ne: visit._id } }).select('purpose').lean();
  if (elsewhere) throw ApiError.conflict(`You are checked in at “${elsewhere.purpose}” — check out there first. One visit at a time.`, { code: 'CHECKED_IN_ELSEWHERE', visit: elsewhere._id });
  const fix = cleanFix(rawFix, { required: false });
  const why = String(reason || '').trim();
  const grade = enteredLater ? 'none' : gradeOf(fix);
  /*
   * The phone could not get close [FIELD_RULES]: within 50 m is kept as approximate and nothing
   * is said; rougher than that, or no fix at all, the person says why — indoors, GPS off, a
   * basement — and the check-in is kept unverified for a later precise fix to confirm [ping].
   */
  if (!enteredLater && grade === 'none' && !why) throw ApiError.badRequest('No location from the phone. Step outside and try again — or say why (indoors, GPS off) to check in without it; a good fix while you are there will verify it.');
  if (!enteredLater && grade === 'rough' && !why) throw ApiError.badRequest(`±${fix.accuracyM ?? '?'} m is too rough to be sure of the place. Step into the open and try again — or say why the GPS could not get closer (indoors, basement) and check in as it is.`);
  const now = new Date();
  const when = enteredLater && at ? new Date(at) : now;
  if (Number.isNaN(when.getTime()) || when > now) throw ApiError.badRequest('The time is in the past');
  const date = dayIST(when);
  const day = await dayOf(user._id, date, { create: true });
  if (!day.dutyStart?.at && !enteredLater) {
    day.dutyStart = stampOf(fix, { auto: true });
    day.history.push({ by: user._id, action: 'duty_start', note: 'started by the first check-in' });
    if (day.punchIn?.at) flag(day, 'office_and_field', `Punched in at ${timeIST(day.punchIn.at)}, field check-in at ${timeIST(now)}`);
    await day.save();
  }
  visit.checkIn = {
    ...stampOf(fix), at: when, verified: !enteredLater && verifiedFix(fix), grade, enteredLater: enteredLater || undefined,
    reason: why || undefined, device: String(device || '').slice(0, 120) || undefined, by: user._id,
    anchor: fix ? { lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM ?? undefined } : undefined,
  };
  visit.status = 'checked_in';
  if (visit.plannedDate !== date) visit.plannedDate = date;
  if (enteredLater) flag(visit, 'entered_later', visit.checkIn.reason);
  /* Approximate is said in the record, not flagged; rough or none is flagged with why, and Admin hears it. */
  if (!visit.checkIn.verified && grade !== 'approximate') flag(visit, 'gps_not_verified', `${fix ? `±${fix.accuracyM ?? '?'} m` : 'no location'}${why ? ` — ${why}` : ''}`);
  if (fix) {
    if (Math.abs(fix.capturedAt - now) > FIELD_RULES.clockSkewMs && !enteredLater) flag(visit, 'clock_skew', `${Math.round(Math.abs(fix.capturedAt - now) / 60_000)} min`);
    if (visit.customer) {
      const { default: Customer } = await import('../models/Customer.js');
      const buyer = await Customer.findById(visit.customer).select('site').lean();
      const away = buyer?.site?.lat != null ? effectiveM(buyer.site, fix) : null;
      if (away != null && away > FIELD_RULES.farFromBuyerM) flag(visit, 'far_from_buyer', `${metres(buyer.site, fix)} m from the pinned gate (±${fix.accuracyM ?? '?'} m)`);
    }
    const previous = await FieldVisit.findOne({ user: user._id, 'checkOut.at': { $lt: when }, 'checkOut.lat': { $ne: null } }).sort({ 'checkOut.at': -1 }).select('checkOut purpose').lean();
    const speed = previous ? kmh(previous.checkOut, { ...fix, at: when }) : null;
    if (speed != null && speed > FIELD_RULES.implausibleKmh) flag(visit, 'implausible_travel', `${Math.round(speed)} km/h from “${previous.purpose}”`);
  }
  visit.history.push({ by: user._id, action: 'checked_in', note: `${fix ? `${fix.place?.name || ''} ±${fix.accuracyM ?? '?'} m · ${grade}`.trim() : 'no location'}${why ? ` — ${why}` : ''}` });
  /* On the task too: the satellite picture, the update line, the notice to Admin and marketing. */
  if (visit.task && fix) {
    const task = await Todo.findById(visit.task);
    if (task && VISIT_KINDS.includes(task.kind) && mayRecordVisit(user, task)) {
      const recorded = await recordVisit(task, user, { lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM, capturedAt: when.toISOString(), note: enteredLater ? `entered later: ${visit.checkIn.reason}` : undefined }, { fetchImpl });
      visit.checkIn.taskVisit = recorded._id;
    }
  }
  await visit.save();
  /* The task reads Visited (PRT) or Contacted (Payment Collection), and the buyer's chase log gets the call. */
  await linkCheckedIn(visit, user);
  if (!visit.checkIn.verified && grade !== 'approximate') {
    await fieldNotice({ by: user._id, label: `GPS not verified: ${user.name}`, note: `${visit.purpose} — ${enteredLater ? 'entered later' : fix ? `fix ±${fix.accuracyM ?? '?'} m` : 'no location from the phone'}${why ? ` (${why})` : ''}. A good fix while they are there will verify it.`, customer: visit.customer, enquiry: visit.enquiry, task: visit.task, link: `/field/team?date=${date}&user=${user._id}` });
  }
  return visit;
}

/**
 * A fix every five minutes while checked in [web: FieldDay.jsx]. Each is kept with its distance
 * from the check-in point; two in a row beyond the limit say the person left; the same
 * coordinates three times running say the GPS is not a GPS; a jump faster than a car is said so.
 */
export async function ping(user, visit, { fix: rawFix, recheck = false } = {}) {
  assertVisitor(user, visit);
  if (visit.status !== 'checked_in') throw ApiError.conflict('Not checked in');
  const fix = cleanFix(rawFix);
  const now = new Date();
  const tracking = visit.tracking || { strikes: 0 };
  const grade = gradeOf(fix);
  const anchor = anchorOf(visit);
  const distanceM = anchor?.lat != null ? metres(anchor, fix) : null;
  /* Metres the error circles cannot explain — a ±40 m fix 160 m off is not someone 160 m away. */
  const clearM = anchor?.lat != null ? effectiveM(anchor, fix) : null;
  const poor = fix.accuracyM == null || fix.accuracyM > FIELD_RULES.judgeMaxAccuracyM;
  const entry = { at: now, lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM ?? undefined, distanceM: distanceM ?? undefined, poor: poor || undefined };
  const pings = [...(visit.pings || []), entry].slice(-FIELD_RULES.maxPings);
  const previous = pings.at(-2);
  if (previous && minutesBetween(previous.at, now) * 60_000 > FIELD_RULES.pingGapMs) flag(visit, 'tracking_gaps', `${minutesBetween(previous.at, now)} min without a fix`);
  visit.pings = pings;
  /*
   * A fix too poor to judge [FIELD_RULES.judgeMaxAccuracyM] is kept and left alone — a strike
   * from it would be the phone's doing. Several in a row say the place has poor GPS, for the
   * report, never for Admin's alarm.
   */
  if (poor) {
    tracking.poorRun = (tracking.poorRun || 0) + 1;
    if (tracking.poorRun >= FIELD_RULES.poorPings) flag(visit, 'poor_gps', `${tracking.poorRun} fixes of ±${fix.accuracyM ?? '?'} m or worse`);
    visit.tracking = tracking;
    visit.markModified('tracking');
    await visit.save();
    return { distanceM, poor: true, accuracyM: fix.accuracyM, message: `The phone's fix is ±${fix.accuracyM ?? '?'} m — too rough to judge, so it is not held against you. Stand near a window or outside when you can.`, flags: visit.flags.map((row) => row.key), pings: pings.length, strikes: tracking.strikes || 0, limit: FIELD_RULES.suspectStrikes, discrepancy: null, confirmed: false };
  }
  tracking.poorRun = 0;
  /*
   * A rough check-in verified after the fact: a precise fix while there, consistent with the
   * rough one, is the place — the check-in reads verified from here, and the fixes are judged
   * against it. Admin's "GPS not verified" is answered by "verified later" on the report.
   */
  let verifiedLater = false;
  if (!visit.checkIn.verified && !visit.checkIn.enteredLater && grade === 'precise' && (visit.checkIn.lat == null || effectiveM(visit.checkIn, fix) <= FIELD_RULES.leftSiteM)) {
    visit.checkIn.verified = true;
    visit.checkIn.verifiedLaterAt = now;
    visit.checkIn.anchor = { lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM ?? undefined };
    visit.markModified('checkIn');
    unflag(visit, 'gps_not_verified');
    flag(visit, 'gps_verified_later', `±${fix.accuracyM} m at ${timeIST(now)}`);
    visit.history.push({ by: user._id, action: 'gps_verified_later', note: `a precise fix at the place, ±${fix.accuracyM} m` });
    verifiedLater = true;
  }
  const judged = pings.filter((row) => !row.poor);
  const last = judged.slice(-FIELD_RULES.leftSitePings);
  const away = clearM != null && clearM > FIELD_RULES.leftSiteM;
  if (away && last.length === FIELD_RULES.leftSitePings && last.every((row) => row.distanceM != null && row.distanceM - (row.accuracyM || 0) - (anchor?.accuracyM || 0) > FIELD_RULES.leftSiteM)) flag(visit, 'left_site', `${distanceM} m away at ${timeIST(now)}`);
  const stale = judged.slice(-FIELD_RULES.stalePings);
  const frozen = stale.length === FIELD_RULES.stalePings && stale.every((row) => row.lat === fix.lat && row.lng === fix.lng && row.accuracyM === entry.accuracyM);
  if (frozen) flag(visit, 'stale_fix', `the same fix ${FIELD_RULES.stalePings} times`);
  const previousJudged = judged.at(-2);
  /* A re-check answers a fix that strayed: the jump back to the place is the point of it, not a strike. */
  const speed = previousJudged && !recheck ? kmh(previousJudged, entry) : null;
  if (speed != null && speed > FIELD_RULES.implausibleKmh) flag(visit, 'implausible_travel', `${Math.round(speed)} km/h between fixes`);
  /* A re-check that is itself rough settles nothing: no strike, the ask stays. */
  if (recheck && grade === 'rough') {
    visit.tracking = tracking;
    visit.markModified('tracking');
    await visit.save();
    return { distanceM, inconclusive: true, accuracyM: fix.accuracyM, message: `±${fix.accuracyM ?? '?'} m is not close enough to tell. Step into the open and try again.`, flags: visit.flags.map((row) => row.key), pings: pings.length, strikes: tracking.strikes || 0, limit: FIELD_RULES.suspectStrikes, discrepancy: null, confirmed: false };
  }

  /*
   * The fix judged [FIELD_RULES.suspectStrikes]: one that strays — away from the check-in point,
   * frozen, an impossible jump — is a strike, and the person is asked to re-check the GPS on the
   * spot; a re-check at the place confirms it and clears the ask. Strikes keep counting: at the
   * limit the visit is marked, and Admin and whoever planned it hear something is wrong with it,
   * under "Needs your action" and on Field today.
   */
  const discrepancy = away ? { kind: 'away', detail: `${distanceM} m from where you checked in (±${fix.accuracyM ?? '?'} m)`, distanceM }
    : frozen ? { kind: 'frozen', detail: `the same fix ${FIELD_RULES.stalePings} times — the GPS is not updating`, distanceM }
      : speed != null && speed > FIELD_RULES.implausibleKmh ? { kind: 'jump', detail: `${Math.round(speed)} km/h since the last fix`, distanceM } : null;
  let suspect = null;
  if (discrepancy) {
    tracking.strikes = (tracking.strikes || 0) + 1;
    tracking.pendingRecheck = true;
    tracking.lastDiscrepancy = { ...discrepancy, at: now };
    visit.history.push({ by: user._id, action: recheck ? 'gps_recheck_failed' : 'gps_strayed', note: `${discrepancy.detail} (strike ${tracking.strikes})` });
    if (tracking.strikes >= FIELD_RULES.suspectStrikes && !tracking.suspectAt) {
      tracking.suspectAt = now;
      flag(visit, 'suspect_tracking', `${tracking.strikes} strikes — last: ${discrepancy.detail}`);
      suspect = true;
    }
  } else if (recheck) {
    tracking.pendingRecheck = false;
    tracking.recheckedAt = now;
    visit.history.push({ by: user._id, action: 'gps_rechecked', note: `at the place — ${distanceM ?? '?'} m from the check-in, ±${fix.accuracyM ?? '?'} m` });
  }
  visit.tracking = tracking;
  visit.markModified('tracking');
  await visit.save();
  if (suspect) {
    const planner = visit.assignedBy && !same(visit.assignedBy, visit.user) ? [idOf(visit.assignedBy)] : [];
    await fieldNotice({
      recipients: planner, by: null, label: `Something wrong in a field visit: ${user.name}`,
      note: `“${visit.purpose}” — the GPS strayed ${tracking.strikes} times since check-in (${discrepancy.detail}). Look at the visit on Field today.`,
      customer: visit.customer, enquiry: visit.enquiry, task: visit.task, link: `/field/team?date=${visit.plannedDate}&user=${idOf(visit.user)}`,
    });
  }
  return {
    distanceM, accuracyM: fix.accuracyM, verifiedLater, flags: visit.flags.map((row) => row.key), pings: pings.length, strikes: tracking.strikes || 0, limit: FIELD_RULES.suspectStrikes,
    discrepancy: discrepancy ? { ...discrepancy, strikes: tracking.strikes, limit: FIELD_RULES.suspectStrikes, suspect: Boolean(tracking.suspectAt) } : null,
    confirmed: Boolean(recheck && !discrepancy),
  };
}

/* ------------------------------------------------------------------ check-out -------------- */

const outcomeOf = (category, body = {}) => {
  const choice = outcomesFor(category).find((entry) => entry.key === body.key);
  if (!choice) throw ApiError.badRequest(`Say what came of the visit: ${outcomesFor(category).map((entry) => entry.label).join(' / ')}`);
  const outcome = { key: choice.key, label: choice.label, completes: choice.completes };
  for (const field of choice.fields) {
    const raw = body[field];
    const value = OUTCOME_FIELDS[field].type === 'number' ? Number(raw) : String(raw ?? '').trim();
    const missing = OUTCOME_FIELDS[field].type === 'number' ? !(value > 0) : !value;
    if (missing && choice.required.includes(field)) throw ApiError.badRequest(`${OUTCOME_FIELDS[field].label} is needed for ${choice.label}`);
    if (!missing) outcome[field] = OUTCOME_FIELDS[field].type === 'number' ? Math.round(value * 100) / 100 : value.slice(0, 500);
  }
  if (outcome.key === 'collected' && outcome.mode === 'cheque' && !outcome.reference) throw ApiError.badRequest('The cheque number is needed for a cheque');
  for (const field of ['committedDate', 'nextFollowUp']) {
    if (outcome[field] && (!isDay(outcome[field]) || outcome[field] < dayIST())) throw ApiError.badRequest(`${OUTCOME_FIELDS[field].label} is today or a day to come`);
  }
  return outcome;
};

const clean = (value, max) => String(value || '').trim().slice(0, max) || undefined;

/**
 * Leaving. The outcome the category asks for is required; the fix at the gate is compared with the
 * check-in's; the words (who was met, what happened, what they said) are written up for Admin and
 * the buyer's marketing person; a collected payment goes on the task's dues for Accounts to
 * confirm; and a visit put off is planned again on the new day.
 */
export async function checkOut(user, visit, { fix: rawFix, outcome: rawOutcome, words = {}, reschedule, link, at } = {}, { ask } = {}) {
  assertVisitor(user, visit);
  if (visit.status !== 'checked_in') throw ApiError.conflict('Check in first');
  const outcome = outcomeOf(visit.category, rawOutcome);
  const enteredLater = Boolean(visit.checkIn?.enteredLater);
  const fix = cleanFix(rawFix, { required: false });
  const now = new Date();
  const when = enteredLater && at ? new Date(at) : now;
  if (Number.isNaN(when.getTime()) || when > now || when < new Date(visit.checkIn.at)) throw ApiError.badRequest('Check-out is after the check-in and not in the future');
  /* A general visit linked to a buyer or an enquiry at the end. */
  if (link?.customer && !visit.customer) visit.customer = link.customer;
  if (link?.enquiry && !visit.enquiry) visit.enquiry = link.enquiry;
  const anchor = anchorOf(visit);
  const away = fix && anchor?.lat != null ? metres(anchor, fix) : null;
  const clearAway = fix && anchor?.lat != null ? effectiveM(anchor, fix) : null;
  visit.checkOut = { ...stampOf(fix), at: when, verified: !enteredLater && verifiedFix(fix), distanceFromCheckInM: away ?? undefined, by: user._id };
  /* An approximate check-out is noted, not flagged; rough or none is. */
  if (!visit.checkOut.verified && gradeOf(fix) !== 'approximate') flag(visit, 'gps_not_verified', fix ? `check-out ±${fix.accuracyM ?? '?'} m` : 'no location at check-out');
  if (clearAway != null && clearAway > FIELD_RULES.checkOutAwayM) flag(visit, 'checked_out_elsewhere', `${away} m from the check-in point (±${fix.accuracyM ?? '?'} m)`);
  const stayed = when - new Date(visit.checkIn.at);
  if (!enteredLater && stayed < FIELD_RULES.tooShortMs) flag(visit, 'too_short', `${Math.max(1, Math.round(stayed / 60_000))} min`);
  const expected = Math.floor(stayed / FIELD_RULES.pingEveryMs) - 1;
  if (!enteredLater && expected >= 2 && (visit.pings || []).length < expected / 2) flag(visit, 'tracking_gaps', `${(visit.pings || []).length} of about ${expected} fixes received`);

  const said = { met: clean(words.met, 500), happened: clean(words.happened, 1000), response: clean(words.response, 1000) };
  outcome.words = said;
  outcome.at = when;
  outcome.by = user._id;
  visit.outcome = outcome;
  visit.status = outcome.completes ? 'completed' : 'not_completed';
  visit.history.push({ by: user._id, action: 'checked_out', note: `${outcome.label}${outcome.amount ? ` ₹${outcome.amount}` : ''}${outcome.reason ? ` — ${outcome.reason}` : ''}` });

  /* The task: the words become its visit report; collected money goes on its dues. */
  const task = visit.task ? await Todo.findById(visit.task) : null;
  if (task && (said.met || said.happened || said.response)) {
    const taskVisit = visit.checkIn?.taskVisit && (task.visits || []).find((entry) => same(entry._id, visit.checkIn.taskVisit));
    if (taskVisit && VISIT_KINDS.includes(task.kind) && mayRecordVisit(user, task)) {
      const { reportForVisit, noteVisit } = await import('./taskVisit.service.js');
      const prepared = await reportForVisit(task, user, taskVisit._id, said, ask ? { ask } : {});
      const noted = await noteVisit(await Todo.findById(task._id), user, taskVisit._id, prepared);
      visit.outcome.report = noted.report;
    }
  }
  if (!visit.outcome.report && (said.met || said.happened || said.response)) {
    const { writeVisitReport } = await import('./visitNote.llm.js');
    let buyer = null;
    if (visit.customer) {
      const { default: Customer } = await import('../models/Customer.js');
      buyer = await Customer.findById(visit.customer).select('name').lean();
    }
    visit.outcome.report = await writeVisitReport({ ...said, context: { task: `${categoryLabel(visit.category)} visit: ${visit.purpose}`, buyer: buyer?.name, visitor: user.name, when: new Date(when).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }), where: visit.checkIn?.place?.name } }, ask ? { ask } : {});
  }
  /* Put off from the gate — the person was not there — the next visit is planned now. */
  let next = null;
  if (reschedule?.date && !outcome.completes) {
    if (!isDay(reschedule.date) || reschedule.date <= dayIST()) throw ApiError.badRequest('The new day is after today');
    next = await FieldVisit.create({
      user: visit.user, assignedBy: user._id, category: visit.category, purpose: visit.purpose, plannedDate: reschedule.date,
      task: visit.task, enquiry: visit.enquiry, customer: visit.customer, rescheduledFrom: visit._id, reschedules: (visit.reschedules || 0) + 1,
      history: [{ by: user._id, action: 'planned', note: `put off from ${visit.plannedDate}: ${outcome.label}${outcome.reason ? ` — ${outcome.reason}` : ''}` }],
    });
    visit.rescheduledTo = next._id;
    visit.status = 'rescheduled';
    if (next.reschedules >= FIELD_RULES.maxReschedules) { flag(next, 'rescheduled_often', `${next.reschedules} times`); await next.save(); }
  }
  /*
   * The task's own workflow reads the outcome [linkOutcome]: the money logged for Accounts as the
   * desk would log it, the promise with its date, the sample handed, the refusal on the chase log.
   * Money and a hand-over the task refuses come back to the person before anything is kept.
   */
  await linkOutcome(visit, user, outcome, { next });
  if (next && outcome.key !== 'person_unavailable') {
    const person = await User.findById(idOf(next.user)).select('name').lean();
    await linkPlanned(next, user, person || { name: user.name }, { note: `put off from ${visit.plannedDate}: ${outcome.label}${outcome.reason ? ` — ${outcome.reason}` : ''}` });
  } else if (next) {
    const person = await User.findById(idOf(next.user)).select('name').lean();
    await linkPlanned(next, user, person || { name: user.name }, { note: 'put off — person unavailable' });
  }
  await visit.save();
  await linkEnquiry(visit, user, outcome);

  /* Admin and the buyer's marketing person hear the outcome; the task's own notice carried the report already. */
  const marketing = await marketingOf(visit);
  const line = [outcome.label, outcome.amount && `₹${outcome.amount}${outcome.mode ? ` by ${outcome.mode}` : ''}`, outcome.committedDate && `promised ${outcome.committedDate}`, outcome.reason, outcome.receivedBy && `received by ${outcome.receivedBy}`, outcome.metWhom && `met ${outcome.metWhom}`, outcome.summary, next && `next visit ${next.plannedDate}`].filter(Boolean).join(' · ');
  await fieldNotice({
    by: user._id, recipients: marketing ? [marketing] : [], label: `${categoryLabel(visit.category)} visit: ${outcome.label}`,
    note: `${visit.purpose} — ${line}${visit.outcome.report?.text && !task ? `. ${visit.outcome.report.text}` : ''}${visit.flags.length ? ` · flags: ${visit.flags.map((entry) => entry.label).join(', ')}` : ''}`,
    customer: visit.customer, enquiry: visit.enquiry, task: visit.task, link: `/field/team?date=${visit.plannedDate}&user=${visit.user}`,
  });
  return visit;
}

/** A visit made without the phone — entered afterwards with why, by the visitor or Admin; never verified. */
export async function lateVisit(user, body = {}, { ask } = {}) {
  const reason = String(body.reason || '').trim();
  if (reason.length < 5) throw ApiError.badRequest('Say why this visit is being entered later');
  const who = body.assignee || user._id;
  if (!same(who, user._id) && user.role !== 'admin') throw ApiError.forbidden('Only Admin enters a visit for someone else');
  const inAt = new Date(body.checkInAt || '');
  const outAt = new Date(body.checkOutAt || '');
  if (Number.isNaN(inAt.getTime()) || Number.isNaN(outAt.getTime()) || outAt <= inAt || outAt > new Date()) throw ApiError.badRequest('Give when you arrived and when you left');
  const marksOk = user.role === 'admin' || fieldPerms(user).allowed;
  if (!marksOk) throw ApiError.forbidden('Field visits are for the people Admin marked as going out');
  const visit = await FieldVisit.create({
    user: who, assignedBy: user._id, category: CATEGORY_KEYS.includes(body.category) ? body.category : 'others', purpose: String(body.purpose || '').trim().slice(0, 300) || 'Visit',
    plannedDate: dayIST(inAt), task: body.task || undefined, enquiry: body.enquiry || undefined, customer: body.customer || undefined,
    history: [{ by: user._id, action: 'planned', note: `entered later: ${reason}` }],
  });
  const person = same(who, user._id) ? user : await User.findById(who);
  await checkIn(person, visit, { fix: body.fix, enteredLater: true, reason, at: inAt });
  return checkOut(person, await loadVisit(visit._id), { fix: null, outcome: body.outcome, words: body.words, at: outAt }, { ask });
}

/** Admin corrects a visit's times, with why; the record keeps what they were. */
export async function editTimes(user, visit, { checkInAt, checkOutAt, reason } = {}) {
  if (user.role !== 'admin') throw ApiError.forbidden('Only Admin corrects a visit’s times');
  const why = String(reason || '').trim();
  if (why.length < 5) throw ApiError.badRequest('Say why the times are being corrected');
  if (!visit.checkIn?.at) throw ApiError.conflict('This visit was never checked into');
  const before = { checkInAt: visit.checkIn.at, checkOutAt: visit.checkOut?.at || null };
  const inAt = checkInAt ? new Date(checkInAt) : visit.checkIn.at;
  const outAt = checkOutAt ? new Date(checkOutAt) : visit.checkOut?.at || null;
  if (Number.isNaN(inAt.getTime()) || (outAt && (Number.isNaN(outAt.getTime()) || outAt <= inAt))) throw ApiError.badRequest('Check-out is after check-in');
  visit.checkIn.at = inAt;
  visit.checkIn.verified = false;
  if (outAt && visit.checkOut) { visit.checkOut.at = outAt; visit.checkOut.verified = false; }
  visit.plannedDate = dayIST(inAt);
  flag(visit, 'times_edited', `${user.name}: ${why}`);
  visit.history.push({ by: user._id, action: 'times_edited', note: why, from: before, to: { checkInAt: inAt, checkOutAt: outAt } });
  visit.markModified('checkIn');
  visit.markModified('checkOut');
  await visit.save();
  return visit;
}

/* ------------------------------------------------------------------ reading ---------------- */

/** The day's list in the order it is worked: the one checked in, then by the time planned (none last), then as planned. */
const RANK = { checked_in: 0, planned: 1, completed: 2, not_completed: 2, rescheduled: 2, cancelled: 3 };
const ordered = (visits) => [...visits].sort((a, b) => (RANK[a.status] - RANK[b.status])
  || (a.checkIn?.at && b.checkIn?.at ? new Date(a.checkIn.at) - new Date(b.checkIn.at) : 0)
  || String(a.plannedTime || '99:99').localeCompare(String(b.plannedTime || '99:99'))
  || (new Date(a.createdAt) - new Date(b.createdAt)));

const LIVE_FLAGS = (day, date, today) => {
  const flags = [...(day?.flags || [])];
  if (day?.dutyStart?.at && !day.dutyEnd?.at && date < today) flags.push({ key: 'incomplete_report', label: flagLabel('incomplete_report'), detail: 'Field duty never ended' });
  return flags;
};

/** The person's own screen: their marks, the day, today's visits with the ones carried over, who they may plan for. */
export async function myDay(user, date = dayIST()) {
  const marks = fieldPerms(user);
  const today = dayIST();
  const [day, visits, carried, people] = await Promise.all([
    dayOf(user._id, date),
    FieldVisit.find({ user: user._id, plannedDate: date }).populate(VISIT_POPULATE).sort({ createdAt: 1 }).lean(),
    date === today ? FieldVisit.find({ user: user._id, plannedDate: { $lt: today }, status: { $in: OPEN_VISIT_STATUSES } }).populate(VISIT_POPULATE).sort({ plannedDate: 1 }).lean() : [],
    assignableFor(user),
  ]);
  const checkedIn = visits.find((visit) => visit.status === 'checked_in') || carried.find((visit) => visit.status === 'checked_in') || null;
  return {
    date, today, marks, people,
    day: day ? { ...day.toObject(), flags: LIVE_FLAGS(day, date, today), summary: day.summary || await summarise(day, [...carried, ...visits]) } : null,
    visits: ordered(visits), carried: ordered(carried), checkedIn,
    categories: VISIT_CATEGORIES, outcomes: Object.fromEntries(CATEGORY_KEYS.map((key) => [key, outcomesFor(key)])), fields: OUTCOME_FIELDS, rules: FIELD_RULES,
  };
}

/** Whose days this viewer may read: everyone who goes out for Admin; their list and themselves for an assigner. */
async function peopleFor(viewer) {
  const marks = fieldPerms(viewer);
  if (viewer.role === 'admin' || isManagement(viewer)) return User.find({ $or: [{ 'fieldVisit.allowed': true }, { role: 'admin' }], isActive: { $ne: false } }).select('name department').sort({ name: 1 }).lean();
  const ids = new Set(marks.mayAssign ? marks.assignTo : []);
  if (marks.allowed) ids.add(String(viewer._id));
  return User.find({ _id: { $in: [...ids] }, isActive: { $ne: false } }).select('name department').sort({ name: 1 }).lean();
}

/** One person's day as the report reads it — self, Admin, or an assigner with them on the list. */
export async function dayFor(viewer, userId, date) {
  const people = await peopleFor(viewer);
  if (!people.some((person) => same(person._id, userId))) throw ApiError.forbidden('You may read your own field days and those of the people you plan visits for');
  const day = await dayOf(userId, date);
  const visits = await FieldVisit.find({ user: userId, $or: [{ plannedDate: date }, { status: 'checked_in' }] }).populate(VISIT_POPULATE).sort({ createdAt: 1 }).lean();
  const today = dayIST();
  const summary = await summarise(day || {}, visits);
  return { user: people.find((person) => same(person._id, userId)), date, day: day ? { ...day.toObject(), flags: LIVE_FLAGS(day, date, today) } : null, visits: ordered(visits), summary };
}

/** Field today, for Admin and the assigners: everyone, with the day's numbers and flags. */
export async function teamDay(viewer, date = dayIST()) {
  const people = await peopleFor(viewer);
  const ids = people.map((person) => person._id);
  const today = dayIST();
  const [days, visits] = await Promise.all([
    FieldDay.find({ user: { $in: ids }, date }).lean(),
    FieldVisit.find({ user: { $in: ids }, $or: [{ plannedDate: date }, { status: 'checked_in' }] }).populate(VISIT_POPULATE).sort({ createdAt: 1 }).lean(),
  ]);
  const rows = [];
  for (const person of people) {
    const day = days.find((entry) => same(entry.user, person._id)) || null;
    const own = visits.filter((visit) => same(visit.user, person._id));
    if (!day && !own.length) continue;
    const summary = await summarise(day || {}, own);
    rows.push({
      user: person, day: day ? { ...day, flags: LIVE_FLAGS(day, date, today) } : null, visits: ordered(own), summary,
      mode: day?.dutyStart?.at ? 'field' : day?.punchIn?.at ? 'office' : own.length ? 'planned' : 'none',
      checkedIn: own.find((visit) => visit.status === 'checked_in') || null,
      /* Visits whose fixes strayed past the limit — Admin's to look at [ping]. */
      suspects: own.filter((visit) => visit.tracking?.suspectAt).map((visit) => ({ _id: visit._id, purpose: visit.purpose, strikes: visit.tracking.strikes, detail: visit.tracking.lastDiscrepancy?.detail || '', at: visit.tracking.suspectAt })),
      flags: [...LIVE_FLAGS(day, date, today), ...own.flatMap((visit) => (visit.flags || []).map((entry) => ({ ...entry, visit: visit._id, purpose: visit.purpose })))],
    });
  }
  return { date, today, people, rows };
}

/** The visits on an enquiry's tasks, and on a job's, for their pages. */
export const visitsOfEnquiry = (enquiryId) => FieldVisit.find({ enquiry: enquiryId }).populate(VISIT_POPULATE).sort({ plannedDate: -1, createdAt: -1 }).lean();
export const visitsOfTasks = (taskIds) => (taskIds?.length ? FieldVisit.find({ task: { $in: taskIds } }).populate(VISIT_POPULATE).sort({ plannedDate: -1, createdAt: -1 }).lean() : Promise.resolve([]));

/** The visits on one task, for its panel and cards. */
export const visitsOfTask = (taskId) => FieldVisit.find({ task: taskId }).populate(VISIT_POPULATE).sort({ plannedDate: -1, createdAt: -1 }).lean();

/** The open field visit on each task — planned or checked in — for queue rows and cards. */
export async function fieldVisitSummary(taskIds) {
  const ids = [...new Set((taskIds || []).filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const visits = await FieldVisit.find({ task: { $in: ids }, status: { $in: OPEN_VISIT_STATUSES } }).populate('user', 'name').select('task user status plannedDate plannedTime checkIn.at').lean();
  const map = new Map();
  /* `checkInAt` for the card's running timer while the person is there. */
  for (const visit of visits) map.set(String(visit.task), { _id: visit._id, status: visit.status, date: visit.plannedDate, time: visit.plannedTime || null, checkInAt: visit.checkIn?.at || null, user: visit.user ? { _id: visit.user._id, name: visit.user.name } : null });
  return map;
}

export const readableVisit = async (user, id) => {
  const visit = await loadVisit(id);
  if (!mayRead(user, visit)) throw ApiError.forbidden('Not your visit to read');
  return visit;
};

/* ------------------------------------------------------------------ the sweep -------------- */

/**
 * Every few minutes [background.js]: a person checked in for two hours is reminded to check out;
 * at six in the evening they and Admin are; a check-in left overnight is flagged; a field day
 * never ended is told to Admin as an incomplete report.
 */
export async function runFieldVisitSweep({ now = new Date() } = {}) {
  const told = [];
  const open = await FieldVisit.find({ status: 'checked_in' }).populate('user', 'name');
  for (const visit of open) {
    const since = now - new Date(visit.checkIn.at);
    if (since > FIELD_RULES.remindAfterMs && !visit.reminders?.afterHours) {
      visit.reminders = { ...(visit.reminders || {}), afterHours: now };
      await visit.save();
      await fieldNotice({ recipients: [visit.user._id], toAdmin: false, label: 'Still checked in?', note: `You checked in at “${visit.purpose}” ${Math.round(since / 3_600_000)} h ago — check out when you leave.`, link: '/field' });
      told.push(`afterHours:${visit._id}`);
    }
    if (hourIST(now) >= FIELD_RULES.remindAtHourIST && dayIST(visit.checkIn.at) === dayIST(now) && !visit.reminders?.evening) {
      visit.reminders = { ...(visit.reminders || {}), evening: now };
      await visit.save();
      await fieldNotice({ recipients: [visit.user._id], label: `Still checked in: ${visit.user.name}`, note: `“${visit.purpose}” since ${timeIST(visit.checkIn.at)} — not checked out this evening.`, link: `/field/team?date=${dayIST(now)}&user=${visit.user._id}` });
      told.push(`evening:${visit._id}`);
    }
    if (dayIST(visit.checkIn.at) < dayIST(now) && flag(visit, 'overnight', `checked in ${dayIST(visit.checkIn.at)} ${timeIST(visit.checkIn.at)}`)) {
      await visit.save();
      await fieldNotice({ label: `Checked in overnight: ${visit.user.name}`, note: `“${visit.purpose}” since ${dayIST(visit.checkIn.at)} ${timeIST(visit.checkIn.at)} — correct the times on Field today.`, link: `/field/team?date=${dayIST(visit.checkIn.at)}&user=${visit.user._id}` });
      told.push(`overnight:${visit._id}`);
    }
  }
  /* Visits planned on a task that closed or was deleted through a door with no hook: cancelled, the visitor told. */
  const orphaned = await cancelOrphans();
  if (orphaned) told.push(`orphans:${orphaned}`);
  const unfinished = await FieldDay.find({ date: { $lt: dayIST(now) }, 'dutyStart.at': { $exists: true }, 'dutyEnd.at': { $exists: false }, incompleteToldAt: { $exists: false } }).populate('user', 'name').limit(100);
  for (const day of unfinished) {
    day.incompleteToldAt = now;
    flag(day, 'incomplete_report', 'Field duty never ended');
    await day.save();
    await fieldNotice({ recipients: await assignersOf(day.user._id), label: `Field day report incomplete: ${day.user.name}`, note: `${day.date} — field duty started ${timeIST(day.dutyStart.at)} and was never ended.`, link: `/field/team?date=${day.date}&user=${day.user._id}` });
    told.push(`incomplete:${day._id}`);
  }
  return told;
}
