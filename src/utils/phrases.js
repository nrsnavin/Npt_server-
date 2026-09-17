/**
 * Saying a number and a day count the way a person would.
 *
 * These lived in `plantFindings.service.js`, where three separate wrong sentences came out of
 * them during the build — "1 days over", "-1 days ago", "today ago" — every one caught by
 * reading the screen rather than by a test, because no fixture lands on a date that is exactly
 * today or exactly one day old.
 *
 * They are here because a second feature then grew the same bugs independently. The lead coach's
 * own summary read *"1 contacts over 0 days, last one 0 days ago. 1 of them were calls or
 * meetings."* — four agreement errors in one sentence, on the path that runs on every deployment
 * with no API key, which is this plant's. Two files writing English about counts is two files
 * getting the edges wrong, so there is one place for it now.
 */

/** "1 contact", "6 contacts", "25,000 pieces" — Indian digit grouping, and the right noun. */
export const plural = (n, one, many) => `${Number(n || 0).toLocaleString('en-IN')} ${n === 1 ? one : many}`;

/** How long past a date: "due today", "1 day over", "12 days over". */
export const over = (days) => {
  if (days <= 0) return 'due today';
  return days === 1 ? '1 day over' : `${days} days over`;
};

/** How long ago something happened: "today", "yesterday", "5 days ago". */
export const since = (days) => {
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
};

/**
 * A span, as a duration rather than a date offset: "on the same day", "over 1 day", "over 25 days".
 *
 * Distinct from `since` because a span of zero is not "today" — six contacts inside one morning
 * span no days at all, and "6 contacts over 0 days" is the sentence this exists to prevent.
 */
export const span = (days) => {
  if (!days || days <= 0) return 'on one day';
  return days === 1 ? 'over 1 day' : `over ${days} days`;
};
