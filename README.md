# WellnessMCP

Stateless, privacy-first health data proxy. Connects your iOS health data to Claude without storing anything.

WellnessMCP is a lightweight HTTP server that acts as a bridge between the [AthletiqX](https://github.com/syntheticfinds/athletiqx) iOS app and Claude. The iOS app sends HealthKit data + a question, the server redacts PII, builds context, calls Claude API, and returns the response. Supports 80+ Apple HealthKit data types across 14 categories. No data is ever stored on the server.

## Architecture

```
┌──────────────────┐                    ┌──────────────────────────────┐
│  AthletiqX iOS   │     POST /chat     │  WellnessMCP (stateless)     │
│                  │ ────────────────→  │                              │
│  Sends:          │  { health_data,    │  1. Validate (Zod)           │
│  - HealthKit data│    message,        │  2. Redact PII               │        ┌────────────┐
│  - Question      │    api_key }       │  3. Build health context     │ ──────→│ Claude API │
│  - API key       │                    │  4. Call Claude API          │ ←──────│            │
│                  │ ←────────────────  │  5. Return response          │        └────────────┘
│  Receives:       │  { response }      │                              │
│  - AI answer     │                    │  Nothing stored. Ever.       │
└──────────────────┘                    └──────────────────────────────┘
```

**Key principles:**
- **Zero storage** — No database, no files, no cache. The server is stateless.
- **iOS app owns the data** — HealthKit data stays on the device. Only sent per-request.
- **Privacy by design** — PII is redacted before health data reaches Claude.
- **Bring your own key** — Users provide their own Anthropic API key.

## Quick Start

### Deploy to Railway (recommended)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.com/template)

Or manually:

```bash
git clone https://github.com/Karthik-Sivacharan/WellnessMCP.git
cd WellnessMCP
npm install
npm run build
npm start
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `WELLNESS_MCP_INGEST_PORT` | `3456` | Port for the HTTP server |
| `WELLNESS_MCP_INGEST_KEY` | *(none)* | API key to authenticate iOS app requests |
| `ANTHROPIC_API_KEY` | *(none)* | Optional default Anthropic API key |

## API Endpoints

### POST /chat

Send a health question with inline HealthKit data. Returns an AI-powered response.

**Headers:**
- `Content-Type: application/json`
- `X-API-Key: <ingest-key>` (if `WELLNESS_MCP_INGEST_KEY` is set)

**Request:**
```json
{
  "message": "How has my sleep been this week?",
  "api_key": "sk-ant-api03-...",
  "health_data": {
    "vitals": {
      "hrv_samples": [{ "date": "2026-03-28T07:30:00Z", "value": 45.2 }],
      "resting_heart_rate_samples": [{ "date": "2026-03-28T06:00:00Z", "value": 58 }],
      "spo2_samples": []
    },
    "sleep": {
      "sessions": [{
        "date": "2026-03-28T00:00:00Z",
        "in_bed_duration": 28800,
        "asleep_core_duration": 14400,
        "asleep_deep_duration": 5400,
        "asleep_rem_duration": 5400,
        "awake_duration": 1800
      }]
    },
    "activity": {
      "daily_steps": [{ "date": "2026-03-28T00:00:00Z", "value": 8542 }],
      "daily_active_energy": [{ "date": "2026-03-28T00:00:00Z", "value": 425 }],
      "daily_exercise_minutes": [{ "date": "2026-03-28T00:00:00Z", "value": 32 }],
      "workouts": []
    },
    "body_composition": {
      "body_mass_samples": [],
      "body_fat_percentage_samples": [],
      "lean_body_mass_samples": [],
      "bmi_samples": []
    },
    "cardio_fitness": { "vo2_max_samples": [] },
    "fetched_at": "2026-03-28T10:00:00Z"
  }
}
```

**Response (200):**
```json
{
  "response": "Based on your sleep data, you got 8 hours in bed last night with 90 minutes of deep sleep and 90 minutes of REM...",
  "model": "claude-sonnet-4-20250514",
  "was_redacted": false
}
```

**Errors:**
| Code | Meaning |
|------|---------|
| 400 | Invalid JSON or missing fields |
| 401 | Bad ingest API key or bad Anthropic API key |
| 413 | Payload exceeds 5MB |
| 422 | Zod validation failed (detailed field errors) |
| 429 | Claude API rate limit |
| 500 | Server error |

### GET /chat/models

Returns available Claude models.

```json
{
  "models": [
    { "id": "claude-opus-4-20250514", "name": "Claude Opus 4", "description": "Most capable" },
    { "id": "claude-sonnet-4-20250514", "name": "Claude Sonnet 4", "description": "Balanced (default)" },
    { "id": "claude-haiku-3-5-20241022", "name": "Claude Haiku 3.5", "description": "Fastest" }
  ],
  "default": "claude-sonnet-4-20250514"
}
```

### GET /health

Simple health check.

```json
{ "status": "ok" }
```

## Test with curl

```bash
# Health check
curl https://wellnessmcp-production.up.railway.app/health

# List models
curl https://wellnessmcp-production.up.railway.app/chat/models

# Ask a question (replace API keys)
curl -X POST https://wellnessmcp-production.up.railway.app/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-ingest-key" \
  -d '{
    "message": "How am I doing?",
    "api_key": "sk-ant-api03-your-anthropic-key",
    "health_data": {
      "vitals": { "hrv_samples": [], "resting_heart_rate_samples": [], "spo2_samples": [] },
      "sleep": { "sessions": [] },
      "activity": { "daily_steps": [], "daily_active_energy": [], "daily_exercise_minutes": [], "workouts": [] },
      "body_composition": { "body_mass_samples": [], "body_fat_percentage_samples": [], "lean_body_mass_samples": [], "bmi_samples": [] },
      "cardio_fitness": { "vo2_max_samples": [] },
      "fetched_at": "2026-03-28T10:00:00Z"
    }
  }'
```

## Privacy

Health data passes through a PII redactor before reaching Claude. The redactor detects and strips 13 types of personally identifiable information:

- Email addresses, phone numbers, SSN
- GPS coordinates, latitude/longitude
- MAC addresses, device serial numbers
- Names, dates of birth, physical addresses

The server never stores any data. Health data exists only in memory for the duration of the request, then is discarded.

## Supported HealthKit Data Types (80+)

WellnessMCP accepts every category of data that Apple HealthKit offers. All fields are optional — send what you have.

| Category | Fields | Examples |
|----------|--------|----------|
| **Vitals** | 3 | HRV (SDNN), resting heart rate, SpO2 |
| **Sleep** | 5 | Sleep stages (core, deep, REM, awake), in-bed duration |
| **Activity** | 4 + workouts | Steps, active energy, exercise minutes, 70+ workout types |
| **Body Composition** | 4 | Weight, body fat %, lean mass, BMI |
| **Cardio Fitness** | 1 | VO2 Max |
| **Nutrition** | 24 | Calories, protein, carbs, fat, fiber, sugar, water, caffeine, vitamins (A/C/D/B6/B12), minerals (iron, calcium, potassium, magnesium, zinc), folate |
| **Heart (extended)** | 4 | Continuous HR, walking HR avg, HR recovery, AFib burden |
| **Respiratory** | 5 | Breathing rate, forced vital capacity, FEV1, peak flow, inhaler usage |
| **Mindfulness** | 3 | Meditation minutes, state of mind, daylight exposure |
| **Mobility** | 7 | Walking speed, step length, asymmetry, double support, stair speed, 6-min walk test |
| **Reproductive** | 6 | Menstrual flow, basal body temp, cervical mucus, ovulation, cycle tracking |
| **Environmental** | 4 | UV index, environmental audio, headphone audio, water temperature |
| **Clinical / Lab** | 10 | Blood glucose, blood pressure (systolic + diastolic), body temp, wrist temp, insulin, falls, electrodermal activity, perfusion index, BAC |
| **Other Metrics** | 17 | Flights climbed, stand/move time, swimming strokes, running dynamics (power, speed, cadence, stride, ground contact, vertical oscillation), cycling metrics, wheelchair distance |

## How It Works with AthletiqX

The [AthletiqX](https://github.com/syntheticfinds/athletiqx) iOS app currently reads 13 HealthKit data types, with plans to expand to all supported categories.

When the user asks a question in the Health Chat tab:

1. App packages the `HealthSnapshot` + question + Anthropic API key
2. POSTs to WellnessMCP's `/chat` endpoint
3. Server validates, redacts PII, formats data as context for Claude
4. Calls Claude API with the user's key
5. Returns the response to the app

Users configure the server URL, ingest API key, and Anthropic API key in the app's Settings tab.

## Project Structure

```
src/
  index.ts                # Entry point — starts HTTP server
  ingest/
    server.ts             # HTTP routes (POST /chat, GET /health, GET /chat/models)
    types.ts              # Zod schemas for HealthSnapshot validation
  chat/
    context.ts            # Formats HealthSnapshot into text for Claude
    service.ts            # Calls Claude API, returns response
  privacy/
    index.ts              # Privacy layer (PII redaction)
    redactor.ts           # Detects and strips 13 PII types
```

## Deployment

Deployed on Railway: `https://wellnessmcp-production.up.railway.app`

The server is stateless — no volumes, no database, no persistent storage needed. Just a Docker container running Node.js.

## License

MIT
