import Machine from '../models/Machine.js';
import MouldRun from '../models/MouldRun.js';
import WorkOrder from '../models/WorkOrder.js';
import MaintenanceRecord from '../models/MaintenanceRecord.js';
import ApiError from '../utils/ApiError.js';
import { nextNumber } from './numbering.service.js';
import { membersOf } from './taskAlert.service.js';
import { sendPush } from './push.service.js';
import { raiseTask, resolveTasks } from './task.service.js';
import { indiaDay } from '../utils/indiaDays.js';
import { DOWNTIME_REASONS, REJECT_REASONS, reasonLabel } from '../config/productionReasons.js';

/**
 * The shop floor: the andon call when a press stops, and the summary one shift hands to the next.
 */

/* ------------------------------------------------------------------- andon --- */

const andonKey = (machineId) => `andon:${machineId}`;

/**
 * The floor calls a breakdown on a press: the press shows broken down, the production team and
 * Admin get a push at once, and a high-priority task sits on Production's queue until the press
 * is running again.
 */
export async function raiseAndon(machineId, user, { reason, note }) {
  const machine = await Machine.findById(machineId);
  if (!machine) throw ApiError.notFound('Machine not found');
  if (machine.andon?.open) throw ApiError.conflict(`${machine.code} is already called in — ${machine.andon.reason || 'breakdown'}`);
  const said = reasonLabel(DOWNTIME_REASONS, reason) || 'Breakdown';
  machine.andon = { open: true, reason, note, at: new Date(), by: user._id };
  machine.status = 'breakdown';
  await machine.save();
  const running = await MouldRun.findOne({ machine: machine._id, status: 'running' }).select('number mould').populate('mould', 'mouldCode').lean();
  const title = `${machine.code} stopped — ${said}`;
  const body = `${note ? `${note} · ` : ''}${running ? `${running.number} (${running.mould?.mouldCode}) is on it · ` : ''}called by ${user.name}`;
  const team = await membersOf('production');
  const admins = await (await import('../models/User.js')).default.find({ role: 'admin', isActive: { $ne: false } }).select('_id').lean();
  await sendPush([...team.map((person) => person._id), ...admins.map((person) => person._id)].filter((id) => String(id) !== String(user._id)), { title, body, link: `/machines/${machine._id}`, kind: 'andon' }).catch(() => null);
  const head = team[0];
  if (head) {
    await raiseTask({
      user: head._id, department: 'production', title, notes: body, priority: 'high', dueDate: new Date(),
      link: `/machines/${machine._id}`, originKey: andonKey(machine._id),
    }).catch(() => null);
  }
  return machine;
}

/**
 * The press is running again: the call closes, the minutes it was down go on the job that was
 * running as a coded stop, a breakdown maintenance record is written with what was done, and
 * the task on Production's queue is closed.
 */
export async function clearAndon(machineId, user, { workDone, note }) {
  const machine = await Machine.findById(machineId);
  if (!machine) throw ApiError.notFound('Machine not found');
  if (!machine.andon?.open) throw ApiError.conflict(`${machine.code} has no open call`);
  const since = machine.andon.at || new Date();
  const minutes = Math.max(1, Math.round((Date.now() - new Date(since)) / 60000));
  const reason = machine.andon.reason || 'machine_breakdown';
  const running = await MouldRun.findOne({ machine: machine._id, status: 'running' });
  if (running) {
    running.downtime = [...(running.downtime || []), { reason, minutes, note: note || machine.andon.note, at: new Date(), by: user._id }];
    running.downtimeMinutes = running.downtime.reduce((sum, entry) => sum + (entry.minutes || 0), 0);
    await running.save();
  }
  await MaintenanceRecord.create([{
    number: await nextNumber('MNT'), asset: 'machine', machine: machine._id, type: 'breakdown', doneOn: new Date(),
    problem: [reasonLabel(DOWNTIME_REASONS, reason), machine.andon.note].filter(Boolean).join(' — '),
    workDone: String(workDone || '').trim() || 'Back running', downtimeHours: Math.round((minutes / 60) * 100) / 100, recordedBy: user._id,
  }]);
  machine.andon = { open: false };
  machine.status = running ? 'running' : 'idle';
  await machine.save();
  await resolveTasks(andonKey(machine._id)).catch(() => null);
  return { machine, minutes, run: running?.number || null };
}

/* ---------------------------------------------------------- shift handover --- */

/**
 * What a shift leaves the next: per press, the runs worked, good and rejected pieces, minutes
 * stopped by reason and the problems written down; the presses still called in; and what each
 * running job still has to make. For a day (India time) and a shift, or the whole day.
 */
export async function shiftSummary({ day = indiaDay(), shift } = {}) {
  const start = new Date(`${day}T00:00:00.000+05:30`);
  const end = new Date(`${day}T23:59:59.999+05:30`);
  const filter = { startedAt: { $lte: end }, $or: [{ endedAt: { $gte: start } }, { status: 'running' }] };
  if (shift) filter.shift = shift;
  const runs = await MouldRun.find(filter)
    .populate([{ path: 'machine', select: 'code' }, { path: 'mould', select: 'mouldCode' }, { path: 'customer', select: 'name' }, { path: 'workOrder', select: 'number quantity goodQty' }])
    .sort({ startedAt: 1 }).lean();
  const presses = new Map();
  for (const run of runs) {
    const key = run.machine?.code || 'No press named';
    const press = presses.get(key) || { press: key, runs: [], good: 0, rejected: 0, downtime: {}, problems: [] };
    press.runs.push({
      number: run.number, status: run.status, mould: run.mould?.mouldCode || null, customer: run.customer?.name || null, operator: run.operator || null,
      good: run.goodPieces || 0, rejected: run.rejectedPieces || 0,
      workOrder: run.workOrder ? { number: run.workOrder.number, left: Math.max(0, (run.workOrder.quantity || 0) - (run.workOrder.goodQty || 0)) } : null,
    });
    press.good += run.goodPieces || 0;
    press.rejected += run.rejectedPieces || 0;
    for (const entry of run.downtime || []) press.downtime[entry.reason] = (press.downtime[entry.reason] || 0) + (entry.minutes || 0);
    if (!(run.downtime || []).length && run.downtimeMinutes) press.downtime.uncoded = (press.downtime.uncoded || 0) + run.downtimeMinutes;
    if (run.issues) press.problems.push(run.issues);
    presses.set(key, press);
  }
  const rows = [...presses.values()].map((press) => ({
    ...press,
    downtime: Object.entries(press.downtime).map(([reason, minutes]) => ({ reason, label: reason === 'uncoded' ? 'Not coded' : reasonLabel(DOWNTIME_REASONS, reason), minutes })).sort((a, b) => b.minutes - a.minutes),
  }));
  const called = await Machine.find({ 'andon.open': true }).select('code andon').lean();
  const totals = rows.reduce((sum, press) => ({ good: sum.good + press.good, rejected: sum.rejected + press.rejected, minutes: sum.minutes + press.downtime.reduce((total, entry) => total + entry.minutes, 0) }), { good: 0, rejected: 0, minutes: 0 });
  const rejectsByReason = {};
  for (const run of runs) for (const entry of run.rejects || []) rejectsByReason[entry.reason] = (rejectsByReason[entry.reason] || 0) + (entry.pieces || 0);
  return {
    day, shift: shift || null, presses: rows, totals,
    rejects: Object.entries(rejectsByReason).map(([reason, pieces]) => ({ reason, label: reasonLabel(REJECT_REASONS, reason), pieces })).sort((a, b) => b.pieces - a.pieces),
    calledIn: called.map((machine) => ({ code: machine.code, reason: reasonLabel(DOWNTIME_REASONS, machine.andon?.reason), note: machine.andon?.note || null, since: machine.andon?.at || null })),
  };
}

/** The floor's view: every press, its running job, its next released work orders and any open call. */
export async function floorView() {
  const [machines, running, queued] = await Promise.all([
    Machine.find({ active: { $ne: false }, status: { $ne: 'retired' } }).select('code name tonnage status andon').sort({ code: 1 }).collation({ locale: 'en', numericOrdering: true }).lean(),
    MouldRun.find({ status: 'running' }).populate([{ path: 'mould', select: 'mouldCode cavities activeCavities cycleTimeSeconds' }, { path: 'customer', select: 'name' }, { path: 'workOrder', select: 'number quantity goodQty colour' }]).lean({ virtuals: true }),
    WorkOrder.find({ status: { $in: ['planned', 'released', 'paused'] }, machine: { $exists: true } })
      .select('number machine sequence status colour quantity goodQty mould dueDate').populate('mould', 'mouldCode').sort({ sequence: 1 }).lean(),
  ]);
  return machines.map((machine) => ({
    machine,
    run: running.find((run) => String(run.machine) === String(machine._id)) || null,
    next: queued.filter((wo) => String(wo.machine) === String(machine._id)).slice(0, 3)
      .map((wo) => ({ _id: wo._id, number: wo.number, status: wo.status, mould: wo.mould?.mouldCode || null, colour: wo.colour, left: Math.max(0, (wo.quantity || 0) - (wo.goodQty || 0)), dueDate: wo.dueDate })),
  }));
}
