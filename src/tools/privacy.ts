import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../server.js";
import type { DataCategory, Granularity } from "../privacy/consent.js";

const VALID_CATEGORIES: DataCategory[] = [
  "sleep", "activity", "vitals", "body_composition", "glucose", "health_metrics", "devices",
];

const VALID_GRANULARITIES: Granularity[] = ["raw", "aggregated", "summary"];

export function registerPrivacyTools(server: McpServer, ctx: ServerContext): void {
  server.tool(
    "get_privacy_settings",
    "View current privacy and consent settings — which data categories are shared and at what granularity",
    {},
    async () => {
      const scopes = ctx.privacy.consent.getScopes();

      // Include defaults for categories not yet in DB
      const allScopes = VALID_CATEGORIES.map((cat) => {
        const existing = scopes.find((s) => s.category === cat);
        return existing ?? { category: cat, enabled: true, granularity: "aggregated" as Granularity };
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            privacy_settings: allScopes,
            granularity_levels: {
              raw: "Full data with no aggregation",
              aggregated: "Statistical summaries (min, max, avg, median)",
              summary: "High-level overview only",
            },
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    "set_privacy_scope",
    "Change privacy settings for a data category — enable/disable sharing or change granularity level",
    {
      category: z.enum(VALID_CATEGORIES as [DataCategory, ...DataCategory[]])
        .describe("Data category to configure"),
      enabled: z.boolean().describe("Whether to allow sharing this data category"),
      granularity: z.enum(VALID_GRANULARITIES as [Granularity, ...Granularity[]])
        .describe("Level of detail: raw (full data), aggregated (statistics), or summary (overview)"),
    },
    async ({ category, enabled, granularity }) => {
      ctx.privacy.consent.setScope(category, enabled, granularity);

      ctx.privacy.audit.log({
        tool_name: "set_privacy_scope",
        data_categories: [category],
        record_count: 0,
        was_aggregated: false,
        was_redacted: false,
      });

      return {
        content: [{
          type: "text" as const,
          text: `Privacy scope updated: ${category} is now ${enabled ? "enabled" : "disabled"} with granularity "${granularity}".`,
        }],
      };
    },
  );

  server.tool(
    "get_audit_log",
    "View the audit log of all data access — who accessed what, when, and what privacy controls were applied",
    {
      limit: z.number().optional().describe("Number of recent entries to return. Defaults to 50"),
    },
    async ({ limit }) => {
      const entries = ctx.privacy.audit.getLog(limit ?? 50);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            audit_log: entries,
            total_entries: entries.length,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    "purge_old_data",
    "Delete health data older than a specified number of days (data retention policy)",
    {
      retention_days: z.number().describe("Delete data older than this many days"),
      confirm: z.boolean().describe("Must be true to confirm purge"),
    },
    async ({ retention_days, confirm }) => {
      if (!confirm) {
        return {
          content: [{ type: "text" as const, text: "Purge not confirmed. Set confirm=true to proceed." }],
        };
      }

      const deleted = ctx.storage.purgeOldData(retention_days);

      ctx.privacy.audit.log({
        tool_name: "purge_old_data",
        data_categories: ["sleep", "activity", "vitals", "body_composition", "glucose", "health_metrics"],
        record_count: deleted,
        was_aggregated: false,
        was_redacted: false,
      });

      return {
        content: [{
          type: "text" as const,
          text: `Purged ${deleted} record(s) older than ${retention_days} days.`,
        }],
      };
    },
  );
}
