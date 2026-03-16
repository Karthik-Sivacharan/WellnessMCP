export interface NormalizedSleep {
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
}

export interface NormalizedActivity {
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
}

export interface NormalizedVital {
  provider: string;
  metric: string;
  value: number;
  unit: string;
  timestamp: string;
}

export interface NormalizedBodyComposition {
  provider: string;
  date: string;
  weight_kg?: number;
  body_fat_pct?: number;
  muscle_mass_kg?: number;
  bmi?: number;
  bone_mass_kg?: number;
  water_pct?: number;
}

export interface NormalizedGlucose {
  provider: string;
  value: number;
  unit: string;
  trend?: string;
  timestamp: string;
}

export interface SyncResult {
  provider: string;
  success: boolean;
  recordsSynced: number;
  errors?: string[];
  categories: string[];
}

export type ProviderName = "apple_health" | "oura" | "whoop" | "garmin" | "fitbit" | "dexcom";
