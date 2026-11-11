// Vayal Attendance widget. Drop it into any page:
//
//   <div id="att"></div>
//   <script src="/attendance/ui/vayal-attendance.js"></script>
//   <script>VayalAttendance.mount("#att", { base: "/attendance" })</script>
//
// With your own login, pass headers: () => ({ Authorization: "Bearer ..." }) and the widget skips its sign-in screen.
(function () {
  "use strict";
  const MODE_LABEL = { office: "In office", on_duty: "On duty", remote: "Remote" };
  const STATE_LABEL = { office: "Checked in · office", on_duty: "Checked in · on duty", remote: "Checked in · remote", checked_out: "Checked out", not_in: "Not checked in", missed_checkout: "Missed check-out" };
  const PING_MS = 120000;

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, "");
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
    return el;
  }
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const fmtDay = (iso) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------- face + camera ---------------- */
  let faceReady;
  function loadFace(base) {
    return (faceReady ||= (async () => {
      if (!window.faceapi) await new Promise((res, rej) => { const s = document.createElement("script"); s.src = `${base}/vendor/face-api/face-api.js`; s.onload = res; s.onerror = () => rej(new Error("Could not load the face detection library.")); document.head.append(s); });
      const url = `${base}/vendor/face-api/model`;
      await Promise.all([faceapi.nets.tinyFaceDetector.loadFromUri(url), faceapi.nets.faceLandmark68Net.loadFromUri(url), faceapi.nets.faceRecognitionNet.loadFromUri(url)]);
    })().catch((e) => { faceReady = null; throw e; }));
  }

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const ear = (p) => (dist(p[1], p[5]) + dist(p[2], p[4])) / (2 * dist(p[0], p[3]));
  function readFace(det) {
    const l = det.landmarks.positions;
    const jaw = l[16].x - l[0].x;
    return { ear: (ear(l.slice(36, 42)) + ear(l.slice(42, 48))) / 2, yaw: (l[30].x - l[0].x) / jaw, size: det.detection.box.width / det.detection.imageWidth };
  }

  /** Camera session: shows the preview, runs the liveness challenge, returns a descriptor + snapshot. */
  async function runCamera({ base, host, kind, samples, say }) {
    const video = h("video", { autoplay: true, playsinline: true, muted: true });
    const msg = h("div", { class: "say" }, "Starting camera…");
    const box = h("div", { class: "cam" }, video, msg);
    host.replaceChildren(box);
    const setSay = (t) => { msg.textContent = t; };
    let stream;
    try {
      setSay("Loading face detection…");
      await loadFace(base);
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      video.srcObject = stream; await video.play();
      const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
      const look = () => faceapi.detectSingleFace(video, opts).withFaceLandmarks().withFaceDescriptor();

      // 1. liveness: a random challenge chosen by the server
      const started = Date.now();
      let blinks = 0, eyesClosed = false, turned = false, passed = false;
      setSay(kind === "blink" ? "Look at the camera and blink twice" : "Turn your head to one side, then back");
      while (!passed) {
        if (Date.now() - started > 25000) throw new Error("Liveness check timed out. Try again in better light.");
        const det = await look();
        if (!det) { await wait(80); continue; }
        const f = readFace(det);
        if (f.size < 0.2) { setSay("Move a little closer"); continue; }
        if (kind === "blink") {
          if (f.ear < 0.2) eyesClosed = true;
          else if (f.ear > 0.26 && eyesClosed) { eyesClosed = false; blinks++; setSay(blinks === 1 ? "Once more" : ""); }
          passed = blinks >= 2;
        } else {
          if (f.yaw < 0.33 || f.yaw > 0.67) turned = true;
          else if (turned && f.yaw > 0.42 && f.yaw < 0.58) passed = true;
        }
      }

      // 2. capture frontal frames for matching
      setSay("Hold still, looking straight at the camera");
      const found = [];
      const t0 = Date.now();
      while (found.length < samples) {
        if (Date.now() - t0 > 20000) throw new Error("Could not get a clear face. Try again.");
        const det = await look();
        if (det) { const f = readFace(det); if (f.size >= 0.2 && f.yaw > 0.4 && f.yaw < 0.6 && f.ear > 0.22) { found.push(Array.from(det.descriptor)); if (found.length < samples) await wait(500); } }
        else await wait(80);
      }
      const c = document.createElement("canvas"); c.width = 240; c.height = Math.round(240 * video.videoHeight / video.videoWidth) || 180;
      c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
      return { descriptors: found, photo: c.toDataURL("image/jpeg", 0.6) };
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
    }
  }

  function getPosition() {
    return new Promise((res, rej) => {
      if (!navigator.geolocation) return rej(new Error("This device has no location support."));
      navigator.geolocation.getCurrentPosition(
        (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, ts: p.timestamp }),
        (e) => rej(new Error(e.code === 1 ? "Location is blocked. Allow location for this site and try again." : "Could not get your location. Try again outside or near a window.")),
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    });
  }

  /* ---------------- widget ---------------- */
  function mount(target, opts = {}) {
    const root = typeof target === "string" ? document.querySelector(target) : target;
    const base = (opts.base ?? "/attendance").replace(/\/$/, "");
    const external = typeof opts.headers === "function";
    const KEY = "vayal-att-token";
    const store = { get: () => { try { return sessionStorage.getItem(KEY); } catch { return null; } }, set: (v) => { try { v ? sessionStorage.setItem(KEY, v) : sessionStorage.removeItem(KEY); } catch {} } };
    let token = store.get(), me = null, pingTimer = null;

    root.classList.add("va"); root.dataset.theme = "";
    const api = async (method, url, body) => {
      const headers = { "content-type": "application/json", ...(external ? await opts.headers() : token ? { authorization: `Bearer ${token}` } : {}) };
      const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && !external) { token = null; store.set(null); render(); }
      if (!res.ok) throw Object.assign(new Error(data.error || "Request failed"), { code: data.code, data });
      return data;
    };
    const busy = (btn, fn) => async () => { btn.disabled = true; try { await fn(); } finally { btn.disabled = false; } };
    const view = (...kids) => root.replaceChildren(...kids);
    const header = () => h("div", {}, h("h1", {}, "Vayal Attendance"), me && h("div", { class: "mute" }, `${me.name} · ${me.code}`));

    async function render() {
      clearInterval(pingTimer);
      if (!external && !token) return renderLogin();
      try { me = await api("GET", "/me"); } catch (e) { if (!external && !token) return; return view(h("div", { class: "card" }, h("div", { class: "err" }, e.message))); }
      if (me.mustChangePin && !external) return renderPin();
      if (!me.consent) return renderConsent();
      if (me.requireFace && !me.faceEnrolled) return renderEnroll();
      renderHome();
    }

    function renderLogin() {
      const code = h("input", { type: "text", autocomplete: "username", autocapitalize: "off" });
      const pin = h("input", { type: "password", inputmode: "numeric", autocomplete: "current-password" });
      const err = h("div", { class: "err", role: "alert" });
      const go = h("button", { class: "primary" }, "Sign in");
      go.onclick = busy(go, async () => { err.textContent = ""; try { const r = await api("POST", "/auth/login", { code: code.value, pin: pin.value }); token = r.token; store.set(token); render(); } catch (e) { err.textContent = e.message; } });
      pin.addEventListener("keydown", (e) => e.key === "Enter" && go.click());
      view(h("div", {}, h("h1", {}, "Vayal Attendance"), h("div", { class: "mute" }, "Sign in with the employee code and PIN from HR.")),
        h("div", { class: "card" }, h("label", {}, "Employee code"), code, h("label", {}, "PIN"), pin, err, h("div", { style: "height:10px" }), go));
    }

    function renderPin() {
      const o = h("input", { type: "password", inputmode: "numeric" }), n = h("input", { type: "password", inputmode: "numeric" }), err = h("div", { class: "err" });
      const go = h("button", { class: "primary" }, "Save new PIN");
      go.onclick = busy(go, async () => { try { await api("POST", "/me/pin", { oldPin: o.value, newPin: n.value }); render(); } catch (e) { err.textContent = e.message; } });
      view(header(), h("div", { class: "card" }, h("h2", {}, "Choose your own PIN"), h("div", { class: "mute" }, "Replace the one HR gave you. 6 to 12 digits."), h("label", {}, "Current PIN"), o, h("label", {}, "New PIN"), n, err, h("div", { style: "height:10px" }), go));
    }

    function renderConsent() {
      const ok = h("input", { type: "checkbox", id: "va-consent" }), err = h("div", { class: "err" });
      const go = h("button", { class: "primary" }, "Agree and continue");
      go.onclick = busy(go, async () => { if (!ok.checked) { err.textContent = "Please tick the box to continue."; return; } try { await api("POST", "/me/consent", { agree: true }); render(); } catch (e) { err.textContent = e.message; } });
      view(header(), h("div", { class: "card" }, h("h2", {}, "Before we start"),
        h("p", {}, "To mark attendance this app uses your camera and your location. Here is exactly what is kept:"),
        h("ul", {}, h("li", {}, "A numeric face template (not a photo) to check it is you."), h("li", {}, "A small photo at each check-in and check-out, visible to HR only."), h("li", {}, "Your location when you check in or out, and while you are checked in with the app open."), h("li", {}, "The reason you give for on-duty or remote work.")),
        h("p", { class: "mute" }, "Location sharing stops when you check out. HR can delete your face template at any time."),
        h("label", { style: "display:flex;gap:8px;color:var(--ink);align-items:flex-start" }, ok, "I understand and agree to this use of my camera, face template and location for attendance."), err, h("div", { style: "height:10px" }), go));
    }

    function renderEnroll() {
      const slot = h("div"), err = h("div", { class: "err", role: "alert" });
      const go = h("button", { class: "primary" }, "Start face setup");
      go.onclick = busy(go, async () => {
        err.textContent = "";
        try {
          const ch = await api("GET", "/challenge");
          const { descriptors } = await runCamera({ base, host: slot, kind: ch.kind, samples: 3 });
          await api("POST", "/me/face", { descriptors });
          render();
        } catch (e) { slot.replaceChildren(); err.textContent = e.message; }
      });
      view(header(), h("div", { class: "card" }, h("h2", {}, "Set up your face"), h("div", { class: "mute" }, "One time only. Face the camera in good light, remove sunglasses or a mask. Only HR can change this later."), slot, err, h("div", { style: "height:10px" }), go));
    }

    function renderHome() {
      const s = me.status, open = ["office", "on_duty", "remote"].includes(s.state);
      const color = `var(--${s.state})`;
      const status = h("div", { class: "card" },
        h("span", { class: "pill", style: `background:${color}` }, STATE_LABEL[s.state]),
        s.since && h("div", { style: "margin-top:8px" }, `Since ${fmtTime(s.since)}`, s.reason ? ` · ${s.reason}` : ""),
        s.outAt && h("div", { style: "margin-top:8px" }, `Checked out at ${fmtTime(s.outAt)}`),
        s.state === "missed_checkout" && h("div", { class: "flag", style: "margin-top:8px" }, "You did not check out yesterday. Check out now to close it."),
        open && h("div", { class: "mute", style: "margin-top:8px" }, "Your location is shared with HR every couple of minutes while this page stays open."));

      const slot = h("div"), err = h("div", { class: "err", role: "alert" }), reason = h("textarea", { placeholder: "Why? e.g. Farm visit at Cheyyar, client meeting, work from home" });
      const reasonBox = h("div", { hidden: true }, h("label", {}, "Reason (HR will see this)"), reason);
      const mode = (v, label, on) => h("label", {}, h("input", { type: "radio", name: "va-mode", value: v, checked: on, onchange: () => { reasonBox.hidden = v === "office"; } }), label);
      const modes = h("div", { class: "modes" }, mode("office", "In office", true), mode("on_duty", "On duty (field)"), mode("remote", "Remote"));
      const chosen = () => root.querySelector("input[name=va-mode]:checked").value;

      const action = open || s.state === "missed_checkout" ? "out" : "in";
      const go = h("button", { class: "primary" }, action === "in" ? "Check in with face" : "Check out with face");
      go.onclick = busy(go, async () => {
        err.textContent = "";
        const m = action === "in" ? chosen() : undefined;
        if (action === "in" && m !== "office" && reason.value.trim().length < 5) { err.textContent = "Please give a reason (at least 5 characters)."; return; }
        try {
          const ch = await api("GET", "/challenge");
          const posP = getPosition();
          posP.catch(() => {});
          const cam = await runCamera({ base, host: slot, kind: ch.kind, samples: 1 });
          slot.textContent = "Getting your location…";
          const position = await posP.catch(() => getPosition()); // retry once if the first fix expired
          slot.textContent = "Sending…";
          await api("POST", "/punch", { action, mode: m, reason: reason.value, challengeId: ch.id, liveness: { kind: ch.kind, passed: true }, descriptor: cam.descriptors[0], position: { ...position, ts: Date.now() }, photo: cam.photo });
          await render();
        } catch (e) {
          slot.replaceChildren(); err.textContent = e.message;
          if (e.code === "outside_geofence") { root.querySelector("input[name=va-mode][value=on_duty]").click(); reasonBox.hidden = false; }
        }
      });

      const hist = h("ul", { class: "hist" });
      api("GET", "/me/history?days=7").then((r) => {
        for (const x of r.records.filter((x) => x.type !== "attempt").slice(0, 8)) hist.append(h("li", { class: "row" }, h("span", {}, `${fmtDay(x.at)} ${fmtTime(x.at)} · ${x.type === "in" ? "In" : "Out"} · ${MODE_LABEL[x.mode]}`), x.flags.length ? h("span", { class: "flag" }, "⚠ " + x.flags.join(", ").replaceAll("_", " ")) : ""));
        if (!hist.children.length) hist.append(h("li", { class: "mute" }, "No check-ins in the last 7 days."));
      }).catch(() => {});

      view(header(), status,
        h("div", { class: "card" }, h("h2", {}, action === "in" ? "Check in" : "Check out"), action === "in" && [modes, reasonBox], slot, err, h("div", { style: "height:10px" }), go),
        h("div", { class: "card" }, h("h2", {}, "Recent"), hist),
        !external && h("div", { class: "links" }, h("button", { onclick: () => { token = null; store.set(null); render(); } }, "Sign out")));

      if (open) pingTimer = setInterval(async () => { try { const p = await getPosition(); await api("POST", "/ping", p); } catch { /* try again next time */ } }, PING_MS);
    }

    render();
    return { refresh: render, destroy() { clearInterval(pingTimer); root.replaceChildren(); } };
  }

  window.VayalAttendance = { mount };
})();
