// Vayal Attendance: HR dashboard (live map, records, people, offices).
(function () {
  "use strict";
  const BASE = location.pathname.replace(/\/hr\/?$/, "").replace(/\/$/, "");
  const KEY = "vayal-att-hr";
  const STATES = [["office", "In office"], ["on_duty", "On duty"], ["remote", "Remote"], ["checked_out", "Checked out"], ["not_in", "Not in yet"], ["missed_checkout", "Missed check-out"]];
  const LABEL = Object.fromEntries(STATES);
  const COLOR = { office: "#2f6b3a", on_duty: "#b45309", remote: "#1d5fa8", checked_out: "#6b6a64", not_in: "#b42318", missed_checkout: "#7c3aed" };
  const root = document.getElementById("app");
  const tok = { get: () => { try { return sessionStorage.getItem(KEY); } catch { return null; } }, set: (v) => { try { v ? sessionStorage.setItem(KEY, v) : sessionStorage.removeItem(KEY); } catch {} } };
  let token = tok.get(), tab = "live", live = { employees: [], offices: [] }, map, layer, selected = null, streamAbort = null, streamOk = false;

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else if (v === true) el.setAttribute(k, ""); else if (v !== false && v != null) el.setAttribute(k, v); }
    for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
    return el;
  }
  const hhmm = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const ago = (iso) => { if (!iso) return ""; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
  const flagText = (f) => f.map((x) => x.replaceAll("_", " ")).join(", ");

  async function api(method, url, body, raw) {
    const res = await fetch(BASE + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) { token = null; tok.set(null); stopStream(); draw(); throw new Error("Signed out"); }
    if (raw && res.ok) return res;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  /* ---------- sign-in ---------- */
  function login() {
    const key = h("input", { type: "password", autocomplete: "current-password" }), err = h("div", { class: "err", role: "alert" });
    const go = h("button", { class: "primary" }, "Sign in");
    go.onclick = async () => { try { token = (await api("POST", "/auth/admin", { key: key.value })).token; tok.set(token); draw(); } catch (e) { err.textContent = e.message; } };
    key.addEventListener("keydown", (e) => e.key === "Enter" && go.click());
    root.replaceChildren(h("div", { style: "max-width:380px;margin:40px auto" }, h("h1", {}, "Vayal Attendance · HR"), h("div", { class: "card" }, h("label", {}, "HR key"), key, err, h("div", { style: "height:10px" }), go)));
  }

  /* ---------- live stream (SSE over fetch so the token stays in a header) ---------- */
  function stopStream() { streamAbort?.abort(); streamAbort = null; }
  async function startStream() {
    stopStream(); streamAbort = new AbortController();
    const signal = streamAbort.signal;
    for (;;) {
      try {
        const res = await fetch(BASE + "/hr/stream", { headers: { authorization: `Bearer ${token}` }, signal });
        if (!res.ok) throw new Error("stream " + res.status);
        streamOk = true; paintLiveDot();
        const reader = res.body.getReader(), dec = new TextDecoder(); let buf = "";
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let i; while ((i = buf.indexOf("\n\n")) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); onEvent(chunk); }
        }
      } catch (e) { if (signal.aborted) return; }
      streamOk = false; paintLiveDot();
      await new Promise((r) => setTimeout(r, 5000));
      if (signal.aborted) return;
      refreshLive();
    }
  }
  function onEvent(chunk) {
    const name = /^event: (.+)$/m.exec(chunk)?.[1], data = /^data: (.+)$/m.exec(chunk)?.[1];
    if (!data) return;
    if (name === "status") { const s = JSON.parse(data), i = live.employees.findIndex((e) => e.id === s.id); i >= 0 ? (live.employees[i] = s) : live.employees.push(s); if (tab === "live") paintLive(); }
    if (name === "attempt") { const a = JSON.parse(data); alert(`Face mismatch: ${a.name} (${a.code}) at ${hhmm(a.at)}`); }
  }
  const paintLiveDot = () => { const d = document.getElementById("live-dot"); if (d) { d.className = "live-dot" + (streamOk ? "" : " off"); d.nextSibling.textContent = streamOk ? "Live" : "Reconnecting…"; } };
  async function refreshLive() { try { live = await api("GET", "/hr/live"); if (tab === "live") paintLive(); } catch {} }

  /* ---------- layout ---------- */
  function draw() {
    if (!token) return login();
    const tabs = [["live", "Live"], ["records", "Records"], ["people", "People"], ["offices", "Offices"]];
    root.replaceChildren(
      h("div", { class: "top" }, h("div", {}, h("h1", {}, "Vayal Attendance · HR"), h("div", { class: "mute" }, h("span", { id: "live-dot", class: "live-dot off" }), "Connecting…")),
        h("button", { onclick: () => { token = null; tok.set(null); stopStream(); draw(); } }, "Sign out")),
      h("div", { class: "tabs", role: "tablist" }, tabs.map(([k, l]) => h("button", { role: "tab", "aria-selected": String(tab === k), onclick: () => { tab = k; draw(); } }, l))),
      h("div", { id: "pane" }));
    map = null;
    ({ live: showLive, records: showRecords, people: showPeople, offices: showOffices })[tab]();
    if (!streamAbort) startStream();
    paintLiveDot();
  }

  /* ---------- live ---------- */
  function showLive() {
    document.getElementById("pane").append(h("div", { class: "tiles", id: "tiles" }), h("div", { class: "live", style: "margin-top:12px" }, h("div", { id: "map" }), h("div", { class: "card scroll", style: "margin:0" }, h("table", { id: "tbl" }))));
    map = L.map("map").setView([13.0827, 80.2707], 11);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }).addTo(map);
    layer = L.layerGroup().addTo(map);
    let fitted = false;
    paintLive.fit = () => !fitted;
    paintLive.done = () => { fitted = true; };
    refreshLive();
  }
  function paintLive() {
    const counts = Object.fromEntries(STATES.map(([k]) => [k, 0]));
    for (const e of live.employees) counts[e.state]++;
    document.getElementById("tiles")?.replaceChildren(...STATES.map(([k, l]) => h("div", { class: "tile" }, h("b", { style: `color:${COLOR[k]}` }, counts[k]), l)));
    const rows = [...live.employees].sort((a, b) => STATES.findIndex(([k]) => k === a.state) - STATES.findIndex(([k]) => k === b.state) || a.name.localeCompare(b.name));
    document.getElementById("tbl")?.replaceChildren(
      h("thead", {}, h("tr", {}, ["Employee", "Status", "Since", "Reason", "Last seen"].map((t) => h("th", {}, t)))),
      h("tbody", {}, rows.map((e) => h("tr", { class: "pick", tabindex: 0, onclick: () => focusOn(e), onkeydown: (ev) => ev.key === "Enter" && focusOn(e) },
        h("td", {}, e.name, h("div", { class: "mute" }, e.code)),
        h("td", {}, h("span", { class: "dot", style: `background:${COLOR[e.state]}` }), LABEL[e.state], e.flags.length ? h("div", { class: "flag", style: "color:var(--warn);font-size:12px" }, "⚠ " + flagText(e.flags)) : ""),
        h("td", {}, hhmm(e.since)), h("td", {}, e.reason), h("td", {}, e.location ? ago(e.location.at) : "")))));
    if (!map) return;
    layer.clearLayers();
    const pts = [];
    for (const o of live.offices) { L.circle([o.lat, o.lng], { radius: o.radiusM, color: "#2f6b3a", weight: 1, fillOpacity: 0.08 }).bindTooltip(o.name).addTo(layer); pts.push([o.lat, o.lng]); }
    for (const e of live.employees) {
      if (!e.location) continue;
      const ll = [e.location.lat, e.location.lng]; pts.push(ll);
      if (e.trail.length > 1) L.polyline(e.trail.map((t) => [t[0], t[1]]), { color: COLOR[e.state], weight: 2, opacity: 0.6 }).addTo(layer);
      const m = L.circleMarker(ll, { radius: e.id === selected ? 11 : 8, color: "#fff", weight: 2, fillColor: COLOR[e.state], fillOpacity: 1 }).addTo(layer);
      m.bindTooltip(`${e.name} · ${LABEL[e.state]}${e.reason ? " · " + e.reason : ""} (±${e.location.accuracy} m, ${ago(e.location.at)})`);
      if (e.location.accuracy > 30) L.circle(ll, { radius: e.location.accuracy, color: COLOR[e.state], weight: 1, fillOpacity: 0.05 }).addTo(layer);
    }
    if (paintLive.fit?.() && pts.length) { map.fitBounds(pts, { padding: [40, 40], maxZoom: 16 }); paintLive.done(); }
  }
  function focusOn(e) { selected = e.id; if (e.location && map) map.setView([e.location.lat, e.location.lng], 16); paintLive(); }

  /* ---------- records ---------- */
  function showRecords() {
    const today = new Date().toLocaleDateString("en-CA");
    const from = h("input", { type: "date", value: today }), to = h("input", { type: "date", value: today });
    const out = h("div", { class: "card scroll" }), dlg = h("dialog", {});
    const load = async () => {
      const r = await api("GET", `/hr/records?from=${from.value}&to=${to.value}`);
      const head = h("thead", {}, h("tr", {}, ["Date", "Employee", "Mode", "Reason", "In", "Out", "Hours", "Distance from office", "Flags", "Photos"].map((t) => h("th", {}, t))));
      const photo = (rec) => rec?.hasPhoto ? h("button", { onclick: async () => { const b = await (await api("GET", `/hr/photo/${rec.id}`, null, true)).blob(); dlg.replaceChildren(h("img", { src: URL.createObjectURL(b), alt: "Check-in photo" }), h("button", { onclick: () => dlg.close(), style: "margin-top:8px;width:100%" }, "Close")); dlg.showModal(); } }, rec.type === "in" ? "In" : "Out") : "";
      const mapLink = (rec) => h("a", { href: `https://www.openstreetmap.org/?mlat=${rec.lat}&mlon=${rec.lng}#map=17/${rec.lat}/${rec.lng}`, target: "_blank", rel: "noopener" }, hhmm(rec.at));
      const body = h("tbody", {}, r.sessions.map((s) => h("tr", {},
        h("td", {}, s.date), h("td", {}, s.name, h("div", { class: "mute" }, s.code)), h("td", {}, LABEL[s.in.mode] || s.in.mode), h("td", {}, s.in.reason),
        h("td", {}, mapLink(s.in)), h("td", {}, s.out ? mapLink(s.out) : ""), h("td", {}, s.out ? ((Date.parse(s.out.at) - Date.parse(s.in.at)) / 3600e3).toFixed(1) : ""),
        h("td", {}, s.in.distanceM != null ? `${s.in.distanceM} m` : ""), h("td", { style: "color:var(--warn)" }, flagText([...s.in.flags, ...(s.out?.flags || [])])), h("td", {}, photo(s.in), " ", photo(s.out)))));
      out.replaceChildren(r.sessions.length ? h("table", {}, head, body) : h("div", { class: "mute" }, "No check-ins in this period."),
        r.attempts.length ? h("div", { style: "margin-top:14px" }, h("h2", {}, "Failed face checks"), h("table", {}, h("tbody", {}, r.attempts.map((a) => h("tr", {}, h("td", {}, a.date, " ", hhmm(a.at)), h("td", {}, a.name, " ", a.code), h("td", {}, `distance ${a.faceDistance}`), h("td", {}, photo(a))))))) : "");
    };
    const csv = h("button", { onclick: async () => { const b = await (await api("GET", `/hr/report.csv?from=${from.value}&to=${to.value}`, null, true)).blob(); const a = h("a", { href: URL.createObjectURL(b), download: `attendance_${from.value}_${to.value}.csv` }); document.body.append(a); a.click(); a.remove(); } }, "Download CSV");
    document.getElementById("pane").append(h("div", { class: "bar" }, h("div", {}, h("label", {}, "From"), from), h("div", {}, h("label", {}, "To"), to), h("button", { class: "primary", style: "width:auto", onclick: load }, "Show"), csv), out, dlg);
    load();
  }

  /* ---------- people ---------- */
  function showPeople() {
    const code = h("input", { type: "text" }), name = h("input", { type: "text" }), note = h("div", { class: "err" }), list = h("div", { class: "card scroll" });
    const add = h("button", { class: "primary", onclick: async () => { try { const r = await api("POST", "/hr/employees", { code: code.value, name: name.value }); note.style.color = "var(--ok)"; note.textContent = `Created ${r.name}. First PIN: ${r.pin} (shown once, share it privately).`; code.value = name.value = ""; load(); } catch (e) { note.style.color = ""; note.textContent = e.message; } } }, "Add employee");
    const act = (label, fn, cls) => h("button", { class: cls || "", onclick: async () => { try { await fn(); } catch (e) { alert(e.message); } } }, label);
    async function load() {
      const { employees } = await api("GET", "/hr/employees");
      list.replaceChildren(h("table", {}, h("thead", {}, h("tr", {}, ["Employee", "Consent", "Face", "Face ID", "Actions"].map((t) => h("th", {}, t)))), h("tbody", {}, employees.map((e) => h("tr", {},
        h("td", {}, e.name, h("div", { class: "mute" }, e.code, e.active ? "" : " · inactive")), h("td", {}, e.consent ? "Yes" : "No"), h("td", {}, e.faceEnrolled ? "Enrolled" : "Not yet"), h("td", {}, e.passkeys ? `${e.passkeys} device${e.passkeys > 1 ? "s" : ""}` : "None"),
        h("td", {}, !e.external && act("New PIN", async () => { const r = await api("POST", `/hr/employees/${e.id}/reset-pin`); alert(`New PIN for ${e.name}: ${r.pin}`); }), " ",
          e.faceEnrolled && act("Reset face", async () => { if (confirm(`Delete ${e.name}'s face template? They will have to enrol again.`)) { await api("POST", `/hr/employees/${e.id}/reset-face`); load(); } }), " ",
          e.passkeys > 0 && act("Lost phone", async () => { if (confirm(`Remove ${e.name}'s Face ID / fingerprint sign-in on all phones?`)) { await api("POST", `/hr/employees/${e.id}/reset-passkeys`); load(); } }), " ",
          act(e.active ? "Deactivate" : "Activate", async () => { await api("POST", `/hr/employees/${e.id}/active`, { active: !e.active }); load(); }, e.active ? "danger" : "")))))));
    }
    document.getElementById("pane").append(h("div", { class: "card" }, h("h2", {}, "Add employee"), h("div", { class: "grid2" }, h("div", {}, h("label", {}, "Employee code"), code), h("div", {}, h("label", {}, "Name"), name)), note, h("div", { style: "height:10px" }), add), list);
    load();
  }

  /* ---------- offices ---------- */
  function showOffices() {
    const name = h("input", { type: "text" }), lat = h("input", { type: "number", step: "any" }), lng = h("input", { type: "number", step: "any" }), rad = h("input", { type: "number", value: "150" }), note = h("div", { class: "err" }), list = h("div", { class: "card scroll" });
    const here = h("button", { onclick: () => navigator.geolocation.getCurrentPosition((p) => { lat.value = p.coords.latitude.toFixed(6); lng.value = p.coords.longitude.toFixed(6); }, () => { note.textContent = "Could not read this device's location."; }, { enableHighAccuracy: true }) }, "Use my current location");
    const add = h("button", { class: "primary", onclick: async () => { try { await api("POST", "/hr/offices", { name: name.value, lat: Number(lat.value), lng: Number(lng.value), radiusM: Number(rad.value) }); note.textContent = ""; name.value = lat.value = lng.value = ""; load(); } catch (e) { note.textContent = e.message; } } }, "Add office");
    async function load() {
      const { offices } = await api("GET", "/hr/live");
      list.replaceChildren(offices.length ? h("table", {}, h("thead", {}, h("tr", {}, ["Office", "Location", "Radius", "QR code", ""].map((t) => h("th", {}, t)))), h("tbody", {}, offices.map((o) => h("tr", {}, h("td", {}, o.name), h("td", {}, `${o.lat.toFixed(5)}, ${o.lng.toFixed(5)}`), h("td", {}, `${o.radiusM} m`), h("td", {}, h("a", { href: `${BASE}/ui/poster.html?office=${encodeURIComponent(o.id)}&name=${encodeURIComponent(o.name)}`, target: "_blank", rel: "noopener" }, "Print poster")), h("td", {}, h("button", { class: "danger", onclick: async () => { if (confirm(`Remove ${o.name}?`)) { await api("DELETE", `/hr/offices/${o.id}`); load(); } } }, "Remove")))))) : h("div", { class: "mute" }, "No office yet. Without one, staff can only check in as On duty or Remote."));
    }
    document.getElementById("pane").append(h("div", { class: "card" }, h("h2", {}, "Staff QR code"), h("div", { class: "mute" }, "Print a poster for each office (see the table below). Staff scan it with their phone camera to open the check-in page. It is a shortcut, not proof of presence: the location check still applies."), h("a", { href: `${BASE}/ui/poster.html`, target: "_blank", rel: "noopener" }, "Print a general staff QR poster")),
      h("div", { class: "card" }, h("h2", {}, "Add office or site"), h("div", { class: "mute" }, "Staff can check in as \"In office\" only within the radius. Stand at the site and use your current location."),
      h("label", {}, "Name"), name, h("div", { class: "grid2" }, h("div", {}, h("label", {}, "Latitude"), lat), h("div", {}, h("label", {}, "Longitude"), lng)), h("label", {}, "Radius (metres, 20 to 5000)"), rad, note, h("div", { style: "display:flex;gap:8px;margin-top:10px" }, here, add)), list);
    load();
  }

  setInterval(() => { if (tab === "live" && token) paintLive(); }, 60000); // refresh "x min ago"
  draw();
})();
