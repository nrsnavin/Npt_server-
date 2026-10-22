import Sample from '../models/Sample.js';
import SampleLog from '../models/SampleLog.js';
import Customer from '../models/Customer.js';
import { raiseDepartmentTask, raiseTask } from './task.service.js';

/**
 * A log entry that reads as a problem raises a flag the sweep sees [the sampling audit, item 11].
 * The bench writes "mould issue" or "resin short" in a note beside a photo, which is not a status
 * and used to raise nothing; now the sample wears the flag until its next move, the queue shows
 * it, and whoever asked for the sample hears once.
 */

/** The words that say something is wrong, as the bench writes them. */
export const PROBLEM_WORDS = [
  /\bmould (issue|problem|damage|crack|repair|down)\b/i,
  /\b(resin|material|raw material|hook|clip|print|ink|masterbatch)s? (short|shortage|not available|out of stock|unavailable|missing|not in stock)\b/i,
  /\b(no|out of|short of) (resin|material|raw material|stock|hooks?|clips?)\b/i,
  /\b(machine|press|m\/c) (down|breakdown|not working|fault|issue|problem)\b/i,
  /\b(cracked|broken|snapped|warped|short shot|flash|sink mark|burn mark|black spot|rejected)\b/i,
  /\b(power cut|no power|power failure)\b/i,
  /\b(cannot|can't|unable to) (make|mould|print|do|supply)\b/i,
  /\b(delay|delayed|stuck|held up|waiting for|not possible)\b/i,
];

/** The phrase that reads as a problem, or null. */
export function problemIn(text) {
  const said = String(text || '');
  for (const pattern of PROBLEM_WORDS) {
    const found = said.match(pattern);
    if (found) return found[0];
  }
  return null;
}

/** Sets the flag on the sample from a log entry that reads as one; returns what was found. */
export async function flagProblemFrom(sample, log, user) {
  const found = problemIn(log.body);
  if (!found) return null;
  log.flag = 'problem';
  log.flaggedWords = found;
  await log.save();
  sample.problem = { note: String(log.body).trim().slice(0, 300), words: found, at: new Date(), by: user._id, log: log._id };
  await sample.save();
  return found;
}

/**
 * The sweep: every open flag not yet raised tells whoever asked for the sample and the bench's
 * own queue (the person on it, or the shared queue), once per flag. Not an escalation — the §25
 * sweep stays the only thing that escalates — but a problem that stays in a note is a problem
 * nobody acts on.
 */
export async function runProblemFlags() {
  const flagged = await Sample.find({ 'problem.log': { $ne: null }, 'problem.raisedAt': null, status: { $nin: ['approved', 'rejected', 'cancelled'] } })
    .select('number modelNumber status problem requestedBy assignedTo customer');
  const raised = [];
  for (const sample of flagged) {
    const base = {
      title: `${sample.number}: the bench flagged a problem — ${sample.problem.words}`,
      notes: sample.problem.note,
      priority: 'high',
      link: `/samples/${sample._id}`,
      originKey: `sample:${sample._id}:problem:${sample.problem.log}`,
    };
    const owner = sample.customer ? (await Customer.findById(sample.customer).select('assignedTo').lean())?.assignedTo : null;
    const people = [...new Set([sample.requestedBy, owner].filter(Boolean).map((who) => String(who?._id || who)))];
    const tasks = [];
    for (const person of people) tasks.push(await raiseTask({ user: person, ...base }));
    if (sample.assignedTo) tasks.push(await raiseTask({ user: sample.assignedTo, ...base }));
    else tasks.push(await raiseDepartmentTask({ department: 'sampling', ...base }));
    sample.problem.raisedAt = new Date();
    sample.markModified('problem');
    await sample.save();
    raised.push({ sample: sample.number, words: sample.problem.words, recipients: tasks.filter(Boolean).length });
  }
  return raised;
}

/** The flag comes off with the next move: the bench has answered it, one way or the other. */
export async function clearProblem(sample) {
  if (!sample.problem?.log) return;
  await SampleLog.updateOne({ _id: sample.problem.log }, { $set: { flagClearedAt: new Date() } }).catch(() => null);
  sample.problem = undefined;
}
