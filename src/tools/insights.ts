import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../server.js";
import { daysAgo, today, minutesToHours, metersToKm } from "../utils/normalize.js";

export function registerInsightTools(server: McpServer, ctx: ServerContext): void {
  server.tool(
    "get_daily_briefing",
    "Get a comprehensive daily health briefing combining sleep, activity, vitals, and body data",
    {
      date: z.string().optional().describe("Date to brief on (YYYY-MM-DD). Defaults to today"),
    },
    async ({ date }) => {
      const d = date ?? today();

      const sleep = ctx.storage.getSleepRecords(d, d);
      const activity = ctx.storage.getActivityRecords(d, d);
      const vitals = ctx.storage.getAllVitals(d, d + "T23:59:59");
      const body = ctx.storage.getBodyComposition(d, d);
      const glucose = ctx.storage.getGlucoseReadings(d, d + "T23:59:59");

      // Apply privacy to each category independently
      const sleepResult = ctx.privacy.filter(sleep, "get_daily_briefing", ["sleep"]);
      const activityResult = ctx.privacy.filter(activity, "get_daily_briefing", ["activity"]);
      const vitalsResult = ctx.privacy.filter(vitals, "get_daily_briefing", ["vitals"]);
      const bodyResult = ctx.privacy.filter(body, "get_daily_briefing", ["body_composition"]);
      const glucoseResult = ctx.privacy.filter(glucose, "get_daily_briefing", ["glucose"]);

      const denied = [
        ...sleepResult.denied,
        ...activityResult.denied,
        ...vitalsResult.denied,
        ...bodyResult.denied,
        ...glucoseResult.denied,
      ];

      const briefing: Record<string, unknown> = { date: d };

      if (sleepResult.data) briefing.sleep = sleepResult.data;
      if (activityResult.data) briefing.activity = activityResult.data;
      if (vitalsResult.data) briefing.vitals = vitalsResult.data;
      if (bodyResult.data) briefing.body_composition = bodyResult.data;
      if (glucoseResult.data) briefing.glucose = glucoseResult.data;

      if (denied.length > 0) {
        briefing.privacy_note = ctx.privacy.formatDeniedMessage(denied);
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(briefing, null, 2) }],
      };
    },
  );

  server.tool(
    "get_trends",
    "Analyze trends in a health metric over time — shows direction, change %, and weekly averages",
    {
      metric: z.enum(["sleep_duration", "sleep_score", "steps", "calories", "active_minutes", "weight", "hrv", "resting_hr"])
        .describe("Which metric to analyze trends for"),
      days: z.number().optional().describe("Number of days to analyze. Defaults to 30"),
    },
    async ({ metric, days }) => {
      const n = days ?? 30;
      const start = daysAgo(n);
      const end = today();

      let values: { date: string; value: number }[] = [];

      // Extract the right data based on metric
      if (metric === "sleep_duration" || metric === "sleep_score" || metric === "hrv") {
        const records = ctx.storage.getSleepRecords(start, end) as Array<Record<string, unknown>>;
        const privResult = ctx.privacy.filter(records, "get_trends", ["sleep"]);
        if (privResult.denied.length > 0) {
          return {
            content: [{ type: "text" as const, text: ctx.privacy.formatDeniedMessage(privResult.denied) }],
          };
        }
        if (!privResult.wasAggregated && Array.isArray(privResult.data)) {
          const key = metric === "sleep_duration" ? "total_duration_min"
            : metric === "sleep_score" ? "score" : "hrv_avg";
          values = (privResult.data as Array<Record<string, unknown>>)
            .filter((r) => r[key] != null)
            .map((r) => ({ date: r.date as string, value: r[key] as number }));
        }
      } else if (metric === "steps" || metric === "calories" || metric === "active_minutes") {
        const records = ctx.storage.getActivityRecords(start, end) as Array<Record<string, unknown>>;
        const privResult = ctx.privacy.filter(records, "get_trends", ["activity"]);
        if (privResult.denied.length > 0) {
          return {
            content: [{ type: "text" as const, text: ctx.privacy.formatDeniedMessage(privResult.denied) }],
          };
        }
        if (!privResult.wasAggregated && Array.isArray(privResult.data)) {
          const key = metric === "calories" ? "calories_total" : metric;
          values = (privResult.data as Array<Record<string, unknown>>)
            .filter((r) => r[key] != null)
            .map((r) => ({ date: r.date as string, value: r[key] as number }));
        }
      } else if (metric === "weight") {
        const records = ctx.storage.getBodyComposition(start, end) as Array<Record<string, unknown>>;
        const privResult = ctx.privacy.filter(records, "get_trends", ["body_composition"]);
        if (privResult.denied.length > 0) {
          return {
            content: [{ type: "text" as const, text: ctx.privacy.formatDeniedMessage(privResult.denied) }],
          };
        }
        if (!privResult.wasAggregated && Array.isArray(privResult.data)) {
          values = (privResult.data as Array<Record<string, unknown>>)
            .filter((r) => r.weight_kg != null)
            .map((r) => ({ date: r.date as string, value: r.weight_kg as number }));
        }
      } else if (metric === "resting_hr") {
        const records = ctx.storage.getVitals("resting_heart_rate", start, end + "T23:59:59") as Array<Record<string, unknown>>;
        const privResult = ctx.privacy.filter(records, "get_trends", ["vitals"]);
        if (privResult.denied.length > 0) {
          return {
            content: [{ type: "text" as const, text: ctx.privacy.formatDeniedMessage(privResult.denied) }],
          };
        }
        if (!privResult.wasAggregated && Array.isArray(privResult.data)) {
          values = (privResult.data as Array<Record<string, unknown>>)
            .filter((r) => r.value != null)
            .map((r) => ({
              date: (r.timestamp as string).slice(0, 10),
              value: r.value as number,
            }));
        }
      }

      if (values.length < 2) {
        return {
          content: [{
            type: "text" as const,
            text: `Not enough data points for ${metric} trend analysis (need at least 2, found ${values.length}).`,
          }],
        };
      }

      // Sort by date ascending
      values.sort((a, b) => a.date.localeCompare(b.date));

      // Calculate trend
      const first = values.slice(0, Math.ceil(values.length / 3));
      const last = values.slice(-Math.ceil(values.length / 3));
      const firstAvg = first.reduce((s, v) => s + v.value, 0) / first.length;
      const lastAvg = last.reduce((s, v) => s + v.value, 0) / last.length;
      const changePct = Math.round(((lastAvg - firstAvg) / firstAvg) * 1000) / 10;

      const allVals = values.map((v) => v.value);
      const overall = {
        min: Math.min(...allVals),
        max: Math.max(...allVals),
        avg: Math.round((allVals.reduce((a, b) => a + b, 0) / allVals.length) * 10) / 10,
        latest: allVals[allVals.length - 1],
      };

      let direction: "improving" | "declining" | "stable";
      // For resting HR and weight, lower is generally better
      const lowerIsBetter = metric === "resting_hr" || metric === "weight";
      if (Math.abs(changePct) < 2) {
        direction = "stable";
      } else if (lowerIsBetter) {
        direction = changePct < 0 ? "improving" : "declining";
      } else {
        direction = changePct > 0 ? "improving" : "declining";
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            metric,
            period: { start, end, days: n },
            data_points: values.length,
            trend: { direction, change_pct: changePct },
            stats: overall,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    "get_correlations",
    "Find correlations between two health metrics (e.g. does better sleep correlate with more steps?)",
    {
      metric_a: z.enum(["sleep_duration", "sleep_score", "steps", "calories", "active_minutes", "weight", "hrv", "resting_hr"])
        .describe("First metric"),
      metric_b: z.enum(["sleep_duration", "sleep_score", "steps", "calories", "active_minutes", "weight", "hrv", "resting_hr"])
        .describe("Second metric"),
      days: z.number().optional().describe("Number of days to analyze. Defaults to 30"),
    },
    async ({ metric_a, metric_b, days }) => {
      if (metric_a === metric_b) {
        return {
          content: [{ type: "text" as const, text: "Please choose two different metrics to compare." }],
        };
      }

      const n = days ?? 30;
      const start = daysAgo(n);
      const end = today();

      const extractMetric = (metric: string): Map<string, number> => {
        const map = new Map<string, number>();

        if (metric === "sleep_duration" || metric === "sleep_score" || metric === "hrv") {
          const records = ctx.storage.getSleepRecords(start, end) as Array<Record<string, unknown>>;
          const key = metric === "sleep_duration" ? "total_duration_min"
            : metric === "sleep_score" ? "score" : "hrv_avg";
          for (const r of records) {
            if (r[key] != null) map.set(r.date as string, r[key] as number);
          }
        } else if (metric === "steps" || metric === "calories" || metric === "active_minutes") {
          const records = ctx.storage.getActivityRecords(start, end) as Array<Record<string, unknown>>;
          const key = metric === "calories" ? "calories_total" : metric;
          for (const r of records) {
            if (r[key] != null) map.set(r.date as string, r[key] as number);
          }
        } else if (metric === "weight") {
          const records = ctx.storage.getBodyComposition(start, end) as Array<Record<string, unknown>>;
          for (const r of records) {
            if (r.weight_kg != null) map.set(r.date as string, r.weight_kg as number);
          }
        } else if (metric === "resting_hr") {
          const records = ctx.storage.getVitals("resting_heart_rate", start, end + "T23:59:59") as Array<Record<string, unknown>>;
          for (const r of records) {
            if (r.value != null) map.set((r.timestamp as string).slice(0, 10), r.value as number);
          }
        }

        return map;
      };

      const mapA = extractMetric(metric_a);
      const mapB = extractMetric(metric_b);

      // Find common dates
      const pairs: { date: string; a: number; b: number }[] = [];
      for (const [date, a] of mapA) {
        const b = mapB.get(date);
        if (b !== undefined) {
          pairs.push({ date, a, b });
        }
      }

      if (pairs.length < 5) {
        return {
          content: [{
            type: "text" as const,
            text: `Not enough overlapping data points (found ${pairs.length}, need at least 5).`,
          }],
        };
      }

      // Pearson correlation coefficient
      const n2 = pairs.length;
      const sumA = pairs.reduce((s, p) => s + p.a, 0);
      const sumB = pairs.reduce((s, p) => s + p.b, 0);
      const sumAB = pairs.reduce((s, p) => s + p.a * p.b, 0);
      const sumA2 = pairs.reduce((s, p) => s + p.a * p.a, 0);
      const sumB2 = pairs.reduce((s, p) => s + p.b * p.b, 0);

      const numerator = n2 * sumAB - sumA * sumB;
      const denominator = Math.sqrt((n2 * sumA2 - sumA * sumA) * (n2 * sumB2 - sumB * sumB));

      const correlation = denominator === 0 ? 0 : Math.round((numerator / denominator) * 1000) / 1000;

      let strength: string;
      const abs = Math.abs(correlation);
      if (abs >= 0.7) strength = "strong";
      else if (abs >= 0.4) strength = "moderate";
      else if (abs >= 0.2) strength = "weak";
      else strength = "negligible";

      const direction = correlation > 0 ? "positive" : correlation < 0 ? "negative" : "none";

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            metric_a,
            metric_b,
            period: { start, end, days: n },
            overlapping_data_points: pairs.length,
            correlation: {
              coefficient: correlation,
              strength,
              direction,
              interpretation: `There is a ${strength} ${direction} correlation between ${metric_a} and ${metric_b}.`,
            },
          }, null, 2),
        }],
      };
    },
  );
}
