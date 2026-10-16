/**
 * The plant's day is India's, whatever the server's clock is set to. A server on UTC would
 * otherwise call a date "today" from 5:30 in the morning, and "yesterday" until then.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 330 * 60 * 1000;

/** The start of the day in India that `now` falls in, as an instant. */
export function startOfIndiaDay(now = new Date()) {
  const local = new Date(new Date(now).getTime() + IST_OFFSET_MS);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - IST_OFFSET_MS);
}

/** The start of the day after the one `date` falls in. */
export const startOfNextIndiaDay = (date) => new Date(startOfIndiaDay(date).getTime() + DAY_MS);
