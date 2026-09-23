/**
 * How urgent a thread is *for the person reading it* — from the record, without a model.
 *
 * **The reader is half the question, and that is the whole reason this exists per person rather
 * than per thread.** A query about a disputed invoice is not equally pressing to everybody in
 * it: to the colleague who asked, it is something they are waiting on; to the department that
 * has not answered in two days, it is something they owe. A single urgency on the record would
 * have to pick one of those readings and be wrong for the other, so nothing is stored and this
 * is computed against whoever is looking.
 *
 * These are the rules, and they are deliberately the ones anybody in the plant would give:
 *
 *   You owe an answer and nobody has given one      the longer it has sat, the louder
 *   You asked and nobody has answered               yours to chase, not yours to do
 *   Somebody answered, and you asked                yours to read and settle
 *   Closed                                          nothing is owed by anyone
 *
 * The model refines this — see `queryUrgency.llm.js` — but never replaces it: the rules answer
 * with no key, on a timeout, and instantly, which is what the list draws with while the model
 * is still reading. A screen that waits for a model before it can colour a row is a screen that
 * looks broken for eight seconds.
 */

import { plural } from '../utils/phrases.js';

/** The same three words the rest of the app uses for priority [Todo.js]. */
export const URGENCIES = ['low', 'normal', 'high'];

/** How long it has sat, said the way somebody would say it rather than as "1 hour(s)". */
const waited = (hours) =>
  (hours >= 24 ? plural(Math.floor(hours / 24), 'day', 'days') : plural(hours, 'hour', 'hours'));

/** Hours a thread has been sitting, from whenever it last moved. */
const waitingHours = (query) => {
  const last = query.messages?.length
    ? new Date(query.messages[query.messages.length - 1].at)
    : new Date(query.createdAt);
  return Math.max(0, Math.floor((Date.now() - last.getTime()) / 3600000));
};

/** Whether this person is one of the people who owe an answer, rather than the one who asked. */
const owes = (query, user) => {
  if (String(query.raisedBy?._id ?? query.raisedBy) === String(user._id)) return false;

  return (query.participants || []).some((participant) => {
    if (participant.user) {
      return String(participant.user?._id ?? participant.user) === String(user._id);
    }
    return participant.department === user.department;
  });
};

/**
 * One thread, as it stands for one reader.
 *
 * Returns the level and the sentence behind it, because a chip nobody can account for is a chip
 * people learn to ignore. The sentence is built from the record — hours, replies, who asked —
 * so it is checkable against the thread underneath it.
 */
export function urgencyByRules(query, user) {
  const hours = waitingHours(query);
  const answered = (query.messages || []).some((message) => message.kind === 'reply');
  /*
   * Whether the reader is one of the people who owe an answer, carried out on the reading
   * itself rather than left to be inferred from the sentence. The model's prompt needs this
   * fact, and reading it back out of the English — `why.startsWith('Asked of you')` — made the
   * wording load-bearing: rephrasing a sentence for a plural would quietly have told the model
   * that nobody owed anything.
   */
  const owed = owes(query, user);
  const reading = (level, why) => ({ level, why, readBy: 'rules', hours, owed });

  if (query.status === 'closed') return reading('low', 'Closed — nothing is owed on it');

  if (owed) {
    if (!answered) {
      if (hours >= 24) {
        return reading('high', `Asked of you ${waited(hours)} ago and nobody has answered`);
      }
      return reading(
        hours >= 4 ? 'high' : 'normal',
        hours < 1
          ? 'Asked of you just now, and nobody has answered'
          : `Asked of you ${waited(hours)} ago and nobody has answered`
      );
    }

    /* Somebody has answered and it is still open, so it is the asker's move rather than yours. */
    return reading('low', 'Answered — waiting on whoever asked');
  }

  /* The asker's side of the same thread. */
  if (!answered) {
    return reading(
      hours >= 24 ? 'high' : 'normal',
      hours >= 24
        ? `You asked ${waited(hours)} ago and nobody has answered — worth chasing`
        : 'You asked and nobody has answered yet'
    );
  }

  return reading('normal', 'Answered — read it and close it if that settles it');
}
