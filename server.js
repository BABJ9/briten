import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "";
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const MAX_BODY = 12 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function requiredEnv(...keys) {
  const missing = keys.filter((key) => !process.env[key]);
  if (missing.length) throw new HttpError(503, `Server configuration is incomplete: ${missing.join(", ")}.`);
}

function bearer(req) {
  const value = String(req.headers.authorization || "");
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

async function supabaseAuthUser(token) {
  requiredEnv("SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY");
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(12000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.id) throw new HttpError(401, "Your session is invalid or has expired. Please sign in again.");
  return data;
}

async function requireUser(req) {
  const token = bearer(req);
  if (!token) throw new HttpError(401, "Sign in to continue.");
  const user = await supabaseAuthUser(token);
  return { id: user.id, email: user.email || "", name: user.user_metadata?.full_name || user.user_metadata?.name || "" };
}

async function supabaseRequest(endpoint, { method = "GET", body, prefer = "" } = {}) {
  requiredEnv("SUPABASE_URL");
  if (!SUPABASE_SECRET_KEY) throw new HttpError(503, "Server configuration is incomplete: SUPABASE_SECRET_KEY.");
  const headers = {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    Accept: "application/json"
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { message: raw.slice(0, 300) }; }
  if (!response.ok) {
    const message = data?.message || data?.hint || data?.details || "Supabase database request failed.";
    throw new HttpError(response.status >= 500 ? 503 : 400, String(message).slice(0, 300), data);
  }
  return data;
}

async function dbSelect(table, params) {
  return supabaseRequest(`${table}?${new URLSearchParams(params).toString()}`);
}
async function dbInsert(table, row) {
  const rows = await supabaseRequest(table, { method: "POST", body: row, prefer: "return=representation" });
  return Array.isArray(rows) ? rows[0] : rows;
}
async function dbPatch(table, params, patch) {
  return supabaseRequest(`${table}?${new URLSearchParams(params).toString()}`, {
    method: "PATCH", body: patch, prefer: "return=representation"
  });
}
async function rpc(name, args) {
  return supabaseRequest(`rpc/${name}`, { method: "POST", body: args });
}

function technicalSnapshot(rows, timeframe = "5") {
  const intervalMs = timeframe === "D" ? 86400000 : timeframe === "W" ? 604800000 : Number(timeframe) * 60000;
  const candles = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      time: Number(row?.[0]),
      open: Number(row?.[1]),
      high: Number(row?.[2]),
      low: Number(row?.[3]),
      close: Number(row?.[4]),
      volume: Number(row?.[5])
    }))
    .filter((c) => [c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite))
    .filter((c) => c.time + intervalMs <= Date.now())
    .reverse();

  if (!candles.length) throw new HttpError(502, "Bybit returned no usable candle data.");

  const closes = candles.map((c) => c.close);
  const ema = (period) => {
    if (closes.length < period) return null;
    const alpha = 2 / (period + 1);
    let value = closes.slice(0, period).reduce((sum, price) => sum + price, 0) / period;
    for (let i = period; i < closes.length; i++) value = closes[i] * alpha + value * (1 - alpha);
    return value;
  };

  const changes = [];
  for (let i = Math.max(1, closes.length - 14); i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }
  const gains = changes.reduce((sum, change) => sum + Math.max(0, change), 0);
  const losses = changes.reduce((sum, change) => sum + Math.max(0, -change), 0);
  const rsi = changes.length
    ? losses === 0 ? (gains === 0 ? 50 : 100) : 100 - 100 / (1 + gains / losses)
    : null;

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2] || last;
  const priorVolumes = candles.slice(-21, -1).map((c) => c.volume);
  const averageVolume = priorVolumes.length
    ? priorVolumes.reduce((sum, volume) => sum + volume, 0) / priorVolumes.length
    : 0;
  const trueRanges = [];
  for (let i = Math.max(1, candles.length - 14); i < candles.length; i++) {
    const current = candles[i];
    const priorClose = candles[i - 1].close;
    trueRanges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - priorClose),
      Math.abs(current.low - priorClose)
    ));
  }

  return {
    last_price: last.close,
    previous_close: previous.close,
    ema_20: ema(20),
    ema_50: ema(50),
    rsi_14: rsi,
    volume_ratio: averageVolume > 0 ? last.volume / averageVolume : null,
    atr_14: trueRanges.length ? trueRanges.reduce((sum, value) => sum + value, 0) / trueRanges.length : null,
    candle_count: candles.length
  };
}

function buildFiveMinuteSignal(market, now = new Date()) {
  const frames = market.multi_timeframe || {};
  const bias = (frame) => {
    if (!frame || frame.ema_20 == null || frame.ema_50 == null) return 0;
    if (frame.last_price > frame.ema_20 && frame.ema_20 > frame.ema_50) return 1;
    if (frame.last_price < frame.ema_20 && frame.ema_20 < frame.ema_50) return -1;
    return 0;
  };
  const score = bias(frames["5"]) * 2 + bias(frames["15"]) * 1.5 +
    bias(frames["60"]) + bias(frames["240"]) * 0.5;
  const five = frames["5"] || market.technicals || {};
  const rsiValue = Number(five.rsi_14);
  const volumeRatio = Number(five.volume_ratio);
  let adjusted = score;
  if (Number.isFinite(rsiValue)) {
    if (rsiValue >= 52 && rsiValue <= 68) adjusted += 1;
    else if (rsiValue >= 32 && rsiValue <= 48) adjusted -= 1;
    else if (rsiValue > 75 || rsiValue < 25) adjusted *= 0.65;
  }
  if (Number.isFinite(volumeRatio) && volumeRatio >= 1.2) {
    if (five.last_price > five.previous_close) adjusted += 0.75;
    else if (five.last_price < five.previous_close) adjusted -= 0.75;
  }
  const imbalance = Number(market.orderbook_top5?.imbalance);
  if (Number.isFinite(imbalance) && imbalance > 0.2) adjusted += 0.5;
  else if (Number.isFinite(imbalance) && imbalance < -0.2) adjusted -= 0.5;

  const flags = [];
  if (market.spread_percent != null && market.spread_percent > 0.15) flags.push("Spread is elevated");
  if (Number.isFinite(volumeRatio) && volumeRatio < 0.6) flags.push("Relative volume is too thin");
  if (!Number.isFinite(Number(five.atr_14)) || Number(five.atr_14) <= 0) flags.push("ATR is unavailable");
  if (bias(frames["5"]) === 0) flags.push("Five-minute trend is not aligned");
  const direction = flags.includes("ATR is unavailable") || flags.includes("Five-minute trend is not aligned") || flags.length >= 2 ? "WAIT" : adjusted >= 4 ? "BUY" : adjusted <= -4 ? "SELL" : "WAIT";
  const entry = Number(market.last_price || five.last_price);
  const atr = Number(five.atr_14);
  const riskDistance = atr > 0 ? atr * 1.25 : null;
  const stop = direction === "BUY" && riskDistance ? entry - riskDistance
    : direction === "SELL" && riskDistance ? entry + riskDistance : null;
  const target = direction === "BUY" && riskDistance ? entry + riskDistance * 1.8
    : direction === "SELL" && riskDistance ? entry - riskDistance * 1.8 : null;
  const rawScore = Math.round(Math.min(85, 50 + Math.abs(adjusted) * 5));
  const confidenceScore = direction === "WAIT" ? Math.min(60, rawScore) : rawScore;
  const confidenceLabel = confidenceScore >= 78 ? "HIGH" : confidenceScore >= 65 ? "MEDIUM" : "LOW";
  const generatedAt = now.getTime();
  const nextFiveMinuteClose = Math.floor(generatedAt / 300000) * 300000 + 300000;
  const rationale = direction === "WAIT"
    ? "The five-minute setup does not meet the signal threshold or market-quality checks. No trade is recommended."
    : `${direction} bias from five-minute EMA structure with higher-timeframe confirmation; RSI ${Number.isFinite(rsiValue) ? rsiValue.toFixed(1) : "n/a"}, relative volume ${Number.isFinite(volumeRatio) ? volumeRatio.toFixed(2) : "n/a"}x.`;
  return {
    timeframe: "5",
    direction,
    entry_price: Number.isFinite(entry) && entry > 0 ? entry : null,
    stop_loss: stop != null && stop > 0 ? stop : null,
    take_profit: target != null && target > 0 ? target : null,
    confidence_score: confidenceScore,
    confidence_label: confidenceLabel,
    evidence_score: Number(adjusted.toFixed(2)),
    rationale,
    risk_flags: flags,
    generated_at: new Date(generatedAt).toISOString(),
    expires_at: new Date(nextFiveMinuteClose).toISOString()
  };
}

async function settleExpiredTradeSignals(userId) {
  const due = await dbSelect("aurapay_trade_signals", {
    select: "id,symbol,category,direction,entry_price,stop_loss,take_profit,expires_at",
    user_id: `eq.${userId}`, outcome_status: "eq.PENDING",
    expires_at: `lte.${new Date().toISOString()}`, order: "expires_at.asc", limit: "30"
  });
  for (const signal of due) {
    if (signal.direction === "WAIT") {
      await dbPatch("aurapay_trade_signals", { id: `eq.${signal.id}`, user_id: `eq.${userId}` }, {
        outcome_status: "UNRESOLVED", outcome_at: new Date().toISOString()
      });
      continue;
    }
    const expires = new Date(signal.expires_at).getTime();
    const candleStart = expires - 300000;
    const query = new URLSearchParams({
      category: signal.category, symbol: signal.symbol, interval: "5",
      start: String(candleStart), end: String(expires), limit: "5"
    });
    const response = await fetch(`https://api.bybit.com/v5/market/kline?${query}`, { signal: AbortSignal.timeout(10000) });
    const payload = await response.json().catch(() => ({}));
    const row = (payload.result?.list || []).find(item => Number(item[0]) === candleStart);
    if (!response.ok || payload.retCode !== 0 || !row) continue;
    const high = Number(row[2]), low = Number(row[3]), close = Number(row[4]);
    const entry = Number(signal.entry_price);
    const stopHit = signal.direction === "BUY" ? low <= Number(signal.stop_loss) : high >= Number(signal.stop_loss);
    const targetHit = signal.direction === "BUY" ? high >= Number(signal.take_profit) : low <= Number(signal.take_profit);
    let outcome = "FLAT";
    if (stopHit && targetHit) outcome = "AMBIGUOUS";
    else if (targetHit) outcome = "CORRECT";
    else if (stopHit) outcome = "INCORRECT";
    else if (signal.direction === "BUY") outcome = close > entry ? "CORRECT" : close < entry ? "INCORRECT" : "FLAT";
    else outcome = close < entry ? "CORRECT" : close > entry ? "INCORRECT" : "FLAT";
    const returnPct = entry > 0 ? (signal.direction === "BUY" ? (close - entry) / entry : (entry - close) / entry) * 100 : null;
    await dbPatch("aurapay_trade_signals", { id: `eq.${signal.id}`, user_id: `eq.${userId}` }, {
      outcome_status: outcome, outcome_price: close,
      outcome_return_pct: returnPct, outcome_at: new Date().toISOString()
    });
  }
}

async function handleApi(req, res, url) {
  const route = url.pathname;
  const method = req.method || "GET";
  if (route === "/api/health" && method === "GET") {
    return json(res, 200, {
      ok: true,
      app: "Trade-Me",
      status: "ready",
      backend: "Supabase",
      hosting: "Render",
      configured: {
        supabase: !!(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY && SUPABASE_SECRET_KEY),
        ai: "Puter.js browser AI (user sign-in required)"
      },
      moneyMovement: "disabled-pending-new-provider"
    });
  }

  const user = await requireUser(req);

  if (route === "/api/ai/snapshot-analysis" && method === "POST") {
    requiredEnv("POLLINATIONS_API_KEY");
    const body = await readBody(req);
    const image = String(body.image || "");
    const match = image.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new HttpError(400, "Upload a valid PNG, JPG or WEBP trading screenshot.");
    const imageBytes = Buffer.from(match[2], "base64");
    if (!imageBytes.length || imageBytes.length > 8 * 1024 * 1024) {
      throw new HttpError(413, "Snapshot must be smaller than 8 MB.");
    }
    const prompt = "You are Trade-Me, a careful visual trading-chart analyst. Inspect the uploaded chart image itself, not OCR alone. Read the exchange, asset/symbol, timeframe, current visible price, chart type, candle structure, trend, momentum, support/resistance, volume and any visible indicators. Distinguish clearly between what is visible, what is inferred and what is unreadable. Never invent a price, indicator value, news item, probability or market fact. Do not imply that a screenshot provides live data. Provide these sections: 1) SNAPSHOT READ, 2) MARKET STRUCTURE, 3) BULLISH CASE, 4) BEARISH CASE, 5) KEY LEVELS, 6) TRADE SETUP (entry area, invalidation/stop and targets only if the image supports them), 7) RISK CHECK, 8) FINAL VERDICT. Say NO TRADE when evidence is incomplete, conflicting or the risk cannot be defined. Never promise profit or certainty. Do not place orders. This is educational analysis, not financial advice.";
    let response;
    try {
      response = await fetch("https://gen.pollinations.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.POLLINATIONS_API_KEY}`,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          model: "google/gemini-3.8-flash",
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: image } }
            ]
          }],
          temperature: 0.2,
          max_tokens: 1400
        }),
        signal: AbortSignal.timeout(90000)
      });
    } catch (error) {
      throw new HttpError(502, error.name === "TimeoutError" ? "Pollinations vision analysis timed out. Please retry." : "Pollinations could not be reached. Please retry.");
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = result.error?.message || result.message || "Pollinations rejected the snapshot analysis request.";
      throw new HttpError(response.status === 401 || response.status === 402 ? 502 : 502, String(message).slice(0, 280));
    }
    const analysis = result.choices?.[0]?.message?.content;
    if (typeof analysis !== "string" || !analysis.trim()) {
      throw new HttpError(502, "Pollinations returned an empty analysis. Please try again.");
    }
    return json(res, 200, { analysis: analysis.trim(), model: result.model || "google/gemini-3.8-flash", provider: "Pollinations", source: "Uploaded image snapshot" });
  }

  if (route === "/api/trading/signals" && method === "GET") {
    await settleExpiredTradeSignals(user.id);
    const signals = await dbSelect("aurapay_trade_signals", {
      select: "id,symbol,category,timeframe,direction,entry_price,stop_loss,take_profit,confidence_score,confidence_label,rationale,generated_at,expires_at,outcome_status,outcome_price,outcome_return_pct,outcome_at",
      user_id: `eq.${user.id}`, order: "generated_at.desc", limit: "50"
    });
    const scored = signals.filter(item => ["CORRECT","INCORRECT","FLAT"].includes(item.outcome_status));
    const wins = scored.filter(item => item.outcome_status === "CORRECT").length;
    return json(res, 200, { signals, stats: { evaluated: scored.length, correct: wins, incorrect: scored.filter(item => item.outcome_status === "INCORRECT").length, flat: scored.filter(item => item.outcome_status === "FLAT").length, accuracy_percent: scored.length ? Number((wins / scored.length * 100).toFixed(1)) : null } });
  }

  if (route === "/api/my-accounts" && method === "GET") {
    return json(res, 200, { accounts: [], payment_links: [] });
  }

  if (route === "/api/wallet/balance" && method === "GET") {
    const [wallets, ledger] = await Promise.all([
      dbSelect("aurapay_wallets", {
        select: "currency,available_ngn,pending_ngn,updated_at",
        user_id: `eq.${user.id}`, limit: "1"
      }),
      dbSelect("aurapay_wallet_ledger", {
        select: "id,reference,entry_type,available_delta,pending_delta,available_after,pending_after,transfer_reference,note,created_at",
        user_id: `eq.${user.id}`, order: "created_at.desc", limit: "50"
      })
    ]);
    const row = wallets[0] || {};
    return json(res, 200, {
      currency: "NGN",
      available_ngn: Number(row.available_ngn || 0),
      pending_ngn: Number(row.pending_ngn || 0),
      updated_at: row.updated_at || null,
      ledger: ledger.map((item) => ({
        ...item,
        available_delta: Number(item.available_delta),
        pending_delta: Number(item.pending_delta),
        available_after: Number(item.available_after),
        pending_after: Number(item.pending_after)
      }))
    });
  }

  if (route === "/api/accounts/crypto" && method === "POST") {
    return json(res, 423, { suspended: true, error: "Crypto features are temporarily suspended. No crypto wallet or transfer requests are being processed." });
  }
  if (route === "/api/accounts/crypto-status" && method === "GET") {
    return json(res, 423, { suspended: true, error: "Crypto features are temporarily suspended." });
  }

  if ((route === "/api/currency/rates" || route === "/api/currency") && method === "GET") {
    const base = String(url.searchParams.get("base") || "NGN").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(base)) throw new HttpError(400, "Use a valid three-letter currency code.");
    let response, data;
    try {
      response = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`, {
        headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12000)
      });
      data = await response.json();
    } catch {
      throw new HttpError(502, "Live exchange-rate service could not be reached. Please retry.");
    }
    if (!response.ok || data.result !== "success" || !data.rates) throw new HttpError(502, data["error-type"] || "Exchange rates are unavailable.");
    return json(res, 200, {
      base: data.base_code || base, rates: data.rates,
      updated_at: data.time_last_update_utc || null,
      next_update_at: data.time_next_update_utc || null,
      source: "ExchangeRate-API", indicative_only: true
    });
  }

  throw new HttpError(404, "API endpoint not found.");
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".ico": "image/x-icon", ".json": "application/json; charset=utf-8"
};

async function staticFile(req, res, url) {
  if (url.pathname === "/config.js") {
    const config = {
      supabaseUrl: SUPABASE_URL,
      supabasePublishableKey: SUPABASE_PUBLISHABLE_KEY
    };
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    return res.end(`window.AURAPAY_CONFIG=${JSON.stringify(config)};`);
  }
  let relative = url.pathname === "/" ? "index.html" :
    (url.pathname === "/login" || url.pathname === "/login/") ? "login.html" :
    decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (relative.includes("..") || relative.includes("\\") || relative.startsWith("api/")) {
    return json(res, 404, { error: "Not found." });
  }
  const target = path.join(PUBLIC, relative);
  if (!target.startsWith(PUBLIC + path.sep)) return json(res, 404, { error: "Not found." });
  try {
    const content = await fs.readFile(target);
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "DENY"
    });
    res.end(content);
  } catch {
    json(res, 404, { error: "Not found." });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return json(res, 405, { error: "Method not allowed." });
    }
    await staticFile(req, res, url);
  } catch (error) {
    const status = Number(error.status || 500);
    if (status >= 500) console.error("Request failed:", error.message || error);
    if (!res.headersSent) {
      json(res, status, {
        error: status >= 500 && status !== 503 ? "The request could not be completed safely. Please retry." : error.message,
        ...(error.details && status < 500 ? { details: error.details } : {})
      });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Trade-Me listening on ${PORT}`);
});
// Render release: Pollinations snapshot-only vision AI.
