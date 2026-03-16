import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../server.js";
import { daysAgo, today, minutesToHours } from "../utils/normalize.js";

export function registerSleepTools(server: McpServer, ctx: ServerContext): void {
  server.tool(
    "get_sleep",
    "Get sleep records for a date range, including duration, phases, HRV, heart rate, and sleep score",
    {
      start_date: z.string().optional().describe("Start date (YYYY-MM-DD). Defaults to 7 days ago"),
      end_date: z.string().optional().describe("End date (YYYY-MM-DD). Defaults to today"),
      provider: z.string().optional().describe("Filter by provider (e.g. oura, whoop, apple_health)"),
    },
    async ({ start_date, end_date, provider }) => {
      const start = start_date ?? daysAgo(7);
      const end = end_date ?? today();

      const raw = ctx.storage.getSleepRecords(start, end, provider);
      const result = ctx.privacy.filter(raw, "get_sleep", ["sleep"]);

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
    "get_sleep_summary",
    "Get a high-level sleep summary with averages for the past N days",
    {
      days: z.number().optional().describe("Number of days to summarize. Defaults to 7"),
    },
    async ({ days }) => {
      const n = days ?? 7;
      const start = daysAgo(n);
      const end = today();

      const raw = ctx.storage.getSleepRecords(start, end) as Array<Record<string, unknown>>;

      if (raw.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No sleep data found for the past ${n} days.` }],
        };
      }

      const result = ctx.privacy.filter(raw, "get_sleep_summary", ["sleep"]);

      if (result.denied.length > 0) {
        return {
          content: [{ type: "text" as const, text: ctx.privacy.formatDeniedMessage(result.denied) }],
        };
      }

      // If privacy layer already aggregated, return as-is
      if (result.wasAggregated) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ period: { start, end }, days: n, summary: result.data }, null, 2),
          }],
        };
      }

      // Build summary from raw records
      const records = result.data as Array<Record<string, unknown>>;
      const avg = (key: string) => {
        const vals = records.map((r) => r[key]).filter((v): v is number => typeof v === "number");
        if (vals.length === 0) return null;
        return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
      };

      const avgDuration = avg("total_duration_min");

      const summary = {
        period: { start, end },
        nights_tracked: records.length,
        avg_duration: avgDuration != null ? minutesToHours(avgDuration) : null,
        avg_duration_min: avgDuration,
        avg_deep_min: avg("deep_min"),
        avg_rem_min: avg("rem_min"),
        avg_light_min: avg("light_min"),
        avg_efficiency: avg("efficiency"),
        avg_hrv: avg("hrv_avg"),
        avg_hr: avg("hr_avg"),
        avg_score: avg("score"),
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    },
  );
}
