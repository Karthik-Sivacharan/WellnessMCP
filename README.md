# WellnessMCP

Local-first, privacy-first health data MCP server. Your health data never leaves your machine.

WellnessMCP is a [Model Context Protocol](https://modelcontextprotocol.io/) server that stores health data from wearables and fitness platforms in a local SQLite database, then exposes it to Claude through 19 MCP tools. Every query passes through a privacy layer that enforces consent, redacts PII, and logs access.

## Architecture

```
┌──────────────────┐                    ┌──────────────────────────────────────┐
│  AthletiqX iOS   │  HTTP POST         │  WellnessMCP                         │
│  (Apple HealthKit)│ ───────────────>  │                                      │
└──────────────────┘  /ingest/health    │  IngestServer (:3456)                │
                                        │    ├─ Zod validation                 │
┌──────────────────┐                    │    ├─ Normalizer (units, grouping)   │
│  Oura / WHOOP /  │  OAuth + REST      │    └─ StorageManager                 │
│  Garmin / Fitbit │ ───────────────>  │           ↓                          │
└──────────────────┘  (coming soon)     │       SQLite (WAL, encrypted)        │
                                        │           ↓                          │
┌──────────────────┐  MCP stdio         │  PrivacyLayer                        │
│  Claude Desktop  │ <──────────────>  │    ├─ Consent Gate (7 categories)    │
│  or Claude Code  │                    │    ├─ PII Redactor (13 field types)  │
│                  │                    │    ├─ Data Aggregator                │
└──────────────────┘                    │    └─ Audit Logger                   │
                                        │           ↓                          │
                                        │  19 MCP Tools                        │
                                        └──────────────────────────────────────┘
```

## Features

- **Privacy-first** — Consent gate, PII redaction, data aggregation, and full audit trail on every query
- **Local storage** — SQLite with WAL mode, optional SQLCipher encryption, OS keychain for secrets
- **Multi-provider** — Abstract provider system supporting Apple Health (implemented), Oura, WHOOP, Garmin, Fitbit, Dexcom (planned)
- **19 MCP tools** — Sleep, activity, vitals, body composition, glucose, devices, privacy controls, and AI-ready insights
- **Apple Health via AthletiqX** — Push-based integration with [AthletiqX](https://github.com/syntheticfinds/athletiqx) iOS app

## Quick Start

### Prerequisites

- Node.js >= 20
- macOS (for keychain support) or Linux (uses file-based key fallback)

### Install and Run

```bash
git clone https://github.com/Karthik-Sivacharan/WellnessMCP.git
cd WellnessMCP
npm install
npm run build
npm start
```

For development with auto-reload:

```bash
npm run dev
```

### Configure with Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "wellness": {
      "command": "node",
      "args": ["/path/to/WellnessMCP/dist/index.js"]
    }
  }
}
```

### Configure with Claude Code

```bash
claude mcp add wellness node /path/to/WellnessMCP/dist/index.js
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `WELLNESS_MCP_INGEST_PORT` | `3456` | Port for the Apple Health HTTP ingest server |
| `WELLNESS_MCP_INGEST_KEY` | *(none)* | API key for ingest server authentication |
| `OAUTH_REDIRECT_PORT` | `9876` | Port for OAuth redirect server |
| `DATA_RETENTION_DAYS` | `90` | Auto-purge data older than N days |
| `DB_PATH` | `~/.wellness-mcp/data.db` | SQLite database location |

Copy `.env.example` to `.env` and fill in your values.

## MCP Tools

### Health

| Tool | Description |
|---|---|
| `get_health_metrics` | Query health metrics by type and date range |
| `get_data_inventory` | Show stored data counts, date ranges, connected devices |
| `sync_providers` | Sync data from all or a specific provider |
| `delete_health_data` | Delete data by category (requires confirmation) |

### Sleep

| Tool | Description |
|---|---|
| `get_sleep` | Get sleep records — duration, phases, HRV, HR, score |
| `get_sleep_summary` | Averages over N days |

### Activity

| Tool | Description |
|---|---|
| `get_activity` | Get activity records — steps, calories, distance, active minutes |
| `get_activity_summary` | Totals and daily averages over N days |

### Body & Vitals

| Tool | Description |
|---|---|
| `get_body_composition` | Weight, body fat %, muscle mass, BMI |
| `get_vitals` | Heart rate, blood pressure, SpO2, temperature |
| `get_glucose` | CGM glucose readings |

### Devices

| Tool | Description |
|---|---|
| `list_devices` | List connected devices and available providers |
| `connect_provider` | Start OAuth flow or provide configuration |

### Privacy

| Tool | Description |
|---|---|
| `get_privacy_settings` | View consent scopes and granularity levels |
| `set_privacy_scope` | Enable/disable data categories, change granularity |
| `get_audit_log` | View the data access audit trail |
| `purge_old_data` | Delete data older than N days (requires confirmation) |

### Insights

| Tool | Description |
|---|---|
| `get_daily_briefing` | Comprehensive daily briefing across all health categories |
| `get_trends` | Trend analysis with direction, change %, and statistics |
| `get_correlations` | Pearson correlation between any two metrics |

## Apple Health Integration

WellnessMCP receives Apple HealthKit data from the [AthletiqX](https://github.com/syntheticfinds/athletiqx) iOS app via a push-based HTTP ingest server.

### How it works

1. AthletiqX reads 13 HealthKit data types on the iOS device
2. Posts a `HealthSnapshot` JSON payload to `http://your-server:3456/ingest/health`
3. WellnessMCP validates (Zod), normalizes (units, grouping), and stores in SQLite
4. Claude queries the data through MCP tools

### Data types supported

| Category | HealthKit Sources | Normalization |
|---|---|---|
| **Sleep** | Sleep stages (core, deep, REM, awake) | Seconds to minutes, efficiency calculation |
| **Activity** | Steps, active energy, exercise time, workouts | Daily aggregation, 70+ workout type mappings |
| **Vitals** | HRV (SDNN), resting HR, SpO2 | HRV in ms, HR in bpm, SpO2 fraction to % |
| **Body** | Weight, body fat, lean mass, BMI | Group by date, fraction to percentage |
| **Cardio** | VO2 Max | Merged into daily activity summaries |

### Test with curl

```bash
# Check ingest server status
curl http://localhost:3456/ingest/health/status

# Send test data
curl -X POST http://localhost:3456/ingest/health \
  -H "Content-Type: application/json" \
  -d '{
    "fetched_at": "2026-03-28T10:00:00Z",
    "vitals": {
      "hrv_samples": [{ "date": "2026-03-28T07:30:00Z", "value": 45.2 }],
      "resting_heart_rate_samples": [{ "date": "2026-03-28T06:00:00Z", "value": 58 }],
      "spo2_samples": []
    },
    "sleep": { "sessions": [] },
    "activity": { "daily_steps": [], "daily_active_energy": [], "daily_exercise_minutes": [], "workouts": [] },
    "body_composition": { "body_mass_samples": [], "body_fat_percentage_samples": [], "lean_body_mass_samples": [], "bmi_samples": [] },
    "cardio_fitness": { "vo2_max_samples": [] }
  }'
```

See [docs/apple-health-integration.md](docs/apple-health-integration.md) for the full payload format, Swift integration guide, and troubleshooting.

## Privacy Layer

Every data access passes through the privacy pipeline:

1. **Consent Gate** — Checks if the user has consented to share each data category. Three granularity levels: `raw`, `aggregated`, `summary`.
2. **PII Redactor** — Detects and redacts 13 types of personally identifiable information (email, phone, SSN, GPS coordinates, MAC addresses, etc.).
3. **Data Aggregator** — Converts raw records into statistical summaries (min, max, avg, median) or high-level overviews when granularity requires it.
4. **Audit Logger** — Records every data access with tool name, categories queried, record count, and privacy flags.

Default privacy settings are in `config/default-privacy.json`. All categories default to `aggregated` granularity.

## Project Structure

```
src/
  index.ts                  # Entry point — starts MCP + ingest servers
  server.ts                 # MCP server creation and tool registration
  providers/
    base.ts                 # Abstract HealthProvider + ProviderRegistry
    types.ts                # Normalized data types (Sleep, Activity, Vital, etc.)
    apple-health.ts         # Apple Health push-based provider
  ingest/
    server.ts               # HTTP ingest server for iOS app data
    types.ts                # Zod schemas for HealthSnapshot validation
    normalizer.ts           # HealthKit → WellnessMCP data transformation
  storage/
    db.ts                   # StorageManager — SQLite CRUD operations
    schema.ts               # Database schema (10 tables)
    keychain.ts             # OS keychain / file-based key management
  privacy/
    index.ts                # PrivacyLayer orchestrator
    consent.ts              # Consent gate — category-level access control
    redactor.ts             # PII detection and redaction
    aggregator.ts           # Data aggregation (raw → summary)
    audit.ts                # Audit logging
  tools/
    health.ts               # get_health_metrics, get_data_inventory, sync_providers, delete_health_data
    sleep.ts                # get_sleep, get_sleep_summary
    activity.ts             # get_activity, get_activity_summary
    body.ts                 # get_body_composition, get_vitals, get_glucose
    devices.ts              # list_devices, connect_provider
    privacy.ts              # get_privacy_settings, set_privacy_scope, get_audit_log, purge_old_data
    insights.ts             # get_daily_briefing, get_trends, get_correlations
  utils/
    oauth.ts                # OAuth 2.0 PKCE flow utility
    normalize.ts            # Unit conversion helpers
config/
  default-privacy.json      # Default consent and PII redaction settings
docs/
  apple-health-integration.md  # Full Apple Health integration guide
```

## Providers

| Provider | Status | Architecture |
|---|---|---|
| Apple Health | Implemented | Push-based via AthletiqX iOS app |
| Oura Ring | Planned | OAuth + REST API |
| WHOOP | Planned | OAuth + REST API |
| Garmin Connect | Planned | OAuth + REST API |
| Fitbit | Planned | OAuth + REST API |
| Dexcom | Planned | OAuth + REST API |

## Database

SQLite with WAL mode and foreign key constraints. 10 tables:

- `sleep_records` — Daily sleep data with stage durations
- `activity_records` — Daily summaries and individual workouts
- `vitals` — Point-in-time vital measurements (HRV, HR, SpO2, etc.)
- `body_composition` — Weight, body fat, muscle mass, BMI
- `glucose_readings` — Continuous glucose monitor data
- `health_metrics` — Generic metric storage
- `devices` — Connected device metadata and sync status
- `audit_log` — Data access audit trail
- `consent_scopes` — Per-category consent and granularity settings
- `schema_version` — Database migration tracking

Data is stored at `~/.wellness-mcp/data.db` by default. Optional SQLCipher encryption when available.

## License

MIT
