import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "";
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";
const CLOUDFLARE_MODEL = "@cf/qwen/qwen3.8-27b";
const CLOUDFLARE_URL = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`;
const MAX_BODY = 36 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(data));
}
async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "Request is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "Request body must be valid JSON."); }
}
function requiredEnv(...keys) {
  const missing = keys.filter(k => !process.env[k]);
  if (missing.length) throw new HttpError(503, "Trade-Me is not configured. Missing: " + missing.join(", ") + ".");
}
async function requireUser(req) {
  const token = (String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i) || [])[1] || "";
  if (!token) throw new HttpError(401, "Sign in to continue.");
  requiredEnv("SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY");
  const r = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: "Bearer " + token, Accept: "application/json" },
    signal: AbortSignal.timeout(12000)
  });
  const user = await r.json().catch(() => ({}));
  if (!r.ok || !user.id) throw new HttpError(401, "Your session has expired. Please sign in again.");
  return { user, token };
}

const SYSTEM_PROMPT = "You are Trade-Me's institutional-style technical analysis engine. Produce a clear, disciplined trading terminal report inspired by the depth and information hierarchy of leading professional exchange chart-analysis screens, but do not mention, imitate logos, or claim affiliation with any exchange or third-party service. Analyze ONLY what is visible in uploaded chart screenshots and details supplied by the user. Do not claim live market access, current prices, order-book data, funding, open interest, news, or indicator values unless explicitly visible/provided. Never fabricate price levels, candles, indicators, timestamps or market data. If the screenshot is blurry, cropped, missing its price scale, or ambiguous, clearly state the limitation and default to WAIT.\n\nFor every chart analysis use this exact structured report, with concise, specific bullet points:\n1. MARKET SNAPSHOT — asset/pair and timeframe (use Unknown if not shown), visible price context, session/context only if evidenced.\n2. TREND & MARKET STRUCTURE — bullish/bearish/ranging; swing highs/lows; HH/HL or LH/LL; BOS/CHOCH only when clearly evidenced; momentum and candle behaviour.\n3. KEY LEVELS — support, resistance, supply/demand or liquidity zones; give exact prices only when readable, otherwise describe the zone without guessing.\n4. INDICATOR READ — interpret only indicators visibly present and legible; otherwise say Not visible.\n5. TRADE PLAN — BIAS: exactly BUY, SELL, WAIT or NEUTRAL; setup type; entry or entry zone; stop/invalidation; TP1, TP2 and TP3 if justified; estimated risk/reward only when levels allow calculation. For every unavailable level write Not reliably identifiable. Never force a trade.\n6. CONFIRMATION CHECKLIST — concrete candle close, retest, breakout, rejection or momentum evidence needed before entry.\n7. INVALIDATION & RISK — what would disprove the setup, nearby opposing levels, volatility/stop placement cautions, and why standing aside may be better.\n8. CONFIDENCE — 0–100 score for the quality/completeness of the visible evidence, NOT a probability of profit or win rate; explain the score.\n9. FINAL VERDICT — one-line actionable summary: BUY / SELL / WAIT / NEUTRAL, with the key reason.\n\nKeep the analysis balanced and avoid false precision. If the user asks a follow-up question, answer conversationally but preserve the same evidence-only discipline. Never promise profit, guarantee accuracy, or encourage reckless leverage. This is educational chart interpretation, not personalized financial advice. Do not give financial advice disclaimers repeatedly; keep one concise risk reminder when relevant.";

function signalOf(s) {
  const m = s.match(/(?:TRADE BIAS|BIAS|SIGNAL)\s*[:：-]*\s*(BUY|SELL|WAIT|NEUTRAL)/i);
  return m ? m[1].toUpperCase() : "WAIT";
}
function confidenceOf(s) {
  const m = s.match(/CONFIDENCE\s*[:：-]*\s*(\d{1,3})\s*%?/i);
  return m ? Math.min(100, Number(m[1])) : null;
}

async function callCloudflare(history, parts) {
  requiredEnv("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN");
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const item of history) {
    if (!item || typeof item.content !== "string") continue;
    messages.push({ role: item.role === "assistant" || item.role === "model" ? "assistant" : "user", content: item.content.slice(0, 6000) });
  }
  const content = parts.map(part => part.inlineData
    ? { type: "image_url", image_url: { url: "data:" + part.inlineData.mimeType + ";base64," + part.inlineData.data } }
    : { type: "text", text: part.text });
  messages.push({ role: "user", content });
  let r;
  try {
    r = await fetch(CLOUDFLARE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + CLOUDFLARE_API_TOKEN },
      body: JSON.stringify({ model: CLOUDFLARE_MODEL, messages, temperature: 0.2, max_tokens: 1800 }),
      signal: AbortSignal.timeout(90000)
    });
  } catch (e) {
    throw new HttpError(502, e.name === "TimeoutError" ? "Cloudflare AI took too long. Please retry." : "Cloudflare AI is temporarily unreachable.");
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.success === false) {
    const detail = (data.errors || []).map(x => x.message).filter(Boolean).join("; ") || "Cloudflare rejected the request.";
    console.error("Cloudflare AI error:", r.status, detail.slice(0, 300));
    throw new HttpError(r.status === 429 ? 429 : 502, r.status === 401 || r.status === 403
      ? "Cloudflare authentication failed. Check the Workers AI token permissions."
      : detail.includes("license") || detail.includes("License")
        ? "Cloudflare requires you to accept the model's Meta license before its first use."
        : "Cloudflare AI could not complete the request. Check the model and account configuration.");
  }
  const raw = data.choices?.[0]?.message?.content ?? data.result?.response ?? data.result?.output_text ?? data.result?.content ?? data.response;
  const answer = Array.isArray(raw) ? raw.map(x => x.text || "").join("\n").trim() : String(raw || "").trim();
  if (!answer) throw new HttpError(502, "Cloudflare AI returned an empty analysis. Please retry with a clearer screenshot.");
  return { answer, model: CLOUDFLARE_MODEL };
}

async function saveAnalysis(token, user, body, analysis) {
  const record = {
    user_id: user.id,
    symbol: String(body.symbol || "").slice(0, 40) || null,
    timeframe: String(body.timeframe || "").slice(0, 30) || null,
    prompt: String(body.message || "Analyze uploaded trading screenshot").slice(0, 5000),
    analysis, signal: signalOf(analysis), confidence: confidenceOf(analysis)
  };
  const r = await fetch(SUPABASE_URL + "/rest/v1/trade_analyses", {
    method: "POST",
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: "Bearer " + token, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(record), signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) {
    console.error("Analysis save failed:", r.status, (await r.text().catch(() => "")).slice(0, 250));
    return { saved: false, analysisId: null };
  }
  const rows = await r.json().catch(() => []);
  return { saved: true, analysisId: rows[0]?.id || null };
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/health" && req.method === "GET") {
    return json(res, 200, {
      ok: true, app: "Trade-Me", status: "ready",
      configured: {
        authentication: Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY),
        database: Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY),
        ai: Boolean(CLOUDFLARE_ACCOUNT_ID && CLOUDFLARE_API_TOKEN),
        provider: "Cloudflare Workers AI", model: CLOUDFLARE_MODEL
      }
    });
  }
  if (url.pathname !== "/api/trading/analyze" || req.method !== "POST") throw new HttpError(404, "Trade-Me endpoint not found.");
  const auth = await requireUser(req);
  const body = await readBody(req);
  const message = String(body.message || "").trim();
  const images = Array.isArray(body.images) ? body.images.slice(0, 4) : [];
  if (!message && !images.length) throw new HttpError(400, "Upload a chart screenshot or ask a trading question.");
  if (message.length > 12000) throw new HttpError(400, "Keep your message under 12,000 characters.");
  const history = Array.isArray(body.history) ? body.history.slice(-16).filter(x => x && ["user", "assistant", "model"].includes(x.role) && typeof x.content === "string") : [];
  const parts = [{ text: message || "Analyze this trading chart screenshot carefully." }];
  let total = 0;
  for (const item of images) {
    const raw = String(item?.data || "");
    const m = raw.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw new HttpError(400, "Use PNG, JPG or WEBP screenshots only.");
    const bytes = Buffer.from(m[2], "base64");
    total += bytes.length;
    if (!bytes.length || bytes.length > 8 * 1024 * 1024 || total > 16 * 1024 * 1024) throw new HttpError(413, "Each image must be under 8 MB and total image size under 16 MB.");
    parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
  }
  const result = await callCloudflare(history, parts);
  const reply = result.answer;
  const saved = await saveAnalysis(auth.token, auth.user, body, reply);
  return json(res, 200, { reply, model: result.model, provider: "Cloudflare Workers AI", signal: signalOf(reply), confidence: confidenceOf(reply), ...saved });
}

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".json": "application/json; charset=utf-8" };
async function staticFile(req, res, url) {
  if (url.pathname === "/config.js") {
    const cfg = { supabaseUrl: SUPABASE_URL, supabasePublishableKey: SUPABASE_PUBLISHABLE_KEY };
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    return res.end("window.TRADEME_CONFIG=" + JSON.stringify(cfg) + ";");
  }
  const relative = url.pathname === "/" ? "index.html" : (url.pathname === "/login" || url.pathname === "/login/") ? "login.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (relative.includes("..") || relative.includes("\\") || relative.startsWith("api/")) return json(res, 404, { error: "Not found." });
  const target = path.join(PUBLIC, relative);
  if (!target.startsWith(PUBLIC + path.sep)) return json(res, 404, { error: "Not found." });
  try {
    const content = await fs.readFile(target), ext = path.extname(target).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=300", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "X-Frame-Options": "DENY" });
    res.end(content);
  } catch { json(res, 404, { error: "Not found." }); }
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://" + (req.headers.host || "localhost"));
  try {
    if (url.pathname.startsWith("/api/")) { await handleApi(req, res, url); return; }
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Method not allowed." });
    await staticFile(req, res, url);
  } catch (e) {
    const status = Number(e.status || 500);
    if (status >= 500) console.error("Trade-Me request failed:", e.message || e);
    if (!res.headersSent) json(res, status, { error: status >= 500 && status !== 503 ? "Trade-Me could not complete that request. Please retry." : e.message });
    else res.end();
  }
});
server.listen(PORT, "0.0.0.0", () => console.log("Trade-Me listening on " + PORT + "; Cloudflare Workers AI " + CLOUDFLARE_MODEL));
