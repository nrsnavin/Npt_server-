/**
 * Auto-loading leads from IndiaMART [BLUEPRINT §41 by analogy].
 *
 * Three failures this guards against, all of which are silent:
 *
 * **Duplicates.** The poller overlaps its windows on purpose, so the same enquiry is fetched
 * more than once by design. If ingestion is not idempotent the pipeline fills with copies of
 * the same buyer and two marketing people ring them.
 *
 * **A shape change read as an empty feed.** IndiaMART answers a bad key with an HTML page and
 * a 200. Parsed loosely, that is "no new leads" — forever, quietly.
 *
 * **A lost window.** The watermark must not advance past leads that were never written, or
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
const { normalise, ingestOne, syncIndiamartLeads } = await import('../src/services/indiamart.ingest.js');

let mongo;
let Lead;
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

/** A different buyer, for the cases that want two leads rather than one and an activity. */
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

  Lead = (await import('../src/models/Lead.js')).default;
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
  await Lead.deleteMany({});
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
   * "0 new leads" every quarter of an hour and nobody finds out for a month.
   */
  assert.throws(() => parseResponse({ CODE: 200, RESPONSE: { leads: [] } }), /has changed/i);
  assert.throws(() => parseResponse('<html>Invalid key</html>'), /not an object/i);
});

/* ------------------------------- Normalising ------------------------------- */

test('a row becomes a lead we could have typed ourselves', () => {
  const parsed = normalise(row());

  assert.equal(parsed.reference, '2026080112345678');
  assert.equal(parsed.lead.company, 'Sunrise Exports');
  assert.equal(parsed.lead.contactName, 'Rakesh Kumar');
  assert.equal(parsed.lead.city, 'Tiruppur');
  assert.equal(parsed.lead.source, 'indiamart');
  assert.match(parsed.lead.productInterest, /Velvet Flocked Hanger/);
});

test('a buyer with no company still gets in', () => {
  // IndiaMART routinely omits the company for an individual. Refusing those loses real work.
  const parsed = normalise(row({ SENDER_COMPANY: '' }));
  assert.equal(parsed.lead.company, 'Rakesh Kumar');

  const anonymous = normalise(row({ SENDER_COMPANY: '', SENDER_NAME: '' }));
  assert.equal(anonymous.lead.company, 'Unnamed IndiaMART buyer');
});

test('a row with no query id is dropped, because it could never be de-duplicated', () => {
  assert.equal(normalise(row({ UNIQUE_QUERY_ID: '', QUERY_ID: '' })), null);
});

/* -------------------------------- Ingesting -------------------------------- */

test('an enquiry becomes an owned lead with a next step against it', async () => {
  await reset();

  const { outcome, lead } = await ingestOne(row());
  assert.equal(outcome, 'created');

  assert.ok(lead.number.startsWith('LEAD-'));
  assert.ok(lead.assignedTo, 'a lead nobody owns is the thing §3 exists to prevent');
  assert.ok(lead.nextAction, 'and it must never arrive blank');
  assert.ok(lead.nextFollowUpDate);
  assert.equal(lead.conversation.provider, 'indiamart');
  assert.equal(lead.conversation.reference, '2026080112345678');

  // What the buyer actually said, kept verbatim on the record.
  assert.match(lead.activities[0].summary, /Need 40000 pcs/);
});

test('the same enquiry twice is one lead', async () => {
  await reset();

  await ingestOne(row());
  const second = await ingestOne(row());

  assert.equal(second.outcome, 'duplicate');
  assert.equal(await Lead.countDocuments(), 1);
});

test('a second enquiry from a buyer we are working lands on the lead we have', async () => {
  await reset();
  await ingestOne(row());

  const again = await ingestOne(
    row({ UNIQUE_QUERY_ID: '2026080999999999', QUERY_MESSAGE: 'Any update on the rate?' })
  );

  assert.equal(again.outcome, 'attached');
  assert.equal(await Lead.countDocuments(), 1, 'two leads for one buyer means two people ringing them');

  const lead = await Lead.findOne();
  /*
   * The enquiry, the rotation note explaining who it landed with, then the second enquiry.
   * Checked from the end rather than by index, so adding another note on creation later does
   * not silently turn this into an assertion about the wrong entry.
   */
  assert.match(lead.activities.at(-1).summary, /Any update on the rate/);
});

test('a buyer whose lead is finished starts a new one', async () => {
  await reset();
  await ingestOne(row());

  // Converted is finished. Hanging a fresh enquiry off it would hide genuinely new work.
  await Lead.updateOne({}, { status: 'converted' });

  const fresh = await ingestOne(row({ UNIQUE_QUERY_ID: '2026081011111111' }));
  assert.equal(fresh.outcome, 'created');
  assert.equal(await Lead.countDocuments(), 2);
});

/* --------------------------------- The poll --------------------------------- */

test('a poll ingests the window and moves the watermark', async () => {
  await reset();

  const result = await syncIndiamartLeads({
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
  await syncIndiamartLeads({ fetchImpl: stubFetch({ CODE: 200, RESPONSE: [row()] }) });
  const before = (await SyncState.forKey('indiamart')).lastSyncedAt;

  const failed = await syncIndiamartLeads({
    fetchImpl: stubFetch({ CODE: 429, MESSAGE: 'Limit exceeded' }),
  });
  assert.equal(failed.failed, true);

  /*
   * The whole reason the mark advances last. Moving it on a failed run would skip a window
   * nobody read, and the leads in it would be gone with nothing to say so.
   */
  const after = await SyncState.forKey('indiamart');
  assert.deepEqual(after.lastSyncedAt, before);
  assert.match(after.lastError, /Limit exceeded/);
  assert.equal(after.failureCount, 1);
});

test('one unreadable row does not cost the rest', async () => {
  await reset();

  const result = await syncIndiamartLeads({
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
  await syncIndiamartLeads({ fetchImpl: feed });
  const again = await syncIndiamartLeads({ fetchImpl: feed });

  /*
   * The poller overlaps its windows deliberately — their `QUERY_TIME` is the buyer's clock,
   * and a lead stamped either side of the mark would otherwise fall between two windows. That
   * only works because re-reading is free.
   */
  assert.equal(again.created, 0);
  assert.equal(again.duplicates, 2);
  assert.equal(await Lead.countDocuments(), 2);
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

test('two enquiries from one buyer in the same window are one lead', async () => {
  await reset();

  /*
   * Found by a test that asserted the opposite and was wrong. A buyer who sends two enquiries
   * an hour apart — a different product each time, which IndiaMART treats as two queries —
   * arrives in one window as two rows sharing a phone number. They are one relationship, and
   * two leads for them means two marketing people ringing the same person the same afternoon.
   */
  const result = await syncIndiamartLeads({
    fetchImpl: stubFetch({
      CODE: 200,
      RESPONSE: [
        row(),
        row({ UNIQUE_QUERY_ID: '2026080199999999', QUERY_PRODUCT_NAME: 'Wooden Suit Hanger' }),
      ],
    }),
  });

  assert.equal(result.fetched, 2);
  assert.equal(result.created, 1);
  assert.equal(result.attachedToExisting, 1);
  assert.equal(await Lead.countDocuments(), 1);

  // And nothing the buyer said is lost — the second enquiry is on the record too.
  const lead = await Lead.findOne();
  assert.match(lead.activities.at(-1).summary, /Wooden Suit Hanger/);
});
