/**
 * @module chat/context
 *
 * Health Context Builder — transforms raw SQLite health data into a concise,
 * privacy-filtered text context suitable for injection into an LLM system prompt.
 *
 * Architecture:
 *   StorageManager (SQLite) --> HealthContextBuilder --> PrivacyLayer --> formatted text
 *
 * The output is a structured plain-text summary organized by category (sleep,
 * activity, vitals, body composition, glucose). Each section includes:
 *   - Individual data points (dates + values)
 *   - Summary statistics (averages, trends, totals)
 *   - Graceful "no data" messages when a category is empty
 *
 * The context is designed to be informative but compact — we include summary
 * stats and recent records rather than dumping raw database rows, keeping the
 * token count reasonable for the LLM context window.
 */

import { StorageManager } from "../storage/db.js";
import { PrivacyLayer } from "../privacy/index.js";
import type { DataCategory } from "../privacy/consent.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of days of health history to include in the context */
const DEFAULT_CONTEXT_DAYS = 14;

// ---------------------------------------------------------------------------
// HealthContextBuilder
// ---------------------------------------------------------------------------

/**
 * Builds a comprehensive health context string from recent SQLite data.
 *
 * Usage:
 * ```ts
 * const builder = new HealthContextBuilder(storage, privacy);
 * const context = await builder.buildContext(14); // last 14 days
 * // context is a formatted string ready to inject into a system prompt
 * ```
 *
 * The builder queries all health categories, applies the privacy layer
 * (consent gate + PII redaction + aggregation), and formats the surviving
 * data into human-readable sections.
 */
export class HealthContextBuilder {
  private storage: StorageManager;
  private privacy: PrivacyLayer;

  constructor(storage: StorageManager, privacy: PrivacyLayer) {
    this.storage = storage;
    this.privacy = privacy;
  }

  /**
   * Builds a comprehensive health context string from recent data.
   *
   * Queries sleep, activity, vitals, body composition, and glucose for the
   * given time range. Applies privacy filtering before including in context.
   * Returns a formatted string ready to inject into a system prompt.
   *
   * Context format:
   * ```
   * === HEALTH DATA CONTEXT (Last 14 days: 2026-03-15 to 2026-03-29) ===
   *
   * --- Sleep ---
   * 2026-03-28: 7.5h total (Deep: 1.2h, REM: 2.0h, Light: 3.8h) | Efficiency: 92% | HRV: 45ms
   * ...
   * Summary: Avg 7.2h/night, Avg efficiency 89%, Avg HRV 42ms
   *
   * --- Activity ---
   * ...
   * ```
   *
   * @param days - Number of days of history to include (default: 14)
   * @returns Formatted health context string
   */
  async buildContext(days?: number): Promise<string> {
    const contextDays = days ?? DEFAULT_CONTEXT_DAYS;

    // Calculate date range for queries
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - contextDays);

    const startStr = startDate.toISOString().split("T")[0];
    const endStr = endDate.toISOString().split("T")[0];

    const sections: string[] = [];

    // Header with date range so the LLM knows the time window
    sections.push(
      `=== HEALTH DATA CONTEXT (Last ${contextDays} days: ${startStr} to ${endStr}) ===`
    );

    // Build each category section independently — a failure or empty result
    // in one category should not prevent others from being included.
    sections.push(this.buildSleepSection(startStr, endStr));
    sections.push(this.buildActivitySection(startStr, endStr));
    sections.push(this.buildVitalsSection(startStr, endStr));
    sections.push(this.buildBodyCompositionSection(startStr, endStr));
    sections.push(this.buildGlucoseSection(startStr, endStr));

    return sections.join("\n\n");
  }

  // -------------------------------------------------------------------------
  // Category-specific section builders
  // -------------------------------------------------------------------------

  /**
   * Builds the sleep data section.
   * Shows nightly records with duration breakdown and summary stats.
   */
  private buildSleepSection(startDate: string, endDate: string): string {
    const raw = this.storage.getSleepRecords(startDate, endDate);

    // Apply privacy filtering — respects consent and redaction settings
    const { data, denied } = this.privacy.filter(
      raw,
      "chat_context",
      ["sleep"] as DataCategory[]
    );

    if (denied.includes("sleep" as DataCategory)) {
      return "--- Sleep ---\nData sharing disabled by user.";
    }

    const records = data as Record<string, unknown>[];
    if (!records || records.length === 0) {
      return "--- Sleep ---\nNo sleep data available for this period.";
    }

    const lines: string[] = ["--- Sleep ---"];

    // Individual records — show up to 14 most recent nights
    const displayRecords = records.slice(0, 14);
    for (const r of displayRecords) {
      const parts: string[] = [];

      // Total duration
      const totalMin = r.total_duration_min as number | null;
      if (totalMin != null) {
        parts.push(`${(totalMin / 60).toFixed(1)}h total`);
      }

      // Stage breakdown (if available)
      const stages: string[] = [];
      if (r.deep_min != null) stages.push(`Deep: ${((r.deep_min as number) / 60).toFixed(1)}h`);
      if (r.rem_min != null) stages.push(`REM: ${((r.rem_min as number) / 60).toFixed(1)}h`);
      if (r.light_min != null) stages.push(`Light: ${((r.light_min as number) / 60).toFixed(1)}h`);
      if (stages.length > 0) parts.push(`(${stages.join(", ")})`);

      // Efficiency and HRV
      if (r.efficiency != null) parts.push(`Efficiency: ${r.efficiency}%`);
      if (r.hrv_avg != null) parts.push(`HRV: ${r.hrv_avg}ms`);
      if (r.hr_avg != null) parts.push(`HR: ${r.hr_avg}bpm`);
      if (r.score != null) parts.push(`Score: ${r.score}`);

      lines.push(`${r.date}: ${parts.join(" | ")}`);
    }

    // Summary statistics
    const summary = this.computeSleepSummary(records);
    if (summary) {
      lines.push(`Summary: ${summary}`);
    }

    return lines.join("\n");
  }

  /**
   * Builds the activity data section.
   * Shows daily activity with steps, calories, distance and summary stats.
   */
  private buildActivitySection(startDate: string, endDate: string): string {
    const raw = this.storage.getActivityRecords(startDate, endDate);

    const { data, denied } = this.privacy.filter(
      raw,
      "chat_context",
      ["activity"] as DataCategory[]
    );

    if (denied.includes("activity" as DataCategory)) {
      return "--- Activity ---\nData sharing disabled by user.";
    }

    const records = data as Record<string, unknown>[];
    if (!records || records.length === 0) {
      return "--- Activity ---\nNo activity data available for this period.";
    }

    const lines: string[] = ["--- Activity ---"];

    const displayRecords = records.slice(0, 14);
    for (const r of displayRecords) {
      const parts: string[] = [];

      // Activity type (if not a daily summary)
      const actType = r.activity_type as string | null;
      if (actType && actType !== "daily_summary") {
        parts.push(`[${actType}]`);
      }

      if (r.steps != null) parts.push(`${(r.steps as number).toLocaleString()} steps`);
      if (r.calories_active != null) parts.push(`${r.calories_active} active cal`);
      else if (r.calories_total != null) parts.push(`${r.calories_total} total cal`);
      if (r.distance_m != null) {
        const km = ((r.distance_m as number) / 1000).toFixed(1);
        parts.push(`${km}km`);
      }
      if (r.active_minutes != null) parts.push(`${r.active_minutes}min active`);
      if (r.vo2_max != null) parts.push(`VO2max: ${r.vo2_max}`);

      lines.push(`${r.date}: ${parts.join(" | ")}`);
    }

    // Summary statistics
    const summary = this.computeActivitySummary(records);
    if (summary) {
      lines.push(`Summary: ${summary}`);
    }

    return lines.join("\n");
  }

  /**
   * Builds the vitals data section.
   * Groups vitals by metric type (HRV, resting HR, SpO2, etc.) and shows trends.
   */
  private buildVitalsSection(startDate: string, endDate: string): string {
    const raw = this.storage.getAllVitals(startDate, endDate);

    const { data, denied } = this.privacy.filter(
      raw,
      "chat_context",
      ["vitals"] as DataCategory[]
    );

    if (denied.includes("vitals" as DataCategory)) {
      return "--- Vitals ---\nData sharing disabled by user.";
    }

    const records = data as Record<string, unknown>[];
    if (!records || records.length === 0) {
      return "--- Vitals ---\nNo vitals data available for this period.";
    }

    // Group vitals by metric type for organized display
    const grouped: Record<string, { value: number; unit: string; timestamp: string }[]> = {};
    for (const r of records) {
      const metric = r.metric as string;
      if (!grouped[metric]) grouped[metric] = [];
      grouped[metric].push({
        value: r.value as number,
        unit: r.unit as string,
        timestamp: (r.timestamp as string).split("T")[0], // date only for display
      });
    }

    const lines: string[] = ["--- Vitals ---"];

    for (const [metric, entries] of Object.entries(grouped)) {
      // Show the last few readings for each metric
      const recent = entries.slice(0, 7);
      const values = recent.map((e) => `${e.timestamp}: ${e.value}${e.unit}`);
      lines.push(`${metric}: ${values.join(", ")}`);

      // Compute average and trend for this metric
      const allValues = entries.map((e) => e.value);
      const avg = allValues.reduce((a, b) => a + b, 0) / allValues.length;
      const unit = entries[0].unit;

      // Simple trend: compare first half average to second half average
      const trend = this.computeTrend(allValues);
      lines.push(`  Avg: ${avg.toFixed(1)}${unit} | Trend: ${trend}`);
    }

    return lines.join("\n");
  }

  /**
   * Builds the body composition section.
   * Shows weight, body fat %, muscle mass, and BMI with trends.
   */
  private buildBodyCompositionSection(startDate: string, endDate: string): string {
    const raw = this.storage.getBodyComposition(startDate, endDate);

    const { data, denied } = this.privacy.filter(
      raw,
      "chat_context",
      ["body_composition"] as DataCategory[]
    );

    if (denied.includes("body_composition" as DataCategory)) {
      return "--- Body Composition ---\nData sharing disabled by user.";
    }

    const records = data as Record<string, unknown>[];
    if (!records || records.length === 0) {
      return "--- Body Composition ---\nNo body composition data available for this period.";
    }

    const lines: string[] = ["--- Body Composition ---"];

    const displayRecords = records.slice(0, 10);
    for (const r of displayRecords) {
      const parts: string[] = [];
      if (r.weight_kg != null) parts.push(`Weight: ${r.weight_kg}kg`);
      if (r.body_fat_pct != null) parts.push(`Body fat: ${r.body_fat_pct}%`);
      if (r.muscle_mass_kg != null) parts.push(`Muscle: ${r.muscle_mass_kg}kg`);
      if (r.bmi != null) parts.push(`BMI: ${r.bmi}`);
      if (r.water_pct != null) parts.push(`Water: ${r.water_pct}%`);

      lines.push(`${r.date}: ${parts.join(" | ")}`);
    }

    // Weight trend if enough data points
    const weights = records
      .map((r) => r.weight_kg as number | null)
      .filter((v): v is number => v != null);
    if (weights.length >= 2) {
      const trend = this.computeTrend(weights);
      const avg = weights.reduce((a, b) => a + b, 0) / weights.length;
      lines.push(`Summary: Avg weight ${avg.toFixed(1)}kg | Trend: ${trend}`);
    }

    return lines.join("\n");
  }

  /**
   * Builds the glucose readings section.
   * Shows recent readings with trend arrows and average.
   */
  private buildGlucoseSection(startDate: string, endDate: string): string {
    const raw = this.storage.getGlucoseReadings(startDate, endDate);

    const { data, denied } = this.privacy.filter(
      raw,
      "chat_context",
      ["glucose"] as DataCategory[]
    );

    if (denied.includes("glucose" as DataCategory)) {
      return "--- Glucose ---\nData sharing disabled by user.";
    }

    const records = data as Record<string, unknown>[];
    if (!records || records.length === 0) {
      return "--- Glucose ---\nNo glucose data available for this period.";
    }

    const lines: string[] = ["--- Glucose ---"];

    // Show recent readings (up to 20 for glucose since they're more frequent)
    const displayRecords = records.slice(0, 20);
    for (const r of displayRecords) {
      const timestamp = (r.timestamp as string).replace("T", " ").substring(0, 16);
      const unit = r.unit as string ?? "mg/dL";
      const trend = r.trend as string | null;
      const trendStr = trend ? ` (${trend})` : "";
      lines.push(`${timestamp}: ${r.value}${unit}${trendStr}`);
    }

    // Summary stats
    const values = records.map((r) => r.value as number);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);
    lines.push(`Summary: Avg ${avg.toFixed(0)}mg/dL | Range: ${min}-${max}mg/dL | ${values.length} readings`);

    return lines.join("\n");
  }

  // -------------------------------------------------------------------------
  // Summary computation helpers
  // -------------------------------------------------------------------------

  /**
   * Computes summary statistics for sleep data.
   * Returns a formatted string like "Avg 7.2h/night, Avg efficiency 89%, Avg HRV 42ms"
   */
  private computeSleepSummary(records: Record<string, unknown>[]): string | null {
    if (records.length === 0) return null;

    const parts: string[] = [];

    // Average total duration
    const durations = records
      .map((r) => r.total_duration_min as number | null)
      .filter((v): v is number => v != null);
    if (durations.length > 0) {
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      parts.push(`Avg ${(avg / 60).toFixed(1)}h/night`);
    }

    // Average efficiency
    const efficiencies = records
      .map((r) => r.efficiency as number | null)
      .filter((v): v is number => v != null);
    if (efficiencies.length > 0) {
      const avg = efficiencies.reduce((a, b) => a + b, 0) / efficiencies.length;
      parts.push(`Avg efficiency ${avg.toFixed(0)}%`);
    }

    // Average HRV
    const hrvs = records
      .map((r) => r.hrv_avg as number | null)
      .filter((v): v is number => v != null);
    if (hrvs.length > 0) {
      const avg = hrvs.reduce((a, b) => a + b, 0) / hrvs.length;
      const trend = this.computeTrend(hrvs);
      parts.push(`Avg HRV ${avg.toFixed(0)}ms (${trend})`);
    }

    return parts.length > 0 ? parts.join(", ") : null;
  }

  /**
   * Computes summary statistics for activity data.
   * Returns a formatted string like "Avg 8,500 steps/day, Avg 450 active cal"
   */
  private computeActivitySummary(records: Record<string, unknown>[]): string | null {
    if (records.length === 0) return null;

    const parts: string[] = [];

    // Average steps (only for daily summaries)
    const dailyRecords = records.filter(
      (r) => !r.activity_type || r.activity_type === "daily_summary"
    );
    const steps = dailyRecords
      .map((r) => r.steps as number | null)
      .filter((v): v is number => v != null);
    if (steps.length > 0) {
      const avg = steps.reduce((a, b) => a + b, 0) / steps.length;
      parts.push(`Avg ${Math.round(avg).toLocaleString()} steps/day`);
    }

    // Average active calories
    const activeCals = dailyRecords
      .map((r) => r.calories_active as number | null)
      .filter((v): v is number => v != null);
    if (activeCals.length > 0) {
      const avg = activeCals.reduce((a, b) => a + b, 0) / activeCals.length;
      parts.push(`Avg ${Math.round(avg)} active cal`);
    }

    // Total distance
    const distances = records
      .map((r) => r.distance_m as number | null)
      .filter((v): v is number => v != null);
    if (distances.length > 0) {
      const total = distances.reduce((a, b) => a + b, 0);
      parts.push(`Total ${(total / 1000).toFixed(1)}km`);
    }

    return parts.length > 0 ? parts.join(", ") : null;
  }

  /**
   * Computes a simple trend direction by comparing the average of the
   * first half of values to the average of the second half.
   *
   * Returns "improving", "declining", or "stable" based on a 5% threshold.
   * For metrics where higher is better (like HRV), "improving" means increasing.
   *
   * @param values - Array of numeric values ordered from most recent to oldest
   * @returns Trend description string
   */
  private computeTrend(values: number[]): string {
    if (values.length < 2) return "insufficient data";

    const mid = Math.floor(values.length / 2);
    // Values are ordered most recent first, so recentHalf is the first half
    const recentHalf = values.slice(0, mid);
    const olderHalf = values.slice(mid);

    const recentAvg = recentHalf.reduce((a, b) => a + b, 0) / recentHalf.length;
    const olderAvg = olderHalf.reduce((a, b) => a + b, 0) / olderHalf.length;

    // Use a 5% threshold to determine if the change is meaningful
    const pctChange = olderAvg !== 0 ? ((recentAvg - olderAvg) / olderAvg) * 100 : 0;

    if (pctChange > 5) return "increasing";
    if (pctChange < -5) return "decreasing";
    return "stable";
  }
}
