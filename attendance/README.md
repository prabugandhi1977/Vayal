# Vayal Attendance

Face-verified, location-stamped attendance. An employee checks in with their face, their location is stamped on the record, and for field or remote work they say why. HR sees everyone live on a map and can export a report.

Use it **standalone**, **inside the Vayal server** (already mounted at `/attendance`), or **in any other app**.

| Page | Who | URL |
|---|---|---|
| Check in / out | Employees (phone) | `/attendance/` |
| Live dashboard, records, people, offices | HR | `/attendance/hr` |

## How a check-in works

1. Employee picks **In office**, **On duty (field)** or **Remote**. The last two need a reason.
2. The server issues a one-time liveness challenge (blink twice, or turn your head and back).
3. The phone opens the camera, runs the challenge, and reads a 128-number face template in the browser (face-api.js, self-hosted, no third-party calls).
4. The phone reads GPS and sends template + location + a small snapshot.
5. The server checks: challenge unused and fresh, face matches the enrolled template, location valid, and for **In office** that the person is inside an office radius. Then it records the punch and pushes it to HR live.
6. While checked in with the page open, location is pinged every 2 minutes (shown as a trail on the map). Check-out stops it.

Records are flagged, not blocked, for: low GPS accuracy, stale or skewed GPS time, impossible travel since the last punch, check-out outside the office. Failed face matches are logged for HR with a snapshot.

## Sign-in options for staff

- **Code + PIN** from HR (always works).
- **Face ID / fingerprint:** after one PIN sign-in, staff tap *Turn on Face ID / fingerprint sign-in*. From then on they sign in with the phone's own biometric (a passkey). The phone checks the face or finger; the server never receives biometric data. If someone loses a phone, HR clicks **Lost phone** under People to remove it. Needs HTTPS and a phone with a screen lock set.
- Check-in itself still always runs the face + liveness + location check described above.

## Office QR code

HR → Offices → **Print poster** gives a printable page with a QR code for that office. Scanning it opens the check-in page with that office selected, and the record shows it was started from a scan. A printed code can be photographed, so it is a shortcut and an extra signal, never proof of presence: the location check still applies. Scanning one office's code while standing at another is flagged.

## Run it

Standalone:

```bash
ATTENDANCE_ADMIN_KEY=choose-a-long-key npm run attendance   # http://localhost:3100
```

Camera and GPS need HTTPS (localhost is fine for testing; Render gives you HTTPS).

First-time setup, in `/hr`: **Offices** → add the office (stand there, "Use my current location"). **People** → add employees; each gets a first PIN, shown once. Employees sign in, set their own PIN, accept the consent notice and enrol their face once. Only HR can reset a face template.

## Put it in another app

**Server (Express):**

```js
import { createAttendanceRouter } from "./attendance/index.js";
app.use("/attendance", await createAttendanceRouter({
  adminKey: process.env.ATTENDANCE_ADMIN_KEY,       // built-in HR sign-in, or...
  authenticate: (req) => req.user && { id: req.user.id, name: req.user.name, role: req.user.isHr ? "hr" : "employee" },
  onEvent: (e) => {},                               // check_in, check_out, failed_attempt, face_enrolled
  webhookUrl: "https://example.com/hooks/attendance" // same events, signed: X-Vayal-Signature = HMAC-SHA256(body, secret)
}));
```

With `authenticate`, your app's login replaces ours (no codes or PINs); employees are created on first use. Any other stack can run the module as its own service and read the events by webhook, or the CSV / `/hr/records` API.

**Browser:**

```html
<div id="att"></div>
<script src="/attendance/ui/vayal-attendance.js"></script>
<link rel="stylesheet" href="/attendance/ui/attendance.css">
<script>VayalAttendance.mount("#att", { base: "/attendance", headers: () => ({ Authorization: "Bearer " + myToken }) })</script>
```

Omit `headers` to use the built-in sign-in.

## Settings

| Variable / option | Default | |
|---|---|---|
| `ATTENDANCE_ADMIN_KEY` / `adminKey` | none | HR sign-in key. Unset = no HR login. |
| `ATTENDANCE_SECRET` / `secret` | generated, saved in the data dir | Signs login tokens and webhooks |
| `ATTENDANCE_DATABASE_URL` (or `DATABASE_URL`) | none | Postgres connection string. When set, it is used instead of files. |
| `ATTENDANCE_DATA_DIR` / `dataDir` | `./data/attendance` | JSON data + photos (used only without a database) |
| `ATTENDANCE_TZ` / `tz` | `Asia/Kolkata` | Defines "today" |
| `ATTENDANCE_FACE_THRESHOLD` / `faceThreshold` | `0.5` | Max face distance to accept. Lower is stricter. |
| `ATTENDANCE_ORIGIN` / `origin` | from the request | Site address used for Face ID passkeys, e.g. `https://vayal.onrender.com`. Changing the domain later invalidates saved passkeys. |
| `ATTENDANCE_PUBLIC_URL` / `publicUrl` | from the request | Address printed in QR codes |
| `ATTENDANCE_WEBHOOK_URL` / `webhookUrl` | none | |
| `store` option | JSON file | Pass your own object with `init/data/save/savePhoto/readPhoto` to use a database |

## Keeping the data (important on Render)

Render's free plan wipes its disk at every restart (each deploy, and when the service wakes from idle). Without permanent storage, employees, offices and records vanish. Pick one:

- **Free: a Postgres database.** Create a free one at neon.tech or supabase.com, copy its connection string (it ends in `?sslmode=require`), and set `ATTENDANCE_DATABASE_URL` on Render. Tables are created automatically. Data and the login signing secret then survive restarts.
- **Paid: a Render disk.** Mount it (e.g. `/var/data`) and set `ATTENDANCE_DATA_DIR=/var/data/attendance`. Do not set that variable without a disk mounted.

If neither is set on Render, the HR page shows a red warning.

## Be clear with your team about what this can and cannot prove

- **Liveness is a deterrent, not proof.** The blink/turn check runs in the browser. It stops a held-up photo, not a determined attacker who controls the device. The one-time server challenge does stop replaying a captured request.
- **GPS can be faked** on a rooted or developer-mode phone, and a web page cannot detect that. The flags (accuracy, stale time, impossible travel) and the snapshot catch the lazy cases. A native app with mock-location detection is the next step if you need it.
- **Tracking only runs while the page is open.** Browsers pause pages in the background, so a field trail has gaps. Check-in and check-out locations are always exact.
- **This is biometric and location data.** In India that falls under the DPDP Act: keep the consent screen, tell staff what is kept, delete leavers (Deactivate, then Reset face), and don't use the data for anything but attendance. Face templates are stored as numbers, not photos; snapshots are stored as files readable only by HR.
- Both built-in stores keep the whole data set in memory and suit a team of a few hundred. Beyond that, pass your own `store` with a proper schema.

## Tests

`npm test` covers geofencing, QR scan flags, passkey endpoints, face mismatch, liveness replay, flags, auth, host-app auth and CSV safety. The camera/face-api step runs in the browser and was exercised with a stubbed detector, not real faces: try it on a real phone before rolling out.
