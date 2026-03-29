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

// ---------------------------------------------------------------------------
// Extended HealthKit data type schemas
// ---------------------------------------------------------------------------

/**
 * Nutrition data from HealthKit — dietary intake tracked via Health app or
 * third-party food logging apps.
 *
 * All HKQuantityTypeIdentifier.dietary* types are represented here.
 * Units noted in comments match the HealthKit default unit for each type.
 *
 * @see https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier
 */
export const NutritionDataSchema = z.object({
  /** Total dietary energy consumed in kilocalories (HKQuantityTypeIdentifier.dietaryEnergyConsumed) */
  dietary_energy_consumed: z.array(DatedValueSchema).default([]),
  /** Protein intake in grams (HKQuantityTypeIdentifier.dietaryProtein) */
  dietary_protein: z.array(DatedValueSchema).default([]),
  /** Carbohydrate intake in grams (HKQuantityTypeIdentifier.dietaryCarbohydrates) */
  dietary_carbohydrates: z.array(DatedValueSchema).default([]),
  /** Total fat intake in grams (HKQuantityTypeIdentifier.dietaryFatTotal) */
  dietary_fat_total: z.array(DatedValueSchema).default([]),
  /** Dietary fiber in grams (HKQuantityTypeIdentifier.dietaryFiber) */
  dietary_fiber: z.array(DatedValueSchema).default([]),
  /** Sugar intake in grams (HKQuantityTypeIdentifier.dietarySugar) */
  dietary_sugar: z.array(DatedValueSchema).default([]),
  /** Water intake in milliliters (HKQuantityTypeIdentifier.dietaryWater) */
  dietary_water: z.array(DatedValueSchema).default([]),
  /** Caffeine intake in milligrams (HKQuantityTypeIdentifier.dietaryCaffeine) */
  dietary_caffeine: z.array(DatedValueSchema).default([]),
  /** Sodium intake in milligrams (HKQuantityTypeIdentifier.dietarySodium) */
  dietary_sodium: z.array(DatedValueSchema).default([]),
  /** Cholesterol intake in milligrams (HKQuantityTypeIdentifier.dietaryCholesterol) */
  dietary_cholesterol: z.array(DatedValueSchema).default([]),
  /** Iron intake in milligrams (HKQuantityTypeIdentifier.dietaryIron) */
  dietary_iron: z.array(DatedValueSchema).default([]),
  /** Calcium intake in milligrams (HKQuantityTypeIdentifier.dietaryCalcium) */
  dietary_calcium: z.array(DatedValueSchema).default([]),
  /** Potassium intake in milligrams (HKQuantityTypeIdentifier.dietaryPotassium) */
  dietary_potassium: z.array(DatedValueSchema).default([]),
  /** Vitamin A intake in micrograms (HKQuantityTypeIdentifier.dietaryVitaminA) */
  dietary_vitamin_a: z.array(DatedValueSchema).default([]),
  /** Vitamin C intake in milligrams (HKQuantityTypeIdentifier.dietaryVitaminC) */
  dietary_vitamin_c: z.array(DatedValueSchema).default([]),
  /** Vitamin D intake in micrograms (HKQuantityTypeIdentifier.dietaryVitaminD) */
  dietary_vitamin_d: z.array(DatedValueSchema).default([]),
  /** Vitamin B6 intake in milligrams (HKQuantityTypeIdentifier.dietaryVitaminB6) */
  dietary_vitamin_b6: z.array(DatedValueSchema).default([]),
  /** Vitamin B12 intake in micrograms (HKQuantityTypeIdentifier.dietaryVitaminB12) */
  dietary_vitamin_b12: z.array(DatedValueSchema).default([]),
  /** Folate intake in micrograms (HKQuantityTypeIdentifier.dietaryFolate) */
  dietary_folate: z.array(DatedValueSchema).default([]),
  /** Magnesium intake in milligrams (HKQuantityTypeIdentifier.dietaryMagnesium) */
  dietary_magnesium: z.array(DatedValueSchema).default([]),
  /** Zinc intake in milligrams (HKQuantityTypeIdentifier.dietaryZinc) */
  dietary_zinc: z.array(DatedValueSchema).default([]),
  /** Saturated fat intake in grams (HKQuantityTypeIdentifier.dietaryFatSaturated) */
  dietary_fat_saturated: z.array(DatedValueSchema).default([]),
  /** Monounsaturated fat intake in grams (HKQuantityTypeIdentifier.dietaryFatMonounsaturated) */
  dietary_fat_monounsaturated: z.array(DatedValueSchema).default([]),
  /** Polyunsaturated fat intake in grams (HKQuantityTypeIdentifier.dietaryFatPolyunsaturated) */
  dietary_fat_polyunsaturated: z.array(DatedValueSchema).default([]),
});

/**
 * Extended heart data from HealthKit — continuous heart rate, walking average,
 * heart rate recovery, and atrial fibrillation burden.
 *
 * These supplement the existing vitals section (which covers HRV, resting HR, SpO2).
 *
 * @see https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier
 */
export const HeartDataSchema = z.object({
  /** Continuous heart rate samples in bpm (HKQuantityTypeIdentifier.heartRate) */
  heart_rate: z.array(DatedValueSchema).default([]),
  /** Walking heart rate average in bpm (HKQuantityTypeIdentifier.walkingHeartRateAverage) */
  walking_heart_rate_average: z.array(DatedValueSchema).default([]),
  /** Heart rate recovery (1-min post-exercise) in bpm (HKQuantityTypeIdentifier.heartRateRecoveryOneMinute) */
  heart_rate_recovery: z.array(DatedValueSchema).default([]),
  /** Atrial fibrillation burden as percentage 0-100 (HKQuantityTypeIdentifier.atrialFibrillationBurden) */
  atrialFibrillationBurden: z.array(DatedValueSchema).default([]),
});

/**
 * Respiratory data from HealthKit — breathing rate, lung function tests,
 * and inhaler usage tracking.
 *
 * @see https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier
 */
export const RespiratoryDataSchema = z.object({
  /** Respiratory rate in breaths per minute (HKQuantityTypeIdentifier.respiratoryRate) */
  respiratory_rate: z.array(DatedValueSchema).default([]),
  /** Forced vital capacity in liters (HKQuantityTypeIdentifier.forcedVitalCapacity) */
  forced_vital_capacity: z.array(DatedValueSchema).default([]),
  /** Forced expiratory volume (FEV1) in liters (HKQuantityTypeIdentifier.forcedExpiratoryVolume1) */
  forced_expiratory_volume: z.array(DatedValueSchema).default([]),
  /** Peak expiratory flow rate in L/min (HKQuantityTypeIdentifier.peakExpiratoryFlowRate) */
  peak_expiratory_flow_rate: z.array(DatedValueSchema).default([]),
  /** Inhaler usage count (HKQuantityTypeIdentifier.inhalerUsage) */
  inhaler_usage: z.array(DatedValueSchema).default([]),
});

/**
 * Mindfulness and mental health data from HealthKit — meditation sessions,
 * mood tracking, and daylight exposure.
 *
 * @see https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier
 * @see https://developer.apple.com/documentation/healthkit/hkcategorytypeidentifier
 */
export const MindfulnessDataSchema = z.object({
  /** Mindful session duration in minutes (HKCategoryTypeIdentifier.mindfulSession) */
  mindful_sessions: z.array(DatedValueSchema).default([]),
  /** State of mind rating on 1-5 scale (HKStateOfMind, iOS 17+) */
  state_of_mind: z.array(DatedValueSchema).default([]),
  /** Time spent in daylight in minutes (HKQuantityTypeIdentifier.timeInDaylight) */
  time_in_daylight: z.array(DatedValueSchema).default([]),
});

/**
 * Mobility data from HealthKit — gait analysis, stair speed, and functional
 * capacity metrics. These are typically derived from iPhone/Watch motion sensors.
 *
 * @see https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier
 */
export const MobilityDataSchema = z.object({
  /** Walking speed in meters per second (HKQuantityTypeIdentifier.walkingSpeed) */
  walking_speed: z.array(DatedValueSchema).default([]),
  /** Walking step length in meters (HKQuantityTypeIdentifier.walkingStepLength) */
  walking_step_length: z.array(DatedValueSchema).default([]),
  /** Walking asymmetry as percentage (HKQuantityTypeIdentifier.walkingAsymmetryPercentage) */
  walking_asymmetry: z.array(DatedValueSchema).default([]),
  /** Walking double support time as percentage (HKQuantityTypeIdentifier.walkingDoubleSupportPercentage) */
  walking_double_support: z.array(DatedValueSchema).default([]),
  /** Stair ascent speed in meters per second (HKQuantityTypeIdentifier.stairAscentSpeed) */
  stair_ascent_speed: z.array(DatedValueSchema).default([]),
  /** Stair descent speed in meters per second (HKQuantityTypeIdentifier.stairDescentSpeed) */
  stair_descent_speed: z.array(DatedValueSchema).default([]),
  /** Six-minute walk test distance in meters (HKQuantityTypeIdentifier.sixMinuteWalkTestDistance) */
  six_minute_walk_distance: z.array(DatedValueSchema).default([]),
});

/**
 * Reproductive health data from HealthKit — menstrual cycle tracking,
 * fertility indicators, and related metrics.
 *
 * Numeric encoding for categorical values:
 * - menstrual_flow: 1=unspecified, 2=light, 3=medium, 4=heavy, 5=none
 * - cervical_mucus_quality: 1=dry, 2=sticky, 3=creamy, 4=watery, 5=eggWhite
 * - ovulation_test_result: 1=negative, 2=luteinizingHormoneSurge, 3=estrogenSurge
 *
 * @see https://developer.apple.com/documentation/healthkit/hkcategorytypeidentifier
 */
export const ReproductiveDataSchema = z.object({
  /** Menstrual flow intensity (HKCategoryTypeIdentifier.menstrualFlow) — see encoding above */
  menstrual_flow: z.array(DatedValueSchema).default([]),
  /** Cervical mucus quality (HKCategoryTypeIdentifier.cervicalMucusQuality) — see encoding above */
  cervical_mucus_quality: z.array(DatedValueSchema).default([]),
  /** Basal body temperature in degrees Celsius (HKQuantityTypeIdentifier.basalBodyTemperature) */
  basal_body_temperature: z.array(DatedValueSchema).default([]),
  /** Ovulation test result (HKCategoryTypeIdentifier.ovulationTestResult) — see encoding above */
  ovulation_test_result: z.array(DatedValueSchema).default([]),
  /** Sexual activity logged as 0/1 boolean (HKCategoryTypeIdentifier.sexualActivity) */
  sexual_activity: z.array(DatedValueSchema).default([]),
  /** Intermenstrual bleeding as 0/1 boolean (HKCategoryTypeIdentifier.intermenstrualBleeding) */
  intermenstrual_bleeding: z.array(DatedValueSchema).default([]),
});

/**
 * Environmental exposure data from HealthKit — UV, noise levels, and
 * water temperature for swimming.
 *
 * @see https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier
 */
export const EnvironmentalDataSchema = z.object({
  /** UV exposure index (HKQuantityTypeIdentifier.uvExposure) */
  uv_exposure: z.array(DatedValueSchema).default([]),
  /** Environmental sound level in dB(A) (HKQuantityTypeIdentifier.environmentalAudioExposure) */
  environmental_audio_exposure: z.array(DatedValueSchema).default([]),
  /** Headphone audio level in dB(A) (HKQuantityTypeIdentifier.headphoneAudioExposure) */
  headphone_audio_exposure: z.array(DatedValueSchema).default([]),
  /** Water temperature in degrees Celsius (HKQuantityTypeIdentifier.waterTemperature) */
  water_temperature: z.array(DatedValueSchema).default([]),
});

/**
 * Clinical and lab data from HealthKit — blood glucose, blood pressure,
 * body temperature, and other medical measurements.
 *
 * Blood pressure is split into systolic and diastolic components because
 * HKCorrelationTypeIdentifier.bloodPressure contains two HKQuantitySamples.
 *
 * @see https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier
 * @see https://developer.apple.com/documentation/healthkit/hkcorrelationtypeidentifier
 */
export const ClinicalDataSchema = z.object({
  /** Blood glucose in mg/dL (HKQuantityTypeIdentifier.bloodGlucose) */
  blood_glucose: z.array(DatedValueSchema).default([]),
  /** Systolic blood pressure in mmHg (from HKCorrelationTypeIdentifier.bloodPressure) */
  blood_pressure_systolic: z.array(DatedValueSchema).default([]),
  /** Diastolic blood pressure in mmHg (from HKCorrelationTypeIdentifier.bloodPressure) */
  blood_pressure_diastolic: z.array(DatedValueSchema).default([]),
  /** Blood alcohol content as percentage (HKQuantityTypeIdentifier.bloodAlcoholContent) */
  blood_alcohol_content: z.array(DatedValueSchema).default([]),
  /** Insulin delivery in international units (HKQuantityTypeIdentifier.insulinDelivery) */
  insulin_delivery: z.array(DatedValueSchema).default([]),
  /** Number of times fallen — count (HKQuantityTypeIdentifier.numberOfTimesFallen) */
  number_of_times_fallen: z.array(DatedValueSchema).default([]),
  /** Electrodermal activity in microsiemens (HKQuantityTypeIdentifier.electrodermalActivity) */
  electrodermal_activity: z.array(DatedValueSchema).default([]),
  /** Peripheral perfusion index as percentage (HKQuantityTypeIdentifier.peripheralPerfusionIndex) */
  peripheral_perfusion_index: z.array(DatedValueSchema).default([]),
  /** Body temperature in degrees Celsius (HKQuantityTypeIdentifier.bodyTemperature) */
  body_temperature: z.array(DatedValueSchema).default([]),
  /**
   * Apple Watch sleeping wrist temperature delta in degrees Celsius
   * (HKQuantityTypeIdentifier.appleSleepingWristTemperature).
   * This is a deviation from baseline, not an absolute temperature.
   */
  apple_sleeping_wrist_temperature: z.array(DatedValueSchema).default([]),
});

/**
 * Additional fitness and activity metrics from HealthKit — flights climbed,
 * swimming, wheelchair, running dynamics, cycling metrics, and more.
 *
 * @see https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier
 */
export const OtherMetricsDataSchema = z.object({
  /** Flights of stairs climbed — count (HKQuantityTypeIdentifier.flightsClimbed) */
  flights_climbed: z.array(DatedValueSchema).default([]),
  /** Nike Fuel points (HKQuantityTypeIdentifier.nikeFuel) — legacy metric */
  nike_fuel: z.array(DatedValueSchema).default([]),
  /** Apple Watch stand time in minutes (HKQuantityTypeIdentifier.appleStandTime) */
  apple_stand_time: z.array(DatedValueSchema).default([]),
  /** Apple Watch move time in minutes (HKQuantityTypeIdentifier.appleMoveTime) */
  apple_move_time: z.array(DatedValueSchema).default([]),
  /** Swimming stroke count (HKQuantityTypeIdentifier.swimmingStrokeCount) */
  swimming_stroke_count: z.array(DatedValueSchema).default([]),
  /** Underwater depth in meters (HKQuantityTypeIdentifier.underwaterDepth) */
  underwater_depth: z.array(DatedValueSchema).default([]),
  /** Wheelchair distance in meters (HKQuantityTypeIdentifier.distanceWheelchair) */
  distance_wheelchair: z.array(DatedValueSchema).default([]),
  /** Wheelchair push count (HKQuantityTypeIdentifier.pushCount) */
  push_count: z.array(DatedValueSchema).default([]),
  /** Running power in watts (HKQuantityTypeIdentifier.runningPower) */
  running_power: z.array(DatedValueSchema).default([]),
  /** Running speed in meters per second (HKQuantityTypeIdentifier.runningSpeed) */
  running_speed: z.array(DatedValueSchema).default([]),
  /** Running stride length in meters (HKQuantityTypeIdentifier.runningStrideLength) */
  running_stride_length: z.array(DatedValueSchema).default([]),
  /** Running vertical oscillation in centimeters (HKQuantityTypeIdentifier.runningVerticalOscillation) */
  running_vertical_oscillation: z.array(DatedValueSchema).default([]),
  /** Running ground contact time in milliseconds (HKQuantityTypeIdentifier.runningGroundContactTime) */
  running_ground_contact_time: z.array(DatedValueSchema).default([]),
  /** Cycling speed in meters per second (HKQuantityTypeIdentifier.cyclingSpeed) */
  cycling_speed: z.array(DatedValueSchema).default([]),
  /** Cycling power in watts (HKQuantityTypeIdentifier.cyclingPower) */
  cycling_power: z.array(DatedValueSchema).default([]),
  /** Cycling cadence in revolutions per minute (HKQuantityTypeIdentifier.cyclingCadence) */
  cycling_cadence: z.array(DatedValueSchema).default([]),
  /** Physical effort / exercise intensity in kcal/hr/kg (HKQuantityTypeIdentifier.physicalEffort) */
  physical_effort: z.array(DatedValueSchema).default([]),
});

/**
 * The top-level HealthSnapshot schema — the complete payload the iOS app
 * sends on each sync. Contains all health data categories plus a timestamp
 * indicating when the data was fetched from HealthKit.
 *
 * Original categories (vitals, sleep, activity, body_composition, cardio_fitness)
 * are always present with defaults. Extended categories (nutrition, heart,
 * respiratory, etc.) are optional with empty defaults so existing iOS app
 * payloads that only include the original categories still validate.
 */
export const HealthSnapshotSchema = z.object({
  // --- Original categories (Phase 1-4) ---
  vitals: VitalsDataSchema.default({ hrv_samples: [], resting_heart_rate_samples: [], spo2_samples: [] }),
  sleep: SleepDataSchema.default({ sessions: [] }),
  activity: ActivityDataSchema.default({ daily_steps: [], daily_active_energy: [], daily_exercise_minutes: [], workouts: [] }),
  body_composition: BodyCompositionDataSchema.default({ body_mass_samples: [], body_fat_percentage_samples: [], lean_body_mass_samples: [], bmi_samples: [] }),
  cardio_fitness: CardioFitnessDataSchema.default({ vo2_max_samples: [] }),

  // --- Extended HealthKit categories (all optional with empty defaults) ---

  /** Dietary/nutrition data — macros, micros, water, caffeine */
  nutrition: NutritionDataSchema.default({}),
  /** Extended heart metrics — continuous HR, walking avg, recovery, AFib burden */
  heart: HeartDataSchema.default({}),
  /** Respiratory metrics — breathing rate, lung function, inhaler usage */
  respiratory: RespiratoryDataSchema.default({}),
  /** Mindfulness & mental health — meditation, mood, daylight exposure */
  mindfulness: MindfulnessDataSchema.default({}),
  /** Mobility & gait analysis — walking speed/asymmetry, stair speed, 6MWT */
  mobility: MobilityDataSchema.default({}),
  /** Reproductive health — menstrual cycle, fertility, basal temp */
  reproductive: ReproductiveDataSchema.default({}),
  /** Environmental exposure — UV, noise, headphone audio, water temp */
  environmental: EnvironmentalDataSchema.default({}),
  /** Clinical & lab — blood glucose, blood pressure, body temp, insulin */
  clinical: ClinicalDataSchema.default({}),
  /** Other fitness metrics — flights climbed, running dynamics, cycling, swimming */
  other_metrics: OtherMetricsDataSchema.default({}),

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

/** Nutrition data: dietary macros, micros, water, caffeine */
export type NutritionData = z.infer<typeof NutritionDataSchema>;

/** Extended heart metrics: continuous HR, walking avg, recovery, AFib */
export type HeartData = z.infer<typeof HeartDataSchema>;

/** Respiratory data: breathing rate, lung function, inhaler usage */
export type RespiratoryData = z.infer<typeof RespiratoryDataSchema>;

/** Mindfulness & mental health: meditation, mood, daylight */
export type MindfulnessData = z.infer<typeof MindfulnessDataSchema>;

/** Mobility & gait analysis: walking metrics, stair speed, 6MWT */
export type MobilityData = z.infer<typeof MobilityDataSchema>;

/** Reproductive health: menstrual cycle, fertility, basal temp */
export type ReproductiveData = z.infer<typeof ReproductiveDataSchema>;

/** Environmental exposure: UV, noise, audio, water temp */
export type EnvironmentalData = z.infer<typeof EnvironmentalDataSchema>;

/** Clinical & lab: blood glucose, BP, body temp, insulin */
export type ClinicalData = z.infer<typeof ClinicalDataSchema>;

/** Other fitness metrics: flights, running dynamics, cycling, swimming */
export type OtherMetricsData = z.infer<typeof OtherMetricsDataSchema>;

/** The complete health data snapshot from AthletiqX */
export type HealthSnapshot = z.infer<typeof HealthSnapshotSchema>;
