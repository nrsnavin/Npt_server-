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
 * The same rule as the Numbering panel on the Quotations screen: it can go back down to fix a
 * mistake, but never to a number already on a quote, which would issue it twice.
 * Reads MONGO_URI from .env, like the server does.
 */
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import Quotation from '../src/models/Quotation.js';
import { financialYear, quoteSequence, setNextQuoteNumber } from '../src/services/numbering.service.js';

const { start } = financialYear();
const raw = process.argv[2];
const next = raw === undefined ? null : Number(raw);
if (raw !== undefined && (!Number.isInteger(next) || next < 1)) {
  console.error(`"${raw}" is not a quote number. Give the number the next quote should have, e.g. 43.`);
  process.exit(1);
}

await connectDatabase();
try {
  if (next === null) {
    const now = await quoteSequence(start, { Quotation });
    console.log(`The next quote will be ${now.next}.${now.lastIssued ? ` The last issued is ${now.lastIssued}.` : ''}`);
  } else {
    const { after } = await setNextQuoteNumber(start, next, { Quotation });
    console.log(`Done. The next quote will be ${after.next}.`);
  }
} catch (error) {
  console.error(`${error.message} Nothing changed.`);
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
