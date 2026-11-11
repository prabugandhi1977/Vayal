// Standalone sign-in: employee code + PIN (scrypt-hashed) -> signed bearer token.
// Host apps that already have their own login can skip all of this by passing
// `authenticate(req)` to createAttendanceRouter.
import crypto from "node:crypto";

export function hashPin(pin, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(String(pin), salt, 32).toString("hex") };
}
export function checkPin(pin, rec) {
  if (!rec?.hash) return false;
  const a = crypto.scryptSync(String(pin), rec.salt, 32);
  return crypto.timingSafeEqual(a, Buffer.from(rec.hash, "hex"));
}
export function safeEqual(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

const b64 = (b) => Buffer.from(b).toString("base64url");
export function signToken(payload, secret, ttlSec = 12 * 3600) {
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  return `${body}.${crypto.createHmac("sha256", secret).update(body).digest("base64url")}`;
}
export function verifyToken(token, secret) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const good = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.exp > Date.now() / 1000 ? p : null;
  } catch { return null; }
}

/** Sliding-window limiter for login guessing (memory only). */
export function makeLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) { hits.set(key, recent); return false; }
    recent.push(now); hits.set(key, recent);
    return true;
  };
}
