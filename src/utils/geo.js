/**
 * Distances between buyers' pinned gates [models/Customer.js `site`], for the trip planner.
 *
 * Straight-line (haversine) kilometres, which on Tiruppur's roads run short by a third or so —
 * good enough to say "these two are near each other" and to put stops in a sensible order, not to
 * promise a driving time.
 */
const R = 6371;
const rad = (degrees) => (degrees * Math.PI) / 180;

export function km(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** The plant's own gate, where every trip starts — `PLANT_LAT` / `PLANT_LNG`, if set. */
export function plantSite() {
  const lat = Number(process.env.PLANT_LAT);
  const lng = Number(process.env.PLANT_LNG);
  return Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng) ? { lat, lng } : null;
}

/**
 * Pinned stops in nearest-next order from `start` (the plant, or the first stop when the plant is
 * not set); stops with no pin keep their order, after the pinned ones.
 */
export function nearestOrder(stops, siteOf, start = plantSite()) {
  const pinned = stops.filter((stop) => siteOf(stop));
  const loose = stops.filter((stop) => !siteOf(stop));
  const ordered = [];
  let here = start || (pinned[0] && siteOf(pinned[0]));
  const left = [...pinned];
  while (left.length) {
    let best = 0;
    for (let i = 1; i < left.length; i += 1) if (km(here, siteOf(left[i])) < km(here, siteOf(left[best]))) best = i;
    const [next] = left.splice(best, 1);
    ordered.push(next);
    here = siteOf(next);
  }
  return [...ordered, ...loose];
}
