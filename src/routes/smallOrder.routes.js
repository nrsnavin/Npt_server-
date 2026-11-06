import { Router } from 'express';
import { z } from 'zod';
import Todo from '../models/Todo.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { transactional } from '../utils/transaction.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { checkStock } from '../services/smallOrder.service.js';

/**
 * A small order's stock check [services/smallOrder.service.js]: Dispatch says, per model, how many
 * are in the godown — what is there goes to Dispatch, the rest to Production. Mounted at the root
 * of /api, so signed in on the route.
 */
const stockCheckSchema = z.object({
  lines: z.array(z.object({
    model: z.string().trim().min(1).max(120),
    available: z.union([z.number().min(0), z.string().trim().max(12)]),
  })).min(1, 'Say what is in stock for each model').max(40),
  note: z.string().trim().max(1000).optional(),
});

const router = Router();

router.post('/workspace/todos/:id/stock-check', authenticate, validate(stockCheckSchema), asyncHandler(transactional(async (req, res) => {
  const task = await Todo.findById(req.params.id);
  if (!task) throw ApiError.notFound('Task not found');
  const { task: done, dispatch, production, rows } = await checkStock(task, req.user, req.body);
  res.json({
    success: true,
    data: done,
    meta: { rows, dispatch: dispatch ? { _id: dispatch._id, title: dispatch.title } : null, production: production ? { _id: production._id, title: production.title } : null },
  });
})));

export default router;
