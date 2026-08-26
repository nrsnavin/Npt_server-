import Todo from '../models/Todo.js';
import StickyNote from '../models/StickyNote.js';
import Announcement from '../models/Announcement.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { canWrite } from '../services/access.service.js';

/** Start and end of the caller's day, used by the reminder feed. */
function dayBounds(reference = new Date()) {
  const start = new Date(reference);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

/* ------------------------------- To-do ------------------------------- */

export const listTodos = asyncHandler(async (req, res) => {
  const filter = { user: req.user._id };
  if (req.query.status === 'open') filter.completed = false;
  if (req.query.status === 'done') filter.completed = true;

  const todos = await Todo.find(filter)
    // Open first, then soonest due, then newest. Undated tasks sort last.
    .sort({ completed: 1, dueDate: 1, createdAt: -1 })
    .limit(200);

  res.json({ success: true, data: todos });
});

export const createTodo = asyncHandler(async (req, res) => {
  const todo = await Todo.create({
    user: req.user._id,
    title: req.body.title,
    notes: req.body.notes,
    dueDate: req.body.dueDate || undefined,
    priority: req.body.priority || 'normal',
  });

  res.status(201).json({ success: true, data: todo });
});

export const updateTodo = asyncHandler(async (req, res) => {
  const todo = await Todo.findOne({ _id: req.params.id, user: req.user._id });
  if (!todo) throw ApiError.notFound('Task not found');

  const { title, notes, dueDate, priority, completed } = req.body;

  if (title !== undefined) todo.title = title;
  if (notes !== undefined) todo.notes = notes;
  if (dueDate !== undefined) todo.dueDate = dueDate || undefined;
  if (priority !== undefined) todo.priority = priority;

  if (completed !== undefined && completed !== todo.completed) {
    todo.completed = completed;
    todo.completedAt = completed ? new Date() : undefined;
  }

  await todo.save();
  res.json({ success: true, data: todo });
});

export const deleteTodo = asyncHandler(async (req, res) => {
  const todo = await Todo.findOneAndDelete({ _id: req.params.id, user: req.user._id });
  if (!todo) throw ApiError.notFound('Task not found');
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
