import Query, { roomFilter, seesEveryQuery } from '../models/Query.js';
import QueryRead from '../models/QueryRead.js';
import Pricing from '../models/Pricing.js';
import Sample from '../models/Sample.js';
import Todo from '../models/Todo.js';
import asyncHandler from '../utils/asyncHandler.js';
import { canRead } from '../services/access.service.js';
import { seesCosting } from '../services/pricingVisibility.js';
import { taggedUnreadFor, unreadFor } from './query.controller.js';

/**
 * Everything waiting on me, in one list — the bell in the header.
 *
 * Built from the records' own state rather than stored as notifications, so there is nothing to
 * mark read and nothing to go stale: a tag leaves when the thread is read, an approval when it
 * is decided, a task when it is done. Each source is scoped the way its own list is, so the
 * bell can never show somebody a record their list would not.
 */
const MOST = 30;
const WEEK = 7 * 24 * 60 * 60 * 1000;

async function queryItems(user) {
  if (!canRead(user, 'queries')) return [];
  /* `$and`, not a spread: the room is itself an `$or`, and a second `$or` spread over it would
     silently replace it — the bell would ring for every urgent thread in the plant. */
  const threads = await Query.find({
    $and: [
      ...(seesEveryQuery(user) ? [] : [roomFilter(user)]),
      { status: { $ne: 'closed' } },
      { $or: [{ 'messages.mentions': user._id }, { isUrgent: true }] },
    ],
  })
    .select('number subject isUrgent messages.by messages.at messages.mentions messages.kind createdAt raisedBy')
    .sort({ updatedAt: -1 })
    .limit(60);

  const cursors = new Map(
    (await QueryRead.find({ user: user._id, query: { $in: threads.map((query) => query._id) } }).select('query at').lean())
      .map((read) => [String(read.query), read.at])
  );

  const items = [];
  for (const query of threads) {
    const cursor = cursors.get(String(query._id));
    const last = query.messages?.at(-1)?.at || query.messages?.at(-1)?.createdAt || query.createdAt;
    const tagged = taggedUnreadFor(query, cursor, user._id);
    if (tagged) {
      items.push({
        id: `tag-${query._id}`, kind: 'tag', at: last, link: `/queries/${query._id}`,
        title: `You were tagged in ${query.number}`, detail: query.subject,
      });
    } else if (query.isUrgent && unreadFor(query, cursor, user._id)) {
      items.push({
        id: `urgent-${query._id}`, kind: 'urgent', at: last, link: `/queries/${query._id}`,
        title: `Urgent: ${query.number} has something new`, detail: query.subject,
      });
    }
  }
  return items;
}

async function approvalItems(user) {
  if (!seesCosting(user)) return [];
  const sheets = await Pricing.find({ 'lines.status': 'approval_pending' })
    .select('number customer lines.status lines.modelNumber updatedAt')
    .populate('customer', 'name')
    .sort({ updatedAt: -1 })
    .limit(20);
  return sheets.map((sheet) => {
    const waiting = sheet.lines.filter((line) => line.status === 'approval_pending');
    return {
      id: `approval-${sheet._id}`, kind: 'approval', at: sheet.updatedAt, link: `/pricings/${sheet._id}`,
      title: `${sheet.number} needs your signature`,
      detail: `${sheet.customer?.name || 'A buyer'} · ${waiting.map((line) => line.modelNumber).filter(Boolean).join(', ') || `${waiting.length} model${waiting.length === 1 ? '' : 's'}`} under the floor`,
    };
  });
}

async function sampleItems(user) {
  if (!canRead(user, 'samples')) return [];
  const samples = await Sample.find({
    requestedBy: user._id,
    status: { $in: ['approved', 'modification_required', 'rejected'] },
    feedbackAt: { $gte: new Date(Date.now() - WEEK) },
  })
    .select('number status feedbackAt feedbackNote customer')
    .populate('customer', 'name')
    .sort({ feedbackAt: -1 })
    .limit(10);
  const said = { approved: 'approved', modification_required: 'asked for a change on', rejected: 'rejected' };
  return samples.map((sample) => ({
    id: `sample-${sample._id}`, kind: 'sample', at: sample.feedbackAt, link: `/samples/${sample._id}`,
    title: `${sample.customer?.name || 'The customer'} ${said[sample.status]} ${sample.number}`,
    detail: sample.feedbackNote || undefined,
  }));
}

async function taskItems(user) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tasks = await Todo.find({ user: user._id, completed: false, dueDate: { $lt: today } })
    .select('title dueDate link')
    .sort({ dueDate: 1 })
    .limit(10);
  return tasks.map((task) => ({
    id: `task-${task._id}`, kind: 'task', at: task.dueDate, link: task.link || '/today', taskId: task._id,
    title: `Overdue: ${task.title}`,
  }));
}

export const inbox = asyncHandler(async (req, res) => {
  const parts = await Promise.all([
    queryItems(req.user), approvalItems(req.user), sampleItems(req.user), taskItems(req.user),
  ]);
  const items = parts.flat().sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, MOST);
  res.json({ success: true, data: { items, count: items.length } });
});
