import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerHealthTools } from "./tools/health.js";
import { registerSleepTools } from "./tools/sleep.js";
import { registerActivityTools } from "./tools/activity.js";
import { registerBodyTools } from "./tools/body.js";
import { registerDeviceTools } from "./tools/devices.js";
import { registerPrivacyTools } from "./tools/privacy.js";
import { registerInsightTools } from "./tools/insights.js";
import { StorageManager } from "./storage/db.js";
import { PrivacyLayer } from "./privacy/index.js";
import { ProviderRegistry } from "./providers/base.js";

export interface ServerContext {
  storage: StorageManager;
  privacy: PrivacyLayer;
  providers: ProviderRegistry;
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "WellnessMCP",
    version: "0.1.0",
  });

  return server;
}

export function registerAllTools(server: McpServer, ctx: ServerContext): void {
  registerHealthTools(server, ctx);
  registerSleepTools(server, ctx);
  registerActivityTools(server, ctx);
  registerBodyTools(server, ctx);
  registerDeviceTools(server, ctx);
  registerPrivacyTools(server, ctx);
  registerInsightTools(server, ctx);
}
