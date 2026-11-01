import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { inTransaction } from '../utils/transaction.js';
import { retryOnConflict } from '../utils/concurrency.js';
import {
  checkIn, checkOut, dayAction, dayFor, dayIST, editTimes, editVisit, fieldPerms, lateVisit, loadVisit, myDay, ping, planVisit, readableVisit, settleVisit, teamDay, visitView, visitsOfTask,
} from '../services/fieldVisit.service.js';

/**
 * Field visits [services/fieldVisit.service.js]. The screens are for anyone with a mark; the
 * actions check the mark themselves. A check-in and a check-out write the visit, the day and the
 * task together, so each runs in one transaction, tried again if another write got there first.
 */
const dateOf = (req) => (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : dayIST());
const guarded = (work) => asyncHandler(async (req, res) => retryOnConflict(() => inTransaction(() => work(req, res), { label: 'field visit' })));

export const me = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await myDay(req.user, dateOf(req)) });
});

export const day = asyncHandler(async (req, res) => {
  const userId = String(req.query.user || req.user._id);
  res.json({ success: true, data: await dayFor(req.user, userId, dateOf(req)) });
});

export const team = asyncHandler(async (req, res) => {
  const marks = fieldPerms(req.user);
  if (!marks.mayAssign && req.user.role !== 'admin') throw ApiError.forbidden('Field today is for Admin and the people who plan visits for others');
  res.json({ success: true, data: await teamDay(req.user, dateOf(req)) });
});

export const act = guarded(async (req, res) => {
  const record = await dayAction(req.user, req.body.action, { fix: req.body.fix });
  res.json({ success: true, data: record.toObject() });
});

export const plan = guarded(async (req, res) => {
  const visit = await planVisit(req.user, req.body);
  res.status(201).json({ success: true, data: await visitView(visit) });
});

export const one = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await visitView(await readableVisit(req.user, req.params.id)) });
});

export const edit = guarded(async (req, res) => {
  const visit = await editVisit(req.user, await loadVisit(req.params.id), req.body);
  res.json({ success: true, data: await visitView(visit) });
});

export const settle = guarded(async (req, res) => {
  const visit = await settleVisit(req.user, await loadVisit(req.params.id), req.body);
  res.json({ success: true, data: await visitView(visit) });
});

export const arrive = guarded(async (req, res) => {
  const visit = await checkIn(req.user, await loadVisit(req.params.id), { fix: req.body.fix, reason: req.body.reason, device: req.body.device || req.headers['user-agent'] }, { fetchImpl: req.app.get('imageryFetch') });
  res.json({ success: true, data: await visitView(visit) });
});

export const stay = asyncHandler(async (req, res) => {
  const answer = await retryOnConflict(async () => ping(req.user, await loadVisit(req.params.id), req.body));
  res.json({ success: true, data: answer });
});

export const leave = guarded(async (req, res) => {
  const visit = await checkOut(req.user, await loadVisit(req.params.id), req.body, { ask: req.app.get('visitNoteAsk') });
  res.json({ success: true, data: await visitView(visit) });
});

export const late = guarded(async (req, res) => {
  const visit = await lateVisit(req.user, req.body, { ask: req.app.get('visitNoteAsk') });
  res.status(201).json({ success: true, data: await visitView(visit) });
});

export const correctTimes = guarded(async (req, res) => {
  const visit = await editTimes(req.user, await loadVisit(req.params.id), req.body);
  res.json({ success: true, data: await visitView(visit) });
});

export const ofTask = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await visitsOfTask(req.params.id) });
});
