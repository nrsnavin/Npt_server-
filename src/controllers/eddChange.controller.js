import Todo from '../models/Todo.js';
import Enquiry from '../models/Enquiry.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { transactional } from '../utils/transaction.js';
import { mayReadEnquiry, mayReadTaskQueries } from '../services/taskQuery.service.js';
import {
  CHANGE_POPULATE, EDD_CHANGE_KINDS, agreeEddChange, changesOnTask, eddTrack, keepEdd, mayAnswerChange, onTeamSide, readableChange,
  replyEddChange, requestEddChange, withdrawEddChange,
} from '../services/eddChange.service.js';

/** EDD change requests [services/eddChange.service.js] — each row says what this person may do with it. */
const withRights = (changes, user) => Promise.all(changes.map(async (change) => {
  const office = change.status === 'open' && (await mayAnswerChange(change, user));
  const team = change.status === 'open' && onTeamSide(change, user);
  return { ...change.toJSON(), mayAgree: office, mayReply: office || team, mayWithdraw: team };
}));

async function taskFor(req) {
  const task = await Todo.findById(req.params.id);
  if (!task || !(await mayReadTaskQueries(task, req.user))) throw ApiError.notFound('Task not found');
  return task;
}

export const listTaskEddChanges = asyncHandler(async (req, res) => {
  const task = await taskFor(req);
  const { mayWorkOnHandoff } = await import('../services/handoff.service.js');
  res.json({
    success: true,
    data: await withRights(await changesOnTask(task), req.user),
    mayAsk: EDD_CHANGE_KINDS.includes(task.kind) && !task.completed && mayWorkOnHandoff(req.user, task),
  });
});

export const askEddChange = asyncHandler(transactional(async (req, res) => {
  const task = await Todo.findById(req.params.id);
  if (!task) throw ApiError.notFound('Task not found');
  const change = await requestEddChange(task, req.user, req.body);
  await change.populate(CHANGE_POPULATE);
  res.status(201).json({ success: true, data: (await withRights([change], req.user))[0] });
}));

/** The enquiry's EDD history and the asks on it — the top of the enquiry page. */
export const enquiryEddTrack = asyncHandler(async (req, res) => {
  const enquiry = await Enquiry.findById(req.params.id).select('number assignedTo customer createdBy edd eddByModel');
  if (!enquiry || !(await mayReadEnquiry(enquiry, req.user))) throw ApiError.notFound('Enquiry not found');
  const track = await eddTrack(enquiry);
  res.json({ success: true, data: { ...track, open: await withRights(track.open, req.user), changes: await withRights(track.changes, req.user) } });
});

const answer = async (res, change, user) => {
  await change.populate(CHANGE_POPULATE);
  res.json({ success: true, data: (await withRights([change], user))[0] });
};

export const replyOnEddChange = asyncHandler(transactional(async (req, res) => {
  await answer(res, await replyEddChange(await readableChange(req.params.id, req.user), req.user, req.body), req.user);
}));
export const agreeOnEddChange = asyncHandler(transactional(async (req, res) => {
  await answer(res, await agreeEddChange(await readableChange(req.params.id, req.user), req.user, req.body), req.user);
}));
export const keepOnEddChange = asyncHandler(transactional(async (req, res) => {
  await answer(res, await keepEdd(await readableChange(req.params.id, req.user), req.user, req.body), req.user);
}));
export const withdrawOnEddChange = asyncHandler(transactional(async (req, res) => {
  await answer(res, await withdrawEddChange(await readableChange(req.params.id, req.user), req.user), req.user);
}));
