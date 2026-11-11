# Trade-Me — Render + Supabase + Cloudflare Workers AI

Trade-Me is a Node.js trading-analysis application hosted on Render. Supabase provides email authentication and saved analysis history. **Cloudflare Workers AI is the only AI provider** and powers both screenshot interpretation and follow-up chat.

## Runtime

- Node.js 22+
- Start command: `npm start`
- Health check: `GET /api/health`
- Supabase: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`
- Cloudflare Workers AI: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (server-only)
- Sole model: `@cf/qwen/qwen3.8-27b`

Never put the Cloudflare token in frontend code, commit it to Git, or expose it in a client response. The frontend only receives the model/provider label and generated answer.

## Cloudflare setup

The backend calls the Cloudflare OpenAI-compatible Chat Completions route (`/ai/v1/chat/completions`) so text and `image_url` screenshot content use the same multimodal request format.

1. Create a Cloudflare API token with Workers AI permissions (Workers AI Read or the Workers AI permission recommended in the dashboard).
2. Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in the Render service environment.
3. The first use of the Llama 3.2 11B Vision model may require accepting Meta's license and acceptable-use policy in Cloudflare.
4. Check `/api/health` and confirm `configured.ai` is true.

## Trading analysis

The model interprets only visible chart evidence and user-provided details. It must not invent live prices, order-book data, indicators, or news. It returns a structured report with BUY, SELL, WAIT or NEUTRAL bias, key levels, confirmation, invalidation and an evidence-quality confidence score. It does not submit orders or guarantee outcomes.

## Local run

```bash
npm start
```
