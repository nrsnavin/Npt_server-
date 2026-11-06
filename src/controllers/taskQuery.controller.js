import Todo from '../models/Todo.js';
import Enquiry from '../models/Enquiry.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { transactional } from '../utils/transaction.js';
import { isManagement } from '../utils/departments.js';
import {
  QUERY_POPULATE, askOnEnquiry, askOnTask, closeTaskQuery, markQuerySeen, mayAnswer, mayReadEnquiry, mayReadTaskQueries,
  mayReplyOnTask, onAskingSide, queriesOnEnquiry, queriesOnTask, queryBoard, readableTaskQuery, replyOnTask, replyToQuery,
} from '../services/taskQuery.service.js';

/**
 * Queries on tasks and enquiries [services/taskQuery.service.js]: asked by the team working the
 * work, answered by whoever raised it. Each row says what this person may do with it, so the
 * screen offers only that.
 */

const withRights = async (queries, user) => Promise.all(queries.map(async (query) => ({
  ...query.toJSON(),
  mayAnswer: query.status !== 'closed' && (await mayAnswer(query, user)),
  mayFollowUp: query.status !== 'closed' && onAskingSide(query, user),
  mayClose: query.status !== 'closed' && (onAskingSide(query, user) || isManagement(user)),
})));

async function taskFor(req) {
  const task = await Todo.findById(req.params.id);
  if (!task) throw ApiError.notFound('Task not found');
  return task;
}

async function enquiryFor(req) {
  const enquiry = await Enquiry.findById(req.params.id).select('number assignedTo customer createdBy');
  if (!enquiry) throw ApiError.notFound('Enquiry not found');
  return enquiry;
}

export const listTaskQueries = asyncHandler(async (req, res) => {
  const task = await taskFor(req);
  if (!(await mayReadTaskQueries(task, req.user))) throw ApiError.notFound('Task not found');
  const { mayWorkOnHandoff } = await import('../services/handoff.service.js');
  res.json({
    success: true,
    data: await withRights(await queriesOnTask(task._id), req.user),
    mayAsk: !task.completed && mayWorkOnHandoff(req.user, task),
    /* Admin and the buyer's marketing person reply to the team from the task itself. */
    mayReply: !task.completed && (await mayReplyOnTask(task, req.user)),
  });
});

/** Admin's or marketing's reply on the task — the answer to its open question, or a reply to the team. */
export const replyOnOneTask = asyncHandler(transactional(async (req, res) => {
  const task = await taskFor(req);
  if (!(await mayReadTaskQueries(task, req.user))) throw ApiError.notFound('Task not found');
  res.json({ success: true, data: await replyOnTask(task, req.user, { body: req.body.body }) });
}));

export const askTaskQuery = asyncHandler(transactional(async (req, res) => {
  const query = await askOnTask(await taskFor(req), req.user, { question: req.body.question, subject: req.body.subject });
  await query.populate(QUERY_POPULATE);
  res.status(201).json({ success: true, data: (await withRights([query], req.user))[0] });
}));

export const listEnquiryQueries = asyncHandler(async (req, res) => {
  const enquiry = await enquiryFor(req);
  if (!(await mayReadEnquiry(enquiry, req.user))) throw ApiError.notFound('Enquiry not found');
  res.json({ success: true, data: await withRights(await queriesOnEnquiry(enquiry._id), req.user), mayAsk: true });
});

export const askEnquiryQuery = asyncHandler(transactional(async (req, res) => {
  const query = await askOnEnquiry(await enquiryFor(req), req.user, { question: req.body.question, subject: req.body.subject });
  await query.populate(QUERY_POPULATE);
  res.status(201).json({ success: true, data: (await withRights([query], req.user))[0] });
}));

export const taskQueryBoard = asyncHandler(async (req, res) => {
  const { forMe, asked, everyOpen } = await queryBoard(req.user, { show: req.query.show, subject: typeof req.query.subject === 'string' ? req.query.subject.slice(0, 60) : '' });
  res.json({
    success: true,
    data: {
      forMe: await withRights(forMe, req.user),
      asked: await withRights(asked, req.user),
      everyOpen: await withRights(everyOpen, req.user),
    },
  });
});

const answerWith = async (res, query, user) => {
  await query.populate(QUERY_POPULATE);
  res.json({ success: true, data: (await withRights([query], user))[0] });
};

export const replyTaskQuery = asyncHandler(transactional(async (req, res) => {
  const query = await replyToQuery(await readableTaskQuery(req.params.id, req.user), req.user, { body: req.body.body });
  await answerWith(res, query, req.user);
}));

export const closeOneTaskQuery = asyncHandler(transactional(async (req, res) => {
  const query = await closeTaskQuery(await readableTaskQuery(req.params.id, req.user), req.user, { reason: req.body?.reason });
  await answerWith(res, query, req.user);
}));

export const seeTaskQuery = asyncHandler(async (req, res) => {
  const query = await markQuerySeen(await readableTaskQuery(req.params.id, req.user), req.user);
  await answerWith(res, query, req.user);
});
