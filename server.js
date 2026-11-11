import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3-flash-preview";
const MAX_BODY = 36 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "That message or attachment is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "Request body must be valid JSON."); }
}

function requiredEnv(...keys) {
  const missing = keys.filter(key => !process.env[key]);
  if (missing.length) throw new HttpError(503, `Aster is not fully configured. Missing: ${missing.join(", ")}.`);
}

function bearer(req) {
  const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
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
  return user;
}

async function generateAster(contents, systemInstruction, generationConfig = {}) {
  requiredEnv("GEMINI_API_KEY");
  let response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents,
        generationConfig
      }),
      signal: AbortSignal.timeout(120000)
    });
  } catch (error) {
    throw new HttpError(502, error.name === "TimeoutError" ? "Aster took too long to respond. Please try again." : "Aster is temporarily unreachable. Please retry.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || "Aster could not complete that request. Check the Gemini API key and model access.";
    throw new HttpError(response.status === 429 ? 429 : 502, String(message).slice(0, 350));
  }
  const answer = (data.candidates?.[0]?.content?.parts || [])
    .filter(part => typeof part.text === "string")
    .map(part => part.text).join("\n").trim();
  if (!answer) throw new HttpError(502, "Aster returned an empty response. Please try again.");
  return { reply: answer, model: GEMINI_MODEL, provider: "Google Gemini", assistant: "Aster" };
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/health" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      app: "Aster AI",
      status: "ready",
      configured: {
        authentication: Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY),
        ai: Boolean(GEMINI_API_KEY),
        model: GEMINI_MODEL
      }
    });
  }

  if (url.pathname !== "/api/ai/chat" || req.method !== "POST") {
    throw new HttpError(404, "Aster endpoint not found.");
  }

  await requireUser(req);
  const body = await readBody(req);
  const message = String(body.message || "").trim();
  const images = Array.isArray(body.images) ? body.images.slice(0, 8) : [];
  if (!message && !images.length) throw new HttpError(400, "Write a message or attach an image.");
  if (message.length > 16000) throw new HttpError(400, "Keep messages under 16,000 characters.");

  const history = Array.isArray(body.history) ? body.history.slice(-24)
    .filter(item => item && ["user", "assistant", "model"].includes(item.role) && typeof item.content === "string")
    .map(item => ({
      role: item.role === "assistant" ? "model" : item.role,
      parts: [{ text: item.content.slice(0, 10000) }]
    })) : [];

  const parts = [{ text: message || "Please inspect the attached image and explain what you see." }];
  let totalBytes = 0;
  for (const item of images) {
    const raw = String(item?.data || "");
    const match = raw.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new HttpError(400, "Attach PNG, JPG, WEBP or GIF images only.");
    const bytes = Buffer.from(match[2], "base64");
    totalBytes += bytes.length;
    if (!bytes.length || bytes.length > 8 * 1024 * 1024 || totalBytes > 16 * 1024 * 1024) {
      throw new HttpError(413, "Keep each image under 8 MB and total image size under 16 MB.");
    }
    parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
  }

  const modes = {
    chat: "Be a natural, versatile conversational assistant.",
    writing: "Act as a skilled writing partner. Draft, edit and refine while preserving the user's intent and voice.",
    code: "Act as a senior software engineering partner. Debug carefully, explain root causes, write maintainable code and identify security concerns.",
    reason: "Act as an analytical reasoning partner. Examine assumptions, evidence, alternatives and uncertainty.",
    plan: "Act as a practical planning partner. Turn goals into sequenced, realistic actions."
  };
  const mode = String(body.mode || "chat").slice(0, 30);
  const modeContext = String(body.systemContext || "").slice(0, 1200);
  const personality = String(body.personality || "Warm, thoughtful, natural and clear").slice(0, 1200);
  const system = [
    "You are Aster, a capable, warm, deeply useful general-purpose AI assistant.",
    "This product is entirely an AI assistant. It is not a fintech app, wallet, trading terminal, payment product, or formal business dashboard.",
    "Help with conversation, complex reasoning, writing, coding, debugging, mathematics, learning, planning, document interpretation and visual understanding.",
    "Be curious, accurate, practical and conversational. Adapt your depth to the user's request.",
    "For difficult tasks, reason carefully and provide clear conclusions and concise explanations without exposing private chain-of-thought.",
    "Explain assumptions and uncertainty. Never invent current facts or claim actions you did not perform.",
    "Analyze user-provided images directly. Never ask for passwords, OTPs, API keys, private keys, seed phrases or full card details.",
    modes[mode] || modes.chat,
    modeContext,
    "Response style: " + personality
  ].filter(Boolean).join("\n");
  const result = await generateAster(
    [...history, { role: "user", parts }],
    system,
    { temperature: 0.7, maxOutputTokens: 4096 }
  );
  return json(res, 200, result);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8"
};

async function staticFile(req, res, url) {
  if (url.pathname === "/config.js") {
    const config = { supabaseUrl: SUPABASE_URL, supabasePublishableKey: SUPABASE_PUBLISHABLE_KEY };
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    return res.end(`window.AURAPAY_CONFIG=${JSON.stringify(config)};`);
  }

  const relative = url.pathname === "/" ? "index.html"
    : (url.pathname === "/login" || url.pathname === "/login/") ? "login.html"
    : decodeURIComponent(url.pathname).replace(/^\/+/, "");
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
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Method not allowed." });
    await staticFile(req, res, url);
  } catch (error) {
    const status = Number(error.status || 500);
    if (status >= 500) console.error("Aster request failed:", error.message || error);
    if (!res.headersSent) json(res, status, {
      error: status >= 500 && status !== 503 ? "Aster could not complete that request. Please retry." : error.message
    });
    else res.end();
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`Aster AI listening on ${PORT} using ${GEMINI_MODEL}`));
