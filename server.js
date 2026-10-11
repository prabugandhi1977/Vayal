// Vayal web server for Render: serves the storefront and proxies the in-app AI
// features (Vayal Mitra chat, photo shopping lists, AI meal plans) to Claude.
// The Anthropic API key stays on the server; the browser never sees it.
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MODEL = process.env.VAYAL_CLAUDE_MODEL || "claude-opus-5-5";
const EFFORT = process.env.VAYAL_CLAUDE_EFFORT || "low";
const PER_IP_LIMIT = Number(process.env.AI_REQUESTS_PER_IP_PER_HOUR || 60);
const DAILY_LIMIT = Number(process.env.AI_REQUESTS_PER_DAY || 2000);
const AI_ON = Boolean(process.env.ANTHROPIC_API_KEY);

const client = AI_ON ? new Anthropic() : null;

// Server-side scope rule, placed ahead of the page's own instructions so the
// proxy can't be used as a general-purpose chatbot.
const SCOPE = `You are the AI assistant inside Vayal, an organic farm-to-kitchen grocery app in Chennai.
Only help with groceries, food, cooking, nutrition, storage and the user's shopping on Vayal.
Politely decline anything unrelated and steer back to food and shopping.`;

// Only the tools the storefront defines may be forwarded.
const ALLOWED_TOOLS = new Set(["add_to_cart", "add_recipe_to_cart", "show_product"]);
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/* ---------- rate limiting (in memory; resets when the service restarts) ---------- */
const hits = new Map();
let day = new Date().toISOString().slice(0, 10);
let dayCount = 0;
function allow(ip) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; dayCount = 0; hits.clear(); }
  if (dayCount >= DAILY_LIMIT) return false;
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  if (recent.length >= PER_IP_LIMIT) { hits.set(ip, recent); return false; }
  recent.push(now);
  hits.set(ip, recent);
  dayCount++;
  return true;
}

/* ---------- request validation ---------- */
function cleanMessages(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 40) return null;
  const out = [];
  for (const m of raw) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) return null;
    if (typeof m.content !== "string" && !Array.isArray(m.content)) return null;
    out.push({ role: m.role, content: m.content });
  }
  return out[0].role === "user" ? out : null;
}
function cleanTools(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const t of raw) {
    if (!t || !ALLOWED_TOOLS.has(t.name) || typeof t.input_schema !== "object") return null;
    out.push({
      name: t.name,
      description: String(t.description || "").slice(0, 500),
      input_schema: t.input_schema,
      eager_input_streaming: true,
    });
  }
  return out;
}
function errorCode(err) {
  if (err instanceof Anthropic.RateLimitError) return "rate_limited";
  if (err instanceof Anthropic.APIUserAbortError) return "cancelled";
  if (err instanceof Anthropic.BadRequestError) return "bad_request";
  if (err instanceof Anthropic.AuthenticationError) return "sampling_disabled";
  return "upstream_error";
}

/* ---------- app ---------- */
const app = express();
app.set("trust proxy", 1);

app.get("/api/health", (_req, res) => res.json({ ok: true, ai: AI_ON }));

function guard(req, res, next) {
  if (!AI_ON) return res.status(503).json({ code: "sampling_disabled" });
  if (!allow(req.ip)) return res.status(429).json({ code: "rate_limited" });
  next();
}

// Chat turn. Streams newline-delimited JSON: {t:"d",v:"text delta"} ... then
// {t:"m",content,stop_reason} with the full assistant message, or {t:"e",code}.
// The browser runs the tools itself and calls this again with the results.
app.post("/api/chat", express.json({ limit: "400kb" }), guard, async (req, res) => {
  const messages = cleanMessages(req.body?.messages);
  const tools = cleanTools(req.body?.tools);
  if (!messages || !tools) return res.status(400).json({ code: "bad_request" });
  const system = [SCOPE, String(req.body?.system || "").slice(0, 60000)].filter(Boolean).join("\n\n");

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: EFFORT },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    messages,
    ...(tools.length ? { tools } : {}),
  });
  res.on("close", () => { if (!res.writableEnded) stream.abort(); });
  stream.on("text", (delta) => send({ t: "d", v: delta }));

  try {
    const msg = await stream.finalMessage();
    send({ t: "m", content: msg.content, stop_reason: msg.stop_reason });
  } catch (err) {
    if (!(err instanceof Anthropic.APIUserAbortError)) console.error("chat error:", err.status ?? "", err.message);
    send({ t: "e", code: errorCode(err), upstream: err.status ?? null, detail: String(err.message || "").slice(0, 300) });
  }
  res.end();
});

// One-shot JSON answer, optionally about one image (photo of a shopping list).
app.post("/api/json", express.json({ limit: "8mb" }), guard, async (req, res) => {
  const prompt = String(req.body?.prompt || "").slice(0, 20000);
  const image = req.body?.image;
  if (!prompt) return res.status(400).json({ code: "bad_request" });
  const content = [];
  if (image) {
    if (!IMAGE_TYPES.has(image.media_type) || typeof image.data !== "string" || image.data.length > 7_000_000)
      return res.status(400).json({ code: "bad_request" });
    content.push({ type: "image", source: { type: "base64", media_type: image.media_type, data: image.data } });
  }
  content.push({ type: "text", text: prompt + "\n\nReply with only the JSON, no other text." });

  try {
    const msg = await client.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: EFFORT },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SCOPE,
      messages: [{ role: "user", content }],
    }).finalMessage();
    if (msg.stop_reason === "refusal") return res.status(422).json({ code: "refused" });
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const match = text.match(/[\[{][\s\S]*[\]}]/);
    if (!match) return res.status(502).json({ code: "bad_output" });
    res.json({ json: JSON.parse(match[0]) });
  } catch (err) {
    if (err instanceof SyntaxError) return res.status(502).json({ code: "bad_output" });
    console.error("json error:", err.status ?? "", err.message);
    res.status(err instanceof Anthropic.RateLimitError ? 429 : 502).json({ code: errorCode(err), upstream: err.status ?? null, detail: String(err.message || "").slice(0, 300) });
  }
});

// Static storefront. Only the page itself is served, never the server source.
const page = path.join(here, "index.html");
app.get(["/", "/index.html"], (_req, res) => res.sendFile(page));
app.use((_req, res) => res.status(404).send("Not found"));

app.listen(PORT, () => console.log(`Vayal listening on :${PORT} (AI ${AI_ON ? `on, ${MODEL}` : "off: set ANTHROPIC_API_KEY"})`));
