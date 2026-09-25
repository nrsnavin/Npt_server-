/**
 * Sets the number the next quotation gets in this financial year.
 *
 * The plant was numbering quotes by hand (NP/26-27/1, /2, …) before the app took over, so the
 * app's first quote must carry on from the last one sent, not start again at 001 and hand a
 * buyer a number they already hold for a different offer.
 *
 * Usage:
 *   npm run set-quote-number -- 43        the next quote is NP/<this year>/043
 *   npm run set-quote-number              shows what the next number will be
 *
 * It never moves the sequence backwards: that would issue a number twice.
 * Reads MONGO_URI from .env, like the server does.
 */
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import Counter from '../src/models/Counter.js';
import { financialYear, quoteCounterKey } from '../src/services/numbering.service.js';

const label = financialYear().label;
const key = quoteCounterKey();
const format = (seq) => `NP/${label}/${String(seq).padStart(3, '0')}`;

const raw = process.argv[2];
const next = raw === undefined ? null : Number(raw);
if (raw !== undefined && (!Number.isInteger(next) || next < 1)) {
  console.error(`"${raw}" is not a quote number. Give the number the next quote should have, e.g. 43.`);
  process.exit(1);
}

await connectDatabase();
try {
  const current = (await Counter.findOne({ key }))?.seq ?? 0;
  if (next === null) {
    console.log(`The next quote will be ${format(current + 1)}.`);
  } else if (next <= current) {
    console.error(`${format(next)} has already been issued — the last quote is ${format(current)}. Nothing changed.`);
    process.exitCode = 1;
  } else {
    await Counter.updateOne({ key, seq: current === 0 ? { $in: [0, null] } : current }, { $set: { seq: next - 1 } }, { upsert: current === 0 });
    console.log(`Done. The next quote will be ${format(next)}.`);
  }
} finally {
  await disconnectDatabase();
}
