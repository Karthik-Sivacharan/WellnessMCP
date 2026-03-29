/**
 * @module ingest/normalizer
 *
 * Transforms the raw HealthSnapshot JSON (from AthletiqX / Apple HealthKit)
 * into WellnessMCP's normalized data types that the StorageManager expects.
 *
 * Key conversions performed here:
 *   - Sleep durations: seconds -> minutes
 *   - Body fat / SpO2: 0-1 fraction -> percentage (multiply by 100)
 *   - HKWorkoutActivityType integer -> human-readable activity string
 *   - DatedValue arrays grouped by date (YYYY-MM-DD) for daily aggregation
 *
 * All functions are pure — they take HealthSnapshot sub-objects and return
 * arrays of normalized records, with no side effects.
 */

import type {
  SleepSession,
  ActivityData,
  VitalsData,
  BodyCompositionData,
  CardioFitnessData,
  DatedValue,
} from "./types.js";
import type {
  NormalizedSleep,
  NormalizedActivity,
  NormalizedVital,
  NormalizedBodyComposition,
} from "../providers/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The provider name string used for all Apple Health records */
const PROVIDER = "apple_health" as const;

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
  37: "running",    // Sometimes 37 is used for running in older iOS versions
  38: "snow_sports",
  39: "soccer",
  40: "softball",
  41: "squash",
  42: "stair_climbing",
  43: "surfing",
  44: "swimming",
  45: "table_tennis",
  46: "swimming",   // Open water swimming
  47: "tennis",
  48: "track_and_field",
  49: "volleyball",
  50: "yoga",
  51: "water_fitness",
  52: "hiking",     // Sometimes 52 is used for hiking
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
 * Extracts the YYYY-MM-DD date portion from an ISO 8601 timestamp string.
 *
 * Handles both full datetime strings ("2026-03-28T08:00:00Z") and
 * date-only strings ("2026-03-28"). Falls back to the first 10 characters
 * which is the standard ISO date prefix.
 *
 * @param isoString - An ISO 8601 date or datetime string
 * @returns The YYYY-MM-DD date string
 */
function toDateString(isoString: string): string {
  // ISO 8601 dates always start with YYYY-MM-DD (10 chars)
  return isoString.substring(0, 10);
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
 * Groups an array of DatedValue samples by their calendar date (YYYY-MM-DD).
 *
 * This is necessary because HealthKit may return multiple samples per day
 * (e.g., multiple weight readings). The grouping allows us to aggregate
 * or pick the most relevant value per day.
 *
 * @param samples - Array of DatedValue objects to group
 * @returns Map from YYYY-MM-DD date string to array of values for that date
 */
function groupByDate(samples: DatedValue[]): Map<string, DatedValue[]> {
  const groups = new Map<string, DatedValue[]>();
  for (const sample of samples) {
    const date = toDateString(sample.date);
    const existing = groups.get(date);
    if (existing) {
      existing.push(sample);
    } else {
      groups.set(date, [sample]);
    }
  }
  return groups;
}

/**
 * Computes the arithmetic mean of an array of numbers.
 *
 * @param values - Array of numeric values
 * @returns The mean, or undefined if the array is empty
 */
function mean(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sum = values.reduce((a, b) => a + b, 0);
  // Round to 2 decimal places to avoid floating-point noise
  return Math.round((sum / values.length) * 100) / 100;
}

/**
 * Maps an HKWorkoutActivityType raw integer to a human-readable string.
 *
 * If the type is not in our known mapping, we generate a fallback string
 * like "workout_42" to preserve the original data.
 *
 * @param rawType - The HKWorkoutActivityType rawValue integer from iOS
 * @returns A human-readable activity type string
 */
function mapWorkoutType(rawType: number): string {
  return HK_WORKOUT_TYPE_MAP[rawType] ?? `workout_${rawType}`;
}

// ---------------------------------------------------------------------------
// Normalization functions
// ---------------------------------------------------------------------------

/**
 * Normalizes Apple HealthKit sleep sessions into WellnessMCP's NormalizedSleep format.
 *
 * Conversion details:
 *   - All durations converted from seconds (HealthKit) to minutes (WellnessMCP)
 *   - "Core" sleep in HealthKit maps to "light" sleep in WellnessMCP
 *   - Sleep efficiency = (total_asleep / in_bed) * 100, as a percentage
 *   - Total duration = in_bed_duration (the full time in bed)
 *
 * @param sessions - Array of SleepSession objects from the HealthSnapshot
 * @returns Array of NormalizedSleep records ready for StorageManager.upsertSleep()
 */
export function normalizeSleep(sessions: SleepSession[]): NormalizedSleep[] {
  return sessions.map((session) => {
    // Calculate total actual sleep time (all stages except awake)
    const totalAsleepSeconds =
      session.asleep_core_duration +
      session.asleep_deep_duration +
      session.asleep_rem_duration;

    // Sleep efficiency: percentage of in-bed time actually spent asleep.
    // Guard against division by zero if in_bed_duration is 0.
    const efficiency =
      session.in_bed_duration > 0
        ? Math.round((totalAsleepSeconds / session.in_bed_duration) * 100)
        : undefined;

    return {
      provider: PROVIDER,
      date: toDateString(session.date),

      // Total time in bed, converted from seconds to minutes
      total_duration_min: secondsToMinutes(session.in_bed_duration),

      // HealthKit's "asleepDeep" maps directly to our "deep" stage
      deep_min: secondsToMinutes(session.asleep_deep_duration),

      // HealthKit's "asleepREM" maps directly to our "rem" stage
      rem_min: secondsToMinutes(session.asleep_rem_duration),

      // HealthKit's "asleepCore" is the equivalent of "light" sleep.
      // Apple uses "Core" to avoid implying lower quality, but it corresponds
      // to NREM stages 1-2 (light sleep) in sleep science terminology.
      light_min: secondsToMinutes(session.asleep_core_duration),

      // Time spent awake during the sleep session
      awake_min: secondsToMinutes(session.awake_duration),

      // Sleep efficiency as a 0-100 percentage
      efficiency,
    };
  });
}

/**
 * Normalizes Apple HealthKit activity data into WellnessMCP's NormalizedActivity format.
 *
 * This function produces two types of activity records:
 *
 * 1. **Daily summaries** — One record per date, aggregating steps, active energy,
 *    and exercise minutes from the DatedValue arrays. Multiple samples on the
 *    same date are summed (steps, calories) or averaged (exercise minutes).
 *
 * 2. **Workout records** — One record per individual HKWorkout, with the
 *    HKWorkoutActivityType mapped to a readable string and duration converted
 *    from seconds to minutes.
 *
 * VO2 Max samples from cardio_fitness are merged into daily summaries by date
 * when available.
 *
 * @param activity - ActivityData from the HealthSnapshot
 * @param cardioFitness - Optional CardioFitnessData for VO2 Max values
 * @returns Array of NormalizedActivity records ready for StorageManager.upsertActivity()
 */
export function normalizeActivity(
  activity: ActivityData,
  cardioFitness?: CardioFitnessData,
): NormalizedActivity[] {
  const results: NormalizedActivity[] = [];

  // -----------------------------------------------------------------------
  // Part 1: Build daily summary records by grouping samples by date
  // -----------------------------------------------------------------------

  // Collect all unique dates from steps, energy, and exercise data
  const allDates = new Set<string>();

  const stepsByDate = groupByDate(activity.daily_steps);
  const energyByDate = groupByDate(activity.daily_active_energy);
  const exerciseByDate = groupByDate(activity.daily_exercise_minutes);

  // Group VO2 Max samples by date if provided
  const vo2ByDate = cardioFitness
    ? groupByDate(cardioFitness.vo2_max_samples)
    : new Map<string, DatedValue[]>();

  // Gather all dates across all data types
  for (const date of stepsByDate.keys()) allDates.add(date);
  for (const date of energyByDate.keys()) allDates.add(date);
  for (const date of exerciseByDate.keys()) allDates.add(date);
  for (const date of vo2ByDate.keys()) allDates.add(date);

  for (const date of allDates) {
    const stepSamples = stepsByDate.get(date);
    const energySamples = energyByDate.get(date);
    const exerciseSamples = exerciseByDate.get(date);
    const vo2Samples = vo2ByDate.get(date);

    // Steps: sum all samples for the day (HealthKit may split into segments)
    const steps = stepSamples
      ? stepSamples.reduce((sum, s) => sum + s.value, 0)
      : undefined;

    // Active energy: sum all samples for the day (kcal)
    const caloriesActive = energySamples
      ? Math.round(energySamples.reduce((sum, s) => sum + s.value, 0))
      : undefined;

    // Exercise minutes: sum all samples for the day
    const activeMinutes = exerciseSamples
      ? Math.round(exerciseSamples.reduce((sum, s) => sum + s.value, 0))
      : undefined;

    // VO2 Max: take the average if multiple readings exist on the same day
    const vo2Max = vo2Samples
      ? mean(vo2Samples.map((s) => s.value))
      : undefined;

    results.push({
      provider: PROVIDER,
      date,
      activity_type: "daily_summary",
      steps: steps ? Math.round(steps) : undefined,
      calories_active: caloriesActive,
      active_minutes: activeMinutes,
      vo2_max: vo2Max,
    });
  }

  // -----------------------------------------------------------------------
  // Part 2: Convert individual workouts into separate activity records
  // -----------------------------------------------------------------------

  for (const workout of activity.workouts) {
    const record: NormalizedActivity = {
      provider: PROVIDER,
      date: toDateString(workout.start_date),
      activity_type: mapWorkoutType(workout.activity_type),

      // Convert duration from seconds to minutes for consistency
      active_minutes: secondsToMinutes(workout.duration),

      // Energy burned is already in kcal from HealthKit
      calories_active: workout.total_energy_burned
        ? Math.round(workout.total_energy_burned)
        : undefined,

      // Distance is already in meters from HealthKit, which matches our schema
      distance_m: workout.total_distance
        ? Math.round(workout.total_distance)
        : undefined,
    };

    results.push(record);
  }

  return results;
}

/**
 * Normalizes Apple HealthKit vitals data into WellnessMCP's NormalizedVital format.
 *
 * Each DatedValue sample becomes its own NormalizedVital record. The three
 * vital types are:
 *
 * | HealthKit metric     | WellnessMCP metric | Unit | Conversion         |
 * |---------------------|--------------------|------|-------------------|
 * | hrv_samples         | hrv                | ms   | None (already ms) |
 * | resting_heart_rate  | resting_heart_rate | bpm  | None (already bpm)|
 * | spo2_samples        | spo2               | %    | value * 100       |
 *
 * @param vitals - VitalsData from the HealthSnapshot
 * @returns Array of NormalizedVital records ready for StorageManager.upsertVital()
 */
export function normalizeVitals(vitals: VitalsData): NormalizedVital[] {
  const results: NormalizedVital[] = [];

  // HRV: Heart Rate Variability (SDNN) — already in milliseconds
  for (const sample of vitals.hrv_samples) {
    results.push({
      provider: PROVIDER,
      metric: "hrv",
      value: Math.round(sample.value * 100) / 100,
      unit: "ms",
      timestamp: sample.date,
    });
  }

  // Resting Heart Rate — already in beats per minute
  for (const sample of vitals.resting_heart_rate_samples) {
    results.push({
      provider: PROVIDER,
      metric: "resting_heart_rate",
      value: Math.round(sample.value),
      unit: "bpm",
      timestamp: sample.date,
    });
  }

  // SpO2 (Blood Oxygen Saturation) — HealthKit stores as 0-1 fraction,
  // we convert to percentage (0-100) for human readability and consistency
  // with medical conventions.
  for (const sample of vitals.spo2_samples) {
    results.push({
      provider: PROVIDER,
      metric: "spo2",
      value: Math.round(sample.value * 100 * 10) / 10, // e.g. 0.98 -> 98.0
      unit: "%",
      timestamp: sample.date,
    });
  }

  return results;
}

/**
 * Normalizes Apple HealthKit body composition data into WellnessMCP's
 * NormalizedBodyComposition format.
 *
 * Multiple samples on the same date are averaged. The grouping-by-date
 * strategy handles the common case where a user weighs themselves multiple
 * times in a day — we store one record per date with the average value.
 *
 * Conversion details:
 *   - body_mass: already in kg, no conversion needed
 *   - body_fat_percentage: 0-1 fraction -> percentage (multiply by 100)
 *   - lean_body_mass: already in kg, no conversion needed
 *   - bmi: unitless, no conversion needed
 *
 * Note: HealthKit does not provide muscle_mass, bone_mass, or water_pct,
 * so those fields are left undefined in the normalized output.
 *
 * @param body - BodyCompositionData from the HealthSnapshot
 * @returns Array of NormalizedBodyComposition records ready for StorageManager.upsertBodyComposition()
 */
export function normalizeBodyComposition(
  body: BodyCompositionData,
): NormalizedBodyComposition[] {
  // Group all sample types by date so we can merge into one record per day
  const weightByDate = groupByDate(body.body_mass_samples);
  const fatByDate = groupByDate(body.body_fat_percentage_samples);
  const leanByDate = groupByDate(body.lean_body_mass_samples);
  const bmiByDate = groupByDate(body.bmi_samples);

  // Collect all unique dates across all body composition sample types
  const allDates = new Set<string>();
  for (const date of weightByDate.keys()) allDates.add(date);
  for (const date of fatByDate.keys()) allDates.add(date);
  for (const date of leanByDate.keys()) allDates.add(date);
  for (const date of bmiByDate.keys()) allDates.add(date);

  const results: NormalizedBodyComposition[] = [];

  for (const date of allDates) {
    const weightSamples = weightByDate.get(date);
    const fatSamples = fatByDate.get(date);
    const leanSamples = leanByDate.get(date);
    const bmiSamples = bmiByDate.get(date);

    results.push({
      provider: PROVIDER,
      date,

      // Weight: average of all samples for the day, in kg (already correct units)
      weight_kg: weightSamples
        ? mean(weightSamples.map((s) => s.value))
        : undefined,

      // Body fat: average of samples, converted from 0-1 fraction to percentage.
      // HealthKit stores body fat as a ratio (e.g., 0.18 for 18%), but our
      // schema expects a percentage (18.0).
      body_fat_pct: fatSamples
        ? mean(fatSamples.map((s) => s.value * 100))
        : undefined,

      // Lean body mass: average of samples, in kg (already correct units).
      // Note: we store this as muscle_mass_kg in our schema since HealthKit's
      // leanBodyMass is the closest available metric.
      muscle_mass_kg: leanSamples
        ? mean(leanSamples.map((s) => s.value))
        : undefined,

      // BMI: unitless, average of samples for the day
      bmi: bmiSamples
        ? mean(bmiSamples.map((s) => s.value))
        : undefined,
    });
  }

  return results;
}
