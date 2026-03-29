#!/usr/bin/env node

/**
 * @module index
 *
 * WellnessMCP entry point — supports two modes:
 *
 * **MCP mode** (default): Starts the MCP stdio server AND the HTTP ingest server.
 *   Used when running locally with Claude Desktop or Claude Code.
 *
 * **Ingest-only mode** (INGEST_ONLY=true): Starts ONLY the HTTP ingest server.
 *   Used when deployed to a remote server (Railway, Fly.io, etc.) where there
 *   is no MCP client connected via stdio. The iOS app pushes data here, and
 *   Claude connects to a local MCP instance that reads the same database
 *   (or the remote server serves as the data ingestion endpoint).
 *
 * Startup sequence:
 *   1. Create StorageManager (SQLite + optional SQLCipher encryption)
 *   2. Create PrivacyLayer (consent gate, PII redaction, aggregation)
 *   3. Create ProviderRegistry and register Apple Health provider
 *   4. Auto-connect Apple Health (starts the HTTP ingest server)
 *   5. If not ingest-only: Create MCP server, register tools, connect stdio
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

/**
 * Whether to run in ingest-only mode (no MCP stdio server).
 * Set INGEST_ONLY=true when deploying to Railway/Fly.io/etc. where
 * there is no MCP client attached to stdin/stdout.
 */
const INGEST_ONLY = process.env.INGEST_ONLY === "true";

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
    console.error(
      `[WellnessMCP] Apple Health ingest server started on port ${appleHealth.getIngestPort()}`
    );
  } catch (err) {
    // Don't crash the entire server if the ingest port is busy.
    console.error(
      `[WellnessMCP] Failed to start Apple Health ingest server: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  if (INGEST_ONLY) {
    // --- Ingest-only mode ---
    // Running on a remote server (Railway, etc.) with no MCP client.
    // The HTTP ingest server is the only active component — it receives
    // HealthKit data from the iOS app and stores it in SQLite.
    console.error("[WellnessMCP] Running in ingest-only mode (no MCP stdio server)");
  } else {
    // --- Full MCP mode ---
    // Running locally with Claude Desktop or Claude Code connected via stdio.
    const server = createServer();
    registerAllTools(server, { storage, privacy, providers });

    const transport = new StdioServerTransport();
    await server.connect(transport);
  }

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
