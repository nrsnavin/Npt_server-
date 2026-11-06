import EddChange from '../models/EddChange.js';
import Todo from '../models/Todo.js';
import Enquiry from '../models/Enquiry.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import { afterCommit } from '../utils/transaction.js';
import { inDepartment, isManagement, MANAGEMENT_QUERY } from '../utils/departments.js';
import { findDepartment } from '../config/modules.js';
import { EVENTS, publish } from './events.service.js';

/**
 * EDD change requests [models/EddChange.js] — the EDD is followed, and every move of it tracked.
 *
 *   ask      Production, Printing or Assembly, from its task: the date the goods can really be
 *            ready (one model, or all), and why. Admin and the enquiry's marketing person hear it
 *            under "Needs your action" and on their phones; the enquiry shows it at the top.
 *   answer   Admin or the marketing person (on a job with no enquiry, whoever gave the job):
 *            Agree — the EDD moves to the date (theirs if they name one), for the model or the
 *            enquiry, everybody working to it told; Reply — a question, or another date; Keep —
 *            the EDD stays, with why.
 *   reply    The team answers a reply, with a new date if it has one — back with the office.
 *   withdraw The team takes its ask back.
 */

const fail = (message) => { throw ApiError.badRequest(message); };
const idOf = (value) => String(value?._id ?? value ?? '');
const departmentName = (key) => findDepartment(key)?.label || String(key || '').replace(/_/g, ' ');
const prettyDay = (day) => (day ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${day}T00:00:00.000+05:30`)) : '—');

/** The teams that give dates and so may ask to move the EDD. */
export const EDD_CHANGE_KINDS = ['ask_edd', 'ask_printing', 'ask_assembling_edd'];

export const CHANGE_POPULATE = [
  { path: 'requestedBy', select: 'name department' },
  { path: 'decidedBy', select: 'name' },
  { path: 'messages.by', select: 'name department' },
  { path: 'enquiry', select: 'number assignedTo' },
  { path: 'customer', select: 'code name' },
  { path: 'task', select: 'title kind department' },
];

const chainOf = (task) => task.chain || task._id;

/** The EDD standing now: the model's own, else the enquiry's; a job's on its tasks. */
async function standingEdd({ enquiry, task, model }) {
  if (enquiry) {
    const row = model ? (enquiry.eddByModel || []).find((entry) => entry.model === model) : null;
    return row?.date || enquiry.edd?.date || null;
  }
  return task.jobEdd?.date || null;
}

/** Who answers for the buyer: Admin, the enquiry's marketing person — or, on a job, whoever gave it. */
async function officeOf(change) {
  if (change.enquiry) {
    const enquiry = await Enquiry.findById(idOf(change.enquiry)).select('assignedTo').lean();
    return enquiry?.assignedTo ? [idOf(enquiry.assignedTo)] : [];
  }
  const first = await Todo.findById(idOf(change.chain || change.task)).select('createdBy').lean();
  return first?.createdBy ? [idOf(first.createdBy)] : [];
}

export async function mayAnswerChange(change, user) {
  if (isManagement(user)) return true;
  return (await officeOf(change)).includes(idOf(user._id));
}

/** The team side: the department that asked, the person who asked, Admin. */
export const onTeamSide = (change, user) => isManagement(user) || idOf(change.requestedBy) === idOf(user._id) || inDepartment(user, change.department);

/* ------------------------------ Telling people ------------------------------ */

async function admins() {
  return (await User.find({ ...MANAGEMENT_QUERY, isActive: { $ne: false } }).select('_id').lean()).map((row) => idOf(row._id));
}

async function teamPeople(change) {
  const task = await Todo.findById(idOf(change.task)).select('user department').lean();
  if (task?.user) return [idOf(task.user), idOf(change.requestedBy)];
  const members = await User.find({ isActive: { $ne: false }, $or: [{ department: change.department }, { extraDepartments: change.department }] }).select('_id').lean();
  return [...members.map((row) => idOf(row._id)), idOf(change.requestedBy)];
}

/*
 * `notice: false` — an open ask or a reply already sits under "Needs your action" as its own card
 * [handoff.service `attentionFor`]; only the phone is rung, so it is not said twice on the screen.
 */
async function tell(change, recipients, user, { label, note, notice = true }) {
  const ids = [...new Set(recipients.filter(Boolean).map(String))].filter((id) => id !== idOf(user._id));
  if (!ids.length) return;
  if (notice) await noticeTo(change, ids, user, { label, note });
  const link = change.enquiry ? `/enquiries/${idOf(change.enquiry)}` : '/departments/mine';
  afterCommit(() => import('./push.service.js')
    .then(({ sendPush }) => sendPush(ids, { title: label, body: String(note || '').slice(0, 200), link, kind: 'edd-change' }))
    .catch((error) => console.error(`[edd-change] push not sent: ${error.message}`)));
}

async function noticeTo(change, ids, user, { label, note }) {
  const { default: TaskNotice } = await import('../models/TaskNotice.js');
  await TaskNotice.insertMany(ids.map((recipient) => ({
    recipient, task: idOf(change.task), enquiry: change.enquiry ? idOf(change.enquiry) : undefined, customer: change.customer ? idOf(change.customer) : undefined,
    department: change.department, kind: 'edd_change', status: 'edd_change', statusLabel: label, note: String(note || '').slice(0, 2000),
    by: user._id, at: new Date(), ...(change.enquiry ? {} : { link: '/departments/mine' }),
  })));
}

/** A line on the task that asked, where its history is. */
async function noteOnTask(change, user, statusLabel, text) {
  await Todo.updateOne({ _id: idOf(change.task) }, {
    $push: { updates: { kind: 'note', statusLabel, text, note: `${statusLabel}: ${text}`, by: user._id, at: new Date() } },
  }, { keepVersion: true });
}

/* ------------------------------ Asking ------------------------------ */

const clean = (text, what, min = 3) => {
  const said = String(text || '').trim();
  if (said.length < min) fail(`Say ${what} — a few words at least`);
  if (said.length > 2000) fail('Keep it under 2000 characters');
  return said;
};

/** The team asks, from its task, to move the EDD to a date — with why. One open ask a model at a time. */
export async function requestEddChange(task, user, { date, reason, model }) {
  const { mayWorkOnHandoff, eddDay } = await import('./handoff.service.js');
  if (!EDD_CHANGE_KINDS.includes(task.kind)) fail('An EDD change is asked from the Production, Printing or Assembly task');
  if (!mayWorkOnHandoff(user, task)) throw ApiError.forbidden('Only the team working this task can ask to change its EDD');
  if (task.completed) fail('This task is closed');
  const day = eddDay(date);
  const why = clean(reason, 'why the date has to move');
  const enquiry = task.enquiry ? await Enquiry.findById(idOf(task.enquiry)).select('edd eddByModel customer assignedTo number') : null;
  const named = String(model || '').trim() || undefined;
  if (named && enquiry?.eddByModel?.length && !enquiry.eddByModel.some((row) => row.model === named)) fail(`${named} is not one of this enquiry’s models`);
  const current = await standingEdd({ enquiry, task, model: named });
  if (current && current === day) fail(`The EDD is already ${prettyDay(day)}`);
  const where = enquiry ? { enquiry: enquiry._id } : { chain: chainOf(task) };
  if (await EddChange.exists({ ...where, status: 'open', model: named || { $exists: false } })) fail('An EDD change is already waiting for an answer here — reply on it instead');
  const change = await EddChange.create({
    enquiry: enquiry?._id, task: task._id, chain: enquiry ? undefined : chainOf(task), customer: task.customer?._id || task.customer || enquiry?.customer,
    department: task.department, model: named, currentEdd: current || undefined, requestedDate: day, reason: why, requestedBy: user._id,
    messages: [{ side: 'team', body: why, date: day, by: user._id }],
  });
  const what = `${named ? `${named}: ` : ''}EDD ${current ? `${prettyDay(current)} → ` : ''}${prettyDay(day)}`;
  await noteOnTask(change, user, 'EDD change asked', `${what} — ${why}`);
  await tell(change, [...(await admins()), ...(await officeOf(change))], user, {
    label: `${departmentName(task.department)} asks to change the EDD${enquiry?.number ? ` — ${enquiry.number}` : ''}`,
    note: `${what} — ${user.name}: ${why}`,
    notice: false,
  });
  await publish(EVENTS.HANDOFF_UPDATED, { task, by: user });
  return change;
}

/* ------------------------------ Answering ------------------------------ */

function assertOpen(change) {
  if (change.status !== 'open') fail(`This EDD change is already ${change.status === 'agreed' ? 'agreed' : change.status === 'kept' ? 'answered — the EDD was kept' : 'withdrawn'}`);
}

/** Either side writes on it: a question, an answer, or another date. It goes to the other side. */
export async function replyEddChange(change, user, { body, date }) {
  assertOpen(change);
  const office = await mayAnswerChange(change, user);
  const team = onTeamSide(change, user);
  if (!office && !team) throw ApiError.forbidden('Only the team that asked, the enquiry’s marketing person or Admin writes on this');
  /* Admin is on both sides: whoever the ask is waiting on is who Admin speaks for. */
  const side = office && team ? (change.waitingOn === 'office' ? 'office' : 'team') : office ? 'office' : 'team';
  const said = clean(body, 'the reply', 2);
  let day;
  if (date) day = (await import('./handoff.service.js')).eddDay(date);
  change.messages.push({ side, body: said, date: day, by: user._id });
  if (side === 'team' && day) change.requestedDate = day;
  change.waitingOn = side === 'office' ? 'team' : 'office';
  await change.save();
  await noteOnTask(change, user, side === 'office' ? 'EDD change — reply' : 'EDD change — the team answers', `${said}${day ? ` (${prettyDay(day)})` : ''}`);
  const to = side === 'office' ? await teamPeople(change) : [...(await admins()), ...(await officeOf(change))];
  await tell(change, to, user, { label: side === 'office' ? `${user.name} replied on your EDD change` : `${departmentName(change.department)} answered on the EDD change`, note: `${said}${day ? ` — ${prettyDay(day)}` : ''}`, notice: false });
  return change;
}

/**
 * Agreed: the EDD moves — to the office's own date if it names one, else the team's ask — for
 * the model or the whole enquiry (or the job), through the same doors marketing's EDD always goes
 * [handoff.service `setModelEdds`, `writeEnquiryEdd` + `tellEddSet`; eddAsk.service `setJobEdd`].
 */
export async function agreeEddChange(change, user, { date, note } = {}) {
  assertOpen(change);
  if (!(await mayAnswerChange(change, user))) throw ApiError.forbidden('Admin or the enquiry’s marketing person agrees an EDD change');
  const handoff = await import('./handoff.service.js');
  const day = date ? handoff.eddDay(date) : change.requestedDate;
  if (day < new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())) fail('That date has passed — agree a date from today on');
  const text = String(note || '').trim();
  const why = `EDD change agreed — ${departmentName(change.department)} asked: ${change.reason}${text ? ` · ${text}` : ''}`;
  if (change.enquiry) {
    const enquiry = await Enquiry.findById(idOf(change.enquiry));
    const byModel = change.model && (enquiry.eddByModel || []).some((row) => row.model === change.model);
    if (byModel) await handoff.setModelEdds(enquiry, user, { models: [{ model: change.model, date: day }], note: why });
    else {
      await handoff.writeEnquiryEdd(enquiry._id, { day, user, department: 'marketing', note: why });
      await handoff.tellEddSet(enquiry, user, { day, note: why });
    }
  } else {
    const task = await Todo.findById(idOf(change.task));
    const { setJobEdd } = await import('./eddAsk.service.js');
    await setJobEdd(task, user, { date: day, note: why });
  }
  change.status = 'agreed';
  change.agreedDate = day;
  change.decidedBy = user._id;
  change.decidedAt = new Date();
  change.waitingOn = undefined;
  change.messages.push({ side: 'office', body: text || 'Agreed', date: day, by: user._id });
  await change.save();
  await noteOnTask(change, user, 'EDD change agreed', `${change.model ? `${change.model}: ` : ''}EDD now ${prettyDay(day)}${text ? ` — ${text}` : ''}`);
  await tell(change, await teamPeople(change), user, { label: `EDD change agreed — now ${prettyDay(day)}`, note: `${user.name}${text ? `: ${text}` : ''}` });
  return change;
}

/** Kept: the EDD stays as it is, and the team is told why. */
export async function keepEdd(change, user, { note }) {
  assertOpen(change);
  if (!(await mayAnswerChange(change, user))) throw ApiError.forbidden('Admin or the enquiry’s marketing person answers an EDD change');
  const why = clean(note, 'why the EDD stays');
  change.status = 'kept';
  change.decidedBy = user._id;
  change.decidedAt = new Date();
  change.waitingOn = undefined;
  change.messages.push({ side: 'office', body: why, by: user._id });
  await change.save();
  await noteOnTask(change, user, 'EDD kept', `${change.currentEdd ? prettyDay(change.currentEdd) : 'The EDD'} stands — ${why}`);
  await tell(change, await teamPeople(change), user, { label: 'EDD change not agreed — the EDD stands', note: `${user.name}: ${why}` });
  return change;
}

/** The team takes its ask back. */
export async function withdrawEddChange(change, user) {
  assertOpen(change);
  if (!onTeamSide(change, user)) throw ApiError.forbidden('Only the team that asked withdraws it');
  change.status = 'withdrawn';
  change.waitingOn = undefined;
  change.decidedAt = new Date();
  change.messages.push({ side: 'team', body: 'Withdrawn', by: user._id });
  await change.save();
  await noteOnTask(change, user, 'EDD change withdrawn', 'The EDD stays');
  return change;
}

/* ------------------------------ Reading ------------------------------ */

export const changesOnTask = (task) => EddChange.find(task.enquiry ? { enquiry: idOf(task.enquiry) } : { chain: chainOf(task) }).sort({ createdAt: -1 }).limit(50).populate(CHANGE_POPULATE);

/**
 * The enquiry's EDD and its history: what was first promised, where it stands, each change asked
 * and how it was answered — the top of the enquiry page.
 */
export async function eddTrack(enquiry) {
  const changes = await EddChange.find({ enquiry: enquiry._id }).sort({ createdAt: 1 }).populate(CHANGE_POPULATE);
  const agreed = changes.filter((row) => row.status === 'agreed');
  const first = changes.find((row) => row.currentEdd)?.currentEdd || enquiry.edd?.date || null;
  return {
    current: enquiry.edd?.date || null,
    first,
    moved: agreed.length,
    open: changes.filter((row) => row.status === 'open'),
    changes: [...changes].reverse(),
  };
}

/**
 * For "Needs your action": the asks waiting on this person — Admin, every one waiting on the
 * office; a marketing person, those on their enquiries or jobs — and the replies waiting on their team.
 */
export async function eddChangesFor(user) {
  const waiting = await EddChange.find({ status: 'open' }).sort({ createdAt: 1 }).limit(100).populate(CHANGE_POPULATE);
  const forOffice = [];
  const forTeam = [];
  for (const change of waiting) {
    if (change.waitingOn === 'office' && (await mayAnswerChange(change, user))) forOffice.push(change);
    else if (change.waitingOn === 'team' && !isManagement(user) && onTeamSide(change, user)) forTeam.push(change);
  }
  return { forOffice, forTeam };
}

/** One change, for whoever may see it: either side. */
export async function readableChange(id, user) {
  const change = await EddChange.findById(id);
  if (!change) throw ApiError.notFound('EDD change not found');
  if (onTeamSide(change, user) || (await mayAnswerChange(change, user))) return change;
  throw ApiError.notFound('EDD change not found');
}
