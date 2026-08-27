/**
 * Reports indexes the models do not declare, and optionally drops them.
 *
 *   npm run doctor:indexes           # report
 *   npm run doctor:indexes -- --fix  # drop them
 *
 * Run this when record creation starts failing with a duplicate-key error naming a field
 * the application does not have. The logic lives in services/indexHealth.service.js so it
 * can be tested; this is the command around it.
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { dropIndexes, findUnexpectedIndexes } from '../src/services/indexHealth.service.js';

// Importing the models is what registers their schemas, and their indexes with them.
import '../src/models/User.js';
import '../src/models/OtpToken.js';
import '../src/models/Todo.js';
import '../src/models/StickyNote.js';
import '../src/models/Announcement.js';
import '../src/models/Counter.js';
import '../src/models/Product.js';
import '../src/models/Customer.js';
import '../src/models/Lead.js';
import '../src/models/Enquiry.js';
import '../src/models/Sample.js';
import '../src/models/SampleLog.js';
import '../src/models/Attachment.js';
import '../src/models/CustomerMessage.js';

const fix = process.argv.includes('--fix');

async function main() {
  await connectDatabase();

  const findings = await findUnexpectedIndexes();

  for (const finding of findings) {
    console.log(
      `\n  ${finding.collection}: ${finding.name}` +
        `\n    on ${finding.fields.join(', ')}${finding.unique ? ' (unique)' : ''}` +
        '\n    no model declares this'
    );
    if (finding.blocksWrites) {
      console.log(
        `    ⚠ every document has null for ${finding.absentFields.join(', ')}, ` +
          'so only one can ever be saved'
      );
    }
  }

  if (!findings.length) {
    console.log('\nEvery index in the database is declared by a model. Nothing to do.');
  } else if (fix) {
    const dropped = await dropIndexes(findings);
    console.log(`\nDropped ${dropped.length} of ${findings.length} unexpected index(es).`);
  } else {
    const blocking = findings.filter((finding) => finding.blocksWrites).length;
    console.log(
      `\nFound ${findings.length} unexpected index(es)` +
        `${blocking ? `, ${blocking} of which block all writes` : ''}.` +
        '\nRe-run with --fix to drop them:\n  npm run doctor:indexes -- --fix'
    );
  }

  await disconnectDatabase();
}

main().catch(async (error) => {
  console.error('Index check failed:', error.message);
  await mongoose.connection.close();
  process.exit(1);
});
