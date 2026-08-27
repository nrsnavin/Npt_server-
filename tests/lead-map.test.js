/**
 * Where the customers are.
 *
 * A map has a failure mode a bar chart does not: it can be quietly wrong about a place and
 * still look authoritative. A transposed pair of coordinates puts Tiruppur in the Bay of
 * Bengal; a town nobody bundled silently vanishes and the map shows a state with no business
 * in it; two spellings of one town draw two dots that each undercount. None of those raise an
 * error, and all of them are read as fact.
 *
 * So these tests are mostly about the map being *honest* rather than about it being drawn.
 *
 *   node --test tests/lead-map.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

import { CITIES, CITY_COORDS, STATE_COORDS, STATES, locate } from '../src/data/places.js';
import { geographyOf } from '../src/services/leadLog.service.js';

process.env.JWT_SECRET = 'lead-map-test-secret-value';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-03-10T10:00:00Z').getTime();

/* ------------------------------ The coordinates ------------------------------ */

test('every bundled town has somewhere to be drawn', () => {
  /*
   * The one that keeps the two lists together. A town added to the suggestion list and
   * forgotten here does not fail, it disappears — and a map missing a place looks exactly like
   * a business with no customers there.
   */
  const missing = Object.keys(CITIES).filter((city) => !CITY_COORDS[city]);
  assert.deepEqual(missing, [], `no coordinates for: ${missing.join(', ')}`);
});

test('every state has somewhere to be drawn', () => {
  const missing = STATES.filter((state) => !STATE_COORDS[state]);
  assert.deepEqual(missing, [], `no coordinates for: ${missing.join(', ')}`);
});

test('nothing has been plotted outside India', () => {
  /*
   * Catches the transposition, which is the coordinate bug that actually happens: [77.34,
   * 11.11] for Tiruppur is a perfectly valid pair of numbers that puts it near Somalia, and
   * nothing but a bounds check will ever notice.
   */
  const outside = [];
  for (const [name, [lat, lng]] of [...Object.entries(CITY_COORDS), ...Object.entries(STATE_COORDS)]) {
    if (lat < 6 || lat > 37 || lng < 68 || lng > 98) outside.push(`${name} → ${lat}, ${lng}`);
  }
  assert.deepEqual(outside, [], outside.join('; '));
});

test('a few towns are where they actually are', () => {
  // A bounds check passes on a plausible-looking wrong number. These are spot checks against
  // the real thing, on the towns this business could least afford to have in the wrong place.
  const near = (name, lat, lng) => {
    const [gotLat, gotLng] = CITY_COORDS[name];
    assert.ok(
      Math.abs(gotLat - lat) < 0.3 && Math.abs(gotLng - lng) < 0.3,
      `${name} is at ${gotLat}, ${gotLng} — expected about ${lat}, ${lng}`
    );
  };

  near('Tiruppur', 11.11, 77.34);
  near('Ludhiana', 30.9, 75.86);
  near('Surat', 21.17, 72.83);
  near('Kolkata', 22.57, 88.36);
  near('Delhi', 28.66, 77.23);
});

/* -------------------------------- Placing one -------------------------------- */

test('a variant spelling lands on the town it means', () => {
  const found = locate({ city: 'tirupur', state: 'Tamil Nadu' });

  assert.equal(found.precision, 'city');
  assert.equal(found.name, 'Tiruppur', 'and is labelled with the spelling the plant agreed on');
  assert.equal(found.state, 'Tamil Nadu');
});

test('a town nobody bundled falls back to its state, and says so', () => {
  const found = locate({ city: 'Chengannur', state: 'Kerala' });

  assert.equal(found.precision, 'state', 'the guess admits it is a guess');
  assert.equal(found.name, 'Kerala');
  assert.deepEqual([found.lat, found.lng], STATE_COORDS.Kerala);
});

test('an address that means nothing here is not placed at all', () => {
  // A mark in the sea is worse than a line saying six leads could not be placed.
  assert.equal(locate({ city: 'Dubai', state: 'Dubai' }), null);
  assert.equal(locate({}), null);
});

/* ------------------------------ The whole book ------------------------------ */

const lead = (attributes) => ({
  status: 'contacted',
  createdAt: new Date(NOW - 40 * DAY),
  activities: [{ type: 'call', occurredAt: new Date(NOW - 2 * DAY), summary: 'Called' }],
  ...attributes,
});

test('two spellings of one town are one dot', () => {
  const { places } = geographyOf(
    [
      lead({ city: 'Tiruppur', state: 'Tamil Nadu' }),
      lead({ city: 'tirupur', state: 'Tamil Nadu' }),
      lead({ city: 'TIRUPPUR', state: 'Tamil Nadu' }),
    ],
    NOW
  );

  assert.equal(places.length, 1, `drew ${places.length} dots for one town`);
  assert.equal(places[0].label, 'Tiruppur');
  assert.equal(places[0].total, 3);
});

test('what could not be placed is counted by name, never dropped', () => {
  const { places, unplaced, unplacedTotal } = geographyOf(
    [
      lead({ city: 'Tiruppur', state: 'Tamil Nadu' }),
      lead({ city: 'Dubai', state: 'Dubai' }),
      lead({ city: 'Dubai', state: 'Dubai' }),
      lead({}),
    ],
    NOW
  );

  assert.equal(places.reduce((sum, place) => sum + place.total, 0), 1);
  assert.equal(unplacedTotal, 3, 'the three that are not on the map are still admitted to');
  assert.deepEqual(unplaced, [
    { label: 'Dubai', value: 2 },
    { label: 'No address recorded', value: 1 },
  ]);
});

test('a state-precision dot names the towns inside it', () => {
  const { places } = geographyOf(
    [
      lead({ city: 'Chengannur', state: 'Kerala' }),
      lead({ city: 'Punalur', state: 'Kerala' }),
    ],
    NOW
  );

  assert.equal(places[0].precision, 'state');
  assert.equal(places[0].total, 2);
  assert.deepEqual(places[0].towns.sort(), ['Chengannur', 'Punalur']);
});

test('the quiet ones are counted, and only among the open', () => {
  /*
   * The reason a map beats a list here: a cluster that is large and mostly quiet is a
   * different problem from a cluster that is large and being worked, and the sorted list of
   * cities cannot tell them apart.
   */
  const stale = { activities: [], createdAt: new Date(NOW - 60 * DAY) };

  const { places } = geographyOf(
    [
      lead({ city: 'Surat', state: 'Gujarat', ...stale }),
      lead({ city: 'Surat', state: 'Gujarat', ...stale, status: 'converted' }),
      lead({ city: 'Surat', state: 'Gujarat' }),
    ],
    NOW
  );

  const surat = places.find((place) => place.label === 'Surat');
  assert.equal(surat.total, 3);
  assert.equal(surat.open, 2, 'the converted one is no longer open');
  assert.equal(surat.quiet, 1, 'and a converted lead is not "gone quiet"');
  assert.equal(surat.converted, 1);
});

test('the biggest place comes first, so the map has a headline', () => {
  const { places } = geographyOf(
    [
      lead({ city: 'Kochi', state: 'Kerala' }),
      lead({ city: 'Tiruppur', state: 'Tamil Nadu' }),
      lead({ city: 'Tiruppur', state: 'Tamil Nadu' }),
    ],
    NOW
  );

  assert.equal(places[0].label, 'Tiruppur');
});

/* ------------------------------ Through the API ------------------------------ */

let mongo;
let server;
let baseUrl;
let token;

const api = async (path, { method = 'GET', body } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' },
  });
  const { json } = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'admin@np.com', password: 'Admin@12345' },
  });
  token = json.data.token;

  for (const [company, city, state] of [
    ['Sri Kumaran Knits', 'Tiruppur', 'Tamil Nadu'],
    ['Poppys Apparel', 'tirupur', 'Tamil Nadu'],
    ['Kota Doria Mills', 'Kota', 'Rajasthan'],
    ['Nilgiri Tea Wear', 'Kotagiri', 'Tamil Nadu'],
  ]) {
    await api('/api/leads', {
      method: 'POST',
      body: { company, city, state, mobile: '9840000000' },
    });
  }
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the overview carries the map with it', async () => {
  const { json } = await api('/api/leads/overview');
  const { places, unplacedTotal } = json.data.geography;

  const tiruppur = places.find((place) => place.label === 'Tiruppur');
  assert.equal(tiruppur.total, 2, 'both spellings, one dot');
  assert.equal(unplacedTotal, 0);
});

test('clicking a dot narrows the list to that town, spelling and all', async () => {
  const { json } = await api('/api/leads?city=Tiruppur');
  const companies = json.data.map((row) => row.company).sort();

  assert.deepEqual(companies, ['Poppys Apparel', 'Sri Kumaran Knits'], 'the variant comes too');
});

test('narrowing to a town does not sweep in the town next to it', async () => {
  // "Kota" contains-matched would take Kotagiri with it, and a filter that answers a slightly
  // different question than the one asked is worse than no filter.
  const { json } = await api('/api/leads?city=Kota');

  assert.deepEqual(json.data.map((row) => row.company), ['Kota Doria Mills']);
});

test('a bracket typed into the filter does not throw', async () => {
  const { status } = await api('/api/leads?city=%28unclosed');
  assert.equal(status, 200);
});
