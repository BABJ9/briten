import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\\/+$/, "");
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
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
  const missing = keys.filter(key => !process.env[key]);
  if (missing.length) throw new HttpError(503, `Trade-Me is not configured. Missing: ${missing.join(", ")}.`);
}
function bearer(req) {
  const match = String(req.headers.authorization || "").match(/^Bearer\\s+(.+)$/i);
  return match ? match[1] : "";
}
async function requireUser(req) {
  const token = bearer(req);
  if (!token) throw new HttpError(401, "Sign in to continue.");
  requiredEnv("SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY");
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(12000)
  });
  const user = await response.json().catch(() => ({}));
  if (!response.ok || !user.id) throw new HttpError(401, "Your session has expired. Please sign in again.");
  return { user, token };
}

const TRADING_SYSTEM = `You are Trade-Me AI, a careful, highly analytical trading-chart interpreter. You are NOT a general-purpose assistant and must focus on financial-market chart analysis.

Analyze only evidence visible in the user's uploaded chart/screenshot and the user's question. Do not claim access to live prices, order books, news, indicators, or market feeds unless they are explicitly present in the screenshot or supplied by the user. Never invent the asset, timeframe, price, indicator values, or candle data. If the screenshot is unclear or insufficient, say exactly what is missing and prefer WAIT.

For every chart analysis, provide these sections:
1. MARKET READ: identify asset/timeframe only when legible; describe trend, structure, momentum, support/resistance and visible indicators.
2. TRADE BIAS: exactly one of BUY, SELL, WAIT, or NEUTRAL.
3. SETUP: entry zone, invalidation/stop-loss idea, and take-profit levels. If exact levels cannot be read or reasonably derived from visible scale, say "Not reliably identifiable" instead of fabricating numbers.
4. CONFIDENCE: 0-100 with a brief reason. Confidence is analytical uncertainty, not a probability guarantee.
5. RISK CHECK: key failure conditions, risk/reward considerations, and what confirmation is needed.
6. FINAL VERDICT: concise actionable summary.

If the user asks a normal question, answer naturally but keep the context focused on trading, risk, market structure, and education. Never promise profit or guaranteed accuracy. Do not encourage reckless leverage. This is analysis, not personalized financial advice.`;

function parseSignal(text) {
  const match = text.match(/(?:TRADE BIAS|BIAS|SIGNAL)\\s*[:：\\-]*\\s*(BUY|SELL|WAIT|NEUTRAL)/i);
  return match ? match[1].toUpperCase() : "WAIT";
}
function parseConfidence(text) {
  const match = text.match(/CONFIDENCE\\s*[:：\\-]*\\s*(\\d{1,3})\\s*%?/i);
  return match ? Math.min(100, Number(match[1])) : null;
}
async function callGemini(history, currentParts) {
  requiredEnv("GEMINI_API_KEY");
  const contents = [];
  for (const item of history) {
    if (!item || typeof item.content !== "string") continue;
    const role = item.role === "assistant" || item.role === "model" ? "model" : "user";
    contents.push({ role, parts: [{ text: item.content.slice(0, 6000) }] });
  }
  contents.push({ role: "user", parts: currentParts });
  let response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: TRADING_SYSTEM }] },
        contents,
        generationConfig: { temperature: 0.2, topP: 0.85, maxOutputTokens: 1800 }
      }),
      signal: AbortSignal.timeout(90000)
    });
  } catch (error) {
    throw new HttpError(502, error.name === "TimeoutError" ? "Gemini took too long to analyze this. Please retry." : "Gemini is temporarily unreachable.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.error?.message || "Gemini rejected the request.";
    throw new HttpError(response.status === 429 ? 429 : 502, String(detail).slice(0, 300));
  }
  const reply = (data.candidates?.[0]?.content?.parts || []).map(part => part.text || "").join("\\n").trim();
  if (!reply) throw new HttpError(502, "Gemini returned an empty analysis. Try a clearer screenshot.");
  return reply;
}
async function saveAnalysis(token, userId, body, reply) {
  const signal = parseSignal(reply);
  const confidence = parseConfidence(reply);
  const record = {
    user_id: userId,
    symbol: String(body.symbol || "").slice(0, 40) || null,
    timeframe: String(body.timeframe || "").slice(0, 30) || null,
    prompt: String(body.message || "Analyze uploaded trading screenshot").slice(0, 5000),
    analysis: reply,
    signal,
    confidence
  };
  const response = await fetch(`${SUPABASE_URL}/rest/v1/trade_analyses`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify(record),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    const error = await response.text().catch(() => "");
    console.error("Could not save trade analysis:", response.status, error.slice(0, 300));
    return { saved: false, analysisId: null };
  }
  const rows = await response.json().catch(() => []);
  return { saved: true, analysisId: rows[0]?.id || null };
}
async function handleApi(req, res, url) {
  if (url.pathname === "/api/health" && req.method === "GET") {
    return json(res, 200, {
      ok: true, app: "Trade-Me", status: "ready",
      configured: {
        authentication: Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY),
        database: Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY),
        ai: Boolean(GEMINI_API_KEY),
        model: GEMINI_MODEL
      }
    });
  }
  if (url.pathname !== "/api/trading/analyze" || req.method !== "POST") throw new HttpError(404, "Trade-Me endpoint not found.");
  const { user, token } = await requireUser(req);
  const body = await readBody(req);
  const message = String(body.message || "").trim();
  const images = Array.isArray(body.images) ? body.images.slice(0, 4) : [];
  if (!message && !images.length) throw new HttpError(400, "Upload a chart screenshot or ask a trading question.");
  if (message.length > 12000) throw new HttpError(400, "Keep your message under 12,000 characters.");
  const history = Array.isArray(body.history) ? body.history.slice(-16).filter(item => item && ["user", "assistant", "model"].includes(item.role) && typeof item.content === "string") : [];
  const parts = [{ text: message || "Analyze this trading chart screenshot carefully." }];
  let totalBytes = 0;
  for (const item of images) {
    const raw = String(item?.data || "");
    const match = raw.match(/^data:(image\\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new HttpError(400, "Use PNG, JPG or WEBP chart screenshots.");
    const bytes = Buffer.from(match[2], "base64");
    totalBytes += bytes.length;
    if (!bytes.length || bytes.length > 8 * 1024 * 1024 || totalBytes > 16 * 1024 * 1024) throw new HttpError(413, "Each image must be under 8 MB and total image size under 16 MB.");
    parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
  }
  const reply = await callGemini(history, parts);
  const stored = await saveAnalysis(token, user.id, body, reply);
  return json(res, 200, {
    reply, model: GEMINI_MODEL, provider: "Google Gemini",
    signal: parseSignal(reply), confidence: parseConfidence(reply), ...stored
  });
}

const MIME = { ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".svg":"image/svg+xml", ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".webp":"image/webp", ".ico":"image/x-icon", ".json":"application/json; charset=utf-8" };
async function staticFile(req, res, url) {
  if (url.pathname === "/config.js") {
    const config = { supabaseUrl: SUPABASE_URL, supabasePublishableKey: SUPABASE_PUBLISHABLE_KEY };
    res.writeHead(200, { "Content-Type":"text/javascript; charset=utf-8", "Cache-Control":"no-store", "X-Content-Type-Options":"nosniff" });
    return res.end(`window.TRADEME_CONFIG=${JSON.stringify(config)};`);
  }
  const relative = url.pathname === "/" ? "index.html" : (url.pathname === "/login" || url.pathname === "/login/") ? "login.html" : decodeURIComponent(url.pathname).replace(/^\\/+/, "");
  if (relative.includes("..") || relative.includes("\\\\") || relative.startsWith("api/")) return json(res, 404, { error:"Not found." });
  const target = path.join(PUBLIC, relative);
  if (!target.startsWith(PUBLIC + path.sep)) return json(res, 404, { error:"Not found." });
  try {
    const content = await fs.readFile(target);
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, { "Content-Type":MIME[ext] || "application/octet-stream", "Cache-Control":ext === ".html" ? "no-store" : "public, max-age=300", "X-Content-Type-Options":"nosniff", "Referrer-Policy":"strict-origin-when-cross-origin", "X-Frame-Options":"DENY" });
    res.end(content);
  } catch { json(res, 404, { error:"Not found." }); }
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) { await handleApi(req, res, url); return; }
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error:"Method not allowed." });
    await staticFile(req, res, url);
  } catch (error) {
    const status = Number(error.status || 500);
    if (status >= 500) console.error("Trade-Me request failed:", error.message || error);
    if (!res.headersSent) json(res, status, { error:status >= 500 && status !== 503 ? "Trade-Me could not complete that request. Please retry." : error.message });
    else res.end();
  }
});
server.listen(PORT, "0.0.0.0", () => console.log(`Trade-Me listening on ${PORT}; Gemini model ${GEMINI_MODEL}`));
