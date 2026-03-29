# Chat API Reference

WellnessMCP's `/chat` endpoint is a stateless, provider-agnostic proxy. The iOS app sends HealthKit data + a question, the server redacts PII, builds context, routes to the chosen LLM provider, and returns the response.

## Flow

```
iOS App                        WellnessMCP                       Any LLM
  │                               │                                 │
  │  POST /chat                   │                                 │
  │  { message,                   │                                 │
  │    health_data,          ───→ │  1. Validate (Zod)              │
  │    api_key,                   │  2. Redact PII                  │
  │    provider,                  │  3. Build context text          │
  │    instructions }             │  4. Apply custom instructions   │
  │                               │  5. Route to provider ────────→ │
  │                               │                            ←── │ Response
  │                          ←── │  6. Return { response }         │
  │                               │                                 │
  │  Server forgets everything.   │  Nothing stored.                │
```

## POST /chat

### Request

```
POST /chat
Content-Type: application/json
X-API-Key: <ingest-api-key>  (if WELLNESS_MCP_INGEST_KEY is configured)
```

```json
{
  "message": "How has my recovery been this week?",
  "api_key": "sk-ant-api03-...",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "instructions": "Act as a sports performance coach. Be concise.",
  "endpoint": null,
  "health_data": { ... }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | Yes | The user's health question (1-10,000 chars) |
| `api_key` | string | Yes | API key for the chosen LLM provider |
| `health_data` | object | Yes | Full HealthSnapshot from the iOS app |
| `provider` | string | No | `"anthropic"` (default), `"openai"`, or `"custom"` |
| `model` | string | No | Model override (provider-specific) |
| `instructions` | string | No | Custom instructions prepended to system prompt (max 5,000 chars) |
| `endpoint` | string | No | Custom URL for `"openai"` or `"custom"` providers |

### Response (200)

```json
{
  "response": "Based on your data, your recovery looks good...",
  "model": "claude-sonnet-4-20250514",
  "provider": "anthropic",
  "was_redacted": false
}
```

### Error Responses

| Code | Error | When |
|------|-------|------|
| 400 | Invalid JSON / Missing API key | Malformed request or no Anthropic key |
| 401 | Unauthorized | Bad ingest API key or bad Anthropic key |
| 413 | Payload too large | Request body exceeds 5MB |
| 422 | Validation failed | Health data doesn't match schema |
| 429 | Rate limited | Claude API rate limit exceeded |
| 500 | Server error | Unexpected failure |

## GET /chat/models

Returns available Claude models. No auth required.

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

## GET /health

```json
{ "status": "ok" }
```

## HealthSnapshot Format

All keys are snake_case (matching iOS `convertToSnakeCase` encoding). The schema supports 80+ fields across 14 categories. All categories except the original 5 are optional — send what you have.

### Core Categories (currently sent by AthletiqX)

| Field | Unit | Notes |
|-------|------|-------|
| `vitals.hrv_samples[].value` | ms | HRV SDNN |
| `vitals.resting_heart_rate_samples[].value` | bpm | Resting heart rate |
| `vitals.spo2_samples[].value` | 0-1 fraction | 0.98 = 98% SpO2 |
| `sleep.sessions[]*_duration` | seconds | All sleep stage durations |
| `activity.daily_steps[].value` | count | Step count |
| `activity.daily_active_energy[].value` | kcal | Active calories |
| `activity.workouts[].activity_type` | integer | HKWorkoutActivityType rawValue |
| `body_composition.body_mass_samples[].value` | kg | Weight |
| `body_composition.body_fat_percentage_samples[].value` | 0-1 fraction | 0.18 = 18% |
| `cardio_fitness.vo2_max_samples[].value` | mL/kg/min | VO2 Max |

### Extended Categories (optional, all `.default({})`)

| Category | Key | Fields | Example Units |
|----------|-----|--------|---------------|
| Nutrition | `nutrition` | 24 dietary fields | kcal, grams, mg, mcg, mL |
| Heart | `heart` | continuous HR, walking HR, recovery, AFib | bpm, % |
| Respiratory | `respiratory` | breathing rate, FVC, FEV1, peak flow | breaths/min, L, L/min |
| Mindfulness | `mindfulness` | mindful sessions, state of mind, daylight | min, 1-5, min |
| Mobility | `mobility` | walking speed/asymmetry, stair speed, 6MWT | m/s, %, meters |
| Reproductive | `reproductive` | menstrual flow, basal temp, ovulation | 1-3, °C, 0/1 |
| Environmental | `environmental` | UV, audio exposure | UV index, dB |
| Clinical | `clinical` | blood glucose, BP, body temp, insulin, falls | mg/dL, mmHg, °C, IU |
| Other | `other_metrics` | flights, running/cycling dynamics, swimming | count, watts, m/s, rpm |

## Privacy

PII redactor strips 13 field types (email, phone, SSN, GPS, MAC address, etc.) before health data reaches Claude. The server is stateless — data exists only in memory during request processing.

## iOS Integration

Users configure in the AthletiqX Settings tab:
1. **Server URL** — `https://wellnessmcp-production.up.railway.app`
2. **Ingest API Key** — Authenticates with the WellnessMCP server
3. **Anthropic API Key** — User's own key for Claude API calls
