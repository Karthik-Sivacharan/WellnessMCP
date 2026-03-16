import type Database from "better-sqlite3";

export const SCHEMA_VERSION = 1;

export function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS health_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      metric_type TEXT NOT NULL,
      value REAL NOT NULL,
      unit TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(provider, metric_type, timestamp)
    );

    CREATE TABLE IF NOT EXISTS sleep_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      date TEXT NOT NULL,
      bedtime TEXT,
      wake_time TEXT,
      total_duration_min REAL,
      deep_min REAL,
      rem_min REAL,
      light_min REAL,
      awake_min REAL,
      efficiency REAL,
      hrv_avg REAL,
      hr_avg REAL,
      hr_min REAL,
      respiratory_rate REAL,
      score REAL,
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(provider, date)
    );

    CREATE TABLE IF NOT EXISTS activity_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      date TEXT NOT NULL,
      activity_type TEXT DEFAULT 'daily_summary',
      steps INTEGER,
      calories_total REAL,
      calories_active REAL,
      distance_m REAL,
      active_minutes INTEGER,
      floors_climbed INTEGER,
      vo2_max REAL,
      training_load REAL,
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(provider, date, activity_type)
    );

    CREATE TABLE IF NOT EXISTS vitals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      metric TEXT NOT NULL,
      value REAL NOT NULL,
      unit TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(provider, metric, timestamp)
    );

    CREATE TABLE IF NOT EXISTS body_composition (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      date TEXT NOT NULL,
      weight_kg REAL,
      body_fat_pct REAL,
      muscle_mass_kg REAL,
      bmi REAL,
      bone_mass_kg REAL,
      water_pct REAL,
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(provider, date)
    );

    CREATE TABLE IF NOT EXISTS glucose_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      value REAL NOT NULL,
      unit TEXT NOT NULL DEFAULT 'mg/dL',
      trend TEXT,
      timestamp TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(provider, timestamp)
    );

    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      device_model TEXT,
      firmware_version TEXT,
      last_sync TEXT,
      oauth_tokens TEXT,
      status TEXT DEFAULT 'connected',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (datetime('now')),
      tool_name TEXT NOT NULL,
      data_categories TEXT NOT NULL,
      record_count INTEGER DEFAULT 0,
      was_aggregated INTEGER DEFAULT 0,
      was_redacted INTEGER DEFAULT 0,
      client_info TEXT,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS consent_scopes (
      category TEXT PRIMARY KEY,
      enabled INTEGER DEFAULT 1,
      granularity TEXT DEFAULT 'aggregated',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_health_metrics_type_ts ON health_metrics(metric_type, timestamp);
    CREATE INDEX IF NOT EXISTS idx_sleep_date ON sleep_records(date);
    CREATE INDEX IF NOT EXISTS idx_activity_date ON activity_records(date);
    CREATE INDEX IF NOT EXISTS idx_vitals_metric_ts ON vitals(metric, timestamp);
    CREATE INDEX IF NOT EXISTS idx_glucose_ts ON glucose_readings(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(timestamp);
  `);

  // Insert default consent scopes
  const insertConsent = db.prepare(`
    INSERT OR IGNORE INTO consent_scopes (category, enabled, granularity)
    VALUES (?, 1, 'aggregated')
  `);

  const categories = [
    "sleep", "activity", "vitals", "body_composition",
    "glucose", "health_metrics", "devices",
  ];

  for (const cat of categories) {
    insertConsent.run(cat);
  }

  // Track schema version
  db.prepare("INSERT OR REPLACE INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
}
