#!/usr/bin/env node

/**
 * @module index
 *
 * WellnessMCP entry point — starts the MCP stdio server and the Apple Health
 * HTTP ingest server.
 *
 * Startup sequence:
 *   1. Create StorageManager (SQLite + optional SQLCipher encryption)
 *   2. Create PrivacyLayer (consent gate, PII redaction, aggregation)
 *   3. Create ProviderRegistry and register Apple Health provider
 *   4. Auto-connect Apple Health (starts the HTTP ingest server)
 *   5. Create MCP server and register all 16+ tools
 *   6. Connect MCP server to stdio transport
 *
 * Shutdown (SIGINT):
 *   1. Stop the Apple Health ingest server (release port)
 *   2. Close the SQLite database
 *   3. Exit
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, registerAllTools } from "./server.js";
import { StorageManager } from "./storage/db.js";
import { PrivacyLayer } from "./privacy/index.js";
import { ProviderRegistry } from "./providers/base.js";
import { AppleHealthProvider } from "./providers/apple-health.js";

async function main(): Promise<void> {
  const storage = await StorageManager.create();
  const privacy = new PrivacyLayer(storage);
  const providers = new ProviderRegistry(storage);

  // --- Register and auto-start the Apple Health provider ---
  // The Apple Health provider uses a push-based architecture: the AthletiqX
  // iOS app POSTs HealthKit data to an HTTP ingest endpoint. We start the
  // ingest server automatically so data can flow in as soon as the MCP
  // server is running.
  const appleHealth = new AppleHealthProvider(storage);
  providers.register(appleHealth);

  try {
    await appleHealth.connect();
    // Log to stderr to avoid interfering with MCP stdio on stdout
    console.error(
      `[WellnessMCP] Apple Health ingest server started on port ${appleHealth.getIngestPort()}`
    );
  } catch (err) {
    // Don't crash the entire MCP server if the ingest port is busy.
    // The provider will report as "not configured" and MCP tools will
    // still work with any previously stored data.
    console.error(
      `[WellnessMCP] Failed to start Apple Health ingest server: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const server = createServer();
  registerAllTools(server, { storage, privacy, providers });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // --- Graceful shutdown ---
  // Stop the ingest HTTP server first (releases the port), then close
  // the database connection.
  process.on("SIGINT", async () => {
    await appleHealth.stopIngestServer();
    await storage.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
