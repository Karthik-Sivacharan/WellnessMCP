import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { KeychainManager } from "./keychain.js";
import { initializeSchema } from "./schema.js";

export class StorageManager {
  private db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static async create(dbPath?: string): Promise<StorageManager> {
    const resolvedPath = dbPath ?? path.join(os.homedir(), ".wellness-mcp", "data.db");
    const dir = path.dirname(resolvedPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const encryptionKey = await KeychainManager.getOrCreateKey();
    const db = new Database(resolvedPath);

    // Use SQLCipher if available, otherwise use regular SQLite with app-level key tracking
    try {
      db.pragma(`key='${encryptionKey}'`);
    } catch {
      // SQLCipher not available — continue with unencrypted SQLite
      // The key is still stored for future migration to SQLCipher
    }

    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    initializeSchema(db);

    return new StorageManager(db);
  }

  // --- Generic query helpers ---

  run(sql: string, ...params: unknown[]): Database.RunResult {
    return this.db.prepare(sql).run(...params);
  }

  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  // --- Sleep Records ---

  upsertSleep(record: {
    provider: string;
    date: string;
    bedtime?: string;
    wake_time?: string;
    total_duration_min?: number;
    deep_min?: number;
    rem_min?: number;
    light_min?: number;
    awake_min?: number;
    efficiency?: number;
    hrv_avg?: number;
    hr_avg?: number;
    hr_min?: number;
    respiratory_rate?: number;
    score?: number;
    metadata?: string;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO sleep_records
        (provider, date, bedtime, wake_time, total_duration_min, deep_min, rem_min,
         light_min, awake_min, efficiency, hrv_avg, hr_avg, hr_min, respiratory_rate, score, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.provider, record.date, record.bedtime ?? null, record.wake_time ?? null,
      record.total_duration_min ?? null, record.deep_min ?? null, record.rem_min ?? null,
      record.light_min ?? null, record.awake_min ?? null, record.efficiency ?? null,
      record.hrv_avg ?? null, record.hr_avg ?? null, record.hr_min ?? null,
      record.respiratory_rate ?? null, record.score ?? null, record.metadata ?? null,
    );
  }

  getSleepRecords(startDate: string, endDate: string, provider?: string): Record<string, unknown>[] {
    if (provider) {
      return this.all(
        "SELECT * FROM sleep_records WHERE date >= ? AND date <= ? AND provider = ? ORDER BY date DESC",
        startDate, endDate, provider,
      );
    }
    return this.all(
      "SELECT * FROM sleep_records WHERE date >= ? AND date <= ? ORDER BY date DESC",
      startDate, endDate,
    );
  }

  // --- Activity Records ---

  upsertActivity(record: {
    provider: string;
    date: string;
    activity_type?: string;
    steps?: number;
    calories_total?: number;
    calories_active?: number;
    distance_m?: number;
    active_minutes?: number;
    floors_climbed?: number;
    vo2_max?: number;
    training_load?: number;
    metadata?: string;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO activity_records
        (provider, date, activity_type, steps, calories_total, calories_active,
         distance_m, active_minutes, floors_climbed, vo2_max, training_load, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.provider, record.date, record.activity_type ?? "daily_summary",
      record.steps ?? null, record.calories_total ?? null, record.calories_active ?? null,
      record.distance_m ?? null, record.active_minutes ?? null, record.floors_climbed ?? null,
      record.vo2_max ?? null, record.training_load ?? null, record.metadata ?? null,
    );
  }

  getActivityRecords(startDate: string, endDate: string, provider?: string): Record<string, unknown>[] {
    if (provider) {
      return this.all(
        "SELECT * FROM activity_records WHERE date >= ? AND date <= ? AND provider = ? ORDER BY date DESC",
        startDate, endDate, provider,
      );
    }
    return this.all(
      "SELECT * FROM activity_records WHERE date >= ? AND date <= ? ORDER BY date DESC",
      startDate, endDate,
    );
  }

  // --- Vitals ---

  upsertVital(record: {
    provider: string;
    metric: string;
    value: number;
    unit: string;
    timestamp: string;
    metadata?: string;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO vitals (provider, metric, value, unit, timestamp, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(record.provider, record.metric, record.value, record.unit, record.timestamp, record.metadata ?? null);
  }

  getVitals(metric: string, startDate: string, endDate: string, provider?: string): Record<string, unknown>[] {
    if (provider) {
      return this.all(
        "SELECT * FROM vitals WHERE metric = ? AND timestamp >= ? AND timestamp <= ? AND provider = ? ORDER BY timestamp DESC",
        metric, startDate, endDate, provider,
      );
    }
    return this.all(
      "SELECT * FROM vitals WHERE metric = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC",
      metric, startDate, endDate,
    );
  }

  getAllVitals(startDate: string, endDate: string): Record<string, unknown>[] {
    return this.all(
      "SELECT * FROM vitals WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC",
      startDate, endDate,
    );
  }

  // --- Body Composition ---

  upsertBodyComposition(record: {
    provider: string;
    date: string;
    weight_kg?: number;
    body_fat_pct?: number;
    muscle_mass_kg?: number;
    bmi?: number;
    bone_mass_kg?: number;
    water_pct?: number;
    metadata?: string;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO body_composition
        (provider, date, weight_kg, body_fat_pct, muscle_mass_kg, bmi, bone_mass_kg, water_pct, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.provider, record.date, record.weight_kg ?? null, record.body_fat_pct ?? null,
      record.muscle_mass_kg ?? null, record.bmi ?? null, record.bone_mass_kg ?? null,
      record.water_pct ?? null, record.metadata ?? null,
    );
  }

  getBodyComposition(startDate: string, endDate: string): Record<string, unknown>[] {
    return this.all(
      "SELECT * FROM body_composition WHERE date >= ? AND date <= ? ORDER BY date DESC",
      startDate, endDate,
    );
  }

  // --- Glucose ---

  upsertGlucose(record: {
    provider: string;
    value: number;
    unit?: string;
    trend?: string;
    timestamp: string;
    metadata?: string;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO glucose_readings (provider, value, unit, trend, timestamp, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(record.provider, record.value, record.unit ?? "mg/dL", record.trend ?? null, record.timestamp, record.metadata ?? null);
  }

  getGlucoseReadings(startDate: string, endDate: string): Record<string, unknown>[] {
    return this.all(
      "SELECT * FROM glucose_readings WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC",
      startDate, endDate,
    );
  }

  // --- Devices ---

  upsertDevice(device: {
    provider: string;
    display_name: string;
    device_model?: string;
    firmware_version?: string;
    oauth_tokens?: string;
    status?: string;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO devices
        (provider, display_name, device_model, firmware_version, last_sync, oauth_tokens, status)
      VALUES (?, ?, ?, ?, datetime('now'), ?, ?)
    `).run(
      device.provider, device.display_name, device.device_model ?? null,
      device.firmware_version ?? null, device.oauth_tokens ?? null, device.status ?? "connected",
    );
  }

  getDevice(provider: string): Record<string, unknown> | undefined {
    return this.get("SELECT * FROM devices WHERE provider = ?", provider);
  }

  getAllDevices(): Record<string, unknown>[] {
    return this.all("SELECT * FROM devices ORDER BY provider");
  }

  updateDeviceSync(provider: string): void {
    this.run("UPDATE devices SET last_sync = datetime('now') WHERE provider = ?", provider);
  }

  // --- Audit Log ---

  logAccess(entry: {
    tool_name: string;
    data_categories: string[];
    record_count: number;
    was_aggregated: boolean;
    was_redacted: boolean;
    client_info?: string;
  }): void {
    this.run(`
      INSERT INTO audit_log (tool_name, data_categories, record_count, was_aggregated, was_redacted, client_info)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      entry.tool_name,
      JSON.stringify(entry.data_categories),
      entry.record_count,
      entry.was_aggregated ? 1 : 0,
      entry.was_redacted ? 1 : 0,
      entry.client_info ?? null,
    );
  }

  getAuditLog(limit = 100): Record<string, unknown>[] {
    return this.all("SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?", limit);
  }

  // --- Consent Scopes ---

  getConsentScopes(): Record<string, unknown>[] {
    return this.all("SELECT * FROM consent_scopes ORDER BY category");
  }

  setConsentScope(category: string, enabled: boolean, granularity: string): void {
    this.run(`
      INSERT OR REPLACE INTO consent_scopes (category, enabled, granularity, updated_at)
      VALUES (?, ?, ?, datetime('now'))
    `, category, enabled ? 1 : 0, granularity);
  }

  // --- Health Metrics (generic) ---

  upsertHealthMetric(record: {
    provider: string;
    metric_type: string;
    value: number;
    unit: string;
    timestamp: string;
    metadata?: string;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO health_metrics (provider, metric_type, value, unit, timestamp, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(record.provider, record.metric_type, record.value, record.unit, record.timestamp, record.metadata ?? null);
  }

  getHealthMetrics(metricType: string, startDate: string, endDate: string): Record<string, unknown>[] {
    return this.all(
      "SELECT * FROM health_metrics WHERE metric_type = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC",
      metricType, startDate, endDate,
    );
  }

  // --- Data Management ---

  deleteDataByCategory(category: string, startDate?: string, endDate?: string): number {
    const tableMap: Record<string, string> = {
      sleep: "sleep_records",
      activity: "activity_records",
      vitals: "vitals",
      body_composition: "body_composition",
      glucose: "glucose_readings",
      health_metrics: "health_metrics",
    };

    const table = tableMap[category];
    if (!table) return 0;

    const dateCol = table === "vitals" || table === "glucose_readings" || table === "health_metrics" ? "timestamp" : "date";

    if (startDate && endDate) {
      return this.run(`DELETE FROM ${table} WHERE ${dateCol} >= ? AND ${dateCol} <= ?`, startDate, endDate).changes;
    }
    return this.run(`DELETE FROM ${table}`).changes;
  }

  getDataInventory(): Record<string, { count: number; earliest: string | null; latest: string | null }> {
    const tables = [
      { name: "sleep", table: "sleep_records", dateCol: "date" },
      { name: "activity", table: "activity_records", dateCol: "date" },
      { name: "vitals", table: "vitals", dateCol: "timestamp" },
      { name: "body_composition", table: "body_composition", dateCol: "date" },
      { name: "glucose", table: "glucose_readings", dateCol: "timestamp" },
      { name: "health_metrics", table: "health_metrics", dateCol: "timestamp" },
    ];

    const inventory: Record<string, { count: number; earliest: string | null; latest: string | null }> = {};
    for (const { name, table, dateCol } of tables) {
      const row = this.get<{ cnt: number; earliest: string | null; latest: string | null }>(
        `SELECT COUNT(*) as cnt, MIN(${dateCol}) as earliest, MAX(${dateCol}) as latest FROM ${table}`,
      );
      inventory[name] = {
        count: row?.cnt ?? 0,
        earliest: row?.earliest ?? null,
        latest: row?.latest ?? null,
      };
    }
    return inventory;
  }

  purgeOldData(retentionDays: number): number {
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString().split("T")[0];
    let total = 0;
    total += this.run("DELETE FROM sleep_records WHERE date < ?", cutoff).changes;
    total += this.run("DELETE FROM activity_records WHERE date < ?", cutoff).changes;
    total += this.run("DELETE FROM vitals WHERE timestamp < ?", cutoff).changes;
    total += this.run("DELETE FROM body_composition WHERE date < ?", cutoff).changes;
    total += this.run("DELETE FROM glucose_readings WHERE timestamp < ?", cutoff).changes;
    total += this.run("DELETE FROM health_metrics WHERE timestamp < ?", cutoff).changes;
    return total;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
