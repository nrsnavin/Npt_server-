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
