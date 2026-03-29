# Chat API Documentation

## Architecture Overview

The Chat API adds conversational AI capabilities to WellnessMCP. It lets the iOS app (or any HTTP client) send natural language questions about health data and receive AI-powered responses that reference the user's actual health metrics.

```
iOS App (AthletiqX)
    |
    | POST /chat { message, api_key }
    v
IngestServer (Node.js HTTP)
    |
    | 1. Authenticate request (WELLNESS_MCP_INGEST_KEY)
    | 2. Validate with Zod
    v
ChatService
    |
    | 3. Build health context
    v
HealthContextBuilder
    |
    | 4. Query SQLite (sleep, activity, vitals, body comp, glucose)
    | 5. Apply PrivacyLayer (consent gate + PII redaction + aggregation)
    | 6. Format into concise text summary
    v
ChatService (continued)
    |
    | 7. Construct system prompt (health data + instructions + medical disclaimer)
    | 8. Call Claude API with user's Anthropic API key
    v
Claude API (Anthropic)
    |
    | 9. AI response referencing actual health data
    v
iOS App (receives response)
```

Key privacy property: Health data passes through the full PrivacyLayer pipeline (consent gate, PII redaction, aggregation) **before** it reaches the LLM. If the user has disabled sharing for a category, that data is excluded from the context entirely.

---

## Endpoint Reference

### POST /chat

Send a health question and receive an AI response.

**Authentication:** Requires `X-API-Key` or `Authorization: Bearer <key>` header if `WELLNESS_MCP_INGEST_KEY` is configured (this is the server access key, not the Anthropic API key).

**Request Body:**

| Field     | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `message` | string | Yes      | The user's question (1-10,000 chars) |
| `api_key` | string | No*      | Anthropic API key for this request |
| `user_id` | string | No       | Look up a stored API key for this user |
| `model`   | string | No       | Claude model override (default: `claude-sonnet-4-20250514`) |
| `days`    | number | No       | Days of health history to include (1-365, default: 14) |

*The `api_key` is required unless one has been stored via `POST /chat/api-key` or the `ANTHROPIC_API_KEY` environment variable is set.

API key resolution order:
1. `api_key` in the request body (highest priority)
2. Stored key for the given `user_id`
3. Stored key for "default" user
4. `ANTHROPIC_API_KEY` environment variable

**Response (200):**

```json
{
  "response": "Based on your data, your average sleep over the past week has been 7.2 hours per night...",
  "model": "claude-sonnet-4-20250514",
  "context_days": 14
}
```

**Example with curl:**

```bash
# With API key in request body
curl -X POST https://wellnessmcp-production.up.railway.app/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-ingest-key" \
  -d '{
    "message": "How has my sleep been this week?",
    "api_key": "sk-ant-api03-your-anthropic-key",
    "days": 7
  }'

# With previously stored API key
curl -X POST https://wellnessmcp-production.up.railway.app/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-ingest-key" \
  -d '{
    "message": "What are my HRV trends?",
    "user_id": "my-ios-device"
  }'
```

---

### POST /chat/api-key

Store an Anthropic API key server-side so subsequent `/chat` requests can omit it.

**Authentication:** Requires ingest API key header.

**Request Body:**

| Field     | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `api_key` | string | Yes      | Anthropic API key to store |
| `user_id` | string | No       | User identifier (default: "default") |

**Response (200):**

```json
{
  "success": true,
  "message": "API key stored successfully. It will be used for subsequent /chat requests.",
  "user_id": "my-ios-device"
}
```

**Example with curl:**

```bash
curl -X POST https://wellnessmcp-production.up.railway.app/chat/api-key \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-ingest-key" \
  -d '{
    "api_key": "sk-ant-api03-your-anthropic-key",
    "user_id": "my-ios-device"
  }'
```

**Important:** Keys are stored in memory only. They are lost when the server restarts. For persistent storage, the iOS app should store the key in its own Keychain and send it with each request.

---

### GET /chat/models

List available Claude models for the chat endpoint.

**Authentication:** None required.

**Response (200):**

```json
{
  "models": [
    {
      "id": "claude-opus-4-20250514",
      "name": "Claude Opus 4",
      "description": "Most capable, best for complex health analysis"
    },
    {
      "id": "claude-sonnet-4-20250514",
      "name": "Claude Sonnet 4",
      "description": "Balanced speed and capability (default)"
    },
    {
      "id": "claude-haiku-3-5-20241022",
      "name": "Claude Haiku 3.5",
      "description": "Fastest, best for simple questions"
    }
  ],
  "default": "claude-sonnet-4-20250514"
}
```

**Example with curl:**

```bash
curl https://wellnessmcp-production.up.railway.app/chat/models
```

---

## How the Health Context is Built

The `HealthContextBuilder` queries all health data categories from SQLite for the specified time range (default: last 14 days) and formats them into a concise text summary injected into the system prompt.

### Categories included:
1. **Sleep** -- Nightly records with duration breakdown (deep, REM, light), efficiency, HRV, HR, and sleep scores. Includes average summary.
2. **Activity** -- Daily activity records with steps, calories, distance, active minutes, VO2max. Includes average summary.
3. **Vitals** -- Grouped by metric type (HRV, resting HR, SpO2, etc.) with recent readings, averages, and trend direction.
4. **Body Composition** -- Weight, body fat %, muscle mass, BMI with trend analysis.
5. **Glucose** -- Recent readings with trend arrows, average, and min/max range.

### Privacy filtering:
Each category passes through the PrivacyLayer before inclusion:
- **Consent Gate**: If the user has disabled sharing for a category, it shows "Data sharing disabled by user" instead of the data.
- **PII Redaction**: Any personally identifiable information is stripped.
- **Aggregation**: If the user's consent granularity is set to "aggregated" or "summary", individual records are aggregated accordingly.

### Empty data handling:
When a category has no data for the time range, it shows "No [category] data available for this period" rather than being omitted entirely. This helps Claude give accurate responses like "I don't have sleep data for that period" instead of ignoring the topic.

### Trend analysis:
The context builder computes simple trends by comparing the average of the first half (recent) vs. second half (older) of the data window, using a 5% threshold to classify as "increasing", "decreasing", or "stable".

---

## Error Handling Reference

| Status | Error | Cause |
|--------|-------|-------|
| 400 | Invalid JSON | Request body is not valid JSON |
| 400 | Missing API key | No Anthropic API key found (body, stored, or env) |
| 401 | Unauthorized | Invalid or missing ingest API key (X-API-Key header) |
| 401 | Invalid Anthropic API key | The Anthropic API key was rejected by Claude's API |
| 413 | Payload too large | Request body exceeds 5MB |
| 422 | Validation failed | Zod validation failure -- check `details` array for field errors |
| 429 | Rate limited | Anthropic API rate limit exceeded -- wait and retry |
| 500 | Chat failed | Unexpected error during chat processing |

Error responses always include:
```json
{
  "error": "Error type",
  "message": "Human-readable description"
}
```

Validation errors (422) also include a `details` array:
```json
{
  "error": "Validation failed",
  "message": "The request does not match the expected format.",
  "details": [
    { "path": "message", "message": "Message is required" }
  ]
}
```

---

## iOS Integration Guide

### Setup flow:

1. **Get an Anthropic API key**: The user creates one at [console.anthropic.com](https://console.anthropic.com/). This is their personal key -- WellnessMCP never sees or stores it persistently.

2. **Store the key (optional)**: Call `POST /chat/api-key` once to store the key server-side. This avoids sending it with every request. Use the iOS device ID as `user_id`.

3. **Send questions**: Call `POST /chat` with the user's question. If the key was stored, just send `message` and `user_id`.

### Recommended iOS implementation:

```swift
struct ChatRequest: Codable {
    let message: String
    let apiKey: String?       // nil if stored server-side
    let userId: String?
    let model: String?
    let days: Int?

    enum CodingKeys: String, CodingKey {
        case message
        case apiKey = "api_key"
        case userId = "user_id"
        case model
        case days
    }
}

struct ChatResponse: Codable {
    let response: String
    let model: String
    let contextDays: Int

    enum CodingKeys: String, CodingKey {
        case response
        case model
        case contextDays = "context_days"
    }
}

func askHealthQuestion(_ question: String) async throws -> ChatResponse {
    let url = URL(string: "https://wellnessmcp-production.up.railway.app/chat")!
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue(ingestApiKey, forHTTPHeaderField: "X-API-Key")

    let body = ChatRequest(
        message: question,
        apiKey: nil,  // using stored key
        userId: UIDevice.current.identifierForVendor?.uuidString,
        model: nil,   // use default
        days: 14
    )
    request.httpBody = try JSONEncoder().encode(body)

    let (data, _) = try await URLSession.shared.data(for: request)
    return try JSONDecoder().decode(ChatResponse.self, from: data)
}
```

### Tips:
- Use `days: 7` for recent questions ("How did I sleep this week?") and `days: 30` for trend questions ("What's my HRV trend?")
- The default model (`claude-sonnet-4-20250514`) is a good balance of speed and quality. Use `claude-haiku-3-5-20241022` for faster responses on simple questions.
- Handle 429 (rate limit) errors with exponential backoff.
- The response time depends on the Claude API -- typically 2-8 seconds.

---

## Getting an Anthropic API Key

1. Go to [console.anthropic.com](https://console.anthropic.com/)
2. Create an account or sign in
3. Navigate to "API Keys" in the dashboard
4. Click "Create Key"
5. Copy the key (starts with `sk-ant-api03-`)
6. Add credit to your account (Claude API is pay-per-use)

The API key is the user's personal key. WellnessMCP uses it only to call the Claude API on the user's behalf. The key is never stored persistently on the server (only in memory until restart).
