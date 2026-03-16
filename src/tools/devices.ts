import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../server.js";

export function registerDeviceTools(server: McpServer, ctx: ServerContext): void {
  server.tool(
    "list_devices",
    "List all connected health devices and data sources with their sync status",
    {},
    async () => {
      const devices = ctx.storage.getAllDevices();
      const providers = ctx.providers.getAll();

      const registered = providers.map((p) => ({
        name: p.name,
        display_name: p.displayName,
        configured: p.isConfigured(),
        last_sync: p.getLastSync(),
      }));

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            connected_devices: devices.map((d) => ({
              provider: d.provider,
              display_name: d.display_name,
              device_model: d.device_model,
              firmware_version: d.firmware_version,
              last_sync: d.last_sync,
              status: d.status,
            })),
            available_providers: registered,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    "connect_provider",
    "Connect a new health data provider by starting the OAuth flow or providing config",
    {
      provider: z.enum(["oura", "whoop", "garmin", "fitbit", "dexcom", "apple_health"])
        .describe("Provider to connect"),
      config: z.record(z.string()).optional()
        .describe("Optional configuration (e.g. export file path for apple_health)"),
    },
    async ({ provider, config }) => {
      const p = ctx.providers.get(provider);
      if (!p) {
        return {
          content: [{
            type: "text" as const,
            text: `Provider "${provider}" is not registered. Available providers: ${ctx.providers.getAll().map((p) => p.name).join(", ") || "none"}`,
          }],
        };
      }

      try {
        await p.connect(config);
        return {
          content: [{
            type: "text" as const,
            text: `Successfully connected to ${p.displayName}. You can now sync data using sync_providers.`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to connect to ${p.displayName}: ${err instanceof Error ? err.message : String(err)}`,
          }],
        };
      }
    },
  );
}
