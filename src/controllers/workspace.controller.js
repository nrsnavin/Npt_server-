import Todo from '../models/Todo.js';
import StickyNote from '../models/StickyNote.js';
import Announcement from '../models/Announcement.js';
import Customer from '../models/Customer.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { canWrite } from '../services/access.service.js';
import { ownershipFilter } from '../services/ownership.service.js';
import { suggestRouting, routingModelConfigured } from '../services/taskRouting.llm.js';
import { DEPARTMENT_KEYS } from '../config/modules.js';
import { listParams, paginated } from '../utils/query.js';

/**
 * The names a task carries, resolved.
 *
 * A shared queue is unreadable without them: "unclaimed" versus "Kavitha has it" is the whole
 * difference between a row somebody picks up and a row everybody assumes is covered, and the
 * customer is how marketing recognises their own work in a list of thirty.
 */
const TODO_POPULATE = [
  { path: 'user', select: 'name department' },
  { path: 'createdBy', select: 'name department' },
  { path: 'completedBy', select: 'name' },
  { path: 'escalation.by', select: 'name department' },
  { path: 'escalation.acknowledgedBy', select: 'name' },
  { path: 'customer', select: 'code name' },
  { path: 'order', select: 'number status' },
];

/** Start and end of the caller's day, used by the reminder feed. */
function dayBounds(reference = new Date()) {
  const start = new Date(reference);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

/* ------------------------------- To-do ------------------------------- */

/**
 * Which tasks a person is shown [BLUEPRINT §29, §35].
 *
 * Three answers, because there are three different questions somebody asks of this list.
 *
 * **`mine`** — what I am holding. My own tasks, plus anything I escalated away: handing a job
 * to despatch should not mean losing sight of whether despatch picked it up. That is the dock's
 * default, and the badge counts it.
 *
 * **`department`** — what my department is holding, mine included. The queue proper. A job
 * nobody has claimed shows here and anybody in the department may take it, which is the whole
 * reason the queue exists: "somebody in despatch needs to chase this POD" is not a fact about a
 * named clerk.
 *
 * **`customers`** — marketing only, and read-only. Every task standing between one of their
 * buyers and a delivery, whichever department is holding it. This is the question a marketing
 * person is asked down the phone and could previously only answer by ringing round.
 *
 * Ownership [§29] is read off the *customer*, not copied onto the task: an account that changes
 * hands takes its tasks with it, and a marketing person still sees only their own book. An
 * admin is not scoped, as everywhere else.
 */
async function todoScopeFilter(req) {
  const scope = req.query.scope || 'mine';

  if (scope === 'department') {
    if (!req.user.department) {
      throw ApiError.badRequest(
        'Your account has no department set, so there is no queue to show. Ask an administrator.'
      );
    }
    return { department: req.user.department };
  }

  if (scope === 'customers') {
    /*
     * The buyers this person owns. Resolved to a list of ids rather than joined, because the
     * task carries the customer and the ownership lives on the customer — one extra query, and
     * it stays correct the day an account is reassigned.
     */
    const mine = await Customer.find(ownershipFilter(req.user)).select('_id');
    return { customer: { $in: mine.map((customer) => customer._id) } };
  }

  /* Mine: what I hold, and what I handed on and am still waiting for. */
  return { $or: [{ user: req.user._id }, { 'escalation.by': req.user._id }] };
}

export const listTodos = asyncHandler(async (req, res) => {
  const filter = await todoScopeFilter(req);
  if (req.query.status === 'open') filter.completed = false;
  if (req.query.status === 'done') filter.completed = true;

  // Paged, and honest about it. The old flat `.limit(200)` meant a long-running account
  // silently stopped showing its oldest done tasks with nothing on screen to say so.
  const { page, limit } = listParams(req.query, { defaultLimit: 50 });

  const [todos, total] = await Promise.all([
    Todo.find(filter)
      .populate(TODO_POPULATE)
      /*
       * Open first, then soonest due, then newest. Undated tasks sort last.
       *
       * Escalations come above everything else on a shared queue: a job another department has
       * handed over has already waited through somebody else's day, and on a list of thirty the
       * only way it gets seen is by not being thirtieth.
       */
      .sort({ completed: 1, 'escalation.at': -1, dueDate: 1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Todo.countDocuments(filter),
  ]);

  paginated(res, todos, { page, limit, total }, {
    meta: {
      scope: req.query.scope || 'mine',
      department: req.user.department || null,
      /* What the screen needs to decide whether to draw the tabs at all. */
      mayReadCustomers: req.user.department === 'marketing' || req.user.role === 'admin',
    },
  });
});

/**
 * What needs somebody in this department today — the dashboard's card [§25, §35].
 *
 * Two groups rather than two cards, because a dashboard that answers "what now" in four
 * warning-coloured blocks answers it in none. Both are on the same queue and both want the same
 * response, so they belong in one place a person scans at nine o'clock:
 *
 * **`handedOver`** — another department stopped and passed it here, and nobody here has picked
 * it up. First, because it has already waited through somebody else's day.
 *
 * **`urgent`** — high priority or past its date, on our own queue. Unclaimed first inside that,
 * since a job nobody holds is the one at risk of being everybody's assumption.
 *
 * Both are *unanswered* work: taking a job removes it from the handover group, and finishing
 * one removes it from either. The card empties as the department works, which is the only thing
 * that keeps it from becoming a second copy of the queue.
 */
export const needsMeToday = asyncHandler(async (req, res) => {
  if (!req.user.department) {
    res.json({ success: true, data: { handedOver: [], urgent: [] }, meta: { open: 0 } });
    return;
  }

  const mine = { department: req.user.department, completed: false };
  const startOfToday = dayBounds().start;

  const [handedOver, urgent] = await Promise.all([
    Todo.find({
      ...mine,
      'escalation.at': { $exists: true },
      'escalation.acknowledgedAt': { $exists: false },
    })
      .populate(TODO_POPULATE)
      .sort({ 'escalation.at': -1 })
      .limit(25),

    Todo.find({
      ...mine,
      /*
       * Urgent means one of two facts, not a mood: somebody set the priority high, or the date
       * has gone. `$lt` the start of today rather than `now`, so a task due at five o'clock
       * does not appear as late at nine in the morning — the same midnight-to-midnight rule the
       * reminder buckets use, so the two screens cannot disagree about what "late" is.
       */
      $or: [{ priority: 'high' }, { dueDate: { $lt: startOfToday } }],
      /* Not the handovers — they are in the group above, and one job should appear once. */
      $nor: [{ 'escalation.at': { $exists: true }, 'escalation.acknowledgedAt': { $exists: false } }],
    })
      .populate(TODO_POPULATE)
      /* Unclaimed first, then soonest due. A row nobody holds is the one that goes unnoticed. */
      .sort({ user: 1, dueDate: 1, createdAt: -1 })
      .limit(25),
  ]);

  res.json({
    success: true,
    data: { handedOver, urgent },
    meta: {
      open: handedOver.length + urgent.length,
      handedOver: handedOver.length,
      urgent: urgent.length,
      department: req.user.department,
    },
  });
});

/**
 * Whose job is this, and is it urgent — asked of the model, answered either way [§25, §35].
 *
 * A read, not a write: it proposes and nothing moves. The escalation still needs the press,
 * still checks the presser may see the task, and still records who did it. That is what makes
 * it safe to have a model in the loop at all — the worst a wrong answer does is pre-select the
 * wrong entry in a dropdown somebody is already looking at.
 *
 * The queue the task is already on is excluded, because suggesting that back suggests nothing.
 */
export const suggestRoutingFor = asyncHandler(async (req, res) => {
  const todo = await todoInView(req);
  await todo.populate([
    { path: 'customer', select: 'name' },
    { path: 'order', select: 'number' },
  ]);

  const suggestion = await suggestRouting(todo, { exclude: todo.department });

  res.json({
    success: true,
    data: {
      ...suggestion,
      /* So the dialog can say "suggested" rather than presenting it as somebody's decision. */
      configured: routingModelConfigured(),
    },
  });
});

export const createTodo = asyncHandler(async (req, res) => {
  /*
   * A task somebody types is theirs, on their own department's queue — which is what it always
   * was, now said out loud. Without a department there is no queue to put it on and no honest
   * place to file it, so the refusal names the fix rather than inventing one.
   */
  if (!req.user.department) {
    throw ApiError.badRequest(
      'Your account has no department set, so a task has nowhere to go. Ask an administrator.'
    );
  }

  const todo = await Todo.create({
    user: req.user._id,
    department: req.user.department,
    createdBy: req.user._id,
    title: req.body.title,
    notes: req.body.notes,
    dueDate: req.body.dueDate || undefined,
    priority: req.body.priority || 'normal',
    customer: req.body.customer || undefined,
    order: req.body.order || undefined,
  });

  res.status(201).json({ success: true, data: todo });
});

/**
 * Whether this person may change this task, and the sentence saying why not.
 *
 * The rule is the department, not the owner. A shared queue whose rows only their claimant may
 * tick off is a private list with extra steps — somebody off sick leaves their jobs frozen in
 * front of colleagues who can see them and can do nothing.
 *
 * Marketing's customer view is deliberately outside this: they may *read* every task on their
 * buyers and escalate one, and they may not close production's work. Seeing across departments
 * is what the view is for; acting across them is not.
 */
function mayWorkOn(user, todo) {
  if (user.role === 'admin') return null;
  if (String(todo.user || '') === String(user._id)) return null;
  if (todo.department && todo.department === user.department) return null;

  return (
    `This task is on the ${(todo.department || 'another').replace(/_/g, ' ')} queue. You can see ` +
    'it because it is on one of your customers — to get it moved, escalate it with a reason ' +
    'rather than closing it here.'
  );
}

/** The task, if this person is allowed to know it exists at all. */
async function todoInView(req) {
  const todo = await Todo.findById(req.params.id);
  if (!todo) throw ApiError.notFound('Task not found');

  if (req.user.role === 'admin') return todo;
  if (String(todo.user || '') === String(req.user._id)) return todo;
  if (String(todo.escalation?.by || '') === String(req.user._id)) return todo;
  if (todo.department === req.user.department) return todo;

  /* Marketing's window: a task on a buyer they own, whichever department holds it. */
  if (todo.customer) {
    const customer = await Customer.findOne({
      _id: todo.customer,
      ...ownershipFilter(req.user),
    }).select('_id');
    if (customer) return todo;
  }

  /* Not found rather than forbidden: a task they may not see is a task that, to them, is not
     there — the same answer every other record in the app gives [§29]. */
  throw ApiError.notFound('Task not found');
}

export const updateTodo = asyncHandler(async (req, res) => {
  const todo = await todoInView(req);

  const refusal = mayWorkOn(req.user, todo);
  if (refusal) throw ApiError.forbidden(refusal);

  const { title, notes, dueDate, priority, completed, claim } = req.body;

  if (title !== undefined) todo.title = title;
  if (notes !== undefined) todo.notes = notes;
  if (dueDate !== undefined) todo.dueDate = dueDate || undefined;
  /* A person setting the priority makes it theirs, so the "suggested" label comes off. That
     matters both ways round: accepting a suggestion by hand is a decision, and overruling one
     must not leave the row still claiming a model chose it. */
  if (priority !== undefined) {
    todo.priority = priority;
    todo.prioritySuggested = undefined;
  }

  /*
   * Taking an unclaimed job off the queue, and putting one back.
   *
   * `claim: true` is the "I've got this" that stops two people starting the same thing;
   * `claim: false` hands it back to the department, which is what somebody does before going
   * home rather than leaving a job that looks covered.
   */
  if (claim === true) todo.user = req.user._id;
  if (claim === false) todo.user = undefined;

  if (completed !== undefined && completed !== todo.completed) {
    todo.completed = completed;
    todo.completedAt = completed ? new Date() : undefined;
    todo.completedBy = completed ? req.user._id : undefined;
    /* Finishing an unclaimed job claims it on the way past. Who did it is worth more on the
       record than a tidy distinction between taking and doing. */
    if (completed && !todo.user) todo.user = req.user._id;
  }

  /*
   * Acting on an escalated task is the acknowledgement — it is what takes the row off the
   * department's highlighted card. Read from the work rather than asked for separately,
   * because a "mark as seen" button is a button people press to clear the badge.
   */
  if (todo.escalation?.at && !todo.escalation.acknowledgedAt && (claim === true || completed)) {
    todo.escalation.acknowledgedAt = new Date();
    todo.escalation.acknowledgedBy = req.user._id;
  }

  await todo.save();
  res.json({ success: true, data: await todo.populate(TODO_POPULATE) });
});

/**
 * Handing a task to another department [§25, §35].
 *
 * It **moves**: the department becomes the target and the owner is cleared, because two
 * departments both holding one task is how it gets done twice or not at all. What stays behind
 * is the record of the handover — so it remains in the escalator's own list, marked with where
 * it went, and they can see whether anybody picked it up. An escalation you cannot follow up is
 * a phone call with extra steps.
 *
 * A reason is required and it is not a formality. "Sent to despatch" tells the receiving
 * department nothing; "buyer is at the gate and the LR is not cut" tells them what to do. The
 * same floor as every other reason the app keeps on the record.
 */
export const escalateTodo = asyncHandler(async (req, res) => {
  const todo = await todoInView(req);

  if (todo.completed) {
    throw ApiError.badRequest('That task is already done — there is nothing to hand over.');
  }

  const to = req.body.department;
  if (!DEPARTMENT_KEYS.includes(to)) throw ApiError.badRequest('That is not a department');
  if (to === todo.department) {
    throw ApiError.badRequest(
      `This is already on the ${to.replace(/_/g, ' ')} queue. Escalating it to itself would ` +
        'only clear whoever is holding it.'
    );
  }

  const reason = String(req.body.reason || '').trim();
  if (reason.length < 10) {
    throw ApiError.badRequest(
      'Say why it is going to them. The department receiving this has not seen the record and ' +
        'a task with no reason on it is one they have to ring back about.'
    );
  }

  todo.escalation = {
    from: todo.department,
    to,
    by: req.user._id,
    at: new Date(),
    reason,
  };
  todo.department = to;
  /* Unclaimed in its new queue: whoever held it in the old department does not hold it here. */
  todo.user = undefined;

  /*
   * Urgency carried on the handover, and attributed.
   *
   * The dialog offers the suggestion's priority pre-selected, so somebody who presses through
   * without reading it has still — technically — accepted it. `suggestedBy` records which it
   * was, and the card labels a suggested priority differently from one a person typed. That
   * distinction is the whole reason a model is allowed near the urgent list: the day one of
   * these is wrong, it is visibly a suggestion rather than somebody's decision.
   *
   * Only ever raised. A handover cannot talk a task *down* from the priority its own department
   * set, model or no model.
   */
  if (req.body.priority === 'high' && todo.priority !== 'high') {
    todo.priority = 'high';
    todo.prioritySuggested = req.body.suggestedBy
      ? { by: req.body.suggestedBy, at: new Date(), reason: req.body.suggestedReason || undefined }
      : undefined;
  }

  await todo.save();
  res.json({ success: true, data: await todo.populate(TODO_POPULATE) });
});

export const deleteTodo = asyncHandler(async (req, res) => {
  const todo = await todoInView(req);

  const refusal = mayWorkOn(req.user, todo);
  if (refusal) throw ApiError.forbidden(refusal);

  /*
   * A system task is the app's record that a handover is owed [§35], not a note somebody wrote.
   * Deleting one makes the reminder disappear while the job it describes is still undone, and
   * the next sweep will raise it again — so it is closed, on the record, rather than removed.
   */
  if (todo.system) {
    throw ApiError.badRequest(
      'This task was raised by the system because something is waiting on it. Tick it off when ' +
        'it is done, or escalate it — it cannot be deleted.'
    );
  }

  await todo.deleteOne();
  res.json({ success: true, data: { id: todo._id } });
});

/**
 * The daily reminder: what is overdue, what is due today, and what lands tomorrow.
 * Undated tasks are deliberately excluded — a reminder needs a date to be about.
 */
export const reminders = asyncHandler(async (req, res) => {
  const { start, end } = dayBounds();
  const tomorrowEnd = new Date(end);
  tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);

  const open = await Todo.find({
    user: req.user._id,
    completed: false,
    dueDate: { $lt: tomorrowEnd },
  }).sort({ dueDate: 1 });

  const overdue = open.filter((todo) => todo.dueDate < start);
  const today = open.filter((todo) => todo.dueDate >= start && todo.dueDate < end);
  const tomorrow = open.filter((todo) => todo.dueDate >= end);

  res.json({
    success: true,
    data: {
      overdue,
      today,
      tomorrow,
      counts: {
        overdue: overdue.length,
        today: today.length,
        tomorrow: tomorrow.length,
        /** What the dock badge shows: everything needing attention now. */
        actionable: overdue.length + today.length,
      },
    },
  });
});

/* ---------------------------- Sticky notes ---------------------------- */

export const listNotes = asyncHandler(async (req, res) => {
  const notes = await StickyNote.find({ user: req.user._id }).sort({ pinned: -1, updatedAt: -1 });
  res.json({ success: true, data: notes });
});

export const createNote = asyncHandler(async (req, res) => {
  const note = await StickyNote.create({
    user: req.user._id,
    content: req.body.content,
    colour: req.body.colour || 'amber',
    pinned: Boolean(req.body.pinned),
  });
  res.status(201).json({ success: true, data: note });
});

export const updateNote = asyncHandler(async (req, res) => {
  const note = await StickyNote.findOne({ _id: req.params.id, user: req.user._id });
  if (!note) throw ApiError.notFound('Note not found');

  const { content, colour, pinned } = req.body;
  if (content !== undefined) note.content = content;
  if (colour !== undefined) note.colour = colour;
  if (pinned !== undefined) note.pinned = pinned;

  await note.save();
  res.json({ success: true, data: note });
});

export const deleteNote = asyncHandler(async (req, res) => {
  const note = await StickyNote.findOneAndDelete({ _id: req.params.id, user: req.user._id });
  if (!note) throw ApiError.notFound('Note not found');
  res.json({ success: true, data: { id: note._id } });
});

/* ---------------------------- Announcements ---------------------------- */

const visibleTo = (user) => ({
  $and: [
    { $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: new Date() } }] },
    // No departments listed means everyone; otherwise the reader's team must be named.
    {
      $or: [
        { departments: { $size: 0 } },
        { departments: { $exists: false } },
        ...(user.department ? [{ departments: user.department }] : []),
      ],
    },
  ],
});

const shape = (announcement, user) => ({
  id: announcement._id,
  title: announcement.title,
  body: announcement.body,
  category: announcement.category,
  departments: announcement.departments,
  pinned: announcement.pinned,
  publishedAt: announcement.publishedAt,
  expiresAt: announcement.expiresAt,
  author: announcement.author?.name
    ? { id: announcement.author._id, name: announcement.author.name }
    : undefined,
  read: (announcement.readBy || []).some((id) => String(id) === String(user._id)),
});

export const listAnnouncements = asyncHandler(async (req, res) => {
  const items = await Announcement.find(visibleTo(req.user))
    .populate('author', 'name')
    .sort({ pinned: -1, publishedAt: -1 })
    .limit(50);

  const data = items.map((item) => shape(item, req.user));

  res.json({
    success: true,
    data,
    meta: {
      unread: data.filter((item) => !item.read).length,
      canPublish: canWrite(req.user, 'announcements'),
    },
  });
});

export const createAnnouncement = asyncHandler(async (req, res) => {
  const announcement = await Announcement.create({
    title: req.body.title,
    body: req.body.body,
    category: req.body.category || 'general',
    departments: req.body.departments || [],
    pinned: Boolean(req.body.pinned),
    expiresAt: req.body.expiresAt || undefined,
    author: req.user._id,
    // The author has, by definition, read their own notice.
    readBy: [req.user._id],
  });

  await announcement.populate('author', 'name');
  res.status(201).json({ success: true, data: shape(announcement, req.user) });
});

export const markAnnouncementRead = asyncHandler(async (req, res) => {
  const announcement = await Announcement.findOneAndUpdate(
    { _id: req.params.id },
    { $addToSet: { readBy: req.user._id } },
    { new: true }
  ).populate('author', 'name');

  if (!announcement) throw ApiError.notFound('Announcement not found');
  res.json({ success: true, data: shape(announcement, req.user) });
});

export const deleteAnnouncement = asyncHandler(async (req, res) => {
  const announcement = await Announcement.findByIdAndDelete(req.params.id);
  if (!announcement) throw ApiError.notFound('Announcement not found');
  res.json({ success: true, data: { id: announcement._id } });
});
