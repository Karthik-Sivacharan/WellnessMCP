import type { Granularity } from "./consent.js";

export class DataAggregator {
  aggregate(data: Record<string, unknown>[], granularity: Granularity): Record<string, unknown>[] | Record<string, unknown> {
    if (granularity === "raw" || data.length === 0) {
      return data;
    }

    if (granularity === "summary") {
      return this.toSummary(data);
    }

    // "aggregated" — return statistical summaries per numeric field
    return this.toAggregated(data);
  }

  private toAggregated(data: Record<string, unknown>[]): Record<string, unknown>[] {
    if (data.length <= 7) return data;

    const numericFields = this.getNumericFields(data);
    const result: Record<string, unknown> = {
      _aggregation: "statistical_summary",
      _record_count: data.length,
      _date_range: this.getDateRange(data),
    };

    for (const field of numericFields) {
      const values = data
        .map((r) => r[field])
        .filter((v): v is number => typeof v === "number");

      if (values.length === 0) continue;

      values.sort((a, b) => a - b);
      result[field] = {
        min: values[0],
        max: values[values.length - 1],
        avg: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100,
        median: values[Math.floor(values.length / 2)],
        count: values.length,
      };
    }

    return [result];
  }

  private toSummary(data: Record<string, unknown>[]): Record<string, unknown> {
    const numericFields = this.getNumericFields(data);
    const summary: Record<string, string> = {
      _summary: "high_level_overview",
      _record_count: String(data.length),
      _date_range: JSON.stringify(this.getDateRange(data)),
    };

    for (const field of numericFields) {
      const values = data
        .map((r) => r[field])
        .filter((v): v is number => typeof v === "number");

      if (values.length === 0) continue;

      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      summary[field] = `avg: ${Math.round(avg * 100) / 100}`;
    }

    return summary;
  }

  private getNumericFields(data: Record<string, unknown>[]): string[] {
    const fields = new Set<string>();
    for (const record of data.slice(0, 10)) {
      for (const [key, val] of Object.entries(record)) {
        if (typeof val === "number" && !key.startsWith("id") && key !== "id") {
          fields.add(key);
        }
      }
    }
    return [...fields];
  }

  private getDateRange(data: Record<string, unknown>[]): { start: string | null; end: string | null } {
    const dateFields = ["date", "timestamp", "bedtime", "created_at"];
    let dates: string[] = [];

    for (const record of data) {
      for (const field of dateFields) {
        const val = record[field];
        if (typeof val === "string" && val.length >= 10) {
          dates.push(val);
        }
      }
    }

    dates = dates.sort();
    return {
      start: dates[0] ?? null,
      end: dates[dates.length - 1] ?? null,
    };
  }
}
