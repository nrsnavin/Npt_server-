/**
 * Joining an outside system's sales order to our records [§2, §28, §29].
 *
 * The hard half of any import, and the half with nothing to do with HTTP — so it is tested
 * against the database directly rather than through an endpoint, and it will still be right
 * whatever Chirix's API turns out to look like.
 *
 * Three rules are what these tests actually defend.
 *
 * **Exact keys, in order of what they prove.** A GSTIN is a legal identity; a name is a spelling.
 *
 * **No fuzzy matching, and least of all on the mould.** A wrong customer is correctable; a wrong
 * tool is fifty thousand pieces on the wrong steel. An unmatched code is a supported state — the
 * schema already allows a line with free text and no mould — so there is never a reason to guess.
 *
 * **A failed join never drops the order.** An import people do not trust to arrive is one nobody
 * stops double-checking, at which point it has saved nothing.
 *
 *   node --test tests/import-matching.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'import-matching-test-secret';

let mongo;
let Customer;
let Mould;
let User;
let match;

let nandhini;   // marketing — owns the existing buyer
let arun;       // marketing — the configured fallback
let retired;    // a user who has left

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  ({ default: Customer } = await import('../src/models/Customer.js'));
  ({ default: Mould } = await import('../src/models/Mould.js'));
  ({ default: User } = await import('../src/models/User.js'));
  match = await import('../src/services/importMatching.service.js');

  [nandhini, arun, retired] = await User.create([
    { name: 'Nandhini S', email: 'nandhini@np.com', password: 'Mktg@123456', department: 'marketing' },
    { name: 'Arun K', email: 'arun@np.com', password: 'Mktg@654321', department: 'marketing' },
    { name: 'Gone Away', email: 'gone@np.com', password: 'Mktg@111111', department: 'marketing', isActive: false },
  ]);

  await Customer.create([
    {
      code: 'CUST-0001', name: 'Sri Kumaran Knits Pvt Ltd', gstin: '33AABCS1429B1ZP',
      mobile: '9840011223', assignedTo: nandhini._id,
    },
    /* Two units of one group, same normalised name — the case where a mobile is the only thing
       that separates them, and guessing attaches an order to the wrong unit. */
    { code: 'CUST-0002', name: 'Vogue Retail', mobile: '9840099001', assignedTo: nandhini._id },
    { code: 'CUST-0003', name: 'Vogue Retail Pvt Ltd', mobile: '9840099002', assignedTo: arun._id },
  ]);

  await Mould.create([
    {
      mouldCode: 'M-NH-400', name: 'Shirt hanger 400mm', category: 'shirt', sizeMm: 400,
      material: 'pp', cavities: 4, partWeightGrams: 26, cycleTimeSeconds: 28,
    },
    {
      mouldCode: 'M-NH-OLD', name: 'Discontinued 380mm', category: 'shirt', sizeMm: 380,
      material: 'pp', cavities: 4, partWeightGrams: 24, cycleTimeSeconds: 26, isActive: false,
    },
  ]);
});

test.after(async () => {
  await mongoose.connection.close();
  await mongo?.stop();
});

/* --------------------------------- The buyer --------------------------------- */

test('a GSTIN matches the buyer even when the name is typed differently', async () => {
  /*
   * The one field that is legally unique to a business, so a match on it is a fact rather than an
   * inference — which is exactly why it is tried first and why a wrong name cannot defeat it.
   */
  const { customer, matchedOn, review } = await match.matchCustomer({
    gstin: '33aabcs1429b1zp',
    name: 'SRI KUMARAN KNITTING MILLS',
  });

  assert.equal(customer.code, 'CUST-0001');
  assert.equal(matchedOn, 'gstin');
  assert.deepEqual(review, [], 'nothing was guessed, so there is nothing to review');
});

test('a legal suffix is not an identity', async () => {
  // "Sri Kumaran Knits" and "Sri Kumaran Knits Pvt Ltd" are one buyer. Treating them as two puts
  // two marketing people on the same account.
  const { customer, matchedOn } = await match.matchCustomer({ name: 'sri kumaran knits' });
  assert.equal(customer.code, 'CUST-0001');
  assert.equal(matchedOn, 'name');
});

test('two units of one group are separated by the mobile, not by luck', async () => {
  const { customer, matchedOn, review } = await match.matchCustomer({
    name: 'Vogue Retail',
    mobile: '9840099002',
  });

  assert.equal(customer.code, 'CUST-0003');
  assert.equal(matchedOn, 'name+mobile');
  assert.deepEqual(review, []);
});

test('an ambiguous buyer is flagged rather than silently picked', async () => {
  /*
   * Two customers, the same normalised name, and nothing to tell them apart. Something has to be
   * chosen — the order is real — but a screen that does not say so would attach it to the wrong
   * unit of the right group and never mention it.
   */
  const { customer, matchedOn, review } = await match.matchCustomer({ name: 'Vogue Retail Limited' });

  assert.ok(customer, 'the order is not dropped');
  assert.equal(matchedOn, 'ambiguous');
  assert.match(review[0], /matches 2 customers/);
  assert.match(review[0], /check this is the right one/);
});

test('a buyer nobody has heard of is created and flagged, not refused', async () => {
  /*
   * Holding the order back for somebody to add the customer first sounds careful and is not: it
   * puts a real order in a queue outside the order book, where the only thing that finds it is
   * somebody remembering to look.
   */
  const { customer, matchedOn, review } = await match.matchCustomer(
    { name: 'Brand New Exports', gstin: '33ZZZZZ9999Z1ZZ', mobile: '9000011111', city: 'Tiruppur' },
    { owner: arun._id }
  );

  assert.equal(matchedOn, 'created');
  assert.equal(customer.name, 'Brand New Exports');
  /* §29: created with an owner, because a customer belonging to nobody is one nobody chases. */
  assert.equal(String(customer.assignedTo), String(arun._id));
  assert.match(review[0], /not on the customer master/);
});

/* --------------------------------- The tool --------------------------------- */

test('a mould matches on its code, and only exactly', async () => {
  const { mould, matchedOn } = await match.matchMould('m-nh-400');
  assert.equal(mould.mouldCode, 'M-NH-400');
  assert.equal(matchedOn, 'mouldCode');
});

test('a code that matches no tool is left empty and named, never guessed', async () => {
  /*
   * The restraint that matters most in this file. A line may legitimately have no mould — bought
   * in, or a new development — so an unmatched code is a supported state rather than an error,
   * which means there is never a reason to reach for the nearest-looking tool.
   */
  const { mould, matchedOn, review } = await match.matchMould('M-NH-4OO');

  assert.equal(mould, null);
  assert.equal(matchedOn, 'none');
  /* The failed code is in the sentence, because that is what somebody takes to the register. */
  assert.match(review[0], /M-NH-4OO/);
  assert.match(review[0], /pick the mould/);
});

test('a retired tool matches and says so', async () => {
  // Information, not an error: the buyer has ordered something we stopped making, and treating
  // it as unmatched would hide exactly the fact somebody needs.
  const { mould, review } = await match.matchMould('M-NH-OLD');

  assert.equal(mould.mouldCode, 'M-NH-OLD');
  assert.match(review[0], /retired tool/);
});

/* --------------------------------- The owner --------------------------------- */

test('their salesperson maps to our user through a table, never by name', async () => {
  /*
   * A table rather than name matching, because "R. Kumar" against "Ramesh Kumar" is precisely the
   * fuzzy match this whole file refuses — and getting it wrong hands somebody else's account to
   * the wrong person.
   */
  const { owner, matchedOn } = await match.matchOwner({
    salesperson: 'R. Kumar',
    mapping: { 'R. Kumar': String(arun._id) },
  });

  assert.equal(String(owner), String(arun._id));
  assert.equal(matchedOn, 'mapping');
});

test('a mapping to somebody who has left falls through rather than assigning to them', async () => {
  const existing = await Customer.findOne({ code: 'CUST-0001' });
  const { owner, matchedOn } = await match.matchOwner({
    salesperson: 'Old Hand',
    mapping: { 'Old Hand': String(retired._id) },
    customer: existing,
  });

  assert.equal(String(owner), String(nandhini._id), "the buyer's own owner, not the leaver");
  assert.equal(matchedOn, 'customer');
});

test('a repeat buyer already belongs to somebody', async () => {
  const existing = await Customer.findOne({ code: 'CUST-0001' });
  const { owner, matchedOn, review } = await match.matchOwner({ customer: existing });

  assert.equal(String(owner), String(nandhini._id));
  assert.equal(matchedOn, 'customer');
  assert.deepEqual(review, [], 'the right answer, so nothing to flag');
});

test('with nothing to go on it lands with the fallback, and says so', async () => {
  // `assignedTo` is required on an order, so an import that cannot fill it cannot import at all.
  const { owner, matchedOn, review } = await match.matchOwner({ fallback: arun._id });

  assert.equal(String(owner), String(arun._id));
  assert.equal(matchedOn, 'fallback');
  assert.match(review[0], /No salesperson was supplied/);
});

/* ------------------------------ All three at once ------------------------------ */

test('a clean order resolves with nothing to review', async () => {
  const result = await match.matchOrder(
    {
      customer: { gstin: '33AABCS1429B1ZP' },
      lines: [{ mouldCode: 'M-NH-400', modelNumber: 'NPT-400S', quantity: 50000 }],
    },
    { fallback: arun._id }
  );

  assert.equal(result.customer.code, 'CUST-0001');
  assert.equal(String(result.owner), String(nandhini._id), "the buyer's own owner wins");
  assert.equal(String(result.lines[0].mould), String((await Mould.findOne({ mouldCode: 'M-NH-400' }))._id));
  assert.equal(result.clean, true);
  assert.deepEqual(result.review, []);
});

test('an unmatched line names which line it is about', async () => {
  /* On a four-line order "no tool matches" is unactionable without knowing which line, which is
     the difference between a note somebody can act on and one they have to investigate. */
  const result = await match.matchOrder(
    {
      customer: { gstin: '33AABCS1429B1ZP' },
      lines: [
        { mouldCode: 'M-NH-400', modelNumber: 'NPT-400S', quantity: 50000 },
        { mouldCode: 'M-UNKNOWN', modelNumber: 'NPT-999X', quantity: 20000 },
      ],
    },
    { fallback: arun._id }
  );

  assert.equal(result.clean, false);
  assert.equal(result.lines[0].mould != null, true, 'the line that matched still matched');
  assert.equal(result.lines[1].mould, undefined);
  assert.match(result.review[0], /^NPT-999X: /);
  assert.match(result.review[0], /M-UNKNOWN/);
});

test('a wholly unknown order still comes out importable', async () => {
  /*
   * New buyer, unmapped salesperson, unmatched tool — the worst case, and it still produces an
   * order somebody can work on. Refusing it would lose real business; importing it silently would
   * put a guessed tool in front of the plant with no sign that it was a guess.
   */
  const result = await match.matchOrder(
    {
      customer: { name: 'Never Heard Of Exports', mobile: '9111122223' },
      salesperson: 'Somebody Else',
      lines: [{ mouldCode: 'M-NOPE', modelNumber: 'XX-1', quantity: 1000 }],
    },
    { fallback: arun._id }
  );

  assert.ok(result.customer, 'a customer exists to hang the order on');
  assert.ok(result.owner, 'and somebody owns it');
  assert.equal(result.clean, false);
  assert.equal(result.review.length >= 2, true, 'and every guess is named');
});
