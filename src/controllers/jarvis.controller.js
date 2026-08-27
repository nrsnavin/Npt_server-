import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { parse } from '../services/jarvis.intents.js';
import { answer } from '../services/jarvis.service.js';

/**
 * Ask Jarvis — one question, one answer.
 *
 * Stateless on purpose. A thread of context is what makes an assistant feel clever and what
 * makes it wrong in ways nobody can retrace: the third answer depends on the first, and if
 * the first was misread every one after it is confidently off. These questions stand alone —
 * "what is overdue", "where is SMP-2026-0004" — so each is parsed and answered on its own,
 * and the reader can always see the whole basis of what they were told.
 *
 * It is open to everyone rather than gated to administrators, and answers are scoped by the
 * asker's own grants and record ownership. An administrator sees the whole plant because
 * their grants say so, not because the route checks their role — which means the same feature
 * serves the bench asking what is on it and marketing asking what is due, without a second
 * implementation and without a hole where one of them sees the other's book.
 */

/** Long enough for any real question; short enough that the box cannot be used as a pipe. */
const MAX_LENGTH = 500;

export const ask = asyncHandler(async (req, res) => {
  const message = String(req.body?.message ?? '').trim();

  if (!message) throw ApiError.badRequest('Ask me something');
  if (message.length > MAX_LENGTH) {
    throw ApiError.badRequest(`That is longer than I can read — keep it under ${MAX_LENGTH} characters`);
  }

  const parsed = parse(message);
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
       * What it understood, returned rather than hidden. When an answer looks wrong this is
       * the first question anybody asks, and a parser that will not say what it heard is one
       * nobody can debug from the outside.
       */
      understood: { subject: parsed.subject, aspect: parsed.aspect },
    },
  });
});
