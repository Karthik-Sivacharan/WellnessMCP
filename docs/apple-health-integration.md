# Apple Health Integration Guide

WellnessMCP receives Apple HealthKit data from the **AthletiqX iOS app** via a local HTTP ingest server. This is a push-based architecture — the iOS app reads from HealthKit and POSTs the data to WellnessMCP, which validates, normalizes, and stores it in the local SQLite database.

## Architecture

```
┌──────────────────┐     HTTP POST      ┌──────────────────────────────────────┐
│  AthletiqX iOS   │ ──────────────────> │  WellnessMCP                         │
│  (reads HealthKit)│  /ingest/health    │                                      │
└──────────────────┘                     │  IngestServer (:3456)                │
                                         │    ├─ Zod validation                 │
                                         │    ├─ Normalizer (units, grouping)   │
                                         │    └─ StorageManager → SQLite        │
                                         │                                      │
┌──────────────────┐     MCP stdio      │  MCP Server (stdin/stdout)           │
│  Claude Desktop  │ <────────────────> │    └─ 16+ tools read from SQLite     │
│  or Claude Code  │                     └──────────────────────────────────────┘
└──────────────────┘
```

**Key points:**
- The MCP server communicates with Claude via **stdin/stdout** (stdio transport)
- The ingest server listens on a **separate HTTP port** (default 3456) — no conflict
- Data is stored locally in **SQLite** — nothing leaves your machine
- The ingest server starts automatically when WellnessMCP launches

## Setup

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `WELLNESS_MCP_INGEST_PORT` | `3456` | Port for the HTTP ingest server |
| `WELLNESS_MCP_INGEST_KEY` | *(none)* | Optional API key for authentication |

### Configuration

Add to your `.env` file (or set in your shell):

```bash
# Required: none (works with defaults)

# Optional: change the ingest port
WELLNESS_MCP_INGEST_PORT=3456

# Recommended: set an API key for security
WELLNESS_MCP_INGEST_KEY=your-secret-key-here
```

### Starting the Server

The ingest server starts automatically when you run WellnessMCP:

```bash
# Development
npm run dev

# Production
npm run build && npm start
```

You'll see in stderr:
```
[WellnessMCP] Apple Health ingest server started on port 3456
[IngestServer] Listening on port 3456
[IngestServer] API key authentication is enabled
```

## API Endpoints

### POST /ingest/health

Receives a HealthSnapshot JSON payload from the iOS app.

**Headers:**
- `Content-Type: application/json`
- `X-API-Key: <key>` or `Authorization: Bearer <key>` (if API key is configured)

**Request body:** HealthSnapshot JSON (see payload format below)

**Response (200):**
```json
{
  "success": true,
  "message": "Health data ingested successfully.",
  "fetched_at": "2026-03-28T10:00:00Z",
  "records_stored": {
    "sleep": 1,
    "activity": 5,
    "vitals": 12,
    "body_composition": 1
  },
  "total_records": 19
}
```

**Error responses:**
- `401` — Missing or invalid API key
- `400` — Invalid JSON
- `413` — Payload exceeds 5MB limit
- `422` — Zod validation failed (includes detailed field errors)

### GET /ingest/health/status

Returns the current status of the ingest server.

**Response (200):**
```json
{
  "status": "ok",
  "provider": "apple_health",
  "server": {
    "running": true,
    "port": 3456,
    "api_key_configured": true
  },
  "last_ingest": {
    "at": "2026-03-28T10:00:00Z",
    "records": {
      "sleep": 1,
      "activity": 5,
      "vitals": 12,
      "body_composition": 1
    }
  },
  "totals": {
    "successful_ingests": 42,
    "failed_ingests": 0
  },
  "device": {
    "last_sync": "2026-03-28 10:00:00",
    "status": "connected"
  },
  "data_inventory": {
    "sleep": { "count": 30, "earliest": "2026-02-26", "latest": "2026-03-28" },
    "activity": { "count": 120, "earliest": "2026-02-26", "latest": "2026-03-28" },
    "vitals": { "count": 450, "earliest": "2026-02-26T00:00:00Z", "latest": "2026-03-28T10:00:00Z" },
    "body_composition": { "count": 15, "earliest": "2026-03-01", "latest": "2026-03-28" },
    "glucose": { "count": 0, "earliest": null, "latest": null },
    "health_metrics": { "count": 0, "earliest": null, "latest": null }
  }
}
```

## HealthSnapshot Payload Format

The iOS app sends a `HealthSnapshot` JSON object containing all health data categories. All keys are **snake_case** (iOS uses `convertToSnakeCase` encoding).

### Complete Example

```json
{
  "vitals": {
    "hrv_samples": [
      { "date": "2026-03-28T07:30:00Z", "value": 45.2 },
      { "date": "2026-03-27T07:15:00Z", "value": 52.1 }
    ],
    "resting_heart_rate_samples": [
      { "date": "2026-03-28T06:00:00Z", "value": 58 },
      { "date": "2026-03-27T06:00:00Z", "value": 55 }
    ],
    "spo2_samples": [
      { "date": "2026-03-28T03:00:00Z", "value": 0.98 }
    ]
  },
  "sleep": {
    "sessions": [
      {
        "date": "2026-03-28",
        "in_bed_duration": 28800,
        "asleep_core_duration": 14400,
        "asleep_deep_duration": 5400,
        "asleep_rem_duration": 5400,
        "awake_duration": 1800
      }
    ]
  },
  "activity": {
    "daily_steps": [
      { "date": "2026-03-28T00:00:00Z", "value": 8542 },
      { "date": "2026-03-27T00:00:00Z", "value": 12305 }
    ],
    "daily_active_energy": [
      { "date": "2026-03-28T00:00:00Z", "value": 425.3 },
      { "date": "2026-03-27T00:00:00Z", "value": 612.8 }
    ],
    "daily_exercise_minutes": [
      { "date": "2026-03-28T00:00:00Z", "value": 32 },
      { "date": "2026-03-27T00:00:00Z", "value": 58 }
    ],
    "workouts": [
      {
        "activity_type": 37,
        "start_date": "2026-03-27T17:00:00Z",
        "duration": 2700,
        "total_energy_burned": 350.5,
        "total_distance": 5200
      }
    ]
  },
  "body_composition": {
    "body_mass_samples": [
      { "date": "2026-03-28T07:00:00Z", "value": 75.2 }
    ],
    "body_fat_percentage_samples": [
      { "date": "2026-03-28T07:00:00Z", "value": 0.18 }
    ],
    "lean_body_mass_samples": [
      { "date": "2026-03-28T07:00:00Z", "value": 61.7 }
    ],
    "bmi_samples": [
      { "date": "2026-03-28T07:00:00Z", "value": 24.1 }
    ]
  },
  "cardio_fitness": {
    "vo2_max_samples": [
      { "date": "2026-03-27T17:45:00Z", "value": 42.5 }
    ]
  },
  "fetched_at": "2026-03-28T10:00:00Z"
}
```

### Field Reference

#### DatedValue
Every measurement is a `{ date, value }` pair:
- `date` — ISO 8601 timestamp (e.g., `"2026-03-28T08:00:00Z"`)
- `value` — Numeric value (units depend on context)

#### Vitals
| Field | Unit | Notes |
|---|---|---|
| `hrv_samples[].value` | milliseconds | HRV SDNN |
| `resting_heart_rate_samples[].value` | bpm | Resting heart rate |
| `spo2_samples[].value` | 0-1 fraction | 0.98 = 98% SpO2 |

#### Sleep Sessions
| Field | Unit | Notes |
|---|---|---|
| `in_bed_duration` | seconds | Total time in bed |
| `asleep_core_duration` | seconds | Light/core sleep (NREM 1-2) |
| `asleep_deep_duration` | seconds | Deep sleep (NREM 3) |
| `asleep_rem_duration` | seconds | REM sleep |
| `awake_duration` | seconds | Time awake during session |

#### Activity
| Field | Unit | Notes |
|---|---|---|
| `daily_steps[].value` | count | Step count |
| `daily_active_energy[].value` | kcal | Active calories burned |
| `daily_exercise_minutes[].value` | minutes | Apple Exercise ring |
| `workouts[].activity_type` | integer | HKWorkoutActivityType rawValue |
| `workouts[].duration` | seconds | Workout duration |
| `workouts[].total_energy_burned` | kcal | Optional |
| `workouts[].total_distance` | meters | Optional |

#### Body Composition
| Field | Unit | Notes |
|---|---|---|
| `body_mass_samples[].value` | kg | Body weight |
| `body_fat_percentage_samples[].value` | 0-1 fraction | 0.18 = 18% |
| `lean_body_mass_samples[].value` | kg | Lean body mass |
| `bmi_samples[].value` | unitless | Body Mass Index |

#### Cardio Fitness
| Field | Unit | Notes |
|---|---|---|
| `vo2_max_samples[].value` | mL/kg/min | VO2 Max estimate |

### HKWorkoutActivityType Mapping

Common activity type integers and their mapped names:

| Raw Value | Activity |
|---|---|
| 3 | dance |
| 13 | cycling |
| 20 | functional_training |
| 22 | hiking |
| 24 | gymnastics |
| 35/37 | running |
| 44/46 | swimming |
| 50 | yoga |
| 52 | hiking |
| 56 | pilates |
| 60 | high_intensity_interval_training |
| 63 | mixed_cardio |

Unknown types fall back to `workout_<rawValue>`.

## Testing with curl

### Check status

```bash
curl http://localhost:3456/ingest/health/status
```

### Send a minimal payload

```bash
curl -X POST http://localhost:3456/ingest/health \
  -H "Content-Type: application/json" \
  -d '{
    "fetched_at": "2026-03-28T10:00:00Z",
    "vitals": { "hrv_samples": [{ "date": "2026-03-28T07:30:00Z", "value": 45.2 }] },
    "sleep": { "sessions": [] },
    "activity": { "daily_steps": [], "daily_active_energy": [], "daily_exercise_minutes": [], "workouts": [] },
    "body_composition": { "body_mass_samples": [], "body_fat_percentage_samples": [], "lean_body_mass_samples": [], "bmi_samples": [] },
    "cardio_fitness": { "vo2_max_samples": [] }
  }'
```

### Send with API key

```bash
curl -X POST http://localhost:3456/ingest/health \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-secret-key-here" \
  -d @health-snapshot.json
```

### Send the complete example payload

Save the complete example above as `health-snapshot.json`, then:

```bash
curl -X POST http://localhost:3456/ingest/health \
  -H "Content-Type: application/json" \
  -d @health-snapshot.json
```

## AthletiqX iOS Integration Guide

To send HealthKit data from the AthletiqX app to WellnessMCP:

### 1. Build the HealthSnapshot

Collect data from your existing HealthKit managers into the snapshot format:

```swift
struct HealthSnapshot: Codable {
    let vitals: VitalsData
    let sleep: SleepData
    let activity: ActivityData
    let bodyComposition: BodyCompositionData
    let cardioFitness: CardioFitnessData
    let fetchedAt: String  // ISO 8601
}

// The JSONEncoder with .convertToSnakeCase will automatically
// convert fetchedAt -> fetched_at, bodyComposition -> body_composition, etc.
```

### 2. Configure the encoder

```swift
let encoder = JSONEncoder()
encoder.keyEncodingStrategy = .convertToSnakeCase
encoder.dateEncodingStrategy = .iso8601
```

### 3. POST to WellnessMCP

```swift
func syncToWellnessMCP(snapshot: HealthSnapshot) async throws {
    let url = URL(string: "http://YOUR_MAC_IP:3456/ingest/health")!
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")

    // Add API key if configured
    if let apiKey = UserDefaults.standard.string(forKey: "wellnessMCPApiKey") {
        request.setValue(apiKey, forHTTPHeaderField: "X-API-Key")
    }

    request.httpBody = try JSONEncoder.snakeCase.encode(snapshot)

    let (data, response) = try await URLSession.shared.data(for: request)
    let httpResponse = response as! HTTPURLResponse

    guard httpResponse.statusCode == 200 else {
        let error = try JSONDecoder().decode(ErrorResponse.self, from: data)
        throw SyncError.serverError(error.message)
    }
}
```

### 4. Network discovery

Since WellnessMCP runs on your Mac and the iOS app runs on your iPhone, they need to be on the same local network. The iOS app should:

- Allow the user to enter the Mac's IP address and port
- Optionally use Bonjour/mDNS for automatic discovery
- Store the configuration in UserDefaults

### 5. Sync frequency

Recommended sync strategies:
- **Background refresh**: Sync every 15-30 minutes using `BGAppRefreshTask`
- **App foreground**: Sync when the app becomes active
- **Manual**: User-triggered sync button
- **After workout**: Sync immediately when a workout completes (via HKObserverQuery)

## Troubleshooting

### Server won't start

**Port already in use:**
```
Error: listen EADDRINUSE: address already in use :::3456
```
Solution: Change the port via `WELLNESS_MCP_INGEST_PORT=3457` or kill the process using port 3456:
```bash
lsof -ti:3456 | xargs kill
```

**Permission denied:**
Ports below 1024 require root. Use the default port 3456 or any port above 1024.

### iOS app can't connect

1. Verify the server is running: `curl http://localhost:3456/ingest/health/status`
2. Check your Mac's IP: `ifconfig | grep "inet " | grep -v 127.0.0.1`
3. Ensure both devices are on the same Wi-Fi network
4. Check macOS firewall: System Settings > Network > Firewall — allow incoming connections
5. Try from the iOS device: replace `localhost` with your Mac's IP address

### 401 Unauthorized

The API key doesn't match. Check:
- The `WELLNESS_MCP_INGEST_KEY` environment variable on the Mac
- The `X-API-Key` header or `Authorization: Bearer` header in the iOS request
- Keys are case-sensitive and must match exactly

### 422 Validation Failed

The payload doesn't match the expected schema. The error response includes details:
```json
{
  "error": "Validation failed",
  "details": [
    { "path": "sleep.sessions.0.in_bed_duration", "message": "Expected number, received string" }
  ]
}
```

Common causes:
- Missing required fields (especially `fetched_at`)
- Wrong types (string instead of number)
- Null values where numbers are expected (use 0 instead, or omit the field)

### Data not showing in Claude

1. Check that data was ingested: `curl http://localhost:3456/ingest/health/status`
2. Use the `get_data_inventory` MCP tool to see what's stored
3. Check the date range — MCP tools query by date range, make sure it covers your data
4. Check privacy settings — the consent gate may be blocking certain categories
