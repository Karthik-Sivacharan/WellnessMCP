# WellnessMCP — Progress Tracker

Stateless, privacy-first health data proxy. Connects iOS health data to Claude without storing anything.

---

## Current Architecture

WellnessMCP is a **stateless HTTP proxy**. The iOS app (AthletiqX) sends HealthKit data + a question in each request. The server redacts PII, builds context, calls Claude API, and returns the response. No data is ever stored.

```
iOS App → POST /chat { health_data, message, api_key } → PII redact → Claude API → response back
```

## Completed

### Server (src/)
- **HTTP server** (src/ingest/server.ts) — Node.js built-in `http` module, stateless
  - `POST /chat` — Accepts health data + question + API key, returns AI response
  - `GET /chat/models` — Lists available Claude models
  - `GET /health` — Simple health check
  - Zod validation, CORS, API key auth, 5MB request limit
- **HealthSnapshot schemas** (src/ingest/types.ts) — Zod validation for all 13 HealthKit data types
- **Health context builder** (src/chat/context.ts) — Formats HealthSnapshot into concise text for Claude prompt
- **Chat service** (src/chat/service.ts) — Calls Claude API via @anthropic-ai/sdk, error handling
- **PII redactor** (src/privacy/redactor.ts) — Detects/strips 13 PII types before data reaches Claude
- **Deployment** — Dockerfile + Railway config, deployed at wellnessmcp-production.up.railway.app

### iOS Integration (AthletiqX PR #1)
- Codable conformance on all HealthKit data models
- WellnessMCPSyncService — Posts health data to server
- WellnessMCPChatService — Calls /chat endpoint
- ChatView + ChatViewModel — Chat UI with message bubbles
- Settings UI — Server URL, ingest API key, Anthropic API key, auto-sync toggle
