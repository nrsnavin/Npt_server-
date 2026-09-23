import { messageText } from '../models/Query.js';

/**
 * A thread's gist, without a model.
 *
 * The fallback the summary falls back *to*, and worth having on its own: an `ANTHROPIC_API_KEY`
 * is optional in this deployment, so for most of the plant's life this is what runs.
 *
 * It does not write prose, because it cannot write prose honestly. It picks: the question, the
 * most recent reply, and a count of what else is in there. Every word it shows was typed by a
 * person, which is a different and lesser promise than a summary — and the screen labels the two
 * differently rather than pretending they are the same thing.
 */

/** A sentence's worth, cut on a word so it does not end mid-syllable. */
const clip = (text, room) => {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= room) return clean;
  const cut = clean.slice(0, room);
  return `${cut.slice(0, cut.lastIndexOf(' ') || room)}…`;
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * What the thread says, in its own words.
 *
 * `outstanding` is the honest half: the difference between a thread with three notes and no
 * reply and one that has been answered is the only thing a reader scanning a list actually
 * needs, and it is knowable without a model.
 */
export function gistByRules(query) {
  const messages = query?.messages || [];
  const replies = messages.filter((message) => message.kind === 'reply');
  const notes = messages.filter((message) => message.kind === 'note');
  const latest = replies[replies.length - 1];

  const parts = [];
  parts.push(`Asked: ${clip(query?.question, 180)}`);

  if (latest) {
    const who = latest.by?.name ? `${latest.by.name} replied` : 'Replied';
    parts.push(`${who}: ${clip(messageText(latest), 180)}`);
  } else {
    parts.push('Nobody has replied yet.');
  }

  const rest = [];
  if (replies.length > 1) rest.push(plural(replies.length - 1, 'earlier reply', 'earlier replies'));
  if (notes.length) rest.push(plural(notes.length, 'note', 'notes'));
  if (rest.length) parts.push(`Also: ${rest.join(' and ')}.`);

  return {
    summary: parts.join(' '),
    /* Said plainly so the screen never has to guess which kind of thing it is holding. */
    writtenBy: 'rules',
    outstanding: query?.status === 'closed' ? false : !replies.length,
  };
}
