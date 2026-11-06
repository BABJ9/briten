import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "";
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const APP_URL = String(process.env.APP_URL || "").replace(/\/+$/, "");
const FLW_SECRET = String(
  process.env.FLUTTERWAVE_SECRET_KEY ||
  process.env.FLW_SECRET_KEY ||
  process.env.FLUTTERWAVE_SECRET ||
  process.env.FLW_SECRET ||
  ""
).trim();
const FLW_SECRET_SOURCE = process.env.FLUTTERWAVE_SECRET_KEY ? "FLUTTERWAVE_SECRET_KEY"
  : process.env.FLW_SECRET_KEY ? "FLW_SECRET_KEY"
  : process.env.FLUTTERWAVE_SECRET ? "FLUTTERWAVE_SECRET"
  : process.env.FLW_SECRET ? "FLW_SECRET"
  : null;
const FLW_WEBHOOK_HASH = String(process.env.FLUTTERWAVE_WEBHOOK_HASH || process.env.FLW_WEBHOOK_HASH || "").trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_API || process.env.GOOGLE_GENERATIVE_AI_API_KEY || "").trim();
const GEMINI_MODEL = String(process.env.GEMINI_MODEL || "gemini-3.8-flash").trim();
const CARD_ISSUING_ENABLED = /^(1|true|yes)$/i.test(process.env.FLUTTERWAVE_VIRTUAL_CARDS_ENABLED || "");
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

function appUrl(req) {
  return APP_URL || `https://${req.headers.host || "localhost"}`;
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

async function flutterwave(pathname, { method = "GET", body } = {}) {
  if (!FLW_SECRET) throw new HttpError(503, "Flutterwave is not configured on the server.");
  const response = await fetch(`https://api.flutterwave.com/v3${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${FLW_SECRET}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(18000)
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

async function webhook(req, body) {
  const received = String(req.headers["verif-hash"] || "");
  if (!FLW_WEBHOOK_HASH || !safeEqual(FLW_WEBHOOK_HASH, received)) {
    throw new HttpError(401, "Invalid webhook authentication.");
  }
  if (!FLW_SECRET) throw new HttpError(503, "Flutterwave verification is not configured.");
  const eventType = String(body.event || body["event.type"] || "unknown");
  const data = body.data || {};
  const eventId = String(data.id || data.tx_ref || body.id || "");
  if (!eventId) throw new HttpError(400, "Webhook event has no usable identifier.");

  if (eventType === "charge.completed" && data.id) {
    const { response, data: verified } = await flutterwave(`/transactions/${encodeURIComponent(String(data.id))}/verify`);
    const tx = verified.data || {};
    if (!response.ok || verified.status !== "success" || tx.status !== "successful" || !tx.tx_ref) {
      return { received: true, credited: false, message: "Payment was not verified as successful." };
    }
    const amount = Number(tx.amount);
    const currency = String(tx.currency || "").toUpperCase();
    if (!Number.isFinite(amount) || amount <= 0) {
      return { received: true, credited: false, message: "Verified payment amount was invalid." };
    }
    const links = await dbSelect("aurapay_payment_links", {
      select: "reference,user_id,currency_code,amount_currency,status",
      reference: `eq.${String(tx.tx_ref)}`,
      provider: "eq.flutterwave",
      limit: "1"
    });
    if (links.length) {
      const link = links[0];
      if (String(link.currency_code).toUpperCase() !== currency || Math.abs(Number(link.amount_currency) - amount) > 0.01) {
        return { received: true, credited: false, message: "Verified currency or amount does not match the payment link." };
      }
      if (currency === "NGN") {
        const result = await rpc("aurapay_credit_payment_link", {
          p_reference: String(tx.tx_ref), p_amount: amount, p_provider_id: String(tx.id)
        });
        if (!result?.credited && !result?.duplicate) return { received: true, credited: false, message: "NGN payment could not be safely credited." };
      } else {
        await dbPatch("aurapay_payment_links", { reference: `eq.${String(tx.tx_ref)}` }, { status: "successful" });
      }
    } else {
      // Static receiving-account deposits reuse the account tx_ref. Use the unique provider transaction ID as the wallet-ledger idempotency reference.
      const accounts = await dbSelect("aurapay_accounts", {
        select: "id,user_id,account_number,metadata",
        user_id: `not.is.null`, provider: "eq.flutterwave", asset: "eq.NGN",
        "metadata->>tx_ref": `eq.${String(tx.tx_ref)}`, limit: "1"
      });
      const account = accounts.find((row) => row.metadata?.is_permanent === true);
      if (!account || currency !== "NGN") return { received: true, credited: false, message: "No matching permanent Aurapay receiving account was found." };
      const providerReference = String(tx.flw_ref || tx.id);
      const result = await rpc("aurapay_credit_wallet", {
        p_user_id: account.user_id,
        p_reference: `flw_va_${String(tx.id)}`,
        p_amount: amount,
        p_note: `Verified Flutterwave receiving-account deposit ${providerReference}`.slice(0, 160)
      });
      if (!result?.credited && !result?.duplicate) return { received: true, credited: false, message: "Verified static-account deposit could not be safely credited." };
    }
  } else if (eventType === "transfer.completed" || eventType === "transfer.failed") {
    const reference = String(data.reference || "");
    const providerId = String(data.id || "");
    if (!reference || !providerId) return { received: true, reconciled: false, message: "Transfer reference or ID unavailable." };
    const { response, data: verified } = await flutterwave(`/transfers/${encodeURIComponent(providerId)}`);
    const payout = verified.data || {};
    if (!response.ok || verified.status !== "success" || String(payout.reference || "") !== reference) {
      return { received: true, reconciled: false, message: "Transfer could not be verified yet." };
    }
    const recorded = await rpc("aurapay_record_transfer_provider", {
      p_reference: reference,
      p_provider_id: providerId,
      p_provider_reference: String(payout.reference || reference)
    });
    if (recorded?.not_found) return { received: true, reconciled: false, message: "Unknown transfer reference." };
    const status = String(payout.status || "").toUpperCase();
    if (["SUCCESSFUL", "SUCCESS", "FAILED", "REVERSED"].includes(status)) {
      const settled = await rpc("aurapay_settle_transfer", {
        p_reference: reference,
        p_status: status,
        p_provider_reference: providerId,
        p_note: String(payout.complete_message || "Verified Flutterwave transfer status").slice(0, 160)
      });
      if (settled?.not_found) return { received: true, reconciled: false, message: "Unknown transfer reference." };
    }
  }

  const inserted = await rpc("aurapay_record_provider_event", {
    p_event_id: `${eventType}:${eventId}`,
    p_event_type: eventType
  });
  return { received: true, duplicate: !!inserted?.duplicate };
}

function ema(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, n) => sum + n, 0) / period;
  for (const next of values.slice(period)) value = (next * multiplier) + (value * (1 - multiplier));
  return value;
}
function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; if (d >= 0) gains += d; else losses -= d; }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}
function technicalSnapshot(rows) {
  const candles = rows.map((c) => ({ time: Number(c[0]), open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]), volume: Number(c[5]) })).reverse();
  const closes = candles.map((c) => c.close);
  const last = candles.at(-1), previous = candles.at(-2);
  const tr = candles.slice(1).map((c, i) => Math.max(c.high - c.low, Math.abs(c.high - candles[i].close), Math.abs(c.low - candles[i].close)));
  const atr = tr.length >= 14 ? tr.slice(-14).reduce((a, b) => a + b, 0) / 14 : null;
  const recent = candles.slice(-20);
  const avgVolume = recent.reduce((sum, c) => sum + c.volume, 0) / Math.max(1, recent.length);
  const recentHigh = Math.max(...recent.map((c) => c.high));
  const recentLow = Math.min(...recent.map((c) => c.low));
  return {
    candles_count: candles.length,
    last_price: last.close,
    previous_close: previous?.close ?? null,
    change_percent: previous?.close ? ((last.close - previous.close) / previous.close) * 100 : 0,
    ema_20: ema(closes, 20), ema_50: ema(closes, 50), ema_200: ema(closes, 200),
    rsi_14: rsi(closes, 14), atr_14: atr,
    support_20: recentLow, resistance_20: recentHigh,
    last_volume: last.volume, average_volume_20: avgVolume,
    volume_ratio: avgVolume ? last.volume / avgVolume : null,
    latest_candle: { open: last.open, high: last.high, low: last.low, close: last.close },
    calculated_at: new Date().toISOString()
  };
}

async function generateGeminiText({ system, prompt, maxOutputTokens = 1200, temperature = 0.2, timeoutMs = 30000 }) {
  if (!GEMINI_API_KEY) throw new HttpError(503, "Gemini is not configured on the server.");

  // Honour the configured model first, then fail over across current stable Flash models.
  // This also recovers automatically if Render still has an older GEMINI_MODEL value.
  const models = [...new Set([
    GEMINI_MODEL || "gemini-3.8-flash",
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash"
  ])];
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
        flutterwave: !!FLW_SECRET, flutterwave_key_source: FLW_SECRET_SOURCE,
        gemini: !!GEMINI_API_KEY, gemini_key_source: process.env.GEMINI_API_KEY ? "GEMINI_API_KEY" : process.env.GOOGLE_GEMINI_API_KEY ? "GOOGLE_GEMINI_API_KEY" : process.env.GOOGLE_API_KEY ? "GOOGLE_API_KEY" : process.env.GEMINI_API ? "GEMINI_API" : process.env.GOOGLE_GENERATIVE_AI_API_KEY ? "GOOGLE_GENERATIVE_AI_API_KEY" : null
      },
      liveMoneyMovement: "provider-credentials-and-merchant-approval-required"
    });
  }

  if ((route === "/api/webhooks/flutterwave" || route === "/api/webhooks/payments") && method === "POST") {
    const body = await readBody(req);
    const result = await webhook(req, body);
    return json(res, 200, result);
  }

  const user = await requireUser(req);

  if (route === "/api/my-accounts" && method === "GET") {
    const [accounts, links] = await Promise.all([
      dbSelect("aurapay_accounts", {
        select: "id,provider,asset,provider_account_id,account_number,account_name,bank_name,deposit_address,metadata,created_at",
        user_id: `eq.${user.id}`, order: "created_at.desc"
      }),
      dbSelect("aurapay_payment_links", {
        select: "id,provider,asset,reference,destination,checkout_url,status,currency_code,amount_currency,created_at",
        user_id: `eq.${user.id}`, order: "created_at.desc", limit: "50"
      })
    ]);
    return json(res, 200, { accounts, payment_links: links });
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

  if (route === "/api/accounts/naira" && method === "POST") {
    const body = await readBody(req);
    const email = String(body.email || user.email).trim().toLowerCase();
    const firstName = String(body.first_name || "").trim().replace(/[^\p{L}\p{M} .'-]/gu, "").slice(0, 60);
    const lastName = String(body.last_name || "").trim().replace(/[^\p{L}\p{M} .'-]/gu, "").slice(0, 60);
    const phone = String(body.phone || "").replace(/[^0-9+]/g, "").slice(0, 16);
    const identityType = body.identity_type === "nin" ? "nin" : "bvn";
    const identityNumber = String(body.identity_number || "").replace(/\D/g, "");
    if (!validEmail(email) || email !== user.email.toLowerCase()) {
      throw new HttpError(400, "Use the email verified on your Aurapay account.");
    }
    if (firstName.length < 2 || lastName.length < 2 || phone.replace(/\D/g, "").length < 10) {
      throw new HttpError(400, "Enter your legal first name, last name and valid phone number.");
    }
    if (!/^\d{11}$/.test(identityNumber)) {
      throw new HttpError(400, `Enter a valid 11-digit ${identityType.toUpperCase()} to request a permanent receiving account.`);
    }
    const existing = await dbSelect("aurapay_accounts", {
      select: "id,account_number,bank_name,provider_account_id,metadata",
      user_id: `eq.${user.id}`, provider: "eq.flutterwave", asset: "eq.NGN", order: "created_at.desc", limit: "10"
    });
    const permanent = existing.find((row) => row.metadata?.is_permanent === true);
    if (permanent) return json(res, 200, { account: permanent, message: "Your permanent naira receiving account is already active." });

    const reference = `apbm_static_${crypto.randomUUID().replace(/-/g, "")}`;
    const payload = {
      email,
      currency: "NGN",
      tx_ref: reference,
      amount: 0,
      is_permanent: true,
      [identityType]: identityNumber,
      firstname: firstName,
      lastname: lastName,
      phonenumber: phone,
      narration: `Aurapay wallet - ${firstName} ${lastName}`.slice(0, 120)
    };
    // Identity number is sent only to Flutterwave for static-account KYC and is never stored or logged by Aurapay.
    const { response, data } = await flutterwave("/virtual-account-numbers", { method: "POST", body: payload });
    if (!response.ok || data.status !== "success" || !data.data?.account_number) {
      const providerMessage = String(data.message || data.data?.response_message || "Flutterwave could not issue a permanent receiving account.").slice(0, 220);
      throw new HttpError(502, `${providerMessage} Permanent accounts require Flutterwave merchant approval and accepted BVN/NIN verification.`);
    }
    const d = data.data;
    const account = await dbInsert("aurapay_accounts", {
      user_id: user.id,
      provider: "flutterwave",
      asset: "NGN",
      provider_account_id: String(d.order_ref || d.flw_ref || reference),
      account_number: String(d.account_number),
      account_name: `${firstName} ${lastName}`,
      bank_name: d.bank_name || null,
      metadata: {
        is_permanent: true,
        account_type: "static",
        order_ref: d.order_ref || null,
        flw_ref: d.flw_ref || null,
        expiry_date: "N/A",
        tx_ref: reference,
        account_holder: `${firstName} ${lastName}`
      }
    });
    return json(res, 201, {
      account,
      message: "Permanent naira receiving account created. You can reuse these account details to fund your Aurapay wallet."
    });
  }

  if (route === "/api/payments/naira-link" && method === "POST") {
    const body = await readBody(req);
    const amount = Number(body.amount);
    const currency = String(body.currency || "NGN").trim().toUpperCase();
    const description = String(body.description || "Aurapay payment").trim().slice(0, 120);
    const email = String(body.email || user.email).trim().toLowerCase();
    const currencies = new Set(["NGN","USD","GBP","EUR","GHS","KES","ZAR","UGX","TZS","RWF","XAF","XOF","CAD","EGP","ZMW","SLL"]);
    const options = {
      NGN: "card,ussd,banktransfer,account,opay", USD: "card,account", GBP: "card,account", EUR: "card,account",
      GHS: "card,mobilemoneyghana", KES: "card,mpesa", ZAR: "card,account", UGX: "card,mobilemoneyuganda",
      TZS: "card,mobilemoneytanzania", RWF: "card,mobilemoneyrwanda", XAF: "card,mobilemoneyxaf",
      XOF: "card,mobilemoneyxof", CAD: "card", EGP: "card,fawrypay", ZMW: "card,mobilemoneyzambia", SLL: "card"
    };
    if (!validEmail(email)) throw new HttpError(400, "Enter a valid customer email address.");
    if (!currencies.has(currency)) throw new HttpError(400, "That currency is not in the supported checkout list.");
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000 || (currency === "NGN" && amount < 100)) {
      throw new HttpError(400, currency === "NGN" ? "NGN payment links must be at least ₦100." : "Enter a valid payment amount.");
    }
    const reference = `apbm_${crypto.randomUUID().replace(/-/g, "")}`;
    const { response, data } = await flutterwave("/payments", {
      method: "POST",
      body: {
        tx_ref: reference,
        amount: amount.toFixed(2),
        currency,
        redirect_url: `${appUrl(req)}/`,
        customer: { email, name: String(body.customer_name || "").trim().slice(0, 100) || undefined },
        customizations: { title: "Aurapay", description },
        payment_options: options[currency] || "card"
      }
    });
    if (!response.ok || data.status !== "success" || !data.data?.link) {
      throw new HttpError(502, data.message || "Flutterwave could not create the payment checkout.");
    }
    await dbInsert("aurapay_payment_links", {
      user_id: user.id,
      provider: "flutterwave",
      asset: currency,
      reference,
      checkout_url: data.data.link,
      status: "pending",
      amount_ngn: currency === "NGN" ? amount : null,
      currency_code: currency,
      amount_currency: amount
    });
    return json(res, 201, { reference, checkout_url: data.data.link, currency, amount, status: "pending" });
  }

  if (route === "/api/cards/create" && method === "POST") {
    const body = await readBody(req);
    if (!CARD_ISSUING_ENABLED) throw new HttpError(503, "Real virtual-card issuing is not enabled for this merchant profile yet. Obtain issuer approval, then enable FLUTTERWAVE_VIRTUAL_CARDS_ENABLED on Render.");
    const name = String(body.billing_name || user.name || "").trim().slice(0, 100);
    const address = String(body.billing_address || "").trim().slice(0, 180);
    const city = String(body.billing_city || "").trim().slice(0, 80);
    const state = String(body.billing_state || "").trim().slice(0, 2).toUpperCase();
    const postal = String(body.billing_postal_code || "").trim();
    const amount = Number(body.amount);
    if (name.length < 3 || address.length < 5 || city.length < 2 || state.length !== 2 || !/^\d{4,10}$/.test(postal)) {
      throw new HttpError(400, "Enter the cardholder legal name and a complete billing address.");
    }
    if (!Number.isFinite(amount) || amount < 1000 || amount > 1000000) {
      throw new HttpError(400, "Enter a valid initial card funding amount between ₦1,000 and ₦1,000,000.");
    }
    const response = await fetch("https://api.ravepay.co/v2/services/virtualcards/new", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        secret_key: FLW_SECRET, currency: "NGN", debit_currency: "NGN", amount: String(amount),
        billing_name: name, billing_address: address, billing_city: city, billing_state: state,
        billing_postal_code: Number(postal), billing_country: "NG",
        callback_url: `${appUrl(req)}/api/webhooks/payments`
      }),
      signal: AbortSignal.timeout(18000)
    });
    const data = await response.json().catch(() => ({}));
    const card = data.data || {};
    if (!response.ok || data.status !== "success" || !card.id || !card.cardpan || !card.cvv || !card.expiration) {
      throw new HttpError(502, data.message || "The issuer did not create a card. Confirm issuer access and KYC approval.");
    }
    await dbInsert("aurapay_accounts", {
      user_id: user.id, provider: "flutterwave", asset: "VIRTUAL_CARD",
      provider_account_id: String(card.id),
      metadata: {
        maskedpan: card.maskedpan || null, last4: String(card.cardpan).slice(-4),
        currency: "NGN", card_type: card.card_type || null,
        status: card.is_active ? "active" : "inactive",
        created_at: card.date_created || new Date().toISOString()
      }
    });
    return json(res, 201, {
      card: {
        id: card.id, number: String(card.cardpan), cvv: String(card.cvv),
        expiry: String(card.expiration), name: String(card.name_on_card || name),
        currency: "NGN", last4: String(card.cardpan).slice(-4),
        status: card.is_active ? "active" : "inactive"
      },
      warning: "Card credentials are shown once and are not stored by Aurapay."
    });
  }

  if (route === "/api/transfers/banks" && method === "GET") {
    const { response, data } = await flutterwave("/banks/NG");
    if (!response.ok || data.status !== "success" || !Array.isArray(data.data)) {
      throw new HttpError(502, "Could not load the current bank directory.");
    }
    const banks = data.data.map((b) => ({
      id: String(b.id || b.code || ""), name: String(b.name || ""), code: String(b.code || b.id || "")
    })).filter((b) => b.id && b.name && b.code);
    return json(res, 200, { banks });
  }

  if (route === "/api/transfers/resolve" && method === "POST") {
    const body = await readBody(req);
    const accountNumber = String(body.account_number || "").replace(/\D/g, "");
    const bankCode = String(body.bank_code || "").trim();
    if (!/^\d{10}$/.test(accountNumber)) throw new HttpError(400, "Enter a valid 10-digit Nigerian bank account number.");
    if (!/^[A-Za-z0-9_-]{2,20}$/.test(bankCode)) throw new HttpError(400, "Choose a valid bank from the bank list.");
    const { response, data } = await flutterwave("/accounts/resolve", {
      method: "POST", body: { account_number: accountNumber, account_bank: bankCode }
    });
    if (!response.ok || data.status !== "success" || !data.data?.account_name) {
      throw new HttpError(422, data.message || "The bank could not verify that account.");
    }
    return json(res, 200, {
      verified: true, account_name: String(data.data.account_name).slice(0, 120),
      account_number: accountNumber, bank_code: bankCode,
      message: "Bank account name resolved. This confirms bank details, not government-ID KYC."
    });
  }

  if (route === "/api/transfers/send" && method === "POST") {
    const body = await readBody(req);
    const accountNumber = String(body.account_number || "").replace(/\D/g, "");
    const bankCode = String(body.bank_code || "").trim();
    const amount = Number(body.amount);
    const confirmed = body.confirmed === true;
    const confirmedName = String(body.recipient_name || "").trim().toLocaleLowerCase();
    const idempotencyKey = String(body.idempotency_key || "").trim();
    if (!confirmed) throw new HttpError(400, "Confirm the recipient name and amount before continuing.");
    if (!/^\d{10}$/.test(accountNumber) || !/^[A-Za-z0-9_-]{2,20}$/.test(bankCode)) throw new HttpError(400, "Verify a recipient bank account before sending.");
    if (!Number.isSafeInteger(amount) || amount < 100 || amount > 1000000) throw new HttpError(400, "Enter an amount between ₦100 and ₦1,000,000.");
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) throw new HttpError(400, "A valid request ID is required.");
    if (!FLW_SECRET) throw new HttpError(503, "Flutterwave payout is not configured.");
    const { response: resolveResponse, data: resolved } = await flutterwave("/accounts/resolve", {
      method: "POST", body: { account_number: accountNumber, account_bank: bankCode }
    });
    if (!resolveResponse.ok || resolved.status !== "success" || !resolved.data?.account_name) {
      throw new HttpError(422, "Flutterwave could not verify this recipient account. No money was reserved or sent.");
    }
    const recipientName = String(resolved.data.account_name).slice(0, 120);
    if (!confirmedName || recipientName.toLocaleLowerCase() !== confirmedName) {
      throw new HttpError(409, "The bank-verified recipient name changed or does not match your confirmation. Verify again.");
    }
    const reference = `apbm_tr_${crypto.randomUUID().replace(/-/g, "")}`;
    let reservation;
    try {
      reservation = await rpc("aurapay_reserve_transfer", {
        p_user_id: user.id, p_reference: reference, p_idempotency_key: idempotencyKey,
        p_account_number: accountNumber, p_bank_code: bankCode,
        p_recipient_name: recipientName, p_amount: amount, p_narration: "Aurapay bank transfer"
      });
    } catch (error) {
      const message = String(error.message || "");
      if (message.includes("KYC_REQUIRED")) throw new HttpError(403, "Identity KYC must be verified by an approved provider before transfers.");
      if (message.includes("INSUFFICIENT_FUNDS")) throw new HttpError(402, "Insufficient available Aurapay wallet balance. Fund your wallet first.");
      if (message.includes("INVALID_TRANSFER")) throw new HttpError(400, "Transfer details are invalid.");
      console.error("Transfer reservation failed:", message.slice(0, 180));
      throw new HttpError(500, "Could not safely reserve wallet funds. No transfer was submitted.");
    }
    if (reservation?.duplicate) {
      return json(res, 200, {
        reference: reservation.reference, status: reservation.status, duplicate: true,
        message: "This request was already submitted. Check its status before retrying."
      });
    }
    let payoutResponse, payout;
    try {
      ({ response: payoutResponse, data: payout } = await flutterwave("/transfers", {
        method: "POST",
        body: { account_bank: bankCode, account_number: accountNumber, amount, currency: "NGN", narration: "Aurapay bank transfer", reference }
      }));
    } catch {
      return json(res, 202, {
        reference, status: "processing",
        message: "Flutterwave response is pending confirmation. Funds remain reserved; do not submit again. Check status or wait for the webhook."
      });
    }
    if (!payoutResponse.ok || payout.status !== "success" || !payout.data?.id) {
      if (payoutResponse.status >= 400 && payout.status !== "success") {
        await rpc("aurapay_settle_transfer", {
          p_reference: reference, p_status: "FAILED", p_provider_reference: null,
          p_note: String(payout.message || "Flutterwave rejected transfer").slice(0, 160)
        });
        throw new HttpError(502, payout.message || "Flutterwave rejected the transfer. Reserved funds were released.");
      }
      return json(res, 202, {
        reference, status: "processing",
        message: "Flutterwave response is ambiguous. Funds remain reserved; do not submit again."
      });
    }
    await rpc("aurapay_record_transfer_provider", {
      p_reference: reference, p_provider_id: String(payout.data.id),
      p_provider_reference: String(payout.data.reference || reference)
    });
    return json(res, 202, {
      reference, provider_transfer_id: String(payout.data.id),
      status: String(payout.data.status || "NEW").toLowerCase(),
      amount_ngn: amount, recipient_name: recipientName,
      message: "Transfer submitted to Flutterwave. It is not complete until Flutterwave confirms the final status."
    });
  }

  if (route === "/api/transfers/status" && method === "POST") {
    const body = await readBody(req);
    const reference = String(body.reference || "").trim();
    if (!/^apbm_tr_[a-f0-9]{32}$/.test(reference)) throw new HttpError(400, "Enter a valid Aurapay transfer reference.");
    const rows = await dbSelect("aurapay_transfers", {
      select: "reference,status,amount_ngn,provider_transfer_id,provider_reference",
      reference: `eq.${reference}`, user_id: `eq.${user.id}`, limit: "1"
    });
    if (!rows.length) throw new HttpError(404, "Transfer not found.");
    const transfer = rows[0];
    if (["successful", "failed", "reversed"].includes(String(transfer.status).toLowerCase())) {
      return json(res, 200, { reference, status: transfer.status, amount_ngn: Number(transfer.amount_ngn), final: true });
    }
    if (!transfer.provider_transfer_id) {
      return json(res, 200, {
        reference, status: transfer.status, amount_ngn: Number(transfer.amount_ngn), final: false,
        message: "Waiting for Flutterwave transfer ID/status confirmation."
      });
    }
    const { response, data } = await flutterwave(`/transfers/${encodeURIComponent(String(transfer.provider_transfer_id))}`);
    if (!response.ok || data.status !== "success" || !data.data) {
      return json(res, 502, {
        reference, status: transfer.status,
        message: "Flutterwave status could not be confirmed. Funds remain reserved; retry later."
      });
    }
    const providerStatus = String(data.data.status || "").toUpperCase();
    let result = null;
    if (["SUCCESSFUL", "SUCCESS", "FAILED", "REVERSED"].includes(providerStatus)) {
      result = await rpc("aurapay_settle_transfer", {
        p_reference: reference, p_status: providerStatus,
        p_provider_reference: String(data.data.id || transfer.provider_transfer_id),
        p_note: String(data.data.complete_message || "Flutterwave verified transfer status").slice(0, 160)
      });
    }
    const status = result?.status || (["NEW", "PENDING", "PROCESSING", "QUEUED"].includes(providerStatus) ? "processing" : transfer.status);
    return json(res, 200, {
      reference, status, amount_ngn: Number(transfer.amount_ngn),
      final: ["successful", "failed", "reversed"].includes(String(status).toLowerCase()),
      message: data.data.complete_message || "Status retrieved from Flutterwave."
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
    const interval = String(body.interval || "60");
    const allowedIntervals = new Set(["1", "3", "5", "15", "30", "60", "120", "240", "360", "720", "D", "W"]);
    if (!/^[A-Z0-9]{3,24}$/.test(symbol) || !allowedIntervals.has(interval)) {
      throw new HttpError(400, "Choose a valid Bybit market symbol and supported chart timeframe.");
    }
    if (!GEMINI_API_KEY) throw new HttpError(503, "AI analysis is not configured. Add your Gemini key in Render using the variable name GEMINI_API_KEY, then redeploy.");
    const intervals = [...new Set([interval, "15", "60", "240", "D"] )];
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
      if (rows.length) multiTimeframe[tf] = technicalSnapshot(rows);
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
    const system = `You are Aurapay Trade Intelligence, a rigorous crypto market analyst. Analyze ONLY the supplied Bybit public market snapshot and calculated indicators. Never claim certainty or 100% accuracy. Do not invent indicators, news, on-chain data, or events. Explain when data is insufficient. Return clear sections: Market regime; Directional bias (bullish/bearish/neutral); Evidence; Key support/resistance; Trade plan (entry zone, invalidation/stop, targets T1/T2, risk/reward only if calculable); Alternative scenario; Risk controls; What would change the view. If a setup is weak, say NO TRADE. Distinguish spot from linear derivatives and warn about leverage/liquidation risk. This is analysis, not order execution or financial advice. Do not give fabricated probabilities; if using confidence, use a qualitative low/medium/high label and explain why.`;
    const prompt = `Analyze this market snapshot for a disciplined trader. Compare the selected timeframe with 15m, 1h, 4h and daily context where available; assess trend alignment, momentum, volatility, volume, liquidity/spread, order-book imbalance and derivatives funding/open interest where supplied. Treat order-book snapshots as noisy, not predictive. Use the supplied heuristic evidence score as a checklist, never as a win probability. Explicitly state NO TRADE when evidence conflicts, liquidity is poor, or invalidation cannot be defined. Separate observed facts from interpretation. Market data JSON:
${JSON.stringify(market)}
User preference: ${String(body.style || "balanced").slice(0, 30)}. Provide a concise but useful multi-timeframe aware decision framework; do not imply certainty.`;
    const gemini = await generateGeminiText({ system, prompt, maxOutputTokens: 1400, temperature: 0.2, timeoutMs: 35000 });
    const analysis = gemini.text;
    return json(res, 200, { symbol, category, interval, market, decision_context: market.decision_context, analysis, ai_model: gemini.model, source: "Live market feed · AI-assisted analysis", generated_at: new Date().toISOString(), disclaimer: "Probabilistic analysis only. No prediction is guaranteed; verify the market and manage risk before trading." });
  }

  if (route === "/api/ai/assistant" && method === "POST") {
    const body = await readBody(req);
    const message = String(body.message || "").trim().slice(0, 1200);
    const mode = body.mode === "insight" ? "insight" : "support";
    if (!message) throw new HttpError(400, "Write a question first.");
    if (!GEMINI_API_KEY) throw new HttpError(503, "Gemini AI is not configured on Render yet.");
    const system = mode === "insight"
      ? "You are Aurapay-bm’s careful financial wellness assistant. Explain general budgeting and spending-analysis concepts in plain language. You have no access to this user’s transaction history unless explicitly included, so never claim to have analysed real spending. Do not give investment guarantees, fabricate balances, claim fraud certainty, or request passwords, OTPs, seed phrases, BVN or card secrets. Keep advice practical and label uncertainty."
      : "You are Aurapay-bm support: calm, concise, warm and precise. Help explain the app, account safety, Flutterwave payment links, crypto wallet status and bills. Never ask for passwords, OTPs, private keys, seed phrases or full card details. Never claim a transaction succeeded unless the app has a verified provider result. For account-specific or unresolved issues, direct the user to official support.";
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