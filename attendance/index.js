// Vayal Attendance: face-verified, location-stamped check-in / check-out.
//
//   import { createAttendanceRouter } from "./attendance/index.js";
//   app.use("/attendance", await createAttendanceRouter({ adminKey: "..." }));
//
// Works standalone too: `node attendance/standalone.js`.
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import express from "express";
import QRCode from "qrcode";
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from "@simplewebauthn/server";
import { FileStore } from "./store.js";
import { hashPin, checkPin, safeEqual, signToken, verifyToken, makeLimiter } from "./auth.js";
import { haversineM, nearestOffice, validLatLng } from "./geo.js";
import { bestDistance, validDescriptor } from "./face.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const MODES = new Set(["office", "on_duty", "remote"]);
const MODE_LABEL = { office: "Office", on_duty: "On duty (field)", remote: "Remote" };

class HttpError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
const bad = (code, msg, extra) => new HttpError(400, code, msg, extra);

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const newId = () => crypto.randomUUID();

/**
 * @param {object} o
 * @param {string}   [o.dataDir]        where data is kept (default ./data/attendance)
 * @param {object}   [o.store]          your own store instead of the JSON file
 * @param {string}   [o.secret]         token signing secret (else ATTENDANCE_SECRET, else generated once and saved)
 * @param {string}   [o.adminKey]       HR sign-in key (else ATTENDANCE_ADMIN_KEY). Without it standalone HR sign-in is off.
 * @param {Function} [o.authenticate]   (req) => {id, name, role:'employee'|'hr'} | null. Use your app's own login instead of ours.
 * @param {number}   [o.faceThreshold]  max face distance to accept, default 0.5 (face-api: lower = stricter)
 * @param {boolean}  [o.requireFace]    default true
 * @param {string}   [o.tz]             IANA zone for "today", default Asia/Kolkata
 * @param {number}   [o.maxAccuracyM]   GPS accuracy worse than this is flagged, default 150
 * @param {Function} [o.onEvent]        (event) => void for check-in / check-out / failed attempts
 * @param {string}   [o.origin]        site origin for passkeys, e.g. https://vayal.onrender.com (default: from the request)
 * @param {string}   [o.publicUrl]     address printed in QR codes (default: from the request)
 * @param {string}   [o.webhookUrl]     POST events here, signed with X-Vayal-Signature (HMAC-SHA256 of the body)
 */
export async function createAttendanceRouter(o = {}) {
  const store = o.store || (await new FileStore(path.resolve(o.dataDir || process.env.ATTENDANCE_DATA_DIR || "data/attendance")).init());
  const secret = o.secret || process.env.ATTENDANCE_SECRET || (await store.persistentSecret());
  const adminKey = o.adminKey ?? process.env.ATTENDANCE_ADMIN_KEY ?? "";
  const authenticate = o.authenticate || null;
  const threshold = o.faceThreshold ?? Number(process.env.ATTENDANCE_FACE_THRESHOLD || 0.5);
  const requireFace = o.requireFace ?? true;
  const tz = o.tz || process.env.ATTENDANCE_TZ || "Asia/Kolkata";
  const maxAccuracy = o.maxAccuracyM ?? 150;
  const webhookUrl = o.webhookUrl ?? process.env.ATTENDANCE_WEBHOOK_URL ?? "";
  const D = store.data;
  const originOf = (req) => o.origin || process.env.ATTENDANCE_ORIGIN || `${req.protocol}://${req.get("host")}`;
  const rpIdOf = (req) => new URL(originOf(req)).hostname;

  const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const dayKey = (t = Date.now()) => dateFmt.format(t);

  /* ---------- live updates to HR (SSE) ---------- */
  const listeners = new Set();
  const broadcast = (name, data) => { for (const r of listeners) r.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); };

  function emit(event) {
    try { o.onEvent?.(event); } catch (e) { console.error("attendance onEvent:", e.message); }
    if (!webhookUrl) return;
    const body = JSON.stringify(event);
    const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
    fetch(webhookUrl, { method: "POST", headers: { "content-type": "application/json", "x-vayal-signature": sig }, body, signal: AbortSignal.timeout(5000) })
      .catch((e) => console.error("attendance webhook:", e.message));
  }

  /* ---------- helpers over the data ---------- */
  const emp = (id) => D.employees.find((e) => e.id === id);
  const lastPunch = (empId) => { for (let i = D.records.length - 1; i >= 0; i--) { const r = D.records[i]; if (r.empId === empId && r.type !== "attempt") return r; } return null; };
  const openSession = (empId) => { const l = lastPunch(empId); return l?.type === "in" ? l : null; };

  const publicRecord = (r) => ({ id: r.id, empId: r.empId, type: r.type, date: r.date, at: r.at, mode: r.mode, reason: r.reason, lat: r.lat, lng: r.lng, accuracy: r.accuracy,
    distanceM: r.distanceM, office: r.office, faceDistance: r.faceDistance, flags: r.flags, viaQr: r.viaQr, hasPhoto: r.hasPhoto, reasonFailed: r.reasonFailed });

  function status(e) {
    const open = openSession(e.id);
    const last = lastPunch(e.id);
    const live = D.live[e.id];
    let state = "not_in";
    if (open) state = open.date === dayKey() ? open.mode : "missed_checkout";
    else if (last?.date === dayKey()) state = "checked_out";
    return {
      id: e.id, code: e.code, name: e.name, state,
      since: open?.at || null, mode: open?.mode || null, reason: open?.reason || "",
      outAt: !open && last?.date === dayKey() ? last.at : null,
      location: open ? (live ? { lat: live.lat, lng: live.lng, accuracy: live.accuracy, at: live.at } : { lat: open.lat, lng: open.lng, accuracy: open.accuracy, at: open.at }) : null,
      trail: open && live ? live.trail : [],
      flags: open?.flags || [],
    };
  }

  /* ---------- router + auth ---------- */
  const router = express.Router();
  router.use((_req, res, next) => { res.set({ "Cache-Control": "no-store", "Permissions-Policy": "camera=(self), geolocation=(self)", "X-Content-Type-Options": "nosniff" }); next(); });
  router.use(express.json({ limit: "400kb" }));

  const loginLimiter = makeLimiter(8, 10 * 60e3);

  async function who(req) {
    if (authenticate) {
      const u = await authenticate(req);
      return u?.id ? { id: String(u.id), role: u.role === "hr" ? "hr" : "employee", host: u } : null;
    }
    const m = /^Bearer (.+)$/.exec(req.get("authorization") || "");
    const p = m && verifyToken(m[1], secret);
    return p ? { id: p.sub, role: p.role } : null;
  }
  // Host-app users become employees the first time they use an employee endpoint.
  async function hostEmployee(u) {
    let e = D.employees.find((x) => x.extId === String(u.id));
    if (!e) {
      e = { id: newId(), extId: String(u.id), code: String(u.code || u.id), name: str(u.name, 80) || String(u.id), role: "employee", active: true, faces: [], consentAt: null, createdAt: new Date().toISOString() };
      D.employees.push(e); await store.save();
    }
    return e;
  }
  const needAuth = (role) => async (req, _res, next) => {
    const u = await who(req);
    if (!u) throw new HttpError(401, "unauthorized", "Please sign in.");
    if (role === "hr" && u.role !== "hr") throw new HttpError(403, "forbidden", "HR access only.");
    if (role === "employee") {
      let e = u.host ? await hostEmployee(u.host) : emp(u.id);
      if (!e || !e.active) throw new HttpError(403, "inactive", "This account is not active.");
      req.emp = e;
    }
    req.user = u; next();
  };

  router.get("/health", (_req, res) => res.json({ ok: true, auth: authenticate ? "host" : "builtin", hrLogin: Boolean(adminKey) || Boolean(authenticate), faceThreshold: threshold }));

  router.post("/auth/login", (req, res) => {
    if (authenticate) throw new HttpError(404, "host_auth", "Sign-in is handled by the host app.");
    const code = str(req.body?.code, 40).toLowerCase();
    if (!loginLimiter(`${req.ip}|${code}`)) throw new HttpError(429, "too_many", "Too many attempts. Try again in a few minutes.");
    const e = D.employees.find((x) => x.code.toLowerCase() === code);
    // Run the hash either way so timing does not reveal whether a code exists.
    const ok = checkPin(str(req.body?.pin, 40), e?.pin || { salt: "00", hash: "00".repeat(32) }) && e?.active;
    if (!ok) throw new HttpError(401, "bad_login", "Employee code or PIN is wrong.");
    res.json({ token: signToken({ sub: e.id, role: "employee" }, secret), mustChangePin: Boolean(e.mustChangePin) });
  });

  router.post("/auth/admin", (req, res) => {
    if (authenticate || !adminKey) throw new HttpError(404, "no_admin_login", "HR sign-in is not enabled here.");
    if (!loginLimiter(`${req.ip}|admin`)) throw new HttpError(429, "too_many", "Too many attempts. Try again in a few minutes.");
    if (!safeEqual(str(req.body?.key, 200), adminKey)) throw new HttpError(401, "bad_login", "Wrong HR key.");
    res.json({ token: signToken({ sub: "hr", role: "hr" }, secret, 8 * 3600) });
  });

  /* ---------- employee: profile, consent, PIN, face enrolment ---------- */
  const me = needAuth("employee");

  router.get("/me", me, (req, res) => {
    const e = req.emp;
    res.json({
      id: e.id, code: e.code, name: e.name, faceEnrolled: e.faces.length > 0, consent: Boolean(e.consentAt), mustChangePin: Boolean(e.mustChangePin), passkeys: (e.passkeys || []).length,
      requireFace, offices: D.offices.map(({ id, name, radiusM }) => ({ id, name, radiusM })), status: status(e), today: dayKey(),
    });
  });

  router.post("/me/consent", me, async (req, res) => {
    if (req.body?.agree !== true) throw bad("consent_required", "Consent is needed to use face check-in.");
    req.emp.consentAt = new Date().toISOString(); await store.save(); res.json({ ok: true });
  });

  router.post("/me/pin", me, async (req, res) => {
    const pin = str(req.body?.newPin, 40);
    if (!/^\d{6,12}$/.test(pin)) throw bad("weak_pin", "PIN must be 6 to 12 digits.");
    if (authenticate) throw new HttpError(404, "host_auth", "PIN is managed by the host app.");
    if (!checkPin(str(req.body?.oldPin, 40), req.emp.pin)) throw new HttpError(401, "bad_login", "Current PIN is wrong.");
    req.emp.pin = hashPin(pin); req.emp.mustChangePin = false; await store.save(); res.json({ ok: true });
  });

  /* ---------- passkeys: sign in with the phone's own Face ID / fingerprint ---------- */
  const noHostAuth = () => { if (authenticate) throw new HttpError(404, "host_auth", "Sign-in is handled by the host app."); };
  const pkLimiter = makeLimiter(30, 10 * 60e3);
  const takeChallenge = (key) => { const c = D.challenges[key]; delete D.challenges[key]; if (!c || c.kind !== "pk" || c.exp < Date.now()) throw bad("challenge_invalid", "That took too long. Please try again."); return c; };

  router.post("/me/passkey/options", me, async (req, res) => {
    noHostAuth();
    const e = req.emp;
    if ((e.passkeys || []).length >= 5) throw bad("too_many_passkeys", "Too many devices. Ask HR to reset them.");
    const options = await generateRegistrationOptions({
      rpName: "Vayal Attendance", rpID: rpIdOf(req), userName: e.code, userDisplayName: e.name, userID: new TextEncoder().encode(e.id), attestationType: "none",
      excludeCredentials: (e.passkeys || []).map((p) => ({ id: p.id })),
      authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "required", userVerification: "required" },
    });
    D.challenges[`pk-reg:${e.id}`] = { kind: "pk", challenge: options.challenge, exp: Date.now() + 5 * 60e3 };
    res.json(options);
  });

  router.post("/me/passkey", me, async (req, res) => {
    noHostAuth();
    const e = req.emp, ch = takeChallenge(`pk-reg:${e.id}`);
    let v;
    try { v = await verifyRegistrationResponse({ response: req.body?.response, expectedChallenge: ch.challenge, expectedOrigin: originOf(req), expectedRPID: rpIdOf(req), requireUserVerification: true }); }
    catch { throw bad("passkey_failed", "Could not set up Face ID / fingerprint on this device."); }
    if (!v.verified) throw bad("passkey_failed", "Could not set up Face ID / fingerprint on this device.");
    const c = v.registrationInfo.credential;
    e.passkeys = [...(e.passkeys || []), { id: c.id, publicKey: Buffer.from(c.publicKey).toString("base64url"), counter: c.counter, transports: c.transports || [], name: str(req.body?.name, 40) || "This phone", createdAt: new Date().toISOString() }];
    await store.save(); res.json({ ok: true });
  });

  router.post("/auth/passkey/options", async (req, res) => {
    noHostAuth();
    if (!pkLimiter(req.ip)) throw new HttpError(429, "too_many", "Too many attempts. Try again in a few minutes.");
    const options = await generateAuthenticationOptions({ rpID: rpIdOf(req), userVerification: "required" });
    const id = newId();
    D.challenges[`pk-auth:${id}`] = { kind: "pk", challenge: options.challenge, exp: Date.now() + 5 * 60e3 };
    res.json({ id, options });
  });

  router.post("/auth/passkey", async (req, res) => {
    noHostAuth();
    if (!pkLimiter(req.ip)) throw new HttpError(429, "too_many", "Too many attempts. Try again in a few minutes.");
    const ch = takeChallenge(`pk-auth:${str(req.body?.id, 60)}`);
    const resp = req.body?.response;
    const e = D.employees.find((x) => (x.passkeys || []).some((p) => p.id === resp?.id));
    const p = e?.passkeys.find((x) => x.id === resp.id);
    if (!e || !e.active) throw new HttpError(401, "bad_login", "This device is not set up for Face ID sign-in. Use your code and PIN.");
    let v;
    try { v = await verifyAuthenticationResponse({ response: resp, expectedChallenge: ch.challenge, expectedOrigin: originOf(req), expectedRPID: rpIdOf(req), requireUserVerification: true, credential: { id: p.id, publicKey: Buffer.from(p.publicKey, "base64url"), counter: p.counter, transports: p.transports } }); }
    catch { throw new HttpError(401, "bad_login", "Face ID sign-in failed. Use your code and PIN."); }
    if (!v.verified) throw new HttpError(401, "bad_login", "Face ID sign-in failed. Use your code and PIN.");
    p.counter = v.authenticationInfo.newCounter; await store.save();
    res.json({ token: signToken({ sub: e.id, role: "employee" }, secret), mustChangePin: Boolean(e.mustChangePin) });
  });

  // First enrolment only. Changing a face later is an HR action, so a borrowed phone cannot replace it.
  router.post("/me/face", me, async (req, res) => {
    const e = req.emp;
    if (!e.consentAt) throw bad("consent_required", "Give consent before enrolling your face.");
    if (e.faces.length) throw new HttpError(409, "already_enrolled", "Face already enrolled. Ask HR to reset it.");
    const ds = req.body?.descriptors;
    if (!Array.isArray(ds) || ds.length < 2 || ds.length > 5 || !ds.every(validDescriptor)) throw bad("bad_descriptors", "Send 2 to 5 face samples.");
    // Samples should look like the same person, or the enrolment is junk.
    for (let i = 1; i < ds.length; i++) if (bestDistance(ds[i], [ds[0]]) > threshold) throw bad("inconsistent_samples", "The face samples did not match each other. Try again in steady light.");
    e.faces = ds; e.faceEnrolledAt = new Date().toISOString(); await store.save();
    emit({ type: "face_enrolled", empId: e.id, code: e.code, at: e.faceEnrolledAt });
    res.json({ ok: true });
  });

  /* ---------- liveness challenge (single use, short lived) ---------- */
  router.get("/challenge", me, async (req, res) => {
    const now = Date.now();
    for (const [k, c] of Object.entries(D.challenges)) if (c.exp < now) delete D.challenges[k];
    const id = newId();
    const kind = crypto.randomInt(2) ? "blink" : "turn";
    D.challenges[id] = { empId: req.emp.id, kind, exp: now + 2 * 60e3 };
    res.json({ id, kind, expiresInSec: 120 });
  });

  /* ---------- punch ---------- */
  function readPosition(p) {
    const lat = Number(p?.lat), lng = Number(p?.lng), accuracy = Number(p?.accuracy), ts = Number(p?.ts);
    if (!validLatLng(lat, lng) || !Number.isFinite(accuracy) || accuracy < 0) throw bad("bad_location", "Location is missing. Allow location access and try again.");
    return { lat, lng, accuracy: Math.round(accuracy), ts };
  }

  router.post("/punch", me, async (req, res) => {
    const e = req.emp, b = req.body || {};
    const action = b.action;
    if (action !== "in" && action !== "out") throw bad("bad_action", "action must be in or out.");
    if (!e.consentAt) throw new HttpError(409, "consent_required", "Give consent first.");
    if (requireFace && !e.faces.length) throw new HttpError(409, "face_not_enrolled", "Enrol your face first.");

    // 1. one-time challenge
    const ch = D.challenges[b.challengeId];
    delete D.challenges[b.challengeId];
    if (!ch || ch.empId !== e.id || ch.exp < Date.now()) throw bad("challenge_invalid", "The liveness check expired. Start again.");
    if (b.liveness?.kind !== ch.kind || b.liveness?.passed !== true) throw bad("liveness_failed", "The liveness check was not completed.");

    // 2. location
    const pos = readPosition(b.position);
    const near = nearestOffice(pos, D.offices);
    const flags = [];
    if (pos.accuracy > maxAccuracy) flags.push("low_gps_accuracy");
    if (!Number.isFinite(pos.ts) || Math.abs(Date.now() - pos.ts) > 120e3) flags.push("stale_or_skewed_time");

    // 3. face
    let faceDistance = null;
    if (requireFace) {
      if (!validDescriptor(b.descriptor)) throw bad("no_face", "No clear face was captured.");
      faceDistance = Number(bestDistance(b.descriptor, e.faces).toFixed(3));
      if (faceDistance > threshold) {
        const r = { id: newId(), empId: e.id, type: "attempt", reasonFailed: "face_mismatch", date: dayKey(), at: new Date().toISOString(), lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy, faceDistance, flags: [], hasPhoto: false };
        await maybePhoto(r, b.photo);
        D.records.push(r); await store.save();
        emit({ type: "failed_attempt", reason: "face_mismatch", empId: e.id, code: e.code, name: e.name, at: r.at });
        broadcast("attempt", { name: e.name, code: e.code, at: r.at });
        throw new HttpError(403, "face_mismatch", "Your face did not match the enrolled one.");
      }
    }

    // 4. state machine
    const open = openSession(e.id);
    let mode, reason;
    if (action === "in") {
      if (open) throw new HttpError(409, "already_in", "You are already checked in.");
      mode = b.mode;
      if (!MODES.has(mode)) throw bad("bad_mode", "Choose office, on duty or remote.");
      reason = str(b.reason, 300);
      if (mode === "office") {
        if (!near) throw bad("no_office", "HR has not set up an office location yet. Use On duty or Remote with a reason.");
        if (near.distanceM > near.office.radiusM) throw new HttpError(422, "outside_geofence", `You are ${Math.round(near.distanceM)} m from ${near.office.name}. Choose On duty or Remote and give the reason.`, { distanceM: Math.round(near.distanceM), office: near.office.name, radiusM: near.office.radiusM });
      } else if (reason.length < 5) throw bad("reason_required", "Please say why (at least 5 characters).");
    } else {
      if (!open) throw new HttpError(409, "not_in", "You are not checked in.");
      mode = open.mode; reason = str(b.reason, 300);
    }

    // QR scanned at the office is recorded as an extra signal (a printed code can be photographed, so it never replaces the GPS check).
    const qrOffice = typeof b.office === "string" ? D.offices.find((x) => x.id === b.office) : null;
    if (qrOffice && mode === "office" && near && near.office.id !== qrOffice.id) flags.push("qr_office_mismatch");

    // 5. plausibility against the previous punch
    const prev = lastPunch(e.id);
    if (prev) {
      const dt = (Date.now() - Date.parse(prev.at)) / 3600e3;
      if (dt > 0 && haversineM(prev, pos) / 1000 / dt > 250 && haversineM(prev, pos) > 2000) flags.push("impossible_travel");
    }
    if (action === "out" && mode === "office" && near && near.distanceM > near.office.radiusM) flags.push("checkout_outside_office");

    const r = { id: newId(), empId: e.id, type: action, date: action === "in" ? dayKey() : open.date, at: new Date().toISOString(), mode, reason,
      lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy, distanceM: near ? Math.round(near.distanceM) : null, office: near?.office.name || null, faceDistance, flags, viaQr: Boolean(qrOffice), hasPhoto: false };
    await maybePhoto(r, b.photo);
    D.records.push(r);
    if (action === "in") D.live[e.id] = { lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy, at: r.at, trail: [[pos.lat, pos.lng, r.at]] };
    else delete D.live[e.id];
    await store.save();

    emit({ type: action === "in" ? "check_in" : "check_out", record: publicRecord(r), employee: { id: e.id, code: e.code, name: e.name } });
    broadcast("status", status(e));
    res.json({ ok: true, record: publicRecord(r), status: status(e) });
  });

  async function maybePhoto(r, dataUrl) {
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
    if (!m) return;
    const buf = Buffer.from(m[1], "base64");
    if (buf.length > 150e3 || buf[0] !== 0xff || buf[1] !== 0xd8) return; // JPEG magic bytes
    await store.savePhoto(r.id, buf); r.hasPhoto = true;
  }

  // While checked in, the app shares a location ping every couple of minutes.
  router.post("/ping", me, async (req, res) => {
    const open = openSession(req.emp.id);
    if (!open) throw new HttpError(409, "not_in", "Not checked in.");
    const pos = readPosition(req.body);
    const live = D.live[req.emp.id] || { trail: [] };
    if (live.at && Date.now() - Date.parse(live.at) < 15e3) return res.json({ ok: true, skipped: true });
    const at = new Date().toISOString();
    D.live[req.emp.id] = { lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy, at, trail: [...live.trail, [pos.lat, pos.lng, at]].slice(-200) };
    await store.save();
    broadcast("status", status(req.emp));
    res.json({ ok: true });
  });

  router.get("/me/history", me, (req, res) => {
    const days = Math.min(Number(req.query.days) || 14, 90);
    const from = dayKey(Date.now() - days * 864e5);
    res.json({ records: D.records.filter((r) => r.empId === req.emp.id && r.date >= from).slice(-200).reverse().map(publicRecord) });
  });

  /* ---------- HR ---------- */
  const hr = needAuth("hr");

  router.get("/hr/live", hr, (_req, res) => {
    res.json({ today: dayKey(), offices: D.offices, employees: D.employees.filter((e) => e.active).map(status) });
  });

  router.get("/hr/stream", hr, (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders(); res.write("retry: 5000\n\n");
    listeners.add(res);
    const beat = setInterval(() => res.write(": hb\n\n"), 25e3);
    req.on("close", () => { clearInterval(beat); listeners.delete(res); });
  });

  router.get("/hr/employees", hr, (_req, res) => {
    res.json({ employees: D.employees.map((e) => ({ id: e.id, code: e.code, name: e.name, active: e.active, faceEnrolled: e.faces.length > 0, passkeys: (e.passkeys || []).length, consent: Boolean(e.consentAt), external: Boolean(e.extId) })) });
  });

  const newPin = () => String(crypto.randomInt(100000, 1000000));
  router.post("/hr/employees", hr, async (req, res) => {
    const code = str(req.body?.code, 40), name = str(req.body?.name, 80);
    if (!code || !name || !/^[\w.-]+$/.test(code)) throw bad("bad_employee", "Give a name and a code (letters, numbers, dot, dash).");
    if (D.employees.some((e) => e.code.toLowerCase() === code.toLowerCase())) throw new HttpError(409, "duplicate", "That employee code exists.");
    const pin = newPin();
    D.employees.push({ id: newId(), code, name, role: "employee", active: true, faces: [], consentAt: null, pin: hashPin(pin), mustChangePin: true, createdAt: new Date().toISOString() });
    await store.save();
    res.status(201).json({ code, name, pin }); // shown once
  });

  const target = (req) => { const e = emp(req.params.id); if (!e) throw new HttpError(404, "not_found", "No such employee."); return e; };
  router.post("/hr/employees/:id/reset-pin", hr, async (req, res) => {
    const e = target(req), pin = newPin(); e.pin = hashPin(pin); e.mustChangePin = true; await store.save(); res.json({ pin });
  });
  router.post("/hr/employees/:id/reset-face", hr, async (req, res) => {
    const e = target(req); e.faces = []; await store.save(); res.json({ ok: true });
  });
  router.post("/hr/employees/:id/reset-passkeys", hr, async (req, res) => {
    const e = target(req); e.passkeys = []; await store.save(); res.json({ ok: true });
  });
  router.post("/hr/employees/:id/active", hr, async (req, res) => {
    const e = target(req); e.active = req.body?.active !== false; await store.save(); res.json({ ok: true });
  });

  router.post("/hr/offices", hr, async (req, res) => {
    const lat = Number(req.body?.lat), lng = Number(req.body?.lng), radiusM = Math.round(Number(req.body?.radiusM));
    const name = str(req.body?.name, 80);
    if (!name || !validLatLng(lat, lng) || !(radiusM >= 20 && radiusM <= 5000)) throw bad("bad_office", "Name, latitude, longitude and a radius of 20 to 5000 m are needed.");
    D.offices.push({ id: newId(), name, lat, lng, radiusM }); await store.save(); res.status(201).json({ ok: true });
  });
  router.delete("/hr/offices/:id", hr, async (req, res) => {
    D.offices = D.offices.filter((o) => o.id !== req.params.id); await store.save(); res.json({ ok: true });
  });

  function range(q) {
    const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? q.to : dayKey();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : to;
    return { from, to };
  }
  /** Pair each check-in with its check-out. */
  function sessions({ from, to }, empId) {
    const out = [], openByEmp = new Map();
    for (const r of D.records) {
      if (r.type === "attempt" || (empId && r.empId !== empId)) continue;
      if (r.type === "in") { const s = { empId: r.empId, date: r.date, in: r, out: null }; openByEmp.set(r.empId, s); out.push(s); }
      else if (openByEmp.has(r.empId)) { openByEmp.get(r.empId).out = r; openByEmp.delete(r.empId); }
    }
    return out.filter((s) => s.date >= from && s.date <= to);
  }

  router.get("/hr/records", hr, (req, res) => {
    const rg = range(req.query);
    const rows = sessions(rg, str(req.query.emp, 60)).map((s) => ({ empId: s.empId, name: emp(s.empId)?.name, code: emp(s.empId)?.code, date: s.date, in: publicRecord(s.in), out: s.out && publicRecord(s.out) }));
    const attempts = D.records.filter((r) => r.type === "attempt" && r.date >= rg.from && r.date <= rg.to).map((r) => ({ ...publicRecord(r), name: emp(r.empId)?.name, code: emp(r.empId)?.code }));
    res.json({ ...rg, sessions: rows.reverse(), attempts: attempts.reverse() });
  });

  const csvCell = (v) => { let s = v == null ? "" : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const hhmm = (iso) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  router.get("/hr/report.csv", hr, (req, res) => {
    const rg = range(req.query);
    const head = ["Date", "Code", "Name", "Mode", "Reason", "Check-in", "Check-out", "Hours", "In lat", "In lng", "In accuracy (m)", "Metres from office", "Face distance", "Flags"];
    const lines = [head.join(",")];
    for (const s of sessions(rg).sort((a, b) => a.date.localeCompare(b.date))) {
      const e = emp(s.empId), hrs = s.out ? ((Date.parse(s.out.at) - Date.parse(s.in.at)) / 3600e3).toFixed(2) : "";
      lines.push([s.date, e?.code, e?.name, MODE_LABEL[s.in.mode], s.in.reason, hhmm(s.in.at), s.out ? hhmm(s.out.at) : "", hrs, s.in.lat, s.in.lng, s.in.accuracy, s.in.distanceM, s.in.faceDistance, [...s.in.flags, ...(s.out?.flags || [])].join(" ")].map(csvCell).join(","));
    }
    res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="attendance_${rg.from}_${rg.to}.csv"` }).send(lines.join("\r\n") + "\r\n");
  });

  router.get("/hr/photo/:id", hr, async (req, res) => {
    const buf = await store.readPhoto(req.params.id);
    if (!buf) throw new HttpError(404, "not_found", "No photo.");
    res.set("Content-Type", "image/jpeg").send(buf);
  });

  /* ---------- QR code for the office poster (public: it only encodes the staff link) ---------- */
  router.get("/qr.svg", async (req, res) => {
    const office = typeof req.query.office === "string" ? D.offices.find((x) => x.id === req.query.office) : null;
    const base = (o.publicUrl || process.env.ATTENDANCE_PUBLIC_URL || `${req.protocol}://${req.get("host")}${req.baseUrl}`).replace(/\/$/, "");
    const svg = await QRCode.toString(`${base}/${office ? `?office=${office.id}` : ""}`, { type: "svg", margin: 2, errorCorrectionLevel: "M" });
    res.type("image/svg+xml").send(svg);
  });

  /* ---------- static: UI, self-hosted face models and map library ---------- */
  const faceDir = path.dirname(require.resolve("@vladmandic/face-api/package.json"));
  const leafletDir = path.join(path.dirname(require.resolve("leaflet/package.json")), "dist");
  const st = (dir, maxAge = "7d") => express.static(dir, { dotfiles: "deny", maxAge, index: false });
  router.use("/vendor/face-api/model", st(path.join(faceDir, "model"), "30d"));
  router.use("/vendor/face-api", st(path.join(faceDir, "dist")));
  router.use("/vendor/leaflet", st(leafletDir));
  router.use("/ui", st(path.join(here, "public"), 0));
  router.get("/", (req, res) => (req.originalUrl.split("?")[0].endsWith("/") ? res.sendFile(path.join(here, "public", "employee.html")) : res.redirect(301, req.originalUrl.replace(/(\?|$)/, "/$1"))));
  router.get("/hr", (_req, res) => res.sendFile(path.join(here, "public", "hr.html")));

  router.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ code: err.code, error: err.message, ...err.extra });
    if (err?.type === "entity.too.large") return res.status(413).json({ code: "too_large", error: "Request too large." });
    if (err instanceof SyntaxError) return res.status(400).json({ code: "bad_json", error: "Invalid JSON." });
    console.error("attendance:", err);
    res.status(500).json({ code: "server_error", error: "Something went wrong." });
  });

  router.store = store;
  return router;
}
