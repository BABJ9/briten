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
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_API || process.env.GOOGLE_GENERATIVE_AI_API_KEY || "").trim();
const GEMINI_MODEL = String(process.env.GEMINI_MODEL || "gemini-3.8-flash").trim();
const MAX_BODY = 1024 * 1024;

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

async function generateGeminiText({ system, prompt, maxOutputTokens = 1200, temperature = 0.2, timeoutMs = 30000 }) {
  if (!GEMINI_API_KEY) throw new HttpError(503, "Gemini is not configured on the server.");

  // Always try Gemini 3.8 Flash first; retain stable Flash fallbacks for temporary outages.
  // An older Render GEMINI_MODEL value must not override the requested primary model.
  const models = ["gemini-3.8-flash"];
  let lastFailure = null;

  for (const model of models) {
    let response;
    let data;
    try {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens, temperature }
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      data = await response.json().catch(() => ({}));
    } catch (error) {
      lastFailure = { model, message: error?.name === "TimeoutError" ? "request timed out" : "network request failed" };
      console.error("Gemini model request failed:", model, lastFailure.message);
      continue;
    }

    const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
    if (response.ok && text) return { text, model };

    const message = String(data.error?.message || data.promptFeedback?.blockReason || `HTTP ${response.status}`).slice(0, 240);
    lastFailure = { model, status: response.status, message };
    console.error("Gemini model unavailable:", model, response.status, message);

    // Try another model for retired/unknown models, rate limits, and temporary provider overload.
    const retryable = [400, 404, 429, 500, 502, 503, 504].includes(response.status);
    if (!retryable) break;
  }

  const detail = lastFailure?.status === 403
    ? "Google rejected API access. Check that the Generative Language API is enabled and the key has permission."
    : "Gemini models are temporarily unavailable or not enabled for this API key. The service tried the configured model and current Flash fallbacks.";
  throw new HttpError(502, detail);
}

async function streamGeminiText({ system, prompt, maxOutputTokens = 700, onText, timeoutMs = 30000 }) {
  if (!GEMINI_API_KEY) throw new HttpError(503, "Gemini AI is not configured on the server.");
  // Gemini 3.8 Flash is the primary streaming model; fall back only if it is unavailable.
  const models = ["gemini-3.8-flash"];
  let lastFailure = null;
  for (const model of models) {
    let response;
    try {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY, "Accept": "text/event-stream" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens }
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      lastFailure = error?.name === "TimeoutError" ? "Gemini timed out." : "Gemini network request failed.";
      continue;
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 240);
      lastFailure = `Gemini ${model} returned HTTP ${response.status}: ${detail}`;
      if ([400, 404, 429, 500, 502, 503, 504].includes(response.status)) continue;
      throw new HttpError(502, lastFailure);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completeText = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const event of events) {
        const line = event.split("\n").find((entry) => entry.startsWith("data:"));
        if (!line) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        try {
          const chunk = JSON.parse(raw);
          const piece = chunk.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
          if (piece) { completeText += piece; onText(piece); }
        } catch {}
      }
    }
    if (completeText.trim()) return { text: completeText, model };
    lastFailure = `Gemini ${model} returned an empty response.`;
  }
  throw new HttpError(502, lastFailure || "Gemini models are temporarily unavailable.");
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
      app: "Aurapay-bm",
      status: "ready",
      backend: "Supabase",
      hosting: "Render",
      configured: {
        supabase: !!(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY && SUPABASE_SECRET_KEY),
        gemini: !!GEMINI_API_KEY, gemini_key_source: process.env.GEMINI_API_KEY ? "GEMINI_API_KEY" : process.env.GOOGLE_GEMINI_API_KEY ? "GOOGLE_GEMINI_API_KEY" : process.env.GOOGLE_API_KEY ? "GOOGLE_API_KEY" : process.env.GEMINI_API ? "GEMINI_API" : process.env.GOOGLE_GENERATIVE_AI_API_KEY ? "GOOGLE_GENERATIVE_AI_API_KEY" : null
      },
      moneyMovement: "disabled-pending-new-provider"
    });
  }

  const user = await requireUser(req);

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

  if (route === "/api/ai/trading-analysis" && method === "POST") {
    const body = await readBody(req);
    const symbol = String(body.symbol || "BTCUSDT").trim().toUpperCase();
    const category = body.category === "spot" ? "spot" : "linear";
    const interval = "5";
    const allowedIntervals = new Set(["1", "3", "5", "15", "30", "60", "120", "240", "360", "720", "D", "W"]);
    if (!/^[A-Z0-9]{3,24}$/.test(symbol)) {
      throw new HttpError(400, "Choose a valid Bybit market symbol and supported chart timeframe.");
    }
    
    const intervals = ["5", "15", "60", "240", "D"];
    const tickerUrl = `https://api.bybit.com/v5/market/tickers?${new URLSearchParams({ category, symbol })}`;
    const requests = await Promise.all([
      fetch(tickerUrl, { signal: AbortSignal.timeout(12000) }),
      ...intervals.map((tf) => fetch(`https://api.bybit.com/v5/market/kline?${new URLSearchParams({ category, symbol, interval: tf, limit: "240" })}`, { signal: AbortSignal.timeout(12000) })),
      fetch(`https://api.bybit.com/v5/market/orderbook?${new URLSearchParams({ category, symbol, limit: "50" })}`, { signal: AbortSignal.timeout(12000) })
    ]);
    const payloads = await Promise.all(requests.map((response) => response.json().catch(() => ({}))));
    const tickerResponse = requests[0], tickerData = payloads[0];
    if (!tickerResponse.ok || tickerData.retCode !== 0) throw new HttpError(502, "Bybit ticker data is unavailable for this market.");
    const klinePayloads = payloads.slice(1, 1 + intervals.length);
    const selectedIndex = intervals.indexOf(interval);
    if (!requests[1 + selectedIndex].ok || klinePayloads[selectedIndex]?.retCode !== 0 || !klinePayloads[selectedIndex]?.result?.list?.length) {
      throw new HttpError(502, "Bybit candle data is unavailable for this symbol/timeframe. Check the symbol (for example BTCUSDT) and try again.");
    }
    const ticker = tickerData.result?.list?.[0] || {};
    const multiTimeframe = {};
    intervals.forEach((tf, index) => {
      const rows = klinePayloads[index]?.result?.list || [];
      if (rows.length) multiTimeframe[tf] = technicalSnapshot(rows, tf);
    });
    const technicals = multiTimeframe[interval];
    const orderbookData = payloads.at(-1);
    const orderbook = orderbookData?.retCode === 0 ? orderbookData.result || {} : {};
    const bids = (orderbook.b || []).slice(0, 5).reduce((sum, level) => sum + Number(level[1] || 0), 0);
    const asks = (orderbook.a || []).slice(0, 5).reduce((sum, level) => sum + Number(level[1] || 0), 0);
    const bestBid = Number(orderbook.b?.[0]?.[0] || ticker.bid1Price || 0);
    const bestAsk = Number(orderbook.a?.[0]?.[0] || ticker.ask1Price || 0);
    const market = {
      exchange: "Live market feed", category, symbol, interval,
      last_price: Number(ticker.lastPrice || technicals.last_price),
      bid: bestBid, ask: bestAsk,
      spread_percent: bestBid > 0 && bestAsk > 0 ? ((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 100 : null,
      high_24h: Number(ticker.highPrice24h || 0), low_24h: Number(ticker.lowPrice24h || 0),
      turnover_24h: Number(ticker.turnover24h || 0), open_interest: ticker.openInterest ? Number(ticker.openInterest) : null,
      funding_rate: ticker.fundingRate ? Number(ticker.fundingRate) : null,
      orderbook_top5: { bid_size: bids, ask_size: asks, imbalance: bids + asks > 0 ? (bids - asks) / (bids + asks) : null },
      technicals, multi_timeframe: multiTimeframe
    };
    // Evidence score is a transparent heuristic, not a win probability or trade signal.
    let evidenceScore = 0;
    let bullishFrames = 0, bearishFrames = 0, usableFrames = 0;
    for (const [tf, frame] of Object.entries(multiTimeframe)) {
      if (frame.ema_20 == null || frame.ema_50 == null || frame.last_price == null) continue;
      usableFrames++;
      const direction = frame.last_price > frame.ema_20 && frame.ema_20 > frame.ema_50 ? 1
        : frame.last_price < frame.ema_20 && frame.ema_20 < frame.ema_50 ? -1 : 0;
      if (direction > 0) bullishFrames++;
      if (direction < 0) bearishFrames++;
      evidenceScore += direction * (tf === interval ? 2 : 1);
    }
    const rsiValue = Number(technicals.rsi_14);
    if (Number.isFinite(rsiValue)) {
      if (rsiValue >= 52 && rsiValue <= 68) evidenceScore++;
      else if (rsiValue >= 32 && rsiValue <= 48) evidenceScore--;
    }
    const volumeRatio = Number(technicals.volume_ratio);
    if (Number.isFinite(volumeRatio) && volumeRatio >= 1.2) {
      if (technicals.last_price > technicals.previous_close) evidenceScore++;
      else if (technicals.last_price < technicals.previous_close) evidenceScore--;
    }
    const riskFlags = [];
    if (market.spread_percent != null && market.spread_percent > 0.15) riskFlags.push("Wide spread: execution costs may be elevated");
    if (Number.isFinite(rsiValue) && rsiValue >= 75) riskFlags.push("Momentum is stretched to the upside");
    if (Number.isFinite(rsiValue) && rsiValue <= 25) riskFlags.push("Momentum is stretched to the downside");
    if (Number.isFinite(volumeRatio) && volumeRatio < 0.6) riskFlags.push("Thin relative volume: breakout confirmation is weak");
    if (usableFrames < 3) riskFlags.push("Limited timeframe coverage: reduce conviction");
    const bias = evidenceScore >= 3 ? "Bullish lean" : evidenceScore <= -3 ? "Bearish lean" : "No clear edge";
    market.decision_context = {
      evidence_score: evidenceScore, score_range: "-8 to +8 (heuristic, not probability)",
      bias, bullish_frames: bullishFrames, bearish_frames: bearishFrames,
      usable_frames: usableFrames, rsi_zone: Number.isFinite(rsiValue) ? (rsiValue >= 70 ? "overbought" : rsiValue <= 30 ? "oversold" : "neutral") : "unavailable",
      volume_confirmation: Number.isFinite(volumeRatio) ? volumeRatio >= 1.2 ? "elevated" : volumeRatio < 0.6 ? "thin" : "normal" : "unavailable",
      risk_flags: riskFlags
    };
    const signal = buildFiveMinuteSignal(market, new Date());
    const system = `You are Aurapay Trade Intelligence, a rigorous crypto market analyst focused on the 5-minute trading horizon. Analyze ONLY the supplied Bybit public market snapshot and calculated indicators. Never claim certainty or 100% accuracy. Do not invent indicators, news, on-chain data, or events. Explain when data is insufficient. Return clear sections: Market regime; Directional bias (bullish/bearish/neutral); Evidence; Key support/resistance; Trade plan (entry zone, invalidation/stop, targets T1/T2, risk/reward only if calculable); Alternative scenario; Risk controls; What would change the view. If a setup is weak, say NO TRADE. Distinguish spot from linear derivatives and warn about leverage/liquidation risk. This is analysis, not order execution or financial advice. Do not give fabricated probabilities; if using confidence, use a qualitative low/medium/high label and explain why.`;
    const prompt = `Analyze this market snapshot for a disciplined trader. The trade decision is strictly for the 5-minute timeframe; use 15m, 1h and 4h only as context; assess trend alignment, momentum, volatility, volume, liquidity/spread, order-book imbalance and derivatives funding/open interest where supplied. Treat order-book snapshots as noisy, not predictive. Use the supplied heuristic evidence score as a checklist, never as a win probability. Explicitly state NO TRADE when evidence conflicts, liquidity is poor, or invalidation cannot be defined. Separate observed facts from interpretation. Market data JSON:
${JSON.stringify(market)}
User preference: ${String(body.style || "balanced").slice(0, 30)}. Provide a concise but useful multi-timeframe aware decision framework; do not imply certainty.`;
    let gemini = null;
    let analysis = "AI commentary is temporarily unavailable. Review the live technical snapshot and retry the AI thesis shortly.";
    try { gemini = await generateGeminiText({ system, prompt, maxOutputTokens: 1800, temperature: 0.2, timeoutMs: 12000 }); analysis = gemini.text; } catch (error) { console.error("Trading AI unavailable:", error.message); }
    const candles = (klinePayloads[selectedIndex]?.result?.list || []).slice().reverse().slice(-100).map(row => ({ time:Number(row[0]),open:Number(row[1]),high:Number(row[2]),low:Number(row[3]),close:Number(row[4]),volume:Number(row[5]) }));
    
    const savedSignal = await dbInsert("aurapay_trade_signals", {
      user_id: user.id, symbol, category, timeframe: "5", direction: signal.direction,
      entry_price: signal.entry_price, stop_loss: signal.stop_loss, take_profit: signal.take_profit,
      confidence_score: signal.confidence_score, confidence_label: signal.confidence_label,
      rationale: signal.rationale, market_snapshot: market,
      generated_at: signal.generated_at, expires_at: signal.expires_at
    });
    return json(res, 200, { symbol, category, interval: "5", market, decision_context: market.decision_context, signal: { ...signal, id: savedSignal?.id || null, outcome_status: "PENDING" }, analysis, candles, ai_model: gemini?.model || null, ai_available: !!gemini, source: "Live Bybit 5-minute market feed · Gemini-assisted analysis", generated_at: new Date().toISOString(), disclaimer: "Probabilistic analysis only. No prediction is guaranteed; verify the market and manage risk before trading." });
  }

  if (route === "/api/ai/assistant" && method === "POST") {
    const body = await readBody(req);
    const message = String(body.message || "").trim().slice(0, 1200);
    const mode = body.mode === "insight" ? "insight" : "support";
    if (!message) throw new HttpError(400, "Write a question first.");
    if (!GEMINI_API_KEY) throw new HttpError(503, "Gemini AI is not configured on Render yet.");
    const system = mode === "insight"
      ? "You are Aurapay-bm’s careful financial wellness assistant. Explain general budgeting and spending-analysis concepts in plain language. You have no access to this user’s transaction history unless explicitly included, so never claim to have analysed real spending. Do not give investment guarantees, fabricate balances, claim fraud certainty, or request passwords, OTPs, seed phrases, BVN or card secrets. Keep advice practical and label uncertainty."
      : "You are Aurapay-bm support: calm, concise, warm and precise. Help explain the app, account safety, crypto wallet status and general product features. Never ask for passwords, OTPs, private keys, seed phrases or full card details. Never claim a transaction succeeded unless the app has a verified provider result. For account-specific or unresolved issues, direct the user to official support.";
    if (body.stream === true) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
      });
      res.flushHeaders?.();
      const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      send({ started: true });
      try {
        const gemini = await streamGeminiText({
          system, prompt: message, maxOutputTokens: 700, timeoutMs: 30000,
          onText: (text) => { if (!res.destroyed) send({ text }); }
        });
        if (!res.destroyed) send({ done: true, model: gemini.model });
      } catch (error) {
        if (!res.destroyed) send({ error: error.message || "Gemini could not complete the response." });
      } finally {
        if (!res.destroyed) res.end();
      }
      return;
    }
    const gemini = await generateGeminiText({ system, prompt: message, maxOutputTokens: 700, temperature: 0.4, timeoutMs: 30000 });
    const answer = gemini.text;
    return json(res, 200, { answer, ai_model: gemini.model });
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
  console.log(`Aurapay-bm listening on ${PORT}`);
});