# Aurapay-bm — Render + Supabase

A dark/gold Aurapay-bm frontend and Node.js API. **Render hosts the app. Supabase is the only authentication and database backend.** Hatchable SDKs and Hatchable backend configuration have been removed.

> **GitHub upload status (2026-11-05):** The README, package manifest, `.gitignore`, `.env.example`, Supabase schema notes, `public/login.html`, `public/theme.css`, and `public/app.js` are committed. `server.js` and `public/index.html` remain to be committed from the updated archive. Do not deploy this repository until those two source files are added.

## What changed

- Replaced Hatchable email OTP/session calls with Supabase Auth email OTP.
- Replaced Hatchable server SDK database/config/AI calls with Supabase REST/RPC, Render environment variables, and the Gemini REST API.
- Added permanent/static NGN receiving-account requests using Flutterwave's `is_permanent: true` flow, with BVN/NIN submitted only to Flutterwave.
- Added verified static-account deposit reconciliation: Flutterwave webhooks are verified against the provider, matched to the user's permanent account, and credited to the wallet through the server-only idempotent Supabase RPC.
- Added an AI trading desk using Bybit V5 market data and Gemini 2.5 Flash. It compares 15m, 1h, 4h and daily structure, calculates EMA 20/50/200, RSI 14, ATR 14, support/resistance and volume context, and includes order-book spread/imbalance and derivatives funding/open-interest data where available.
- Preserved provider verification and idempotency for payment links and bank transfers.
- Kept crypto endpoints suspended, as they were in the supplied v21 project.
- Removed `hatchable.toml` and all Hatchable SDK imports.

## Runtime

- Node.js 22+
- No server-side npm dependencies; the API uses Node's built-in HTTP/fetch APIs.
- Browser Supabase client is pinned to `@supabase/supabase-js` 2.118.0 via jsDelivr.
- Render serves both the static frontend and API from one web service.

## Supabase setup

The connected Supabase project (`nopjflcndafxuvvxpmqg`) has already been initialized with the Aurapay schema and RPC functions. The exact applied migration versions are documented in `supabase/SCHEMA.md`. All user data tables have RLS enabled. Balance-changing functions are executable only by `service_role`; the app uses a server-only Supabase Secret key.

In Supabase Dashboard:

1. Open **Authentication → URL Configuration** and set the Site URL to your Render URL after deployment.
2. Under **Authentication → Email Templates**, edit the Magic Link template to include the OTP token, for example:
   ```html
   <h2>Your Aurapay sign-in code</h2>
   <p>Enter this code: {{ .Token }}</p>
   ```
   The login screen expects an email OTP, not a clickable magic link.
3. Under **Settings → API Keys**, copy the **Publishable key** and create/copy a **Secret key**. The publishable key is safe for browser use; the secret key is backend-only and must never be committed or placed in frontend code.
4. Existing Hatchable Auth users/sessions are not automatically transferred. Users must sign in/create accounts through Supabase Auth. The supplied ZIP contained no Hatchable database dump, so existing Hatchable balances and records were not copied.

## Render environment variables

Set these in the Render web service's Environment tab:

| Variable | Required | Notes |
|---|---|---|
| `SUPABASE_URL` | Yes | `https://nopjflcndafxuvvxpmqg.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | Yes | Supabase publishable key |
| `SUPABASE_SECRET_KEY` | Yes | Supabase Secret key (`sb_secret_...`), server-only |
| `APP_URL` | Yes | Full public Render URL |
| `FLUTTERWAVE_SECRET_KEY` | For payments | Flutterwave secret API key |
| `FLUTTERWAVE_WEBHOOK_HASH` | For webhooks | Webhook hash from Flutterwave |
| `GEMINI_API_KEY` | For AI and trading analysis | Google Gemini API key |
| `FLUTTERWAVE_VIRTUAL_CARDS_ENABLED` | Optional | Keep `false` until card issuing is approved |

Bybit public market data does not require a private API key. Never put secret keys in GitHub, HTML, JavaScript, or screenshots. Do not send secret keys in ChatGPT messages.

## Flutterwave setup

After deployment, configure the Flutterwave webhook as:

`https://YOUR-RENDER-DOMAIN/api/webhooks/flutterwave`

The legacy `/api/webhooks/payments` path is also retained. Webhook events are checked against `FLUTTERWAVE_WEBHOOK_HASH`, then payment/transfer status is verified against Flutterwave before wallet settlement.

The naira virtual-account endpoint requests a **permanent static account** (`is_permanent: true`, `amount: 0`) and forwards the user-supplied BVN or NIN to Flutterwave for issuance. Aurapay does not persist the identity number. Flutterwave requires accepted identity verification and merchant eligibility; if the provider rejects the request, no account is fabricated. Existing temporary accounts are not upgraded automatically.

Static-account deposits use Flutterwave's `charge.completed` webhook. The server verifies the transaction, maps its static-account `tx_ref` to the account owner, then calls `aurapay_credit_wallet` with the unique provider transaction ID to prevent duplicate credits. The wallet is credited only after provider verification.

Real card issuing remains disabled unless `FLUTTERWAVE_VIRTUAL_CARDS_ENABLED=true` is explicitly set after issuer approval. Bank transfers require an approved KYC record in `aurapay_kyc_checks`; this codebase does not yet contain a KYC provider onboarding flow. Do not mark users verified manually just to bypass the check.

## AI trading analysis

The AI trading desk uses Bybit public V5 ticker, candlestick and order-book endpoints, then asks Gemini 2.5 Flash to interpret the measured snapshot. It includes multi-timeframe context, volatility, momentum, volume, liquidity and derivatives context where available. It is analysis-only: it does not connect to a trading account or submit orders. **No AI can guarantee 100% correct trades.** Outputs are probabilistic and must not be treated as guaranteed financial advice.

## Known gaps / not enabled

- Crypto remains suspended (HTTP 423).
- Bill-payment UI/API integration is not present in the supplied v21 frontend, even though an old Hatchable migration mentioned bill purchases.
- No KYC provider integration is included; bank transfers remain blocked until an approved verification process writes a verified KYC status.
- Existing Hatchable user accounts, balances, transaction records, and provider secrets are not migrated by the ZIP.

## Local run

```bash
cp .env.example .env
# Fill in the Supabase keys and optional provider credentials.
npm start
```

Open `http://localhost:3000`. Health check: `GET /api/health`.

## Deploy to Render

Connect the GitHub repository `BABJ9/briten` as a Node web service:

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/api/health`
- Node version: 22 or later

Add the environment variables above before testing sign-in or money movement.
