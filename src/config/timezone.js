/**
 * The plant's day, whatever clock the server's machine keeps.
 *
 * Imported first by every entry point [server.js, worker.js, app.js], before anything else runs.
 * "Today" is worked out in many places with plain Date arithmetic — `setHours(0, 0, 0, 0)` for
 * the start of the day, `getDate() + 1` for tomorrow — and that is the machine's local day. A
 * cloud server keeps UTC, so between midnight and 05:30 in Tiruppur the app still thought it was
 * yesterday: a follow-up due today did not count as due, Dispatch's "Today" schedule showed the
 * previous day's loads, a quotation's validity ran out five and a half hours late.
 *
 * Setting TZ before any date is made puts every one of those on India's day at once. Node reads
 * the variable when it changes, so this works even though the process has already started.
 * `APP_TIMEZONE` overrides it for a plant somewhere else.
 */
process.env.TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';
