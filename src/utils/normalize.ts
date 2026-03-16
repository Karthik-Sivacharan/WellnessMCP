// Utility functions for normalizing data across providers

export function toISODate(date: Date | string): string {
  if (typeof date === "string") {
    return date.slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

export function toISOTimestamp(date: Date | string): string {
  if (typeof date === "string") {
    return new Date(date).toISOString();
  }
  return date.toISOString();
}

export function minutesToHours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${m}m`;
}

export function metersToMiles(meters: number): number {
  return Math.round((meters / 1609.344) * 100) / 100;
}

export function metersToKm(meters: number): number {
  return Math.round((meters / 1000) * 100) / 100;
}

export function kgToLbs(kg: number): number {
  return Math.round(kg * 2.20462 * 10) / 10;
}

export function lbsToKg(lbs: number): number {
  return Math.round((lbs / 2.20462) * 10) / 10;
}

export function celsiusToFahrenheit(c: number): number {
  return Math.round((c * 9 / 5 + 32) * 10) / 10;
}

export function mgdlToMmol(mgdl: number): number {
  return Math.round((mgdl / 18.0182) * 100) / 100;
}

export function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toISODate(d);
}

export function today(): string {
  return toISODate(new Date());
}
