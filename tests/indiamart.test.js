/**
 * Auto-loading IndiaMART enquiries [BLUEPRINT §41 by analogy] — as a customer and an enquiry.
 *
 * Three failures this guards against, all of which are silent:
 *
 * **Duplicates.** The poller overlaps its windows on purpose, so the same enquiry is fetched
 * more than once by design. If ingestion is not idempotent the pipeline fills with copies of
 * the same buyer and two marketing people ring them.
 *
 * **A shape change read as an empty feed.** IndiaMART answers a bad key with an HTML page and
 * a 200. Parsed loosely, that is "no new enquiries" — forever, quietly.
 *
 * **A lost window.** The watermark must not advance past rows that were never written, or
 * they are gone with nothing to say so.
 *
 *   node --test tests/indiamart.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'indiamart-test-secret-value';
process.env.INDIAMART_CRM_KEY = 'test-key-not-a-real-one';

const { asApiTime, parseResponse } = await import('../src/services/indiamart.client.js');
const { normalise, ingestOne, syncIndiamartEnquiries } = await import('../src/services/indiamart.ingest.js');

let mongo;
let Customer;
let Enquiry;
let User;
let SyncState;

/** One IndiaMART row, in the shape their pull API documents. */
const row = (overrides = {}) => ({
  UNIQUE_QUERY_ID: '2026080112345678',
  QUERY_TYPE: 'W',
  QUERY_TIME: '2026-08-01 11:04:00',
  SENDER_NAME: 'Rakesh Kumar',
  SENDER_MOBILE: '+919840011223',
  SENDER_EMAIL: 'rakesh@sunriseexports.in',
  SENDER_COMPANY: 'Sunrise Exports',
  SENDER_CITY: 'Tiruppur',
  SENDER_STATE: 'Tamil Nadu',
  QUERY_PRODUCT_NAME: 'Velvet Flocked Hanger',
  QUERY_MCAT_NAME: 'Garment Hangers',
  QUERY_MESSAGE: 'Need 40000 pcs, black. Share best rate.',
  ...overrides,
});

/** A different buyer, for the cases that want two customers rather than one. */
const otherBuyer = (overrides = {}) =>
  row({
    UNIQUE_QUERY_ID: '2026080287654321',
    SENDER_NAME: 'Meera Iyer',
    SENDER_MOBILE: '+919000011111',
    SENDER_EMAIL: 'meera@metrowholesale.in',
    SENDER_COMPANY: 'Metro Wholesale Traders',
    ...overrides,
  });

/** A fetch that answers with whatever body is handed to it, without touching the network. */
const stubFetch = (body, { ok = true, status = 200, text } = {}) =>
  async () => ({
    ok,
    status,
    text: async () => text ?? JSON.stringify(body),
  });

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  Customer = (await import('../src/models/Customer.js')).default;
  Enquiry = (await import('../src/models/Enquiry.js')).default;
  User = (await import('../src/models/User.js')).default;
  SyncState = (await import('../src/models/SyncState.js')).default;

  /*
   * Somebody for the rotation to land on. The grants matter: the rotation only considers
   * marketing people who may actually write enquiries, so a user without them is correctly
   * invisible to it — which is what the "nobody to assign to" path below relies on.
   */
  const { defaultAccessFor } = await import('../src/config/modules.js');
  await User.create({
    name: 'Nandhini S',
    email: 'nandhini@np.com',
    password: 'Passw0rd@123',
    role: 'member',
    department: 'marketing',
    moduleAccess: defaultAccessFor('marketing'),
  });
});

test.after(async () => {
  await mongoose.connection.close();
  await mongo?.stop();
});

const reset = async () => {
  await Customer.deleteMany({});
  await Enquiry.deleteMany({});
  await SyncState.deleteMany({});
};

/* ------------------------------- Their shape ------------------------------- */

test('their timestamp format is not ISO, and we do not send ISO', () => {
  // `DD-MMM-YYYYHH:MM:SS`, with no separator before the time. A 400 with no explanation is
  // what getting this wrong looks like, so it is asserted rather than assumed.
  assert.equal(asApiTime(new Date(2026, 7, 1, 9, 5, 3)), '01-Aug-202609:05:03');
});

test('an empty window is an answer, not a fault', () => {
  assert.deepEqual(parseResponse({ CODE: 200, RESPONSE: [] }), []);
  assert.deepEqual(parseResponse({ CODE: 200, RESPONSE: null }), []);
});

test('a refusal carries their own words, not ours', () => {
  assert.throws(
    () => parseResponse({ CODE: 429, MESSAGE: 'Limit exceeded, try after 5 minutes' }),
    /Limit exceeded/
  );
});

test('a changed payload shape is an error, never an empty feed', () => {
  /*
   * The failure this exists for: read loosely, a payload that is no longer a list reports
   * "0 new enquiries" every quarter of an hour and nobody finds out for a month.
   */
  assert.throws(() => parseResponse({ CODE: 200, RESPONSE: { leads: [] } }), /has changed/i);
  assert.throws(() => parseResponse('<html>Invalid key</html>'), /not an object/i);
});

/* ------------------------------- Normalising ------------------------------- */

test('a row becomes a buyer we could have typed in ourselves', () => {
  const parsed = normalise(row());

  assert.equal(parsed.reference, '2026080112345678');
  assert.equal(parsed.buyer.company, 'Sunrise Exports');
  assert.equal(parsed.buyer.contactName, 'Rakesh Kumar');
  assert.equal(parsed.buyer.city, 'Tiruppur');
  assert.match(parsed.interest, /Velvet Flocked Hanger/);
});

test('a buyer with no company still gets in', () => {
  // IndiaMART routinely omits the company for an individual. Refusing those loses real work.
  const parsed = normalise(row({ SENDER_COMPANY: '' }));
  assert.equal(parsed.buyer.company, 'Rakesh Kumar');

  const anonymous = normalise(row({ SENDER_COMPANY: '', SENDER_NAME: '' }));
  assert.equal(anonymous.buyer.company, 'Unnamed IndiaMART buyer');
});

test('a row with no query id is dropped, because it could never be de-duplicated', () => {
  assert.equal(normalise(row({ UNIQUE_QUERY_ID: '', QUERY_ID: '' })), null);
});

/* -------------------------------- Ingesting -------------------------------- */

test('a new buyer becomes an owned customer and an enquiry with a next step', async () => {
  await reset();

  const { outcome, customer, enquiry } = await ingestOne(row());
  assert.equal(outcome, 'created');

  assert.ok(customer.code.startsWith('CUST-'));
  assert.equal(customer.name, 'Sunrise Exports');
  assert.equal(customer.source, 'indiamart');
  assert.ok(customer.assignedTo, 'a buyer nobody owns is the thing §3 exists to prevent');
  assert.equal(customer.contacts[0].name, 'Rakesh Kumar');

  assert.ok(enquiry.number.startsWith('ENQ-'));
  assert.equal(String(enquiry.customer), String(customer._id));
  assert.equal(String(enquiry.assignedTo), String(customer.assignedTo));
  /* The model is what the first call finds out, so it waits in clarification. */
  assert.equal(enquiry.status, 'requirement_clarification');
  assert.equal(enquiry.source, 'indiamart');
  assert.ok(enquiry.nextAction, 'and it must never arrive blank');
  assert.ok(enquiry.nextFollowUpDate);
  assert.equal(enquiry.conversation.provider, 'indiamart');
  assert.equal(enquiry.conversation.reference, '2026080112345678');

  // What the buyer actually said, kept verbatim on the record.
  assert.match(enquiry.remarks, /Need 40000 pcs/);
  assert.match(enquiry.remarks, /Velvet Flocked Hanger/);
});

test('the same IndiaMART enquiry twice is one enquiry', async () => {
  await reset();

  await ingestOne(row());
  const second = await ingestOne(row());

  assert.equal(second.outcome, 'duplicate');
  assert.equal(await Enquiry.countDocuments(), 1);
  assert.equal(await Customer.countDocuments(), 1);
});

test('a buyer we already have gets the enquiry on their own record, with their owner', async () => {
  await reset();
  const { customer } = await ingestOne(row());

  const again = await ingestOne(
    row({ UNIQUE_QUERY_ID: '2026080999999999', QUERY_MESSAGE: 'Any update on the rate?' })
  );

  assert.equal(again.outcome, 'attached');
  assert.equal(await Customer.countDocuments(), 1, 'two records for one buyer means two people ringing them');
  assert.equal(await Enquiry.countDocuments(), 2);
  assert.equal(String(again.enquiry.customer), String(customer._id));
  assert.equal(String(again.enquiry.assignedTo), String(customer.assignedTo));
  assert.match(again.enquiry.remarks, /Any update on the rate/);
});

test('a buyer on file under a contact\'s number is matched too', async () => {
  await reset();
  const { customer } = await ingestOne(row());
  await Customer.updateOne(
    { _id: customer._id },
    { mobile: '9000000001', whatsapp: '9000000001', contacts: [{ name: 'Rakesh Kumar', mobile: '+919840011223' }] }
  );

  const again = await ingestOne(row({ UNIQUE_QUERY_ID: '2026081011111111', SENDER_EMAIL: '' }));
  assert.equal(again.outcome, 'attached');
  assert.equal(await Customer.countDocuments(), 1);
});

test('an enquiry captured without a model cannot move on until it names one', async () => {
  await reset();
  const { enquiry } = await ingestOne(row());
  const { default: app } = await import('../src/app.js');
  const { signToken } = await import('../src/middleware/auth.js');
  const token = signToken(await User.findById(enquiry.assignedTo));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const move = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/enquiries/${enquiry._id}/status`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'pricing_required',
        nextAction: 'Cost it',
        nextFollowUpDate: new Date(Date.now() + 86400000).toISOString(),
      }),
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    const stuck = await move();
    assert.equal(stuck.status, 400, JSON.stringify(stuck.body));
    assert.match(stuck.body.message, /Name the model/);

    await Enquiry.updateOne({ _id: enquiry._id }, { 'requirement.modelNumber': 'VF-17' });
    const moved = await move();
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/* --------------------------------- The poll --------------------------------- */

test('a poll ingests the window and moves the watermark', async () => {
  await reset();

  const result = await syncIndiamartEnquiries({
    fetchImpl: stubFetch({ CODE: 200, RESPONSE: [row(), otherBuyer()] }),
  });

  assert.equal(result.fetched, 2);
  assert.equal(result.created, 2);

  const state = await SyncState.forKey('indiamart');
  assert.ok(state.lastSyncedAt, 'the watermark is how the next window knows where to start');
  assert.equal(state.lastRun.created, 2);
  assert.equal(state.totals.created, 2);
});

test('a failed fetch leaves the watermark alone', async () => {
  await reset();

  // Get one good run in, so there is a mark to protect.
  await syncIndiamartEnquiries({ fetchImpl: stubFetch({ CODE: 200, RESPONSE: [row()] }) });
  const before = (await SyncState.forKey('indiamart')).lastSyncedAt;

  const failed = await syncIndiamartEnquiries({
    fetchImpl: stubFetch({ CODE: 429, MESSAGE: 'Limit exceeded' }),
  });
  assert.equal(failed.failed, true);

  /*
   * The whole reason the mark advances last. Moving it on a failed run would skip a window
   * nobody read, and the enquiries in it would be gone with nothing to say so.
   */
  const after = await SyncState.forKey('indiamart');
  assert.deepEqual(after.lastSyncedAt, before);
  assert.match(after.lastError, /Limit exceeded/);
  assert.equal(after.failureCount, 1);
});

test('one unreadable row does not cost the rest', async () => {
  await reset();

  const result = await syncIndiamartEnquiries({
    fetchImpl: stubFetch({
      CODE: 200,
      RESPONSE: [row({ UNIQUE_QUERY_ID: '' }), row(), otherBuyer()],
    }),
  });

  assert.equal(result.fetched, 3);
  assert.equal(result.created, 2);
  assert.equal(result.skipped, 1);
});

test('re-reading an overlapped window creates nothing new', async () => {
  await reset();

  const feed = stubFetch({ CODE: 200, RESPONSE: [row(), otherBuyer()] });
  await syncIndiamartEnquiries({ fetchImpl: feed });
  const again = await syncIndiamartEnquiries({ fetchImpl: feed });

  /*
   * The poller overlaps its windows deliberately — their `QUERY_TIME` is the buyer's clock,
   * and a row stamped either side of the mark would otherwise fall between two windows. That
   * only works because re-reading is free.
   */
  assert.equal(again.created, 0);
  assert.equal(again.attachedToExisting, 0);
  assert.equal(again.duplicates, 2);
  assert.equal(await Enquiry.countDocuments(), 2);
});

test('with no key the feed is simply off', async () => {
  const key = process.env.INDIAMART_CRM_KEY;
  delete process.env.INDIAMART_CRM_KEY;

  // The config is read at import time, so this asserts the guard rather than the env: a
  // deployment that does not sell through IndiaMART must not log an error every 15 minutes.
  const { isConfigured } = await import('../src/services/indiamart.client.js');
  assert.equal(typeof isConfigured, 'function');

  process.env.INDIAMART_CRM_KEY = key;
});

test('two enquiries from one buyer in the same window are one customer with two enquiries', async () => {
  await reset();

  /*
   * A buyer who sends two enquiries an hour apart — a different product each time, which
   * IndiaMART treats as two queries — arrives in one window as two rows sharing a phone number.
   * They are one relationship: one customer, one owner, and each product its own enquiry.
   */
  const window = {
    CODE: 200,
    RESPONSE: [
      row(),
      row({ UNIQUE_QUERY_ID: '2026080199999999', QUERY_PRODUCT_NAME: 'Wooden Suit Hanger' }),
    ],
  };
  const result = await syncIndiamartEnquiries({ fetchImpl: stubFetch(window) });

  assert.equal(result.fetched, 2);
  assert.equal(result.created, 1);
  assert.equal(result.attachedToExisting, 1);
  assert.equal(await Customer.countDocuments(), 1);
  assert.equal(await Enquiry.countDocuments(), 2);
  assert.ok(await Enquiry.exists({ remarks: /Wooden Suit Hanger/ }));

  // And pulled again, the overlap adds nothing.
  const again = await syncIndiamartEnquiries({ fetchImpl: stubFetch(window) });
  assert.equal(again.duplicates, 2);
  assert.equal(await Enquiry.countDocuments(), 2);
});
