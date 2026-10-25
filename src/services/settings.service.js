import Setting from '../models/Setting.js';

/**
 * The security policy every signed-in app follows: a device PIN for everybody or only for those
 * who choose one, and the idle minutes before the app locks behind it. The PIN itself never
 * reaches the server — it seals the session token in the browser — so this is policy alone.
 */
export const SECURITY_DEFAULTS = Object.freeze({ pinRequired: false, lockAfterMinutes: 15 });
export const LOCK_MINUTES = Object.freeze({ min: 1, max: 240 });

export async function securityPolicy() {
  const row = await Setting.findOne({ key: 'security' }).lean();
  return { ...SECURITY_DEFAULTS, ...(row?.value || {}) };
}

export async function setSecurityPolicy(changes, by) {
  const current = await securityPolicy();
  const next = {
    pinRequired: changes.pinRequired === undefined ? current.pinRequired : Boolean(changes.pinRequired),
    lockAfterMinutes: changes.lockAfterMinutes === undefined
      ? current.lockAfterMinutes
      : Math.min(LOCK_MINUTES.max, Math.max(LOCK_MINUTES.min, Math.round(Number(changes.lockAfterMinutes)))),
  };
  await Setting.updateOne({ key: 'security' }, { $set: { value: next, updatedBy: by?._id } }, { upsert: true });
  return next;
}

/**
 * The plant's working calendar — what turns a mould's pieces an hour into a delivery date
 * [services/capacity.service.js]. Hours a press actually runs in a day (two twelve-hour shifts,
 * less changeovers and breaks), the shifts worked, and the weekly day off.
 */
export const PLANT_DEFAULTS = Object.freeze({ hoursPerDay: 22, shifts: ['A', 'B'], weeklyOff: 0, mouldChangeHours: 2, handoverLeadDays: 5 });
/** The days each finishing team gets before the EDD, the least and most it may be set to. */
export const HANDOVER_LEAD_RANGE = Object.freeze({ min: 1, max: 30 });
export const PLANT_SHIFTS = ['A', 'B', 'C', 'General'];

export async function plantCalendar() {
  const row = await Setting.findOne({ key: 'plant' }).lean();
  return { ...PLANT_DEFAULTS, ...(row?.value || {}) };
}

export async function setPlantCalendar(changes, by) {
  const current = await plantCalendar();
  const next = {
    hoursPerDay: changes.hoursPerDay === undefined ? current.hoursPerDay : Math.min(24, Math.max(1, Number(changes.hoursPerDay))),
    shifts: changes.shifts === undefined ? current.shifts : [...new Set(changes.shifts.filter((shift) => PLANT_SHIFTS.includes(shift)))],
    weeklyOff: changes.weeklyOff === undefined ? current.weeklyOff : (changes.weeklyOff === null ? null : Number(changes.weeklyOff)),
    /* A mould change, heat-up and first piece approved, when the mould itself does not say [pressScore.service]. */
    mouldChangeHours: changes.mouldChangeHours === undefined ? current.mouldChangeHours : Math.min(24, Math.max(0, Number(changes.mouldChangeHours))),
    /* Kept as it is: Production, Admin or marketing set it on its own [setHandoverLead]. */
    handoverLeadDays: current.handoverLeadDays,
  };
  if (!next.shifts.length) next.shifts = [...PLANT_DEFAULTS.shifts];
  await Setting.updateOne({ key: 'plant' }, { $set: { value: next, updatedBy: by?._id } }, { upsert: true });
  return next;
}

/**
 * The days each finishing team gets before the EDD [handoff.service `assertHandoverBeforeEdd`;
 * web: utils/edd.js `handOverDefault`]: a printed and assembled model goes to Printing twice this
 * before the EDD and to Assembly once; printed or assembled only, once. Production, Admin or
 * marketing set it.
 */
export async function setHandoverLead(days, by) {
  const current = await plantCalendar();
  const next = { ...current, handoverLeadDays: Math.min(HANDOVER_LEAD_RANGE.max, Math.max(HANDOVER_LEAD_RANGE.min, Math.round(Number(days)))) };
  await Setting.updateOne({ key: 'plant' }, { $set: { value: next, updatedBy: by?._id } }, { upsert: true });
  return next;
}
