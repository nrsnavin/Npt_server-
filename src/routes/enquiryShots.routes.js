import { Router } from 'express';
import Todo from '../models/Todo.js';
import Enquiry from '../models/Enquiry.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { authenticate } from '../middleware/auth.js';
import { mayReadTaskQueries } from '../services/taskQuery.service.js';
import { forwardShotsTo, mayViewEnquiryShots, shotsOf, sourceCardOf } from '../services/enquiryShots.service.js';
import { sendCardImage } from '../controllers/buyerCard.controller.js';

/**
 * The enquiry's screenshots on a task [services/enquiryShots.service.js]: shown on the task's card
 * once forwarded to it, and forwarded later from the card by the enquiry's marketing person or
 * Admin when the form that raised the task did not. Signed in on each route — mounted at /api.
 */
const router = Router();

async function taskFor(req) {
  const task = await Todo.findById(req.params.id);
  if (!task || !(await mayReadTaskQueries(task, req.user))) throw ApiError.notFound('Task not found');
  return task;
}

const enquiryOf = (task) => (task.enquiry ? Enquiry.findById(task.enquiry).select('assignedTo customer') : null);

router.get('/workspace/todos/:id/screenshots', authenticate, asyncHandler(async (req, res) => {
  const task = await taskFor(req);
  const card = task.enquiry ? await sourceCardOf(task.enquiry) : null;
  if (!card) return res.json({ success: true, data: { forwarded: false, shots: null, mayForward: false } });
  const enquiry = await enquiryOf(task);
  const owner = Boolean(enquiry) && (await mayViewEnquiryShots(req.user, enquiry));
  return res.json({
    success: true,
    data: {
      forwarded: Boolean(task.shotsForwarded),
      shots: task.shotsForwarded || owner ? shotsOf(card) : null,
      mayForward: !task.shotsForwarded && !task.completed && owner,
    },
  });
}));

router.get('/workspace/todos/:id/screenshots/image', authenticate, asyncHandler(async (req, res) => {
  const task = await taskFor(req);
  if (!task.shotsForwarded) {
    const enquiry = await enquiryOf(task);
    if (!enquiry || !(await mayViewEnquiryShots(req.user, enquiry))) throw ApiError.notFound('The screenshots were not forwarded to this task');
  }
  sendCardImage(res, task.enquiry ? await sourceCardOf(task.enquiry) : null, req.query.n);
}));

router.post('/workspace/todos/:id/screenshots/forward', authenticate, asyncHandler(async (req, res) => {
  const task = await taskFor(req);
  const enquiry = await enquiryOf(task);
  if (!enquiry || !(await mayViewEnquiryShots(req.user, enquiry))) throw ApiError.forbidden('Only the enquiry\'s marketing person or an Admin forwards its screenshots');
  if (!(await forwardShotsTo(task))) throw ApiError.badRequest('This enquiry was not made from a screenshot');
  res.json({ success: true, data: { forwarded: true, shots: shotsOf(await sourceCardOf(task.enquiry)), mayForward: false } });
}));

export default router;
