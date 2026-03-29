/**
 * @module providers/apple-health
 *
 * Apple Health provider implementation for WellnessMCP.
 *
 * Unlike cloud-based providers (Oura, WHOOP, Garmin, etc.) that use OAuth +
 * pull-based API syncing, Apple Health uses a **push-based** architecture:
 *
 *   1. The AthletiqX iOS app reads data from HealthKit on the device
 *   2. It POSTs a HealthSnapshot JSON payload to our HTTP ingest server
 *   3. The ingest server validates, normalizes, and stores the data
 *   4. MCP tools read from the local SQLite database as usual
 *
 * This means:
 *   - `connect()` starts the HTTP ingest server (not an OAuth flow)
 *   - `sync()` is a no-op that reports last received data (data arrives via push)
 *   - `isConfigured()` returns true when the ingest server is running
 *
 * The ingest server runs on a separate port from the MCP stdio transport,
 * so there's no conflict between the two communication channels.
 */

import { HealthProvider } from "./base.js";
import type { SyncResult, ProviderName } from "./types.js";
import { StorageManager } from "../storage/db.js";
import type { PrivacyLayer } from "../privacy/index.js";
import { IngestServer } from "../ingest/server.js";

/**
 * Apple Health provider — receives health data from the AthletiqX iOS app
 * via an HTTP ingest server rather than polling a cloud API.
 *
 * Lifecycle:
 *   1. Instantiate with a StorageManager
 *   2. Call `connect()` to start the ingest HTTP server
 *   3. iOS app POSTs data to http://host:port/ingest/health
 *   4. Call `sync()` to get a status report (no actual fetching occurs)
 *   5. Call `stopIngestServer()` on shutdown
 */
export class AppleHealthProvider extends HealthProvider {
  readonly name: ProviderName = "apple_health";
  readonly displayName = "Apple Health";

  /** The HTTP ingest server instance, created on connect() */
  private ingestServer: IngestServer | null = null;

  /** Privacy layer passed through to the IngestServer for chat context filtering */
  private privacy: PrivacyLayer;

  constructor(storage: StorageManager, privacy: PrivacyLayer) {
    super(storage);
    this.privacy = privacy;
  }

  /**
   * Returns true if the ingest server is currently running and ready
   * to receive data from the iOS app.
   *
   * Unlike cloud providers where "configured" means "has valid OAuth tokens",
   * for Apple Health "configured" means "the ingest endpoint is active".
   */
  isConfigured(): boolean {
    return this.ingestServer?.isRunning() ?? false;
  }

  /**
   * Starts the HTTP ingest server and registers the Apple Health device
   * in the storage layer.
   *
   * This is analogous to the OAuth `connect()` flow for cloud providers,
   * but instead of exchanging tokens, we spin up an HTTP endpoint that
   * the iOS app can POST data to.
   *
   * @param config - Optional configuration overrides:
   *   - `port`: Override the ingest server port (default: env var or 3456)
   *   - `api_key`: Override the API key (default: env var)
   */
  async connect(config?: Record<string, string>): Promise<void> {
    // Parse optional configuration overrides
    const port = config?.port ? parseInt(config.port, 10) : undefined;
    const apiKey = config?.api_key;

    // Create and start the ingest server, passing the privacy layer so the
    // chat endpoints can apply consent/redaction before sending data to the LLM
    this.ingestServer = new IngestServer(this.storage, this.privacy, port, apiKey);
    await this.ingestServer.start();

    // Register the device in the storage layer so MCP tools can see it
    // in list_devices and know when the last sync occurred.
    this.storage.upsertDevice({
      provider: this.name,
      display_name: this.displayName,
      device_model: "iOS (AthletiqX)",
      status: "connected",
    });
  }

  /**
   * For Apple Health, sync is **push-based** — the iOS app pushes data to us.
   * We don't fetch anything.
   *
   * This method returns a SyncResult summarizing what data has been received.
   * The `recordsSynced` count reflects the last ingest, not a new fetch.
   *
   * The startDate/endDate parameters are ignored because we don't control
   * when or what the iOS app sends — it pushes whatever data it has.
   *
   * @param _startDate - Ignored (push-based provider)
   * @param _endDate - Ignored (push-based provider)
   * @returns A SyncResult with status information about the last ingest
   */
  async sync(_startDate?: string, _endDate?: string): Promise<SyncResult> {
    // If the ingest server isn't running, we can't receive data
    if (!this.ingestServer || !this.ingestServer.isRunning()) {
      return {
        provider: this.name,
        success: false,
        recordsSynced: 0,
        errors: [
          "Ingest server is not running. Call connect() first, or " +
          "check that the port is available.",
        ],
        categories: [],
      };
    }

    const status = this.ingestServer.getStatus();
    const lastCounts = status.lastIngestCounts;
    const totalRecords = Object.values(lastCounts).reduce((a, b) => a + b, 0);
    const categories = Object.keys(lastCounts).filter((k) => lastCounts[k] > 0);

    // Report what data we've received via push, without actually fetching
    return {
      provider: this.name,
      success: true,
      recordsSynced: totalRecords,
      categories,
      errors: status.totalErrors > 0
        ? [`${status.totalErrors} failed ingest attempt(s) since server start`]
        : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Ingest server lifecycle methods
  // -------------------------------------------------------------------------

  /**
   * Starts the ingest HTTP server.
   *
   * This is called automatically by `connect()`, but can also be called
   * directly if the server needs to be restarted without re-registering
   * the device.
   *
   * @param port - Optional port override
   * @param apiKey - Optional API key override
   */
  async startIngestServer(port?: number, apiKey?: string): Promise<void> {
    if (this.ingestServer?.isRunning()) {
      console.error("[AppleHealthProvider] Ingest server is already running");
      return;
    }

    this.ingestServer = new IngestServer(this.storage, this.privacy, port, apiKey);
    await this.ingestServer.start();
  }

  /**
   * Stops the ingest HTTP server gracefully.
   *
   * Should be called during application shutdown (e.g., on SIGINT) to
   * release the port and close pending connections.
   */
  async stopIngestServer(): Promise<void> {
    if (this.ingestServer) {
      await this.ingestServer.stop();
      this.ingestServer = null;

      // Update device status to reflect that the ingest endpoint is down
      this.storage.upsertDevice({
        provider: this.name,
        display_name: this.displayName,
        device_model: "iOS (AthletiqX)",
        status: "disconnected",
      });
    }
  }

  /**
   * Returns the port the ingest server is listening on, or the configured
   * default if the server hasn't started yet.
   */
  getIngestPort(): number {
    return this.ingestServer?.getPort() ?? parseInt(
      process.env.WELLNESS_MCP_INGEST_PORT ?? "3456",
      10,
    );
  }
}
