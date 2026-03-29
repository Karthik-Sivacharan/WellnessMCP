# WellnessMCP — Progress Tracker

Local-first, privacy-first health data MCP server. Your health data never leaves your machine.

---

## Completed

### Phase 1 — Project Setup
- Package.json with all dependencies (MCP SDK, better-sqlite3, keytar, zod, etc.)
- TypeScript config (strict, ES2022)
- Environment config template (.env.example) for 6 providers
- Privacy defaults config (config/default-privacy.json)

### Phase 2 — Storage & Security Layer
- **Database schema** — 10 tables: sleep_records, activity_records, vitals, body_composition, glucose_readings, health_metrics, devices, audit_log, consent_scopes, schema_version
- **StorageManager** — Full CRUD for all data types, WAL mode, optional SQLCipher encryption
- **KeychainManager** — OS keychain via keytar with file-based fallback (~/.wellness-mcp/.keyfile)
- Indexes on frequently queried fields

### Phase 3 — Privacy & Provider Abstraction
- **PII Redactor** — Detects/redacts 13 PII types (email, phone, SSN, GPS, MAC, etc.)
- **Consent Gate** — 7 data categories, 3 granularity levels (raw/aggregated/summary)
- **Data Aggregator** — Statistical summaries (min, max, avg, median) or high-level overviews
- **Audit Logger** — Logs every data access with tool name, categories, record count, privacy flags
- **PrivacyLayer** — Orchestrates consent → redaction → aggregation → audit in a single `filter()` call
- **HealthProvider** abstract base class + **ProviderRegistry** for managing 6 provider types
- **Normalized data types** — NormalizedSleep, NormalizedActivity, NormalizedVital, NormalizedBodyComposition, NormalizedGlucose
- **OAuth 2.0 utility** — PKCE flow, local redirect server, token exchange/refresh
- **Normalization helpers** — Unit conversions (kg↔lbs, m↔km/mi, °C↔°F, mg/dL↔mmol), date helpers

### Phase 4 — MCP Tool Implementations (16 tools)

**Health (src/tools/health.ts)**
- `get_health_metrics` — Query generic health metrics by type and date range
- `get_data_inventory` — Show stored data counts, date ranges, connected devices
- `sync_providers` — Sync from all or a specific provider
- `delete_health_data` — Delete data by category (requires confirm=true)

**Sleep (src/tools/sleep.ts)**
- `get_sleep` — Get sleep records (duration, phases, HRV, HR, score)
- `get_sleep_summary` — Averages over N days

**Activity (src/tools/activity.ts)**
- `get_activity` — Get activity records (steps, calories, distance, active minutes)
- `get_activity_summary` — Totals + daily averages over N days

**Body & Vitals (src/tools/body.ts)**
- `get_body_composition` — Weight, body fat %, muscle mass, BMI
- `get_vitals` — Heart rate, blood pressure, SpO2, temperature
- `get_glucose` — CGM glucose readings

**Devices (src/tools/devices.ts)**
- `list_devices` — List connected devices + available providers
- `connect_provider` — Start OAuth flow or provide config

**Privacy (src/tools/privacy.ts)**
- `get_privacy_settings` — View consent scopes and granularity levels
- `set_privacy_scope` — Enable/disable categories, change granularity
- `get_audit_log` — View data access audit trail
- `purge_old_data` — Delete data older than N days (requires confirm=true)

**Insights (src/tools/insights.ts)**
- `get_daily_briefing` — Comprehensive daily briefing across all health categories
- `get_trends` — Trend analysis with direction, change %, and stats
- `get_correlations` — Pearson correlation between any two metrics

### Phase 5 — Provider Implementations (partial)

**Apple Health (src/providers/apple-health.ts + src/ingest/)**
- **AppleHealthProvider** — Push-based HealthProvider implementation; starts HTTP ingest server on connect()
- **IngestServer** (src/ingest/server.ts) — Node.js `http` server (no Express) on configurable port (default 3456)
  - `POST /ingest/health` — Accepts HealthSnapshot JSON from AthletiqX iOS app
  - `GET /ingest/health/status` — Returns connection status, last sync time, record counts
  - API key auth via `X-API-Key` or `Authorization: Bearer` headers (optional, env `WELLNESS_MCP_INGEST_KEY`)
  - CORS headers, 5MB request size limit, Zod validation, meaningful error responses
- **HealthSnapshot types** (src/ingest/types.ts) — Zod schemas + TypeScript interfaces for all 13 HealthKit data types
- **Normalizer** (src/ingest/normalizer.ts) — Transforms HealthSnapshot → WellnessMCP normalized types:
  - Sleep: seconds→minutes, efficiency calculation, stage mapping (core→light)
  - Activity: daily aggregation by date, individual workouts with HKWorkoutActivityType mapping (70+ types)
  - Vitals: HRV (ms), resting HR (bpm), SpO2 (fraction→percentage)
  - Body composition: group by date, body fat fraction→percentage, lean mass→muscle_mass_kg
  - VO2 Max merged into daily activity summaries
- **Auto-start** — Ingest server starts automatically on WellnessMCP startup, graceful shutdown on SIGINT
- **Documentation** — docs/apple-health-integration.md with architecture, setup, payload format, curl examples, troubleshooting

---

## Up Next

### Phase 5 — Provider Implementations (remaining)
- [ ] **Oura Ring** — OAuth connect, REST API sync (sleep, activity, readiness)
- [ ] **WHOOP** — OAuth connect, REST API sync (sleep, strain, recovery)
- [ ] **Garmin Connect** — OAuth connect, REST API sync (activities, sleep, body)
- [ ] **Fitbit** — OAuth connect, REST API sync (sleep, activity, heart rate, weight)
- [ ] **Dexcom** — OAuth connect, REST API sync (glucose readings)

### Phase 6 — Testing
- [ ] Unit tests for privacy layer (redactor, consent gate, aggregator)
- [ ] Unit tests for storage manager (CRUD operations)
- [ ] Unit tests for each tool file (mock storage + privacy)
- [ ] Integration tests (tool → privacy → storage flow)
- [ ] Provider tests with mock API responses

### Phase 7 — Polish & Documentation
- [ ] README with setup guide, architecture overview, usage examples
- [ ] Error handling and recovery patterns
- [ ] CLI argument parsing for the MCP server
- [ ] Rate limiting for provider API calls
- [ ] Data retention policy auto-enforcement
- [ ] CLAUDE.md for development conventions
