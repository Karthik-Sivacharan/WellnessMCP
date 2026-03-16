import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../server.js";
import { daysAgo, today } from "../utils/normalize.js";

export function registerHealthTools(server: McpServer, ctx: ServerContext): void {
  server.tool(
    "get_health_metrics",
    "Query generic health metrics by type and date range",
    {
      metric_type: z.string().describe("Metric type to query (e.g. resting_heart_rate, spo2, stress)"),
      start_date: z.string().optional().describe("Start date (YYYY-MM-DD). Defaults to 7 days ago"),
      end_date: z.string().optional().describe("End date (YYYY-MM-DD). Defaults to today"),
    },
    async ({ metric_type, start_date, end_date }) => {
      const start = start_date ?? daysAgo(7);
      const end = end_date ?? today();

      const raw = ctx.storage.getHealthMetrics(metric_type, start, end);
      const result = ctx.privacy.filter(raw, "get_health_metrics", ["health_metrics"]);

      if (result.denied.length > 0) {
        return {
          content: [{ type: "text" as const, text: ctx.privacy.formatDeniedMessage(result.denied) }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            metric_type,
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
    "get_data_inventory",
    "Show a summary of all stored health data — record counts, date ranges, and data sources",
    {},
    async () => {
      const inventory = ctx.storage.getDataInventory();
      const devices = ctx.storage.getAllDevices();

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            inventory,
            connected_devices: devices.map((d) => ({
              provider: d.provider,
              display_name: d.display_name,
              last_sync: d.last_sync,
              status: d.status,
            })),
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    "sync_providers",
    "Sync data from all configured health providers, or a specific one",
    {
      provider: z.string().optional().describe("Specific provider to sync (e.g. oura, whoop, fitbit). Omit to sync all"),
      start_date: z.string().optional().describe("Start date for sync range (YYYY-MM-DD)"),
      end_date: z.string().optional().describe("End date for sync range (YYYY-MM-DD)"),
    },
    async ({ provider, start_date, end_date }) => {
      if (provider) {
        const p = ctx.providers.get(provider as any);
        if (!p) {
          return {
            content: [{ type: "text" as const, text: `Provider "${provider}" is not registered.` }],
          };
        }
        if (!p.isConfigured()) {
          return {
            content: [{ type: "text" as const, text: `Provider "${provider}" is not configured. Set up credentials first.` }],
          };
        }
        const result = await p.sync(start_date, end_date);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      }

      const results = await ctx.providers.syncAll(start_date, end_date);
      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No providers are configured. Set up provider credentials to start syncing data." }],
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
      };
    },
  );

  server.tool(
    "delete_health_data",
    "Delete stored health data by category, with optional date range",
    {
      category: z.enum(["sleep", "activity", "vitals", "body_composition", "glucose", "health_metrics"])
        .describe("Data category to delete"),
      start_date: z.string().optional().describe("Start date (YYYY-MM-DD). Omit to delete all data in category"),
      end_date: z.string().optional().describe("End date (YYYY-MM-DD). Omit to delete all data in category"),
      confirm: z.boolean().describe("Must be true to confirm deletion"),
    },
    async ({ category, start_date, end_date, confirm }) => {
      if (!confirm) {
        return {
          content: [{ type: "text" as const, text: "Deletion not confirmed. Set confirm=true to proceed." }],
        };
      }

      const deleted = ctx.storage.deleteDataByCategory(category, start_date, end_date);

      ctx.privacy.audit.log({
        tool_name: "delete_health_data",
        data_categories: [category],
        record_count: deleted,
        was_aggregated: false,
        was_redacted: false,
      });

      return {
        content: [{
          type: "text" as const,
          text: `Deleted ${deleted} record(s) from ${category}${start_date ? ` between ${start_date} and ${end_date}` : ""}.`,
        }],
      };
    },
  );
}
