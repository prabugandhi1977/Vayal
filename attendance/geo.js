// Small geo helpers (no dependencies).
const R = 6371008.8; // mean Earth radius, metres
const rad = (d) => (d * Math.PI) / 180;

export function validLatLng(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

/** Great-circle distance in metres. */
export function haversineM(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Nearest office and distance to it, or null when no offices are set up. */
export function nearestOffice(pos, offices) {
  let best = null;
  for (const o of offices) {
    const d = haversineM(pos, o);
    if (!best || d < best.distanceM) best = { office: o, distanceM: d };
  }
  return best;
}
