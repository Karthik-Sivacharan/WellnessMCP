import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../server.js";
import { daysAgo, today } from "../utils/normalize.js";

export function registerBodyTools(server: McpServer, ctx: ServerContext): void {
  server.tool(
    "get_body_composition",
    "Get body composition data — weight, body fat %, muscle mass, BMI, etc.",
    {
      start_date: z.string().optional().describe("Start date (YYYY-MM-DD). Defaults to 30 days ago"),
      end_date: z.string().optional().describe("End date (YYYY-MM-DD). Defaults to today"),
    },
    async ({ start_date, end_date }) => {
      const start = start_date ?? daysAgo(30);
      const end = end_date ?? today();

      const raw = ctx.storage.getBodyComposition(start, end);
      const result = ctx.privacy.filter(raw, "get_body_composition", ["body_composition"]);

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
    "get_vitals",
    "Get vital sign readings — heart rate, blood pressure, temperature, SpO2, etc.",
    {
      metric: z.string().optional().describe("Specific vital metric (e.g. heart_rate, blood_pressure, temperature, spo2). Omit for all vitals"),
      start_date: z.string().optional().describe("Start date (YYYY-MM-DD). Defaults to 7 days ago"),
      end_date: z.string().optional().describe("End date (YYYY-MM-DD). Defaults to today"),
      provider: z.string().optional().describe("Filter by provider"),
    },
    async ({ metric, start_date, end_date, provider }) => {
      const start = start_date ?? daysAgo(7);
      const end = end_date ?? today();

      let raw: Record<string, unknown>[];
      if (metric) {
        raw = ctx.storage.getVitals(metric, start, end, provider);
      } else {
        raw = ctx.storage.getAllVitals(start, end);
      }

      const result = ctx.privacy.filter(raw, "get_vitals", ["vitals"]);

      if (result.denied.length > 0) {
        return {
          content: [{ type: "text" as const, text: ctx.privacy.formatDeniedMessage(result.denied) }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            metric: metric ?? "all",
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
    "get_glucose",
    "Get continuous glucose monitor (CGM) readings",
    {
      start_date: z.string().optional().describe("Start date (YYYY-MM-DD). Defaults to 7 days ago"),
      end_date: z.string().optional().describe("End date (YYYY-MM-DD). Defaults to today"),
    },
    async ({ start_date, end_date }) => {
      const start = start_date ?? daysAgo(7);
      const end = end_date ?? today();

      const raw = ctx.storage.getGlucoseReadings(start, end);
      const result = ctx.privacy.filter(raw, "get_glucose", ["glucose"]);

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
}
