/**
 * @module ingest/types
 *
 * TypeScript interfaces and Zod schemas for the HealthSnapshot JSON payload
 * that the AthletiqX iOS app POSTs to the WellnessMCP ingest server.
 *
 * The iOS app encodes with `JSONEncoder.KeyEncodingStrategy.convertToSnakeCase`,
 * so every JSON key arrives in snake_case. These interfaces mirror that format
 * exactly so Zod can validate the incoming payload without any key transformation.
 *
 * Data flow:
 *   AthletiqX (iOS) -> POST /ingest/health -> Zod validates -> normalize -> SQLite
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schemas — used for runtime validation of incoming JSON payloads
// ---------------------------------------------------------------------------

/**
 * A single timestamped numeric measurement from HealthKit.
 *
 * The iOS app serializes every HKQuantitySample / HKStatisticsCollection
 * point as `{ date, value }`. The `date` is an ISO 8601 string from
 * `ISO8601DateFormatter` and `value` is the sample's doubleValue.
 */
export const DatedValueSchema = z.object({
  /** ISO 8601 timestamp of the measurement (e.g. "2026-03-28T08:00:00Z") */
  date: z.string(),
  /** Numeric value of the measurement (units depend on the parent context) */
  value: z.number(),
});

/**
 * Vitals data from HealthKit — heart rate variability, resting heart rate,
 * and blood oxygen saturation.
 */
export const VitalsDataSchema = z.object({
  /**
   * HRV samples in milliseconds (HKQuantityTypeIdentifier.heartRateVariabilitySDNN).
   * Each sample is the SDNN value for a single measurement period.
   */
  hrv_samples: z.array(DatedValueSchema).default([]),

  /**
   * Resting heart rate samples in beats per minute
   * (HKQuantityTypeIdentifier.restingHeartRate).
   */
  resting_heart_rate_samples: z.array(DatedValueSchema).default([]),

  /**
   * Blood oxygen saturation samples as a 0-1 fraction
   * (HKQuantityTypeIdentifier.oxygenSaturation).
   * Example: 0.98 means 98% SpO2. We multiply by 100 during normalization.
   */
  spo2_samples: z.array(DatedValueSchema).default([]),
});

/**
 * A single sleep session from HealthKit (HKCategorySample of type sleepAnalysis).
 *
 * The iOS app aggregates the raw sleep category samples (inBed, asleepCore,
 * asleepDeep, asleepREM, awake) into durations per session. All durations
 * are in seconds; we convert to minutes during normalization.
 */
export const SleepSessionSchema = z.object({
  /** The calendar date of the sleep session in ISO 8601 (e.g. "2026-03-28") */
  date: z.string(),

  /** Total time in bed in seconds (includes all stages + awake time) */
  in_bed_duration: z.number(),

  /** Core (light) sleep duration in seconds (HKCategoryValueSleepAnalysis.asleepCore) */
  asleep_core_duration: z.number(),

  /** Deep sleep duration in seconds (HKCategoryValueSleepAnalysis.asleepDeep) */
  asleep_deep_duration: z.number(),

  /** REM sleep duration in seconds (HKCategoryValueSleepAnalysis.asleepREM) */
  asleep_rem_duration: z.number(),

  /** Time spent awake during the sleep session, in seconds */
  awake_duration: z.number(),
});

/**
 * Sleep data container — holds an array of sleep sessions.
 */
export const SleepDataSchema = z.object({
  sessions: z.array(SleepSessionSchema).default([]),
});

/**
 * A single workout summary from HealthKit (HKWorkout).
 */
export const WorkoutSummarySchema = z.object({
  /**
   * The HKWorkoutActivityType raw integer value.
   * Common values: 37=running, 13=cycling, 52=hiking, 20=functional_training,
   * 46=swimming, 3=dance, 24=gymnastics, 50=yoga, 63=mixed_cardio, etc.
   * See normalizer.ts for the full mapping.
   */
  activity_type: z.number(),

  /** Workout start time in ISO 8601 */
  start_date: z.string(),

  /** Total workout duration in seconds */
  duration: z.number(),

  /** Total energy burned during the workout in kilocalories (optional) */
  total_energy_burned: z.number().nullable().optional(),

  /** Total distance covered in meters (optional, e.g. for running/cycling) */
  total_distance: z.number().nullable().optional(),
});

/**
 * Activity data from HealthKit — daily aggregates plus individual workouts.
 */
export const ActivityDataSchema = z.object({
  /** Daily step counts (HKQuantityTypeIdentifier.stepCount, statisticsCollection) */
  daily_steps: z.array(DatedValueSchema).default([]),

  /** Daily active energy burned in kilocalories (HKQuantityTypeIdentifier.activeEnergyBurned) */
  daily_active_energy: z.array(DatedValueSchema).default([]),

  /** Daily exercise minutes (HKQuantityTypeIdentifier.appleExerciseTime) */
  daily_exercise_minutes: z.array(DatedValueSchema).default([]),

  /** Individual workout sessions */
  workouts: z.array(WorkoutSummarySchema).default([]),
});

/**
 * Body composition data from HealthKit — weight, body fat, lean mass, BMI.
 */
export const BodyCompositionDataSchema = z.object({
  /** Body mass in kilograms (HKQuantityTypeIdentifier.bodyMass) */
  body_mass_samples: z.array(DatedValueSchema).default([]),

  /**
   * Body fat percentage as a 0-1 fraction (HKQuantityTypeIdentifier.bodyFatPercentage).
   * Example: 0.18 means 18% body fat. We multiply by 100 during normalization.
   */
  body_fat_percentage_samples: z.array(DatedValueSchema).default([]),

  /** Lean body mass in kilograms (HKQuantityTypeIdentifier.leanBodyMass) */
  lean_body_mass_samples: z.array(DatedValueSchema).default([]),

  /** Body Mass Index (HKQuantityTypeIdentifier.bodyMassIndex) — unitless */
  bmi_samples: z.array(DatedValueSchema).default([]),
});

/**
 * Cardio fitness data — VO2 Max estimates from HealthKit.
 */
export const CardioFitnessDataSchema = z.object({
  /**
   * VO2 Max samples in mL/kg/min
   * (HKQuantityTypeIdentifier.vo2Max).
   */
  vo2_max_samples: z.array(DatedValueSchema).default([]),
});

/**
 * The top-level HealthSnapshot schema — the complete payload the iOS app
 * sends on each sync. Contains all health data categories plus a timestamp
 * indicating when the data was fetched from HealthKit.
 */
export const HealthSnapshotSchema = z.object({
  vitals: VitalsDataSchema.default({ hrv_samples: [], resting_heart_rate_samples: [], spo2_samples: [] }),
  sleep: SleepDataSchema.default({ sessions: [] }),
  activity: ActivityDataSchema.default({ daily_steps: [], daily_active_energy: [], daily_exercise_minutes: [], workouts: [] }),
  body_composition: BodyCompositionDataSchema.default({ body_mass_samples: [], body_fat_percentage_samples: [], lean_body_mass_samples: [], bmi_samples: [] }),
  cardio_fitness: CardioFitnessDataSchema.default({ vo2_max_samples: [] }),

  /** ISO 8601 timestamp of when AthletiqX fetched this data from HealthKit */
  fetched_at: z.string(),
});

// ---------------------------------------------------------------------------
// TypeScript types — inferred from Zod schemas for type-safe usage
// ---------------------------------------------------------------------------

/** A single timestamped numeric value from HealthKit */
export type DatedValue = z.infer<typeof DatedValueSchema>;

/** Vitals data: HRV, resting HR, SpO2 */
export type VitalsData = z.infer<typeof VitalsDataSchema>;

/** A single sleep session with stage durations */
export type SleepSession = z.infer<typeof SleepSessionSchema>;

/** Container for sleep sessions */
export type SleepData = z.infer<typeof SleepDataSchema>;

/** A single workout summary */
export type WorkoutSummary = z.infer<typeof WorkoutSummarySchema>;

/** Activity data: daily steps, energy, exercise, plus workouts */
export type ActivityData = z.infer<typeof ActivityDataSchema>;

/** Body composition: weight, body fat, lean mass, BMI */
export type BodyCompositionData = z.infer<typeof BodyCompositionDataSchema>;

/** Cardio fitness: VO2 Max */
export type CardioFitnessData = z.infer<typeof CardioFitnessDataSchema>;

/** The complete health data snapshot from AthletiqX */
export type HealthSnapshot = z.infer<typeof HealthSnapshotSchema>;
