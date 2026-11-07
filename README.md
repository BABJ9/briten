# Aurapay-bm — Render + Supabase

Aurapay-bm is a Node.js web app hosted on Render. Supabase provides email OTP authentication and the database. Gemini powers AI assistance and trading analysis. Bybit public V5 market data supplies the research feed.

## Provider removal
- The Flutterwave API client, credential lookup, webhook, checkout, virtual-account, card-issuing, recipient-resolution and payout handlers have been removed.
- Provider-dependent receiving-account, payment-link, send-money and virtual-card screens are disabled.
- This release does not delete historical wallet, account, payment or ledger records from Supabase.
- Obsolete Flutterwave variables are no longer read by the app. Remove old keys from Render after verifying the new deployment. Do not replace the entire environment group, because that could erase Supabase and Gemini credentials.

## Runtime
- Node.js 22+
- Start command: `npm start`
- Health check: `GET /api/health`
- Supabase: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and server-only `SUPABASE_SECRET_KEY` (or legacy `SUPABASE_SERVICE_ROLE_KEY`)
- Gemini: `GEMINI_API_KEY`; default model `gemini-2.5-flash`
- Bybit public market data requires no private API key.

## Trading desk
The trading desk uses Bybit public tickers, candles and order-book data with multi-timeframe technical indicators and Gemini-assisted interpretation. It is research-only and does not submit orders. No signal guarantees profit or accuracy.

## Local run
```bash
cp .env.example .env
# Fill in private Supabase and Gemini values.
npm start
```
