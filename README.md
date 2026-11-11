# Trade-Me — Render + Supabase + Cloudflare Workers AI

Trade-Me is a Node.js trading-analysis application hosted on Render. Supabase provides email authentication and saved analysis history. **Cloudflare Workers AI is the only AI provider** and powers both screenshot interpretation and follow-up chat.

## Runtime

- Node.js 22+
- Start command: `npm start`
- Health check: `GET /api/health`
- Supabase: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`
- Cloudflare Workers AI: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (server-only)
- Sole model: `@cf/google/gemma-4-26b-a4b-it` (override with `CLOUDFLARE_MODEL` if needed)

Never put the Cloudflare token in frontend code, commit it to Git, or expose it in a client response. The frontend only receives the model/provider label and generated answer.

## Cloudflare setup

The backend calls Cloudflare's OpenAI-compatible AI Gateway Chat Completions route (`/ai/v1/chat/completions`) using the `@cf/google/gemma-4-26b-a4b-it` model route. Text, chat history and image screenshots are sent as one standard multimodal messages payload.

1. Create a Cloudflare API token with Workers AI access.
2. Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in the Render service environment.
3. Enable Cloudflare Workers AI Unified Billing/credits, or store a Google AI Studio API key in the gateway (BYOK). Gemma is a Google-hosted model routed through Cloudflare; it is not a Workers AI-hosted model.
4. Check `/api/health` and confirm `configured.ai` is true.

## Trading analysis

The model interprets only visible chart evidence and user-provided details. It must not invent live prices, order-book data, indicators, or news. It returns a structured report with BUY, SELL, WAIT or NEUTRAL bias, key levels, confirmation, invalidation and an evidence-quality confidence score. It does not submit orders or guarantee outcomes.

## Local run

```bash
npm start
```
