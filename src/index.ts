#!/usr/bin/env node

/**
 * @module index
 *
 * WellnessMCP entry point — stateless health data proxy server.
 *
 * The server receives health data + questions from the iOS app,
 * applies PII redaction, sends to Claude API, and returns responses.
 * No data is stored — the iOS app is the single source of truth.
 *
 * Startup:
 *   1. Create PrivacyLayer (PII redactor only)
 *   2. Start HTTP server on configured port
 *
 * Shutdown (SIGINT):
 *   1. Stop HTTP server
 *   2. Exit
 */

import { PrivacyLayer } from "./privacy/index.js";
import { IngestServer } from "./ingest/server.js";

async function main(): Promise<void> {
  const privacy = new PrivacyLayer();

  const port = parseInt(process.env.WELLNESS_MCP_INGEST_PORT ?? "3456", 10);
  const apiKey = process.env.WELLNESS_MCP_INGEST_KEY ?? undefined;

  const server = new IngestServer(privacy, port, apiKey);
  await server.start();

  console.error(`[WellnessMCP] Stateless proxy server started on port ${port}`);

  process.on("SIGINT", async () => {
    await server.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
