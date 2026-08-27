/**
 * Indian states and the towns this business actually sells into.
 *
 * The point is not convenience, it is **one spelling per place**. Left as free text, the
 * database fills with Tiruppur, Tirupur, TIRUPPUR and Tirupur., which are one town to
 * everybody in the plant and four to every report that groups by city — and the person who
 * finds "customers in Tiruppur: 3" when there are eleven does not conclude the spelling is
 * wrong, they conclude the CRM is.
 *
 * States are the whole list, because there are thirty-six of them and they never change.
 *
 * Cities are a starting set rather than a gazetteer: India has thousands of towns and a list
 * of all of them would bury Tiruppur under places nobody here has heard of. These are the
 * garment and textile centres and the metros — where a hanger manufacturer's buyers are — and
 * the endpoint merges whatever the plant has actually typed on top, so the list grows into the
 * business rather than being guessed at once and left.
 *
 * Free text is always accepted. A suggestion list that becomes a constraint means the buyer in
 * a town nobody has dealt with cannot be entered at all, which is a worse problem than an
 * inconsistent spelling.
 */

/** The 28 states and 8 union territories. */
export const STATES = [
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chhattisgarh',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
  // Union territories
  'Andaman and Nicobar Islands',
  'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Jammu and Kashmir',
  'Ladakh',
  'Lakshadweep',
  'Puducherry',
];

/**
 * `city: state`, so picking a town can fill in the state that goes with it.
 *
 * Weighted towards the garment belt on purpose — Tiruppur, Ludhiana, Surat, Bengaluru and the
 * rest are where the buyers are, and a list that put them beside every district headquarters
 * in the country would be worse at the one job it has.
 */
export const CITIES = {
  // Tamil Nadu — the home belt
  Tiruppur: 'Tamil Nadu',
  Coimbatore: 'Tamil Nadu',
  Chennai: 'Tamil Nadu',
  Erode: 'Tamil Nadu',
  Salem: 'Tamil Nadu',
  Karur: 'Tamil Nadu',
  Madurai: 'Tamil Nadu',
  Hosur: 'Tamil Nadu',
  Tiruchirappalli: 'Tamil Nadu',
  Tirunelveli: 'Tamil Nadu',
  Kanchipuram: 'Tamil Nadu',
  Vellore: 'Tamil Nadu',

  // Karnataka
  Bengaluru: 'Karnataka',
  Mysuru: 'Karnataka',
  Hubballi: 'Karnataka',
  Mangaluru: 'Karnataka',
  Ballari: 'Karnataka',

  // Maharashtra
  Mumbai: 'Maharashtra',
  Pune: 'Maharashtra',
  Thane: 'Maharashtra',
  Nashik: 'Maharashtra',
  Nagpur: 'Maharashtra',
  Ichalkaranji: 'Maharashtra',
  Solapur: 'Maharashtra',

  // Gujarat
  Surat: 'Gujarat',
  Ahmedabad: 'Gujarat',
  Vadodara: 'Gujarat',
  Rajkot: 'Gujarat',
  Jamnagar: 'Gujarat',
  Bhavnagar: 'Gujarat',

  // The north
  Ludhiana: 'Punjab',
  Amritsar: 'Punjab',
  Jalandhar: 'Punjab',
  Delhi: 'Delhi',
  'New Delhi': 'Delhi',
  Gurugram: 'Haryana',
  Faridabad: 'Haryana',
  Panipat: 'Haryana',
  Sonipat: 'Haryana',
  Noida: 'Uttar Pradesh',
  Ghaziabad: 'Uttar Pradesh',
  Kanpur: 'Uttar Pradesh',
  Lucknow: 'Uttar Pradesh',
  Agra: 'Uttar Pradesh',
  Meerut: 'Uttar Pradesh',
  Moradabad: 'Uttar Pradesh',
  Varanasi: 'Uttar Pradesh',
  Chandigarh: 'Chandigarh',
  Baddi: 'Himachal Pradesh',
  Shimla: 'Himachal Pradesh',
  Dehradun: 'Uttarakhand',
  Haridwar: 'Uttarakhand',
  Rudrapur: 'Uttarakhand',
  Srinagar: 'Jammu and Kashmir',
  Jammu: 'Jammu and Kashmir',

  // Rajasthan and the centre
  Jaipur: 'Rajasthan',
  Jodhpur: 'Rajasthan',
  Udaipur: 'Rajasthan',
  Bhilwara: 'Rajasthan',
  Kota: 'Rajasthan',
  Indore: 'Madhya Pradesh',
  Bhopal: 'Madhya Pradesh',
  Gwalior: 'Madhya Pradesh',
  Jabalpur: 'Madhya Pradesh',
  Raipur: 'Chhattisgarh',

  // The east
  Kolkata: 'West Bengal',
  Howrah: 'West Bengal',
  Siliguri: 'West Bengal',
  Patna: 'Bihar',
  Ranchi: 'Jharkhand',
  Jamshedpur: 'Jharkhand',
  Bhubaneswar: 'Odisha',
  Cuttack: 'Odisha',
  Guwahati: 'Assam',

  // The south
  Hyderabad: 'Telangana',
  Warangal: 'Telangana',
  Visakhapatnam: 'Andhra Pradesh',
  Vijayawada: 'Andhra Pradesh',
  Guntur: 'Andhra Pradesh',
  Kochi: 'Kerala',
  Thiruvananthapuram: 'Kerala',
  Kozhikode: 'Kerala',
  Thrissur: 'Kerala',
  Panaji: 'Goa',
  Puducherry: 'Puducherry',
};

/**
 * The key two spellings of the same place share.
 *
 * Lowercased, punctuation dropped, and runs of the same letter collapsed — so Tiruppur,
 * tirupur and TIRUPPUR are one key. The doubled consonant is the spelling variance that
 * actually happens here, and it is the one that quietly splits a city report in two.
 *
 * Deliberately not fuzzy beyond that. Bengaluru and Bangalore are different names for the same
 * place and this treats them as two, which is right: guessing that two unlike strings mean one
 * town is how a report starts hiding real answers.
 *
 * Lives here rather than in whichever file needed it first, because the suggestion list, the
 * city report and the map must agree on what counts as the same town. Two copies of this rule
 * that drift apart is a map whose dots do not add up to the list beside them.
 */
export const placeKey = (value) =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/(.)\1+/g, '$1');

/**
 * A pattern matching every spelling of one place — the inverse of `placeKey`.
 *
 * Needed because a dot on the map and the list behind it must hold the same leads. The map
 * draws Tiruppur and tirupur as one dot of eleven; clicking it and getting four is the map
 * calling itself a liar, and the reader will believe the list.
 *
 * So the filter matches what the key collapses: any letter may be doubled, punctuation may sit
 * anywhere, case is ignored. Anchored at both ends, which is the part that matters — a
 * contains-match on "Kota" would sweep in Kotagiri, and a filter that answers a slightly
 * different question than the one asked is worse than no filter at all.
 */
export function spelledLike(value) {
  const key = placeKey(value);
  // Only ever a-z0-9 by construction, so nothing here needs escaping.
  if (!key) return new RegExp(`^${String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

  const gap = '[^a-z0-9]*';
  return new RegExp(`^${gap}${[...key].map((letter) => `${letter}+`).join(gap)}${gap}$`, 'i');
}

/**
 * Where each town is, so the book can be drawn as a map.
 *
 * `[latitude, longitude]`, to about a kilometre — which is far more precision than a dot on a
 * map of India needs, and the figures are the town centres rather than anybody's address.
 *
 * Every town in `CITIES` has an entry, and a test holds the two lists together: a town added
 * to one and forgotten in the other would silently vanish from the map, which is the worst
 * failure available here — a map that is quietly missing a place looks exactly like a map of a
 * business that has no customers there.
 */
export const CITY_COORDS = {
  Tiruppur: [11.11, 77.34],
  Coimbatore: [11.02, 76.96],
  Chennai: [13.08, 80.27],
  Erode: [11.34, 77.72],
  Salem: [11.66, 78.15],
  Karur: [10.96, 78.08],
  Madurai: [9.93, 78.12],
  Hosur: [12.74, 77.83],
  Tiruchirappalli: [10.79, 78.7],
  Tirunelveli: [8.71, 77.76],
  Kanchipuram: [12.84, 79.7],
  Vellore: [12.92, 79.13],

  Bengaluru: [12.97, 77.59],
  Mysuru: [12.3, 76.64],
  Hubballi: [15.36, 75.12],
  Mangaluru: [12.91, 74.86],
  Ballari: [15.14, 76.92],

  Mumbai: [19.08, 72.88],
  Pune: [18.52, 73.86],
  Thane: [19.22, 72.98],
  Nashik: [20.0, 73.79],
  Nagpur: [21.15, 79.09],
  Ichalkaranji: [16.69, 74.46],
  Solapur: [17.66, 75.91],

  Surat: [21.17, 72.83],
  Ahmedabad: [23.02, 72.57],
  Vadodara: [22.31, 73.18],
  Rajkot: [22.3, 70.8],
  Jamnagar: [22.47, 70.06],
  Bhavnagar: [21.76, 72.15],

  Ludhiana: [30.9, 75.86],
  Amritsar: [31.63, 74.87],
  Jalandhar: [31.33, 75.58],
  Delhi: [28.66, 77.23],
  'New Delhi': [28.61, 77.21],
  Gurugram: [28.46, 77.03],
  Faridabad: [28.41, 77.31],
  Panipat: [29.39, 76.97],
  Sonipat: [28.99, 77.02],
  Noida: [28.54, 77.39],
  Ghaziabad: [28.67, 77.44],
  Kanpur: [26.45, 80.33],
  Lucknow: [26.85, 80.95],
  Agra: [27.18, 78.01],
  Meerut: [28.98, 77.71],
  Moradabad: [28.84, 78.77],
  Varanasi: [25.32, 82.97],
  Chandigarh: [30.73, 76.78],
  Baddi: [30.96, 76.79],
  Shimla: [31.1, 77.17],
  Dehradun: [30.32, 78.03],
  Haridwar: [29.95, 78.16],
  Rudrapur: [28.98, 79.4],
  Srinagar: [34.08, 74.8],
  Jammu: [32.73, 74.86],

  Jaipur: [26.91, 75.79],
  Jodhpur: [26.24, 73.02],
  Udaipur: [24.58, 73.71],
  Bhilwara: [25.35, 74.63],
  Kota: [25.18, 75.83],
  Indore: [22.72, 75.86],
  Bhopal: [23.26, 77.41],
  Gwalior: [26.22, 78.18],
  Jabalpur: [23.18, 79.99],
  Raipur: [21.25, 81.63],

  Kolkata: [22.57, 88.36],
  Howrah: [22.59, 88.31],
  Siliguri: [26.73, 88.4],
  Patna: [25.59, 85.14],
  Ranchi: [23.34, 85.31],
  Jamshedpur: [22.8, 86.19],
  Bhubaneswar: [20.3, 85.82],
  Cuttack: [20.46, 85.88],
  Guwahati: [26.14, 91.74],

  Hyderabad: [17.39, 78.49],
  Warangal: [17.97, 79.59],
  Visakhapatnam: [17.69, 83.22],
  Vijayawada: [16.51, 80.65],
  Guntur: [16.31, 80.44],
  Kochi: [9.93, 76.27],
  Thiruvananthapuram: [8.52, 76.94],
  Kozhikode: [11.26, 75.78],
  Thrissur: [10.53, 76.21],
  Panaji: [15.5, 73.83],
  Puducherry: [11.94, 79.83],
};

/**
 * A point somewhere in the middle of each state.
 *
 * The fallback for a buyer in a town nobody bundled: rather than dropping them off the map, the
 * map places them in their state and **says so** — the mark is drawn hollow and the tooltip
 * names the town. A guess that admits it is a guess is useful; the same guess drawn as a
 * certainty is the map lying about where somebody's customers are.
 */
export const STATE_COORDS = {
  'Andhra Pradesh': [15.9, 79.7],
  'Arunachal Pradesh': [28.2, 94.7],
  Assam: [26.2, 92.9],
  Bihar: [25.6, 85.5],
  Chhattisgarh: [21.3, 82.0],
  Goa: [15.4, 74.0],
  Gujarat: [22.6, 71.6],
  Haryana: [29.2, 76.3],
  'Himachal Pradesh': [31.8, 77.3],
  Jharkhand: [23.6, 85.4],
  Karnataka: [14.8, 76.0],
  Kerala: [10.5, 76.3],
  'Madhya Pradesh': [23.5, 78.5],
  Maharashtra: [19.5, 75.9],
  Manipur: [24.7, 93.9],
  Meghalaya: [25.5, 91.3],
  Mizoram: [23.3, 92.8],
  Nagaland: [26.1, 94.4],
  Odisha: [20.5, 84.5],
  Punjab: [31.0, 75.4],
  Rajasthan: [26.6, 73.8],
  Sikkim: [27.6, 88.5],
  'Tamil Nadu': [11.1, 78.5],
  Telangana: [17.9, 79.0],
  Tripura: [23.8, 91.7],
  'Uttar Pradesh': [27.0, 80.5],
  Uttarakhand: [30.1, 79.0],
  'West Bengal': [23.8, 87.9],
  'Andaman and Nicobar Islands': [11.7, 92.7],
  Chandigarh: [30.73, 76.78],
  'Dadra and Nagar Haveli and Daman and Diu': [20.3, 73.0],
  Delhi: [28.66, 77.23],
  'Jammu and Kashmir': [33.8, 75.3],
  Ladakh: [34.5, 77.6],
  Lakshadweep: [10.6, 72.6],
  Puducherry: [11.94, 79.83],
};

/** Coordinates looked up the way a person spells, not the way a database stores. */
const byKey = (table) => {
  const map = new Map();
  for (const [name, point] of Object.entries(table)) map.set(placeKey(name), { name, point });
  return map;
};

const CITY_INDEX = byKey(CITY_COORDS);
const STATE_INDEX = byKey(STATE_COORDS);

/**
 * Where a lead or customer sits, from whatever address somebody typed.
 *
 * Returns the canonical spelling alongside the point, so a book holding "tirupur" and
 * "Tiruppur" draws one dot rather than two — and so the label under it is the spelling the
 * plant agreed on rather than whichever variant happened to be typed first.
 *
 * `precision` is the honest part: `city` means the point is the town, `state` means only the
 * state is known and the point is its middle. Nothing is returned at all when neither is
 * recognised, because a mark in the sea is worse than a line saying six leads could not be
 * placed.
 */
export function locate({ city, state } = {}) {
  const town = city && CITY_INDEX.get(placeKey(city));
  if (town) {
    return {
      precision: 'city',
      name: town.name,
      state: CITIES[town.name] || state || null,
      lat: town.point[0],
      lng: town.point[1],
    };
  }

  const region = state && STATE_INDEX.get(placeKey(state));
  if (region) {
    return {
      precision: 'state',
      name: region.name,
      state: region.name,
      lat: region.point[0],
      lng: region.point[1],
    };
  }

  return null;
}
