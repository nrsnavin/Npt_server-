import Enquiry, { LOST_REASONS } from '../models/Enquiry.js';
import ApiError from '../utils/ApiError.js';
import { isManagement } from '../utils/departments.js';
import { CLOSED_STAGE } from '../config/enquiryStages.js';
import { CLOSE_OUTCOMES, findCloseOutcome } from '../config/enquiryClosure.js';

/**
 * Admin closes an enquiry and records how it ended [config/enquiryClosure.js] — for the enquiry
 * that was finished in the plant while nobody kept its statuses up: it was dispatched, the order
 * was completed, it is in production, or it was cancelled, before or after a quotation.
 *
 * Closing is the same Task Closed as the button [handoff.service `sendHandoff`]: its open tasks
 * close with it, a money case stays open until the money is in, the bench's samples stop. On top
 * of that the outcome is kept on the enquiry (`closure`) and the sales status says it — Won for
 * an order taken, Lost with its reason for a cancellation. An enquiry already closed takes the
 * outcome too, so one closed with only a reason can still be said properly.
 */

const fail = (message) => { throw ApiError.badRequest(message); };
const todayIST = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const prettyDay = (day) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${day}T00:00:00.000+05:30`));

/** The outcomes, for the form. */
export const closeOutcomes = () => ({ outcomes: CLOSE_OUTCOMES, lostReasons: LOST_REASONS });

export async function closeEnquiryWithOutcome(enquiry, user, { outcome, date, reference, lostReason, note }) {
  if (!isManagement(user)) throw ApiError.forbidden('Only Admin closes an enquiry with its outcome');
  const rule = findCloseOutcome(outcome);
  if (!rule) fail('Choose how the enquiry ended');
  const said = String(note || '').trim();
  if (rule.noteRequired && said.length < 5) fail('Say what happened — a few words at least');
  const day = String(date || '').trim() || undefined;
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) fail('Give the date as a day');
  if (day && day > todayIST()) fail('That date has not come yet — record what has already happened');
  const ref = String(reference || '').trim() || undefined;
  const reason = rule.status === 'lost' ? (lostReason || rule.defaultLostReason) : undefined;
  if (reason && !LOST_REASONS.includes(reason)) fail('Choose the reason from the list');

  const line = `${rule.label}${day ? ` on ${prettyDay(day)}` : ''}${ref ? ` (${ref})` : ''}${said ? ` — ${said}` : ''}`;
  const wasClosed = enquiry.stage === CLOSED_STAGE;
  if (!wasClosed) {
    const { sendHandoff } = await import('./handoff.service.js');
    await sendHandoff({ enquiry, kind: 'task_closed', note: `Closed by Admin: ${line}`, user });
  }

  const now = new Date();
  const from = enquiry.status;
  const set = { closure: { outcome: rule.key, label: rule.label, date: day, reference: ref, note: said || undefined, by: user._id, at: now } };
  const unset = {};
  const push = {};
  if (rule.status && rule.status !== from) {
    set.status = rule.status;
    push.statusHistory = { from, to: rule.status, at: now, by: user._id, note: `Closed by Admin: ${line}` };
  }
  if (rule.status === 'lost') {
    set.lostReason = reason;
    set.lostNote = said || rule.label;
  } else if (rule.status === 'won') {
    unset.lostReason = 1;
    unset.lostNote = 1;
  }
  /* Marketing's word follows what happened: Dispatch, Production, or Task Closed. */
  const fresh = await Enquiry.findById(enquiry._id).select('marketingStatus').lean();
  if (rule.marketing && fresh?.marketingStatus !== rule.marketing) {
    set.marketingStatus = rule.marketing;
    push.marketingStatusHistory = { from: fresh?.marketingStatus || null, to: rule.marketing, at: now, by: user._id, note: `Closed by Admin: ${line}` };
  }
  /* Already closed: the outcome is said on its history, since no Task Closed was written now. */
  if (wasClosed) push.stageHistory = { from: CLOSED_STAGE, to: CLOSED_STAGE, at: now, by: user._id, note: `Outcome recorded by Admin: ${line}` };
  await Enquiry.updateOne(
    { _id: enquiry._id },
    { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}), ...(Object.keys(push).length ? { $push: push } : {}) },
    { timestamps: false, keepVersion: true },
  );
  return Enquiry.findById(enquiry._id).populate('closure.by', 'name');
}
