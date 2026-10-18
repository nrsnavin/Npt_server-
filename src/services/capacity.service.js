import { PIECES_PER_DAY } from './productionUrgency.service.js';

/**
 * How long the plant takes to make something, from the mould register rather than a guess.
 *
 * A mould knows its cycle time, the cavities actually running and the efficiency it achieves;
 * the plant calendar [settings.service `plantCalendar`] knows how many hours a press runs in a
 * day and which day is off. Together they give pieces a day for that tool, and from there the
 * working days a quantity needs and the day it would finish.
 *
 * Where the mould is not known, or its figures are not filled in, the old plant-wide assumption
 * stands in — and says so (`basis: 'assumed'`), so a screen never presents a guess as arithmetic.
 */

const cavitiesOf = (mould) => {
  if (!mould) return 0;
  const cut = Number(mould.cavities) || 0;
  const active = mould.activeCavities == null ? cut : Number(mould.activeCavities);
  return Math.max(0, Math.min(active, cut || active));
};

/** Saleable pieces an hour at the mould's own cycle, running cavities and efficiency. */
export function piecesPerHour(mould) {
  const cycle = Number(mould?.cycleTimeSeconds) || 0;
  const cavities = cavitiesOf(mould);
  if (!cycle || !cavities) return 0;
  const efficiency = (mould.efficiencyPercent ?? 100) / 100;
  return (3600 / cycle) * efficiency * cavities;
}

/** Pieces a working day for one press running this mould. */
export function piecesPerDay(mould, plant) {
  const perHour = piecesPerHour(mould);
  if (!perHour) return 0;
  return Math.round(perHour * (Number(plant?.hoursPerDay) || 22));
}

/** The day after `from`, skipping the weekly off — whole calendar days in India time. */
function nextWorkingDay(date, weeklyOff) {
  const next = new Date(date.getTime() + 24 * 60 * 60 * 1000);
  if (weeklyOff != null && next.getDay() === weeklyOff) return nextWorkingDay(next, weeklyOff);
  return next;
}

/** Working days from today until `due` (negative once it has passed), not counting the day off. */
export function workingDaysUntil(due, plant, now = new Date()) {
  if (!due) return null;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(due);
  end.setHours(0, 0, 0, 0);
  if (end < start) return -Math.round((start - end) / 86400000);
  let days = 0;
  let cursor = start;
  while (cursor < end) {
    cursor = nextWorkingDay(cursor, plant?.weeklyOff);
    if (cursor <= end) days += 1;
  }
  return days;
}

/**
 * What a quantity needs on one press: pieces a day, working days, and the day it would finish
 * if started today. `basis` says whether the rate came from the mould or the plant assumption.
 */
export function estimate(quantity, mould, plant, now = new Date()) {
  const left = Math.max(0, Number(quantity) || 0);
  const fromMould = piecesPerDay(mould, plant);
  const perDay = fromMould || PIECES_PER_DAY;
  const days = left ? Math.ceil(left / perDay) : 0;
  let finish = new Date(now);
  finish.setHours(0, 0, 0, 0);
  if (plant?.weeklyOff != null && finish.getDay() === plant.weeklyOff) finish = nextWorkingDay(finish, plant.weeklyOff);
  for (let day = 1; day < days; day += 1) finish = nextWorkingDay(finish, plant?.weeklyOff);
  return {
    perDay, days, basis: fromMould ? 'mould' : 'assumed',
    perHour: fromMould ? Math.round(piecesPerHour(mould)) : null,
    finish: days ? finish : null,
  };
}

/** The fields of a mould the estimate reads — for a populate or a select. */
export const CAPACITY_FIELDS = 'cavities activeCavities cycleTimeSeconds efficiencyPercent';
