import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { parse, llmConfigured } from '../services/jarvis.llm.js';
import { answer } from '../services/jarvis.service.js';

/**
 * Ask Jarvis — one question, one answer.
 *
 * **Administrators only**, enforced on the route. The record-level scoping inside the answers
 * is kept all the same, and deliberately: an administrator bypasses ownership anyway, so
 * today it changes nothing, but the day this opens to marketing or the bench it is already
 * correct. A permission model retro-fitted to a feature that has been running without one is
 * how a colleague's book ends up in somebody else's answer.
 *
 * Stateless on purpose. A thread of context is what makes an assistant feel clever and what
 * makes it wrong in ways nobody can retrace: the third answer depends on the first, and if the
 * first was misread every one after it is confidently off. These questions stand alone —
 * "what is overdue", "where is SMP-2026-0004" — so each is parsed and answered on its own,
 * and the reader can see the whole basis of what they were told.
 */

/** Long enough for any real question; short enough that the box cannot be used as a pipe. */
const MAX_LENGTH = 500;

export const ask = asyncHandler(async (req, res) => {
  const message = String(req.body?.message ?? '').trim();

  if (!message) throw ApiError.badRequest('Ask me something');
  if (message.length > MAX_LENGTH) {
    throw ApiError.badRequest(`That is longer than I can read — keep it under ${MAX_LENGTH} characters`);
  }

  const parsed = await parse(message);
  const result = await answer(req.user, parsed);

  res.json({
    success: true,
    data: {
      question: message,
      answer: result.answer,
      rows: result.rows || [],
      // The whole count, where the rows are a sample of it — a list that stops at eight
      // without saying so is the screen disagreeing with the business.
      total: result.total ?? (result.rows || []).length,
      /*
       * What it understood, returned rather than hidden, and which parser understood it.
       * When an answer looks wrong this is the first question anybody asks, and the second is
       * whether the model or the fallback read it — a parser that will not say either is one
       * nobody can debug from the outside.
       */
      understood: { subject: parsed.subject, aspect: parsed.aspect, readBy: parsed.readBy || 'rules' },
    },
  });
});

/** Whether the model is wired up, for the panel to say so rather than leave it a mystery. */
export const status = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: { model: llmConfigured() } });
});
