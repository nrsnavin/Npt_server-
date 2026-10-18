import FloorMessage from '../models/FloorMessage.js';
import Machine from '../models/Machine.js';
import MouldRun from '../models/MouldRun.js';
import { DOWNTIME_REASONS, REJECT_REASONS, reasonLabel } from '../config/productionReasons.js';
import { inDepartment, isManagement } from '../utils/departments.js';
import { isWhatsAppConfigured, sendWhatsApp } from '../providers/whatsapp.js';

/**
 * Floor readings over WhatsApp: a production colleague texts the plant's number from the press
 * — "IM-2 23400 rej 40 flash", "IM2 down 30 heater" — and the reading becomes a run log once
 * they answer YES. Nothing reaches the run on the first message: a number misread from a
 * thumb-typed text is worse than no number, so the reading is said back and confirmed.
 *
 *   press      the first word that names a press on the register (the hyphen optional)
 *   counter    a bare number, or one after "counter" / "ctr" / "c"
 *   rejects    "rej" / "reject(s)" and a number, then the defect in words
 *   stop       "down" / "stop" / "stopped" and minutes, then the reason in words
 *
 * YES applies the latest reading still waiting (from the last half hour); NO drops it.
 */

const HOLD_MINUTES = 30;

/* Words the floor uses for each reason — the first match wins, so the specific ones lead. */
const REJECT_WORDS = [
  ['short_shot', ['short']], ['sink_mark', ['sink']], ['warpage', ['warp', 'bend', 'bent']],
  ['black_spot', ['black', 'spot', 'contamin', 'dirt']], ['colour_variation', ['colour', 'color', 'shade']],
  ['flow_mark', ['flow', 'silver', 'streak']], ['weld_line', ['weld', 'crack']], ['burn_mark', ['burn']],
  ['hook_defect', ['hook', 'clip']], ['startup', ['start', 'purge']], ['flash', ['flash', 'burr']],
];
const DOWNTIME_WORDS = [
  ['mould_change', ['mould change', 'mold change', 'tool change']], ['colour_change', ['colour change', 'color change', 'material change']],
  ['planned_maintenance', ['service', 'pm', 'planned']], ['heater_band', ['heater', 'temp', 'band']],
  ['mould_problem', ['mould', 'mold', 'stuck', 'ejector', 'cooling']], ['material_wet', ['wet', 'dry', 'moisture']],
  ['material_shortage', ['material', 'resin', 'granule']], ['power_cut', ['power', 'current', 'eb', 'light']],
  ['no_operator', ['operator', 'labour', 'labor', 'man']], ['waiting_qc', ['qc', 'quality']],
  ['hook_clip_shortage', ['hook', 'clip']], ['machine_breakdown', ['breakdown', 'machine', 'hydraulic', 'oil', 'motor']],
];

const reasonFrom = (table, words) => {
  const text = words.join(' ').toLowerCase();
  if (!text) return 'other';
  for (const [key, cues] of table) if (cues.some((cue) => (cue.includes(' ') ? text.includes(cue) : text.split(/\s+/).some((word) => word.startsWith(cue))))) return key;
  return 'other';
};

const squash = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const asNumber = (word) => {
  const clean = String(word || '').replace(/,/g, '');
  return /^\d+(\.\d+)?k?$/i.test(clean) ? Math.round(parseFloat(clean) * (/k$/i.test(clean) ? 1000 : 1)) : null;
};

/**
 * Reads one message against the register's press codes. Returns `{ code, log }` or
 * `{ error }` saying what could not be read. Pure — the register is passed in.
 */
export function parseFloorMessage(body, codes) {
  const words = String(body || '').trim().split(/[\s:;=]+/).filter(Boolean);
  if (!words.length) return { error: 'empty' };
  const byKey = new Map(codes.map((code) => [squash(code), code]));
  let code = null;
  let at = 0;
  for (; at < Math.min(words.length, 3); at += 1) {
    const hit = byKey.get(squash(words[at]));
    if (hit) { code = hit; break; }
    /* "IM 2" written with a space. */
    const joined = words[at + 1] ? byKey.get(squash(words[at] + words[at + 1])) : null;
    if (joined) { code = joined; at += 1; break; }
  }
  if (!code) return { error: 'press' };
  const rest = words.slice(at + 1);
  const log = {};
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index].toLowerCase();
    const next = asNumber(rest[index + 1]);
    if (/^rej(ect(s|ed)?)?$/.test(word) && next != null) {
      const reasonWords = [];
      let look = index + 2;
      while (look < rest.length && asNumber(rest[look]) == null && !/^(rej|reject|rejects|down|stop|stopped|counter|ctr|c|good)$/i.test(rest[look])) reasonWords.push(rest[look++]);
      log.rejects = { pieces: next, reason: reasonFrom(REJECT_WORDS, reasonWords) };
      index = look - 1;
    } else if (/^(down|stop|stopped|stoppage)$/.test(word) && next != null) {
      const reasonWords = [];
      let look = index + 2;
      if (/^(m|min|mins|minutes?)$/i.test(rest[look] || '')) look += 1;
      while (look < rest.length && asNumber(rest[look]) == null && !/^(rej|reject|rejects|down|stop|stopped|counter|ctr|c|good)$/i.test(rest[look])) reasonWords.push(rest[look++]);
      log.downtime = { minutes: next, reason: reasonFrom(DOWNTIME_WORDS, reasonWords) };
      index = look - 1;
    } else if (/^(counter|ctr|c|shots?)$/.test(word) && next != null) {
      log.counter = next;
      index += 1;
    } else if (asNumber(word) != null && log.counter == null) {
      log.counter = asNumber(word);
    }
  }
  if (log.counter == null && !log.rejects && !log.downtime) return { error: 'reading', code };
  return { code, log };
}

/** The reading said back in plain words. */
export function describeLog(log) {
  const parts = [];
  if (log.counter != null) parts.push(`counter ${Number(log.counter).toLocaleString('en-IN')}`);
  if (log.rejects) parts.push(`${Number(log.rejects.pieces).toLocaleString('en-IN')} rejects (${reasonLabel(REJECT_REASONS, log.rejects.reason)})`);
  if (log.downtime) parts.push(`stopped ${log.downtime.minutes} min (${reasonLabel(DOWNTIME_REASONS, log.downtime.reason)})`);
  return parts.join(', ');
}

async function reply(to, body) {
  if (!isWhatsAppConfigured()) {
    console.log(`\n[whatsapp] to ${to}\n${body}\n`);
    return;
  }
  await sendWhatsApp({ to, body }).catch((error) => console.error(`[floor-message] reply to ${to} not sent: ${error.message}`));
}

const HELP = 'Send a reading as: press, counter, then rejects or a stop — e.g. "IM-2 23400 rej 40 flash" or "IM-2 down 30 heater". Reply YES to log it, NO to drop it.';

/**
 * A text from a staff phone that may be a floor reading or an answer to one. Returns null when
 * it is neither (it then goes on to the inbox as before), or the outcome.
 */
export async function handleFloorMessage({ staff, from, body, providerId }) {
  if (!staff || !(inDepartment(staff, 'production') || isManagement(staff))) return null;
  const text = String(body || '').trim();
  if (!text) return null;
  if (providerId && await FloorMessage.exists({ providerId })) return { outcome: 'duplicate' };

  const answer = text.toLowerCase().replace(/[^a-z]/g, '');
  if (['yes', 'y', 'ok', 'haan', 'ha', 'no', 'n', 'cancel'].includes(answer)) {
    const since = new Date(Date.now() - HOLD_MINUTES * 60000);
    const pending = await FloorMessage.findOne({ sender: staff._id, status: 'pending', createdAt: { $gte: since } }).sort({ createdAt: -1 });
    if (!pending) return null;
    if (['no', 'n', 'cancel'].includes(answer)) {
      pending.status = 'cancelled';
      pending.decidedAt = new Date();
      await pending.save();
      await reply(from, `Dropped — nothing logged on ${pending.summary?.split(' · ')[0] || 'the run'}.`);
      return { outcome: 'floor_cancelled', message: pending._id };
    }
    return applyFloorMessage(pending, staff, from);
  }

  const codes = (await Machine.find({ active: { $ne: false } }).select('code').lean()).map((machine) => machine.code);
  const read = parseFloorMessage(text, codes);
  /* Not naming a press is not a floor reading — let the inbox have it. */
  if (read.error === 'press' || read.error === 'empty') return null;
  if (read.error === 'reading') {
    await reply(from, `${read.code}: no counter, rejects or stop read in that. ${HELP}`);
    return { outcome: 'floor_unread' };
  }
  const machine = await Machine.findOne({ code: read.code }).select('code').lean();
  const run = await MouldRun.findOne({ machine: machine._id, status: 'running' }).select('number mould').populate('mould', 'mouldCode').lean();
  if (!run) {
    await reply(from, `${read.code} has no running job in the app — start the run first, then send the reading.`);
    return { outcome: 'floor_no_run' };
  }
  /* A newer reading replaces one still waiting from the same person. */
  await FloorMessage.updateMany({ sender: staff._id, status: 'pending' }, { $set: { status: 'expired', decidedAt: new Date() } });
  const summary = `${read.code} · ${run.number}${run.mould?.mouldCode ? ` (${run.mould.mouldCode})` : ''}: ${describeLog(read.log)}`;
  const message = await FloorMessage.create({
    from, sender: staff._id, providerId, body: text.slice(0, 1000), machine: machine._id, run: run._id, log: read.log, summary,
  }).catch((error) => (error.code === 11000 ? null : Promise.reject(error)));
  if (!message) return { outcome: 'duplicate' };
  await reply(from, `${summary}\nReply YES to log it, NO to drop it.`);
  return { outcome: 'floor_pending', message: message._id };
}

/** YES: the held reading onto its run, through the same rules as the app's own log. */
export async function applyFloorMessage(pending, staff, from) {
  const { logRun } = await import('./records.service.js');
  const run = await MouldRun.findById(pending.run);
  try {
    if (!run) throw new Error('The run is no longer there');
    const log = pending.log?.toObject ? pending.log.toObject() : pending.log || {};
    const body = {
      ...(log.counter != null ? { counter: log.counter } : {}),
      ...(log.rejects?.pieces != null ? { rejects: { pieces: log.rejects.pieces, reason: log.rejects.reason } } : {}),
      ...(log.downtime?.minutes != null ? { downtime: { minutes: log.downtime.minutes, reason: log.downtime.reason, note: 'Sent over WhatsApp' } } : {}),
    };
    await logRun(run, body, staff);
    pending.status = 'applied';
    pending.decidedAt = new Date();
    await pending.save();
    await reply(from, `Logged — ${pending.summary}`);
    return { outcome: 'floor_applied', message: pending._id };
  } catch (error) {
    pending.status = 'failed';
    pending.error = String(error.message || error).slice(0, 300);
    pending.decidedAt = new Date();
    await pending.save();
    await reply(from, `Not logged — ${pending.error}`);
    return { outcome: 'floor_failed', why: pending.error, message: pending._id };
  }
}

/** Readings sent over WhatsApp lately, for the floor screen. */
export async function recentFloorMessages({ limit = 30 } = {}) {
  return FloorMessage.find({}).sort({ createdAt: -1 }).limit(Math.min(100, limit))
    .populate([{ path: 'sender', select: 'name' }, { path: 'machine', select: 'code' }, { path: 'run', select: 'number' }])
    .lean();
}
