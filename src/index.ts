#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, registerAllTools } from "./server.js";
import { StorageManager } from "./storage/db.js";
import { PrivacyLayer } from "./privacy/index.js";
import { ProviderRegistry } from "./providers/base.js";

async function main(): Promise<void> {
  const storage = await StorageManager.create();
  const privacy = new PrivacyLayer(storage);
  const providers = new ProviderRegistry(storage);

  const server = createServer();
  registerAllTools(server, { storage, privacy, providers });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("SIGINT", async () => {
    await storage.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
