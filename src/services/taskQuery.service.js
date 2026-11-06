import TaskQuery from '../models/TaskQuery.js';
import Todo from '../models/Todo.js';
import Enquiry from '../models/Enquiry.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import { afterCommit } from '../utils/transaction.js';
import { departmentsOf, inDepartment, isManagement, MANAGEMENT_QUERY } from '../utils/departments.js';
import { findDepartment } from '../config/modules.js';
import { findHandoff } from '../config/handoffs.js';
import { EVENTS, publish } from './events.service.js';
import { canRead } from './access.service.js';
import { ensureSubject } from './querySubjects.service.js';
import { isOwnershipScoped, ownsRecord } from './ownership.service.js';
import Customer from '../models/Customer.js';

/**
 * Questions asked on a task or an enquiry, and their answers [models/TaskQuery.js].
 *
 *   ask       whoever works the task (its department, the person it is with, Admin) asks the
 *             person who raised it — the task's creator, else the enquiry's marketing person,
 *             else Admin. On an enquiry: anybody who may read it asks its marketing person.
 *   answer    the person it was put to, the task's creator, the enquiry's marketing person, or
 *             Admin. The answer goes onto the task (its "Replies", the clarifications kept on
 *             the task and the enquiry), and a task held at Needs Clarification goes back to
 *             where it was.
 *   follow up the asking side may add to its question; it is open again.
 *   close     the asking side or Admin, when the question no longer matters.
 *
 * The workflow's own clarifications (the SO team's Needs Clarification) are asked here too —
 * `askFromWorkflow`, from handoff.service `setTaskStatus` — in place of a task for marketing.
 */

const fail = (message) => { throw ApiError.badRequest(message); };
const idOf = (value) => String(value?._id ?? value ?? '');
const departmentName = (key) => findDepartment(key)?.label || String(key || '').replace(/_/g, ' ');

export const QUERY_POPULATE = [
  { path: 'askedBy', select: 'name department' },
  { path: 'to', select: 'name department' },
  { path: 'answeredBy', select: 'name' },
  { path: 'messages.by', select: 'name department' },
  { path: 'task', select: 'title kind department status completed createdBy' },
  { path: 'enquiry', select: 'number' },
  { path: 'customer', select: 'code name' },
];

const activeUser = async (id) => (id ? User.findOne({ _id: id, isActive: { $ne: false } }).select('_id name').lean() : null);

/**
 * Who a question on this work goes to: the person who raised the task — unless that is the
 * asker, or somebody in the asking department itself — else the enquiry's marketing person,
 * else nobody by name, which makes it Admin's.
 */
export async function recipientFor({ task = null, enquiry = null, asker }) {
  const candidates = [];
  if (task?.createdBy) candidates.push(task.createdBy);
  if (enquiry?.assignedTo) candidates.push(enquiry.assignedTo);
  for (const candidate of candidates) {
    if (idOf(candidate) === idOf(asker._id)) continue;
    const person = await User.findOne({ _id: idOf(candidate), isActive: { $ne: false } }).select('_id name department extraDepartments role').lean();
    if (!person) continue;
    /* Somebody in the department that asks is asking themselves — the enquiry's marketing person is asked instead. */
    if (task?.department && inDepartment(person, task.department) && !isManagement(person)) continue;
    return person;
  }
  return null;
}

/**
 * Who replies to a team's doubt on its task, from the task itself: Admin, and marketing — the
 * marketing person who raised the task, owns its enquiry or owns its buyer, or one not held to
 * their own buyers. Not a marketing person working the task: they are the team that asks.
 */
export async function mayReplyOnTask(task, user) {
  if (isManagement(user)) return true;
  if (!inDepartment(user, 'marketing')) return false;
  if (task.department && task.department !== 'marketing' && inDepartment(user, task.department)) return false;
  if (!isOwnershipScoped(user)) return true;
  if (task.createdBy && idOf(task.createdBy) === idOf(user._id)) return true;
  if (task.enquiry) {
    const enquiry = await Enquiry.findById(idOf(task.enquiry)).select('assignedTo').lean();
    if (enquiry?.assignedTo && idOf(enquiry.assignedTo) === idOf(user._id)) return true;
  }
  if (task.customer) {
    const customer = await Customer.findById(idOf(task.customer)).select('assignedTo').lean();
    if (customer?.assignedTo && idOf(customer.assignedTo) === idOf(user._id)) return true;
  }
  return false;
}

/** Who answers a question: whoever it was put to, the task's creator, the enquiry's marketing person, Admin — and on a task, whoever may reply on it. */
export async function mayAnswer(query, user) {
  if (isManagement(user)) return true;
  if (query.to && idOf(query.to) === idOf(user._id)) return true;
  const task = query.task ? await Todo.findById(idOf(query.task)).select('createdBy enquiry customer department').lean() : null;
  if (task?.createdBy && idOf(task.createdBy) === idOf(user._id)) return true;
  if (task && !onAskingSide(query, user) && (await mayReplyOnTask(task, user))) return true;
  if (query.enquiry) {
    const enquiry = await Enquiry.findById(idOf(query.enquiry)).select('assignedTo').lean();
    if (enquiry?.assignedTo && idOf(enquiry.assignedTo) === idOf(user._id)) return true;
  }
  return false;
}

/** The asking side: whoever asked, and the department it was asked for. */
export const onAskingSide = (query, user) => idOf(query.askedBy) === idOf(user._id)
  || Boolean(query.department && inDepartment(user, query.department));

/** May this person see the questions on this task? Whoever works it, raised it, is asked on it, or owns its enquiry. */
export async function mayReadTaskQueries(task, user) {
  if (isManagement(user)) return true;
  if (task.user && idOf(task.user) === idOf(user._id)) return true;
  if (inDepartment(user, task.department)) return true;
  if (task.createdBy && idOf(task.createdBy) === idOf(user._id)) return true;
  /* The department that asked for it — not a marketing colleague: a buyer is one marketing person's. */
  if (task.fromDepartment && inDepartment(user, task.fromDepartment) && !isOwnershipScoped(user)) return true;
  if (task.enquiry) {
    const enquiry = await Enquiry.findById(idOf(task.enquiry)).select('assignedTo').lean();
    if (enquiry?.assignedTo && idOf(enquiry.assignedTo) === idOf(user._id)) return true;
  }
  if (await mayReplyOnTask(task, user)) return true;
  return Boolean(await TaskQuery.exists({ task: task._id, $or: [{ to: user._id }, { askedBy: user._id }] }));
}

/** May this person read the enquiry — and so its questions? The enquiry screen's own rule. */
export async function mayReadEnquiry(enquiry, user) {
  if (isManagement(user)) return true;
  if (canRead(user, 'enquiries') && ownsRecord(user, enquiry)) return true;
  const { mayHandOff } = await import('./handoff.service.js');
  if (await mayHandOff(user, enquiry)) return true;
  return Boolean(await TaskQuery.exists({ enquiry: enquiry._id, $or: [{ to: user._id }, { askedBy: user._id }] }));
}

/* ------------------------------ Telling people ------------------------------ */

/** The people who hear a question: whoever it is put to — or, put to nobody, every Admin. */
async function answerers(query) {
  if (query.to) return [idOf(query.to)];
  const admins = await User.find({ ...MANAGEMENT_QUERY, isActive: { $ne: false } }).select('_id').lean();
  return admins.map((person) => idOf(person._id));
}

const linkOf = (query) => (query.enquiry ? `/enquiries/${idOf(query.enquiry)}` : '/task-queries');

function ring(userIds, { title, body, query }) {
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  if (!ids.length) return;
  afterCommit(() => import('./push.service.js')
    .then(({ sendPush }) => sendPush(ids, { title, body: String(body || '').slice(0, 200), link: linkOf(query), kind: 'task-query', queryId: idOf(query._id) }))
    .catch((error) => console.error(`[task-query] push not sent: ${error.message}`)));
}

/** A notice under "Needs your action" for the asker of an answered question with no task to carry it. */
async function noticeAnswer(query, user, text) {
  const { default: TaskNotice } = await import('../models/TaskNotice.js');
  if (idOf(query.askedBy) === idOf(user._id)) return;
  await TaskNotice.create({
    recipient: idOf(query.askedBy), task: query.task ? idOf(query.task) : undefined,
    enquiry: query.enquiry ? idOf(query.enquiry) : undefined, customer: query.customer ? idOf(query.customer) : undefined,
    department: query.department, kind: 'task_query', status: 'query_answered', statusLabel: 'Your query was answered',
    note: `${user.name}: ${text}`.slice(0, 2000), link: linkOf(query), by: user._id, at: new Date(),
  });
}

/* ------------------------------ Asking ------------------------------ */

function cleanText(text, what = 'the question') {
  const said = String(text || '').trim();
  if (said.length < 3) fail(`Write ${what} — a few words at least`);
  if (said.length > 2000) fail('Keep it under 2000 characters');
  return said;
}

/** Put a question on a task to the person who raised it. */
export async function askOnTask(task, user, { question, subject = null, workflow = null }) {
  const { mayWorkOnHandoff } = await import('./handoff.service.js');
  if (!mayWorkOnHandoff(user, task)) throw ApiError.forbidden('Only the team working this task can ask on it');
  if (task.completed) fail('This task is closed — ask on the enquiry instead');
  const text = cleanText(question);
  const enquiry = task.enquiry ? await Enquiry.findById(idOf(task.enquiry)).select('assignedTo customer number').lean() : null;
  const to = await recipientFor({ task, enquiry, asker: user });
  if (!to && isManagement(user)) fail('There is nobody else to ask on this task — it was raised by you or your team');
  /* A new subject joins the drop-down for everyone. */
  const filed = await ensureSubject(subject, user);
  const query = await TaskQuery.create({
    subject: filed || undefined,
    task: task._id, enquiry: enquiry?._id, customer: task.customer?._id || task.customer || enquiry?.customer || undefined,
    order: task.order?._id || task.order || undefined,
    department: task.department, askedBy: user._id, question: text, to: to?._id,
    ...(workflow ? { workflow } : {}),
    messages: [{ body: text, by: user._id, side: 'ask', at: new Date() }],
  });
  /* The task says it asked — the timeline reads it with everything else that happened. */
  await Todo.updateOne({ _id: task._id }, {
    $push: { updates: { kind: 'query', statusLabel: 'Query asked', text, note: `Query to ${to?.name || 'Admin'} (${user.name}): ${text}`, by: user._id, at: new Date() } },
  }, { keepVersion: true });
  ring(await answerers(query), {
    title: `${departmentName(task.department)} asks you`,
    body: `${task.title}${enquiry?.number ? ` (${enquiry.number})` : ''} — ${user.name}: ${text}`,
    query,
  });
  await publish(EVENTS.HANDOFF_UPDATED, { task, by: user });
  return query;
}

/** Put a question on the enquiry itself to its marketing person — or, from them, to Admin. */
export async function askOnEnquiry(enquiry, user, { question, subject = null }) {
  if (!(await mayReadEnquiry(enquiry, user))) throw ApiError.notFound('Enquiry not found');
  const text = cleanText(question);
  const owner = idOf(enquiry.assignedTo) === idOf(user._id) ? null : await activeUser(enquiry.assignedTo);
  if (!owner && isManagement(user)) fail('This enquiry is yours — there is nobody else to ask');
  /* Asked for the department the asker works the enquiry for — its people follow the answer too. */
  const holding = await Todo.findOne({ enquiry: enquiry._id, completed: false, department: { $exists: true, $ne: null } })
    .sort({ createdAt: -1 }).select('department').lean();
  const department = holding && inDepartment(user, holding.department) ? holding.department : undefined;
  const filed = await ensureSubject(subject, user);
  const query = await TaskQuery.create({
    subject: filed || undefined,
    enquiry: enquiry._id, customer: enquiry.customer?._id || enquiry.customer || undefined,
    department, askedBy: user._id, question: text, to: owner?._id,
    messages: [{ body: text, by: user._id, side: 'ask', at: new Date() }],
  });
  ring(await answerers(query), { title: `${user.name} asks you`, body: `${enquiry.number} — ${text}`, query });
  return query;
}

/**
 * The workflow asks [handoff.service `setTaskStatus`, a status marked `query`]: the SO team's
 * Needs Clarification. `from` is where the task was, and where the answer puts it back.
 */
export async function askFromWorkflow(task, user, step, text) {
  const open = await TaskQuery.findOne({ task: task._id, status: 'open', 'workflow.status': step.key }).sort({ createdAt: -1 }).lean();
  const from = task.status && task.status !== step.key ? task.status : open?.workflow?.from;
  return askOnTask(task, user, { question: text, subject: step.querySubject || null, workflow: { status: step.key, from } });
}

/* ------------------------------ Answering ------------------------------ */

const statusesOf = (task) => findHandoff(task.kind)?.form?.statuses || [];

/**
 * The answer onto the task it was asked on: a line in its timeline, the clarification kept on the
 * task and the enquiry, "Replies" for its department — and, held at Needs Clarification, back to
 * where it was before the question.
 */
async function answerOnTask(query, user, text) {
  const task = await Todo.findById(idOf(query.task));
  if (!task) return;
  const now = new Date();
  task.updates = [...(task.updates || []), {
    kind: 'query', statusLabel: 'Query answered', text, note: `Reply from ${user.name}: ${text}`, by: user._id, at: now,
  }];
  const pair = {
    question: query.question, answer: text, askedBy: idOf(query.askedBy), askedAt: query.createdAt,
    answeredBy: user._id, answeredAt: now, query: query._id,
  };
  task.clarifications = [...(task.clarifications || []), pair];
  if (task.enquiry) {
    await Enquiry.updateOne({ _id: idOf(task.enquiry) }, {
      $push: { clarifications: { ...pair, kind: 'query', department: task.department, task: task._id } },
    }, { keepVersion: true });
  }
  if (!task.completed) {
    /* At the top of the asking department's dashboard until somebody there acts on it. */
    task.attention = { kind: 'reply', note: text, by: user._id, at: now };
    await returnFromQuery(task, query, user, 'Query answered');
  }
  await task.save();
  await publish(EVENTS.HANDOFF_UPDATED, { task, by: user });
}

/** A task held at the workflow's question goes back to where it was — once no other such question is open. */
async function returnFromQuery(task, query, user, why) {
  const asking = query.workflow?.status;
  if (!asking || task.status !== asking) return;
  const stillOpen = await TaskQuery.exists({ task: task._id, _id: { $ne: query._id }, status: 'open', 'workflow.status': asking });
  if (stillOpen) return;
  const before = query.workflow.from
    || [...(task.statusHistory || [])].reverse().find((entry) => entry.status !== asking)?.status
    || statusesOf(task)[0]?.key;
  if (!before) return;
  task.status = before;
  task.statusHistory = [...(task.statusHistory || []), { status: before, note: why, by: user._id, at: new Date() }];
}

/** A reply in the thread: an answer from the side it was put to, or a follow-up from the asking side. */
export async function replyToQuery(query, user, { body }) {
  if (query.status === 'closed') fail('This query is closed');
  const text = cleanText(body, 'the reply');
  const answering = await mayAnswer(query, user);
  const asking = onAskingSide(query, user);
  if (!answering && !asking) throw ApiError.forbidden('Only the person asked, or the team that asked, can reply here');
  /* Both sides at once (Admin asking): the side it was asked from decides — Admin's own question is a follow-up. */
  const side = answering && !(asking && idOf(query.askedBy) === idOf(user._id)) ? 'answer' : 'ask';
  const now = new Date();
  query.messages.push({ body: text, by: user._id, side, at: now });
  if (side === 'answer') {
    query.status = 'answered';
    query.answeredAt = now;
    query.answeredBy = user._id;
    query.seenAt = undefined;
    await query.save();
    if (query.task) await answerOnTask(query, user, text);
    else {
      if (query.enquiry) {
        await Enquiry.updateOne({ _id: idOf(query.enquiry) }, {
          $push: { clarifications: { kind: 'query', department: query.department, question: query.question, answer: text, askedBy: idOf(query.askedBy), askedAt: query.createdAt, answeredBy: user._id, answeredAt: now, query: query._id } },
        }, { keepVersion: true });
      }
      await noticeAnswer(query, user, text);
    }
    ring([idOf(query.askedBy)].filter((id) => id !== idOf(user._id)), { title: `${user.name} answered your query`, body: `${query.question} — ${text}`, query });
  } else {
    query.status = 'open';
    await query.save();
    if (query.task) {
      await Todo.updateOne({ _id: idOf(query.task) }, {
        $push: { updates: { kind: 'query', statusLabel: 'Query follow-up', text, note: `Follow-up (${user.name}): ${text}`, by: user._id, at: now } },
      }, { keepVersion: true });
    }
    ring((await answerers(query)).filter((id) => id !== idOf(user._id)), { title: `${user.name} follows up`, body: `${query.question} — ${text}`, query });
  }
  return query;
}

/**
 * Admin's or marketing's reply on a task, written under its timeline [web: TaskQueries `ReplyBox`].
 * A question waiting on the task is answered by it — the newest one somebody else asked. With
 * none, the reply goes onto the task as it is: a line in its timeline and "Replies" for the team
 * working it; a task held at Needs Clarification from before queries goes back to where it was,
 * the doubt and its answer kept on the task and the enquiry.
 */
export async function replyOnTask(task, user, { body }) {
  if (!(await mayReplyOnTask(task, user))) throw ApiError.forbidden('Only Admin or the buyer’s marketing person replies on this task');
  if (task.completed) fail('This task is done — reply on the enquiry instead');
  const text = cleanText(body, 'the reply');
  const open = await TaskQuery.findOne({ task: task._id, status: 'open', askedBy: { $ne: user._id } }).sort({ createdAt: -1 });
  if (open) {
    await replyToQuery(open, user, { body: text });
    return { answered: idOf(open._id) };
  }
  const live = await Todo.findById(task._id);
  const now = new Date();
  live.updates = [...(live.updates || []), {
    kind: 'reply', statusLabel: isManagement(user) ? 'Reply from Admin' : 'Reply from marketing', text,
    note: `Reply from ${user.name}: ${text}`, by: user._id, at: now,
  }];
  live.attention = { kind: 'reply', note: text, by: user._id, at: now };
  const step = statusesOf(live).find((entry) => entry.key === live.status);
  if (step?.opensQuery) {
    const history = [...(live.statusHistory || [])].reverse();
    const asked = history.find((entry) => entry.status === step.key);
    const pair = {
      question: asked?.note || '', answer: text, askedBy: asked?.by || undefined, askedAt: asked?.at || undefined,
      answeredBy: user._id, answeredAt: now,
    };
    live.clarifications = [...(live.clarifications || []), pair];
    if (live.enquiry) {
      await Enquiry.updateOne({ _id: idOf(live.enquiry) }, {
        $push: { clarifications: { ...pair, kind: 'reply', department: live.department, task: live._id } },
      }, { keepVersion: true });
    }
    const before = history.find((entry) => entry.status !== step.key)?.status || statusesOf(live)[0]?.key;
    if (before && before !== step.key) {
      live.status = before;
      live.statusHistory = [...(live.statusHistory || []), { status: before, note: 'Replied', by: user._id, at: now }];
    }
  }
  await live.save();
  const holder = live.user && idOf(live.user) !== idOf(user._id) ? [idOf(live.user)] : [];
  if (holder.length) {
    afterCommit(() => import('./push.service.js')
      .then(({ sendPush }) => sendPush(holder, {
        title: `${user.name} replied`, body: `${live.title} — ${text}`.slice(0, 200),
        link: live.enquiry ? `/enquiries/${idOf(live.enquiry)}` : '/workspace', kind: 'task-reply', taskId: idOf(live._id),
      }))
      .catch((error) => console.error(`[task-reply] push not sent: ${error.message}`)));
  }
  await publish(EVENTS.HANDOFF_UPDATED, { task: live, by: user });
  return { replied: true };
}

/** Closed by the asking side or Admin: it no longer matters. A task held for it goes back. */
export async function closeTaskQuery(query, user, { reason } = {}) {
  if (query.status === 'closed') return query;
  if (!onAskingSide(query, user) && !isManagement(user)) throw ApiError.forbidden('Only the team that asked, or Admin, closes a query');
  const now = new Date();
  query.status = 'closed';
  query.closedAt = now;
  query.closedBy = user._id;
  const why = String(reason || '').trim();
  if (why) query.messages.push({ body: `Closed: ${why}`.slice(0, 2000), by: user._id, side: 'ask', at: now });
  await query.save();
  if (query.task) {
    const task = await Todo.findById(idOf(query.task));
    if (task && !task.completed) {
      await returnFromQuery(task, query, user, 'Query closed');
      task.updates = [...(task.updates || []), { kind: 'query', statusLabel: 'Query closed', text: why || undefined, note: `Query closed by ${user.name}${why ? `: ${why}` : ''}`, by: user._id, at: now }];
      await task.save();
    }
  }
  return query;
}

/** The asker read the answer — off the top of their screen. */
export async function markQuerySeen(query, user) {
  if (!onAskingSide(query, user) && !isManagement(user)) throw ApiError.forbidden('Not your query');
  if (!query.seenAt) {
    query.seenAt = new Date();
    await query.save();
  }
  return query;
}

/** The task's own questions are done with it — its "Got it", or the task closing. */
export async function seeQueriesOfTask(taskId) {
  await TaskQuery.updateMany({ task: taskId, status: 'answered', seenAt: null }, { $set: { seenAt: new Date() } });
}

/** A task closed: questions still open on it no longer hold anything up. */
export async function closeQueriesOfTask(task, user, why) {
  const open = await TaskQuery.find({ task: task._id, status: 'open' });
  const now = new Date();
  for (const query of open) {
    query.status = 'closed';
    query.closedAt = now;
    query.closedBy = user?._id || undefined;
    if (user?._id) query.messages.push({ body: `Closed with the task${why ? ` — ${why}` : ''}`.slice(0, 2000), by: user._id, side: 'ask', at: now });
    await query.save();
  }
}

/* ------------------------------ Reading ------------------------------ */

export const queriesOnTask = (taskId) => TaskQuery.find({ task: taskId }).sort({ createdAt: -1 }).limit(100).populate(QUERY_POPULATE);
export const queriesOnEnquiry = (enquiryId) => TaskQuery.find({ enquiry: enquiryId }).sort({ createdAt: -1 }).limit(100).populate(QUERY_POPULATE);

/** Open questions this person is to answer — put to them, or (Admin) put to nobody. */
export function questionsFor(user) {
  const branches = [{ to: user._id }];
  if (isManagement(user)) branches.push({ to: null });
  return TaskQuery.find({ status: 'open', $or: branches }).sort({ createdAt: 1 }).limit(50).populate(QUERY_POPULATE);
}

/**
 * Answers to this person's own questions not yet read — the ones no task's "Replies" carries:
 * asked on the enquiry, or asked by somebody outside the task's department (Admin).
 */
export async function answersFor(user) {
  const rows = await TaskQuery.find({ askedBy: user._id, status: 'answered', seenAt: null }).sort({ answeredAt: -1 }).limit(50).populate(QUERY_POPULATE);
  return rows.filter((query) => !query.task || !query.department || !inDepartment(user, query.department));
}

/** The Task queries screen: for me, asked by me or my team, and (Admin) every open one. */
export async function queryBoard(user, { show = 'open', subject = '' } = {}) {
  const live = { ...(show === 'all' ? {} : { status: { $ne: 'closed' } }), ...(subject ? { subject } : {}) };
  const mine = [{ askedBy: user._id }];
  const departments = departmentsOf(user);
  if (departments.length) mine.push({ department: { $in: departments } });
  const [forMe, asked, everyOpen] = await Promise.all([
    TaskQuery.find({ ...live, $or: [{ to: user._id }, ...(isManagement(user) ? [{ to: null }] : [])] }).sort({ updatedAt: -1 }).limit(100).populate(QUERY_POPULATE),
    TaskQuery.find({ ...live, $or: mine }).sort({ updatedAt: -1 }).limit(100).populate(QUERY_POPULATE),
    isManagement(user) ? TaskQuery.find({ status: 'open', ...(subject ? { subject } : {}) }).sort({ createdAt: 1 }).limit(200).populate(QUERY_POPULATE) : [],
  ]);
  return { forMe, asked, everyOpen };
}

/** One query, if this person may see it. */
export async function readableTaskQuery(id, user) {
  const query = await TaskQuery.findById(id);
  if (!query) throw ApiError.notFound('Query not found');
  if (isManagement(user) || onAskingSide(query, user) || (await mayAnswer(query, user))) return query;
  throw ApiError.notFound('Query not found');
}
