import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../server.js";
import { daysAgo, today, metersToKm } from "../utils/normalize.js";

export function registerActivityTools(server: McpServer, ctx: ServerContext): void {
  server.tool(
    "get_activity",
    "Get activity/fitness records for a date range — steps, calories, distance, active minutes, etc.",
    {
      start_date: z.string().optional().describe("Start date (YYYY-MM-DD). Defaults to 7 days ago"),
      end_date: z.string().optional().describe("End date (YYYY-MM-DD). Defaults to today"),
      provider: z.string().optional().describe("Filter by provider (e.g. oura, whoop, fitbit, garmin)"),
    },
    async ({ start_date, end_date, provider }) => {
      const start = start_date ?? daysAgo(7);
      const end = end_date ?? today();

      const raw = ctx.storage.getActivityRecords(start, end, provider);
      const result = ctx.privacy.filter(raw, "get_activity", ["activity"]);

      if (result.denied.length > 0) {
        return {
          content: [{ type: "text" as const, text: ctx.privacy.formatDeniedMessage(result.denied) }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            period: { start, end },
            record_count: result.recordCount,
            aggregated: result.wasAggregated,
            data: result.data,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    "get_activity_summary",
    "Get a high-level activity summary with daily averages and totals for the past N days",
    {
      days: z.number().optional().describe("Number of days to summarize. Defaults to 7"),
    },
    async ({ days }) => {
      const n = days ?? 7;
      const start = daysAgo(n);
      const end = today();

      const raw = ctx.storage.getActivityRecords(start, end) as Array<Record<string, unknown>>;

      if (raw.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No activity data found for the past ${n} days.` }],
        };
      }

      const result = ctx.privacy.filter(raw, "get_activity_summary", ["activity"]);

      if (result.denied.length > 0) {
        return {
          content: [{ type: "text" as const, text: ctx.privacy.formatDeniedMessage(result.denied) }],
        };
      }

      if (result.wasAggregated) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ period: { start, end }, days: n, summary: result.data }, null, 2),
          }],
        };
      }

      const records = result.data as Array<Record<string, unknown>>;
      const sum = (key: string) => {
        const vals = records.map((r) => r[key]).filter((v): v is number => typeof v === "number");
        return vals.reduce((a, b) => a + b, 0);
      };
      const avg = (key: string) => {
        const vals = records.map((r) => r[key]).filter((v): v is number => typeof v === "number");
        if (vals.length === 0) return null;
        return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
      };

      const totalDistanceM = sum("distance_m");

      const summary = {
        period: { start, end },
        days_tracked: records.length,
        total_steps: sum("steps"),
        avg_steps: avg("steps"),
        total_calories: sum("calories_total"),
        avg_calories: avg("calories_total"),
        total_active_minutes: sum("active_minutes"),
        avg_active_minutes: avg("active_minutes"),
        total_distance_km: metersToKm(totalDistanceM),
        avg_vo2_max: avg("vo2_max"),
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    },
  );
}
