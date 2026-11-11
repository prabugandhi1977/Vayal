// Face matching on the server. The browser extracts a 128-number descriptor
// (face-api.js); the server compares it to the descriptors enrolled by the
// employee. Raw camera frames are never needed for matching.
export const DESCRIPTOR_LENGTH = 128;

export function validDescriptor(d) {
  return Array.isArray(d) && d.length === DESCRIPTOR_LENGTH && d.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 10);
}

export function euclidean(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

/** Smallest distance between a probe and any enrolled descriptor (lower = more alike). */
export function bestDistance(probe, enrolled) {
  return enrolled.reduce((m, e) => Math.min(m, euclidean(probe, e)), Infinity);
}
