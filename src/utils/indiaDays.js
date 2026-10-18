/**
 * Calendar days as the plant counts them — India time — whatever time zone the server runs in.
 *
 * A day is a 'YYYY-MM-DD' string; it becomes a moment only when stored, as midnight in India.
 * Weekdays and day arithmetic are done on the calendar date itself, so a server in UTC and one
 * in India agree on what "Sunday" and "three days later" are.
 */
export const indiaDay = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(date));
export const dayToDate = (day) => new Date(`${day}T00:00:00.000+05:30`);
export const weekdayOf = (day) => new Date(`${day}T00:00:00.000Z`).getUTCDay();
export function addDays(day, count) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}
/** The next working day after `day`, skipping the weekly off. */
export function nextWorkingDay(day, weeklyOff) {
  let next = addDays(day, 1);
  while (weeklyOff != null && weekdayOf(next) === weeklyOff) next = addDays(next, 1);
  return next;
}
/** `day` itself if it is worked, else the next working day. */
export function firstWorkingDay(day, weeklyOff) {
  let current = day;
  while (weeklyOff != null && weekdayOf(current) === weeklyOff) current = addDays(current, 1);
  return current;
}
