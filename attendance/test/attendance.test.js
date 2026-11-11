import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { createAttendanceRouter } from "../index.js";
import { haversineM } from "../geo.js";

const OFFICE = { name: "Vayal HQ", lat: 13.0827, lng: 80.2707, radiusM: 150 };
const rand = () => Array.from({ length: 128 }, () => (Math.random() - 0.5) * 0.3);
const jitter = (d, s = 0.002) => d.map((x) => x + (Math.random() - 0.5) * s);

async function boot(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "att-"));
  const app = express();
  app.use("/a", await createAttendanceRouter({ dataDir: dir, adminKey: "hr-secret", ...opts }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/a`;
  const call = async (method, url, body, token) => {
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const ct = res.headers.get("content-type") || "";
    return { status: res.status, body: ct.includes("json") ? await res.json() : await res.text() };
  };
  return { call, close: () => server.close(), dir };
}

async function setup(t, opts) {
  const s = await boot(opts); t.after(s.close);
  const hr = (await s.call("POST", "/auth/admin", { key: "hr-secret" })).body.token;
  await s.call("POST", "/hr/offices", OFFICE, hr);
  const created = (await s.call("POST", "/hr/employees", { code: "E1", name: "Asha" }, hr)).body;
  const token = (await s.call("POST", "/auth/login", { code: "E1", pin: created.pin })).body.token;
  await s.call("POST", "/me/consent", { agree: true }, token);
  const face = rand();
  const enr = await s.call("POST", "/me/face", { descriptors: [face, jitter(face), jitter(face)] }, token);
  assert.equal(enr.status, 200);
  const punch = async (extra = {}, o = {}) => {
    const ch = (await s.call("GET", "/challenge", null, token)).body;
    return s.call("POST", "/punch", {
      action: "in", mode: "office", challengeId: ch.id, liveness: { kind: ch.kind, passed: true },
      descriptor: jitter(face), position: { lat: OFFICE.lat, lng: OFFICE.lng, accuracy: 20, ts: Date.now() }, ...extra,
    }, token);
  };
  return { ...s, hr, token, face, punch };
}

test("haversine is about right (1 degree latitude ~ 111 km)", () => {
  const d = haversineM({ lat: 13, lng: 80 }, { lat: 14, lng: 80 });
  assert.ok(Math.abs(d - 111195) < 300);
});

test("auth: HR and employee endpoints are protected", async (t) => {
  const s = await setup(t);
  assert.equal((await s.call("GET", "/hr/live")).status, 401);
  assert.equal((await s.call("GET", "/hr/live", null, s.token)).status, 403);
  assert.equal((await s.call("POST", "/auth/admin", { key: "nope" })).status, 401);
  assert.equal((await s.call("POST", "/auth/login", { code: "E1", pin: "000000" })).status, 401);
  assert.equal((await s.call("GET", "/me")).status, 401);
});

test("office check-in inside geofence, then check-out", async (t) => {
  const s = await setup(t);
  const inn = await s.punch();
  assert.equal(inn.status, 200, JSON.stringify(inn.body));
  assert.equal(inn.body.status.state, "office");
  assert.equal((await s.punch()).status, 409); // already in
  const out = await s.punch({ action: "out" });
  assert.equal(out.status, 200);
  assert.equal(out.body.status.state, "checked_out");
});

test("office check-in outside geofence is refused; on-duty needs a reason", async (t) => {
  const s = await setup(t);
  const far = { lat: OFFICE.lat + 0.05, lng: OFFICE.lng, accuracy: 10, ts: Date.now() };
  const r1 = await s.punch({ position: far });
  assert.equal(r1.status, 422); assert.equal(r1.body.code, "outside_geofence");
  assert.equal((await s.punch({ position: far, mode: "on_duty", reason: "" })).body.code, "reason_required");
  const ok = await s.punch({ position: far, mode: "on_duty", reason: "Farm visit at Cheyyar" });
  assert.equal(ok.status, 200);
  const live = (await s.call("GET", "/hr/live", null, s.hr)).body.employees[0];
  assert.equal(live.state, "on_duty"); assert.equal(live.reason, "Farm visit at Cheyyar");
});

test("a different face is rejected and logged for HR", async (t) => {
  const s = await setup(t);
  const ch = (await s.call("GET", "/challenge", null, s.token)).body;
  const r = await s.call("POST", "/punch", { action: "in", mode: "office", challengeId: ch.id, liveness: { kind: ch.kind, passed: true }, descriptor: rand(), position: { lat: OFFICE.lat, lng: OFFICE.lng, accuracy: 10, ts: Date.now() } }, s.token);
  assert.equal(r.status, 403); assert.equal(r.body.code, "face_mismatch");
  const rec = (await s.call("GET", "/hr/records", null, s.hr)).body;
  assert.equal(rec.attempts.length, 1); assert.equal(rec.sessions.length, 0);
});

test("liveness challenge is single-use and must match", async (t) => {
  const s = await setup(t);
  const ch = (await s.call("GET", "/challenge", null, s.token)).body;
  const body = { action: "in", mode: "office", challengeId: ch.id, liveness: { kind: ch.kind, passed: true }, descriptor: jitter(s.face), position: { lat: OFFICE.lat, lng: OFFICE.lng, accuracy: 10, ts: Date.now() } };
  assert.equal((await s.call("POST", "/punch", body, s.token)).status, 200);
  assert.equal((await s.call("POST", "/punch", { ...body, action: "out" }, s.token)).body.code, "challenge_invalid"); // replay
  const ch2 = (await s.call("GET", "/challenge", null, s.token)).body;
  assert.equal((await s.call("POST", "/punch", { ...body, action: "out", challengeId: ch2.id, liveness: { kind: ch2.kind, passed: false } }, s.token)).body.code, "liveness_failed");
});

test("flags: poor GPS accuracy and stale fix", async (t) => {
  const s = await setup(t);
  const r = await s.punch({ position: { lat: OFFICE.lat, lng: OFFICE.lng, accuracy: 900, ts: Date.now() - 10 * 60e3 } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.record.flags.sort(), ["low_gps_accuracy", "stale_or_skewed_time"]);
});

test("face enrolment cannot be replaced by the employee; HR can reset", async (t) => {
  const s = await setup(t);
  const again = await s.call("POST", "/me/face", { descriptors: [s.face, s.face] }, s.token);
  assert.equal(again.status, 409);
  const id = (await s.call("GET", "/hr/employees", null, s.hr)).body.employees[0].id;
  await s.call("POST", `/hr/employees/${id}/reset-face`, {}, s.hr);
  assert.equal((await s.call("GET", "/me", null, s.token)).body.faceEnrolled, false);
});

test("CSV report neutralises spreadsheet formulas in reasons", async (t) => {
  const s = await setup(t);
  const far = { lat: OFFICE.lat + 0.05, lng: OFFICE.lng, accuracy: 10, ts: Date.now() };
  await s.punch({ position: far, mode: "remote", reason: '=HYPERLINK("http://x","hi")' });
  const csv = (await s.call("GET", "/hr/report.csv", null, s.hr)).body;
  assert.match(csv, /"'=HYPERLINK/);
  assert.match(csv, /Remote/);
});

test("host-app auth: authenticate() replaces built-in login and creates the employee", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "att-"));
  const app = express();
  app.use("/a", await createAttendanceRouter({ dataDir: dir, authenticate: (req) => (req.get("x-user") ? { id: req.get("x-user"), name: "Host User", role: req.get("x-role") } : null) }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  t.after(() => server.close());
  const url = (p) => `http://127.0.0.1:${server.address().port}/a${p}`;
  assert.equal((await fetch(url("/me"))).status, 401);
  const me = await (await fetch(url("/me"), { headers: { "x-user": "u42" } })).json();
  assert.equal(me.name, "Host User");
  assert.equal((await fetch(url("/hr/live"), { headers: { "x-user": "u42" } })).status, 403);
  const live = await (await fetch(url("/hr/live"), { headers: { "x-user": "boss", "x-role": "hr" } })).json();
  assert.equal(live.employees.length, 1); // only the employee, not the HR user
  assert.equal((await fetch(url("/auth/login"), { method: "POST" })).status, 404);
});
