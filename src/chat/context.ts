/**
 * @module chat/context
 *
 * Health Context Builder — transforms an inline HealthSnapshot into a concise,
 * structured text context suitable for injection into an LLM system prompt.
 *
 * Architecture (stateless):
 *   iOS app sends HealthSnapshot --> PrivacyLayer redacts PII -->
 *     HealthContextBuilder formats as text --> injected into system prompt
 *
 * The output is a structured plain-text summary organized by category (sleep,
 * activity, vitals, body composition, cardio fitness). Each section includes:
 *   - Individual data points (dates + values with proper units)
 *   - Summary statistics (averages, trends)
 *   - Graceful "no data" messages when a category is empty
 *
 * This module is a pure data formatter — it does NOT query a database or apply
 * privacy filtering. PII redaction should be applied to the HealthSnapshot
 * BEFORE passing it to buildContext().
 */

import type { HealthSnapshot, DatedValue, SleepSession, WorkoutSummary } from "../ingest/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Mapping from HKWorkoutActivityType raw integer values to human-readable
 * activity type strings.
 *
 * Source: Apple documentation for HKWorkoutActivityType enumeration.
 * Only the most common types are listed here; unknown types fall back
 * to "workout_<rawValue>" to preserve the original information.
 *
 * @see https://developer.apple.com/documentation/healthkit/hkworkoutactivitytype
 */
const HK_WORKOUT_TYPE_MAP: Record<number, string> = {
  1: "american_football",
  2: "archery",
  3: "dance",
  4: "australian_football",
  5: "badminton",
  6: "baseball",
  7: "basketball",
  8: "bowling",
  9: "boxing",
  10: "climbing",
  11: "cricket",
  12: "cross_training",
  13: "cycling",
  14: "elliptical",
  15: "equestrian_sports",
  16: "fencing",
  17: "fishing",
  18: "functional_strength_training",
  19: "golf",
  20: "functional_training",
  21: "handball",
  22: "hiking",
  23: "hockey",
  24: "gymnastics",
  25: "hunting",
  26: "lacrosse",
  27: "martial_arts",
  28: "mind_and_body",
  29: "paddle_sports",
  30: "play",
  31: "preparation_and_recovery",
  32: "racquetball",
  33: "rowing",
  34: "rugby",
  35: "running",
  36: "sailing",
  37: "running",
  38: "snow_sports",
  39: "soccer",
  40: "softball",
  41: "squash",
  42: "stair_climbing",
  43: "surfing",
  44: "swimming",
  45: "table_tennis",
  46: "swimming",
  47: "tennis",
  48: "track_and_field",
  49: "volleyball",
  50: "yoga",
  51: "water_fitness",
  52: "hiking",
  53: "water_polo",
  54: "water_sports",
  55: "wrestling",
  56: "pilates",
  57: "tai_chi",
  58: "core_training",
  59: "flexibility",
  60: "high_intensity_interval_training",
  61: "jump_rope",
  62: "kickboxing",
  63: "mixed_cardio",
  64: "stairs",
  65: "step_training",
  66: "wheelchair_walk",
  67: "wheelchair_run",
  68: "hand_cycling",
  69: "disc_sports",
  70: "fitness_gaming",
  71: "cardiodance",
  72: "social_dance",
  73: "pickleball",
  74: "cooldown",
  75: "swim_bike_run",
  76: "transition",
  3000: "other",
};

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

/**
 * Converts seconds to hours, rounded to one decimal place.
 *
 * @param seconds - Duration in seconds
 * @returns Duration in hours (1 decimal), e.g. 27000 -> 7.5
 */
function secondsToHours(seconds: number): number {
  return Math.round((seconds / 3600) * 10) / 10;
}

/**
 * Converts seconds to minutes, rounded to one decimal place.
 *
 * @param seconds - Duration in seconds
 * @returns Duration in minutes (1 decimal)
 */
function secondsToMinutes(seconds: number): number {
  return Math.round((seconds / 60) * 10) / 10;
}

/**
 * Extracts the YYYY-MM-DD date portion from an ISO 8601 timestamp string.
 *
 * @param isoString - An ISO 8601 date or datetime string
 * @returns The YYYY-MM-DD date string
 */
function toDateString(isoString: string): string {
  return isoString.substring(0, 10);
}

/**
 * Computes the arithmetic mean of an array of numbers.
 *
 * @param values - Array of numeric values
 * @returns The mean rounded to 1 decimal, or undefined if the array is empty
 */
function mean(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sum = values.reduce((a, b) => a + b, 0);
  return Math.round((sum / values.length) * 10) / 10;
}

/**
 * Maps an HKWorkoutActivityType raw integer to a human-readable string.
 *
 * @param rawType - The HKWorkoutActivityType rawValue integer from iOS
 * @returns A human-readable activity type string
 */
function mapWorkoutType(rawType: number): string {
  return HK_WORKOUT_TYPE_MAP[rawType] ?? `workout_${rawType}`;
}

/**
 * Computes a simple trend direction by comparing the average of the
 * first half of values to the average of the second half.
 *
 * Returns "increasing", "decreasing", or "stable" based on a 5% threshold.
 *
 * @param values - Array of numeric values ordered chronologically
 * @returns Trend description string
 */
function computeTrend(values: number[]): string {
  if (values.length < 2) return "insufficient data";

  const mid = Math.floor(values.length / 2);
  // First half is older, second half is more recent
  const olderHalf = values.slice(0, mid);
  const recentHalf = values.slice(mid);

  const olderAvg = olderHalf.reduce((a, b) => a + b, 0) / olderHalf.length;
  const recentAvg = recentHalf.reduce((a, b) => a + b, 0) / recentHalf.length;

  const pctChange = olderAvg !== 0 ? ((recentAvg - olderAvg) / olderAvg) * 100 : 0;

  if (pctChange > 5) return "increasing";
  if (pctChange < -5) return "decreasing";
  return "stable";
}

// ---------------------------------------------------------------------------
// HealthContextBuilder
// ---------------------------------------------------------------------------

/**
 * Builds a comprehensive health context string from an inline HealthSnapshot.
 *
 * This class is stateless — it does not query a database or manage any state.
 * All data comes directly from the HealthSnapshot passed to buildContext().
 * PII redaction should be applied to the snapshot BEFORE calling this method.
 *
 * Usage:
 * ```ts
 * const builder = new HealthContextBuilder();
 * const context = builder.buildContext(redactedSnapshot);
 * // context is a formatted string ready to inject into a system prompt
 * ```
 */
export class HealthContextBuilder {
  /**
   * Builds a health context string from an inline HealthSnapshot.
   * No database queries — all data comes from the request payload.
   * PII should already be redacted before calling this method.
   *
   * @param snapshot - The HealthSnapshot from the iOS app (already PII-redacted)
   * @returns Formatted health context string for injection into an LLM system prompt
   */
  buildContext(snapshot: HealthSnapshot): string {
    const sections: string[] = [];

    // Header with the fetch timestamp so the LLM knows data freshness
    const fetchedDate = toDateString(snapshot.fetched_at);
    sections.push(
      `=== HEALTH DATA CONTEXT (fetched ${fetchedDate}) ===`
    );

    // Build each category section independently — a failure or empty result
    // in one category should not prevent others from being included.
    sections.push(this.buildSleepSection(snapshot.sleep.sessions));
    sections.push(this.buildActivitySection(snapshot));
    sections.push(this.buildVitalsSection(snapshot));
    sections.push(this.buildBodyCompositionSection(snapshot));
    sections.push(this.buildCardioFitnessSection(snapshot));

    return sections.join("\n\n");
  }

  // -------------------------------------------------------------------------
  // Category-specific section builders
  // -------------------------------------------------------------------------

  /**
   * Builds the sleep data section.
   *
   * Shows per-session breakdown with durations converted from seconds to hours,
   * plus sleep efficiency and summary averages.
   *
   * @param sessions - Array of SleepSession objects from the HealthSnapshot
   * @returns Formatted sleep section string
   */
  private buildSleepSection(sessions: SleepSession[]): string {
    if (sessions.length === 0) {
      return "--- Sleep ---\nNo sleep data available.";
    }

    const lines: string[] = ["--- Sleep ---"];

    for (const session of sessions) {
      const parts: string[] = [];

      // Total time in bed
      const totalHours = secondsToHours(session.in_bed_duration);
      parts.push(`${totalHours}h in bed`);

      // Stage breakdown
      const stages: string[] = [];
      if (session.asleep_deep_duration > 0) {
        stages.push(`Deep: ${secondsToHours(session.asleep_deep_duration)}h`);
      }
      if (session.asleep_rem_duration > 0) {
        stages.push(`REM: ${secondsToHours(session.asleep_rem_duration)}h`);
      }
      if (session.asleep_core_duration > 0) {
        stages.push(`Light: ${secondsToHours(session.asleep_core_duration)}h`);
      }
      if (stages.length > 0) {
        parts.push(`(${stages.join(", ")})`);
      }

      // Awake time
      if (session.awake_duration > 0) {
        parts.push(`Awake: ${secondsToMinutes(session.awake_duration)}min`);
      }

      // Sleep efficiency: percentage of in-bed time actually spent asleep
      const totalAsleep =
        session.asleep_core_duration +
        session.asleep_deep_duration +
        session.asleep_rem_duration;
      if (session.in_bed_duration > 0) {
        const efficiency = Math.round((totalAsleep / session.in_bed_duration) * 100);
        parts.push(`Efficiency: ${efficiency}%`);
      }

      lines.push(`${toDateString(session.date)}: ${parts.join(" | ")}`);
    }

    // Summary statistics
    const summary = this.computeSleepSummary(sessions);
    if (summary) {
      lines.push(`Summary: ${summary}`);
    }

    return lines.join("\n");
  }

  /**
   * Builds the activity data section.
   *
   * Shows daily steps, active calories, exercise minutes, and individual
   * workouts with activity type mapping.
   *
   * @param snapshot - The full HealthSnapshot
   * @returns Formatted activity section string
   */
  private buildActivitySection(snapshot: HealthSnapshot): string {
    const { activity } = snapshot;
    const hasDaily =
      activity.daily_steps.length > 0 ||
      activity.daily_active_energy.length > 0 ||
      activity.daily_exercise_minutes.length > 0;
    const hasWorkouts = activity.workouts.length > 0;

    if (!hasDaily && !hasWorkouts) {
      return "--- Activity ---\nNo activity data available.";
    }

    const lines: string[] = ["--- Activity ---"];

    // Daily summaries — group all daily metrics by date
    if (hasDaily) {
      const dailyByDate = this.buildDailySummaries(activity.daily_steps, activity.daily_active_energy, activity.daily_exercise_minutes);
      for (const [date, parts] of dailyByDate) {
        lines.push(`${date}: ${parts.join(" | ")}`);
      }
    }

    // Individual workouts
    if (hasWorkouts) {
      lines.push("Workouts:");
      for (const workout of activity.workouts) {
        lines.push(`  ${this.formatWorkout(workout)}`);
      }
    }

    // Summary statistics for daily data
    const summary = this.computeActivitySummary(activity.daily_steps, activity.daily_active_energy);
    if (summary) {
      lines.push(`Summary: ${summary}`);
    }

    return lines.join("\n");
  }

  /**
   * Builds the vitals data section.
   *
   * Groups vitals by metric type (HRV, resting HR, SpO2) and shows
   * values with proper units. SpO2 is converted from 0-1 fraction to percentage.
   *
   * @param snapshot - The full HealthSnapshot
   * @returns Formatted vitals section string
   */
  private buildVitalsSection(snapshot: HealthSnapshot): string {
    const { vitals } = snapshot;
    const hasData =
      vitals.hrv_samples.length > 0 ||
      vitals.resting_heart_rate_samples.length > 0 ||
      vitals.spo2_samples.length > 0;

    if (!hasData) {
      return "--- Vitals ---\nNo vitals data available.";
    }

    const lines: string[] = ["--- Vitals ---"];

    // HRV — already in milliseconds
    if (vitals.hrv_samples.length > 0) {
      const values = vitals.hrv_samples.map((s) => `${toDateString(s.date)}: ${Math.round(s.value * 100) / 100}ms`);
      lines.push(`HRV: ${values.join(", ")}`);
      const numericValues = vitals.hrv_samples.map((s) => s.value);
      const avg = mean(numericValues);
      const trend = computeTrend(numericValues);
      lines.push(`  Avg: ${avg}ms | Trend: ${trend}`);
    }

    // Resting Heart Rate — already in bpm
    if (vitals.resting_heart_rate_samples.length > 0) {
      const values = vitals.resting_heart_rate_samples.map((s) => `${toDateString(s.date)}: ${Math.round(s.value)}bpm`);
      lines.push(`Resting HR: ${values.join(", ")}`);
      const numericValues = vitals.resting_heart_rate_samples.map((s) => s.value);
      const avg = mean(numericValues);
      const trend = computeTrend(numericValues);
      lines.push(`  Avg: ${avg}bpm | Trend: ${trend}`);
    }

    // SpO2 — stored as 0-1 fraction, convert to percentage for display
    if (vitals.spo2_samples.length > 0) {
      const values = vitals.spo2_samples.map((s) => `${toDateString(s.date)}: ${(s.value * 100).toFixed(1)}%`);
      lines.push(`SpO2: ${values.join(", ")}`);
      const numericValues = vitals.spo2_samples.map((s) => s.value * 100);
      const avg = mean(numericValues);
      lines.push(`  Avg: ${avg}%`);
    }

    return lines.join("\n");
  }

  /**
   * Builds the body composition section.
   *
   * Shows weight (kg), body fat (converted from 0-1 to %), lean mass (kg),
   * and BMI with trends.
   *
   * @param snapshot - The full HealthSnapshot
   * @returns Formatted body composition section string
   */
  private buildBodyCompositionSection(snapshot: HealthSnapshot): string {
    const { body_composition } = snapshot;
    const hasData =
      body_composition.body_mass_samples.length > 0 ||
      body_composition.body_fat_percentage_samples.length > 0 ||
      body_composition.lean_body_mass_samples.length > 0 ||
      body_composition.bmi_samples.length > 0;

    if (!hasData) {
      return "--- Body Composition ---\nNo body composition data available.";
    }

    const lines: string[] = ["--- Body Composition ---"];

    // Weight — already in kg
    if (body_composition.body_mass_samples.length > 0) {
      const values = body_composition.body_mass_samples.map(
        (s) => `${toDateString(s.date)}: ${s.value.toFixed(1)}kg`
      );
      lines.push(`Weight: ${values.join(", ")}`);
      const numericValues = body_composition.body_mass_samples.map((s) => s.value);
      const avg = mean(numericValues);
      const trend = computeTrend(numericValues);
      lines.push(`  Avg: ${avg}kg | Trend: ${trend}`);
    }

    // Body fat — stored as 0-1 fraction, convert to percentage
    if (body_composition.body_fat_percentage_samples.length > 0) {
      const values = body_composition.body_fat_percentage_samples.map(
        (s) => `${toDateString(s.date)}: ${(s.value * 100).toFixed(1)}%`
      );
      lines.push(`Body Fat: ${values.join(", ")}`);
      const numericValues = body_composition.body_fat_percentage_samples.map((s) => s.value * 100);
      const avg = mean(numericValues);
      const trend = computeTrend(numericValues);
      lines.push(`  Avg: ${avg}% | Trend: ${trend}`);
    }

    // Lean body mass — already in kg
    if (body_composition.lean_body_mass_samples.length > 0) {
      const values = body_composition.lean_body_mass_samples.map(
        (s) => `${toDateString(s.date)}: ${s.value.toFixed(1)}kg`
      );
      lines.push(`Lean Mass: ${values.join(", ")}`);
    }

    // BMI — unitless
    if (body_composition.bmi_samples.length > 0) {
      const values = body_composition.bmi_samples.map(
        (s) => `${toDateString(s.date)}: ${s.value.toFixed(1)}`
      );
      lines.push(`BMI: ${values.join(", ")}`);
    }

    return lines.join("\n");
  }

  /**
   * Builds the cardio fitness section.
   *
   * Shows VO2 Max values in mL/kg/min with trend analysis.
   *
   * @param snapshot - The full HealthSnapshot
   * @returns Formatted cardio fitness section string
   */
  private buildCardioFitnessSection(snapshot: HealthSnapshot): string {
    const samples = snapshot.cardio_fitness.vo2_max_samples;

    if (samples.length === 0) {
      return "--- Cardio Fitness ---\nNo VO2 Max data available.";
    }

    const lines: string[] = ["--- Cardio Fitness ---"];

    const values = samples.map(
      (s) => `${toDateString(s.date)}: ${s.value.toFixed(1)} mL/kg/min`
    );
    lines.push(`VO2 Max: ${values.join(", ")}`);

    const numericValues = samples.map((s) => s.value);
    const avg = mean(numericValues);
    const trend = computeTrend(numericValues);
    lines.push(`  Avg: ${avg} mL/kg/min | Trend: ${trend}`);

    return lines.join("\n");
  }

  // -------------------------------------------------------------------------
  // Helper methods
  // -------------------------------------------------------------------------

  /**
   * Groups daily steps, active energy, and exercise minutes by date into
   * a Map of date -> formatted parts array.
   *
   * @returns Map from YYYY-MM-DD to array of formatted metric strings
   */
  private buildDailySummaries(
    steps: DatedValue[],
    energy: DatedValue[],
    exercise: DatedValue[],
  ): Map<string, string[]> {
    const byDate = new Map<string, string[]>();

    // Steps
    for (const s of steps) {
      const date = toDateString(s.date);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date)!.push(`${Math.round(s.value).toLocaleString()} steps`);
    }

    // Active energy (kcal)
    for (const s of energy) {
      const date = toDateString(s.date);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date)!.push(`${Math.round(s.value)} active cal`);
    }

    // Exercise minutes
    for (const s of exercise) {
      const date = toDateString(s.date);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date)!.push(`${Math.round(s.value)}min exercise`);
    }

    return byDate;
  }

  /**
   * Formats a single workout into a readable string line.
   *
   * @param workout - A WorkoutSummary from the HealthSnapshot
   * @returns Formatted workout string, e.g. "2026-03-28: running — 45.0min, 350 cal, 5.2km"
   */
  private formatWorkout(workout: WorkoutSummary): string {
    const date = toDateString(workout.start_date);
    const type = mapWorkoutType(workout.activity_type);
    const parts: string[] = [
      `${secondsToMinutes(workout.duration)}min`,
    ];
    if (workout.total_energy_burned != null) {
      parts.push(`${Math.round(workout.total_energy_burned)} cal`);
    }
    if (workout.total_distance != null) {
      parts.push(`${(workout.total_distance / 1000).toFixed(1)}km`);
    }
    return `${date}: ${type} — ${parts.join(", ")}`;
  }

  /**
   * Computes summary statistics for sleep sessions.
   *
   * @param sessions - Array of SleepSession objects
   * @returns Formatted summary string, or null if no meaningful data
   */
  private computeSleepSummary(sessions: SleepSession[]): string | null {
    if (sessions.length === 0) return null;

    const parts: string[] = [];

    // Average total time in bed
    const inBedHours = sessions.map((s) => s.in_bed_duration / 3600);
    const avgInBed = mean(inBedHours);
    if (avgInBed != null) {
      parts.push(`Avg ${avgInBed}h/night in bed`);
    }

    // Average actual sleep time (all stages minus awake)
    const asleepHours = sessions.map((s) =>
      (s.asleep_core_duration + s.asleep_deep_duration + s.asleep_rem_duration) / 3600
    );
    const avgAsleep = mean(asleepHours);
    if (avgAsleep != null) {
      parts.push(`Avg ${avgAsleep}h actual sleep`);
    }

    // Average efficiency
    const efficiencies = sessions
      .filter((s) => s.in_bed_duration > 0)
      .map((s) => {
        const totalAsleep =
          s.asleep_core_duration + s.asleep_deep_duration + s.asleep_rem_duration;
        return (totalAsleep / s.in_bed_duration) * 100;
      });
    const avgEfficiency = mean(efficiencies);
    if (avgEfficiency != null) {
      parts.push(`Avg efficiency ${avgEfficiency}%`);
    }

    return parts.length > 0 ? parts.join(", ") : null;
  }

  /**
   * Computes summary statistics for daily activity data.
   *
   * @param steps - Daily step count samples
   * @param energy - Daily active energy samples
   * @returns Formatted summary string, or null if no meaningful data
   */
  private computeActivitySummary(steps: DatedValue[], energy: DatedValue[]): string | null {
    const parts: string[] = [];

    if (steps.length > 0) {
      const avgSteps = mean(steps.map((s) => s.value));
      if (avgSteps != null) {
        parts.push(`Avg ${Math.round(avgSteps).toLocaleString()} steps/day`);
      }
    }

    if (energy.length > 0) {
      const avgCal = mean(energy.map((s) => s.value));
      if (avgCal != null) {
        parts.push(`Avg ${Math.round(avgCal)} active cal/day`);
      }
    }

    return parts.length > 0 ? parts.join(", ") : null;
  }
}
