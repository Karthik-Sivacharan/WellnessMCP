/**
 * @module ingest/server
 *
 * HTTP ingest server for receiving health data from the AthletiqX iOS app.
 *
 * Architecture:
 *   This server runs alongside the MCP stdio server. While the MCP server
 *   communicates with Claude via stdin/stdout, this HTTP server listens on
 *   a configurable port for incoming health data POSTs from the iOS app.
 *
 *   AthletiqX (iOS) --HTTP POST--> IngestServer --normalize--> StorageManager --> SQLite
 *                                                                                   |
 *   Claude <--MCP stdio--> MCP Server <-- reads from ----------------------------- /
 *
 * Uses Node.js built-in `http` module — no Express dependency required.
 *
 * Configuration (environment variables):
 *   - WELLNESS_MCP_INGEST_PORT: Port to listen on (default: 3456)
 *   - WELLNESS_MCP_INGEST_KEY: Optional API key for authentication
 *
 * Endpoints:
 *   - POST /ingest/health       — Receive and store a HealthSnapshot
 *   - GET  /ingest/health/status — Check server status and record counts
 *   - POST /chat                — Send a question, get an AI response using health data context
 *   - POST /chat/api-key        — Store an Anthropic API key server-side for convenience
 *   - GET  /chat/models         — List available Claude models
 */

import http from "node:http";
import { z } from "zod";
import { HealthSnapshotSchema } from "./types.js";
import type { HealthSnapshot } from "./types.js";
import {
  normalizeSleep,
  normalizeActivity,
  normalizeVitals,
  normalizeBodyComposition,
} from "./normalizer.js";
import { StorageManager } from "../storage/db.js";
import { PrivacyLayer } from "../privacy/index.js";
import { HealthContextBuilder } from "../chat/context.js";
import { ChatService, SUPPORTED_MODELS } from "../chat/service.js";
import type { ChatOptions } from "../chat/service.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default port for the ingest HTTP server */
const DEFAULT_PORT = 3456;

/** Maximum request body size in bytes (5 MB). Prevents memory exhaustion
 *  from oversized payloads, whether malicious or accidental. */
const MAX_BODY_SIZE = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Tracks the result of the most recent ingest operation */
interface IngestStatus {
  /** Whether the server is currently running */
  running: boolean;
  /** ISO 8601 timestamp of the last successful ingest */
  lastIngestAt: string | null;
  /** Number of records stored in the last ingest, by category */
  lastIngestCounts: Record<string, number>;
  /** Total number of successful ingests since server start */
  totalIngests: number;
  /** Total number of failed ingest attempts since server start */
  totalErrors: number;
}

// ---------------------------------------------------------------------------
// IngestServer class
// ---------------------------------------------------------------------------

/**
 * HTTP server that accepts health data from the AthletiqX iOS app,
 * validates it against the HealthSnapshot Zod schema, normalizes it
 * into WellnessMCP's format, and persists it via the StorageManager.
 *
 * Designed to be started/stopped by the AppleHealthProvider.
 */
export class IngestServer {
  private server: http.Server | null = null;
  private storage: StorageManager;
  private privacy: PrivacyLayer;
  private port: number;
  private apiKey: string | null;

  /** The chat service handles question -> context -> LLM -> response */
  private chatService: ChatService;

  /**
   * In-memory store for user API keys, keyed by user_id.
   * This allows the iOS app to store the key once and omit it from
   * subsequent /chat requests. Keys are lost on server restart.
   */
  private storedApiKeys: Map<string, string> = new Map();

  /** Tracks status information for the /status endpoint */
  private status: IngestStatus = {
    running: false,
    lastIngestAt: null,
    lastIngestCounts: {},
    totalIngests: 0,
    totalErrors: 0,
  };

  /**
   * Creates a new IngestServer instance.
   *
   * @param storage - The StorageManager instance for persisting normalized data
   * @param privacy - The PrivacyLayer instance for consent/redaction/aggregation
   * @param port - Port to listen on (defaults to WELLNESS_MCP_INGEST_PORT env var or 3456)
   * @param apiKey - Optional API key for authenticating requests (defaults to WELLNESS_MCP_INGEST_KEY env var)
   */
  constructor(storage: StorageManager, privacy: PrivacyLayer, port?: number, apiKey?: string) {
    this.storage = storage;
    this.privacy = privacy;
    this.port = port ?? parseInt(process.env.WELLNESS_MCP_INGEST_PORT ?? String(DEFAULT_PORT), 10);
    this.apiKey = apiKey ?? process.env.WELLNESS_MCP_INGEST_KEY ?? null;

    // Initialize the chat service pipeline:
    //   HealthContextBuilder (queries SQLite + applies privacy filtering)
    //   -> ChatService (constructs prompt + calls Claude API)
    const contextBuilder = new HealthContextBuilder(storage, privacy);
    this.chatService = new ChatService(contextBuilder);
  }

  /**
   * Starts the HTTP ingest server.
   *
   * The server handles two routes:
   *   - POST /ingest/health       — Accepts HealthSnapshot JSON
   *   - GET  /ingest/health/status — Returns server status
   *
   * All other routes receive a 404 response.
   *
   * @returns A promise that resolves once the server is listening
   * @throws If the server is already running or the port is in use
   */
  start(): Promise<void> {
    if (this.server) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      // Handle server-level errors (e.g., EADDRINUSE)
      this.server.on("error", (err) => {
        reject(err);
      });

      this.server.listen(this.port, () => {
        this.status.running = true;
        // Log to stderr so it doesn't interfere with MCP stdio on stdout
        console.error(`[IngestServer] Listening on port ${this.port}`);
        if (this.apiKey) {
          console.error(`[IngestServer] API key authentication is enabled`);
        } else {
          console.error(`[IngestServer] WARNING: No API key configured (set WELLNESS_MCP_INGEST_KEY)`);
        }
        resolve();
      });
    });
  }

  /**
   * Stops the HTTP ingest server gracefully.
   *
   * @returns A promise that resolves once the server has closed
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close(() => {
        this.server = null;
        this.status.running = false;
        console.error("[IngestServer] Server stopped");
        resolve();
      });
    });
  }

  /**
   * Returns whether the server is currently running.
   */
  isRunning(): boolean {
    return this.status.running;
  }

  /**
   * Returns the current port the server is configured to use.
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Returns a snapshot of the current ingest status for the /status endpoint
   * and for the AppleHealthProvider's sync() method.
   */
  getStatus(): IngestStatus {
    return { ...this.status };
  }

  // -------------------------------------------------------------------------
  // Request handling
  // -------------------------------------------------------------------------

  /**
   * Main request router. Dispatches to the appropriate handler based on
   * the HTTP method and URL path.
   *
   * Also sets CORS headers on every response to allow the iOS app to
   * communicate from the local network.
   */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Set CORS headers for local network access.
    // The iOS app may send requests from a different origin on the local network.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");

    // Handle CORS preflight requests
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? "";

    // Route: POST /ingest/health — receive health data
    if (req.method === "POST" && url === "/ingest/health") {
      this.handleIngest(req, res);
      return;
    }

    // Route: GET /ingest/health/status — check server status
    if (req.method === "GET" && url === "/ingest/health/status") {
      this.handleStatus(req, res);
      return;
    }

    // Route: POST /chat — process a health question through the LLM
    if (req.method === "POST" && url === "/chat") {
      this.handleChat(req, res);
      return;
    }

    // Route: POST /chat/api-key — store an Anthropic API key server-side
    if (req.method === "POST" && url === "/chat/api-key") {
      this.handleStoreApiKey(req, res);
      return;
    }

    // Route: GET /chat/models — list available Claude models
    if (req.method === "GET" && url === "/chat/models") {
      this.handleListModels(req, res);
      return;
    }

    // All other routes: 404
    this.sendJson(res, 404, { error: "Not found", path: url });
  }

  /**
   * Handles POST /ingest/health requests.
   *
   * Processing pipeline:
   *   1. Authenticate (if API key is configured)
   *   2. Read and parse the JSON body (with size limit)
   *   3. Validate against the HealthSnapshot Zod schema
   *   4. Normalize all data categories
   *   5. Persist to SQLite via StorageManager
   *   6. Return a summary of what was stored
   */
  private handleIngest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Step 1: Check API key authentication
    if (!this.authenticateRequest(req)) {
      this.sendJson(res, 401, {
        error: "Unauthorized",
        message: "Missing or invalid API key. Set the X-API-Key header or Authorization: Bearer <key>.",
      });
      return;
    }

    // Step 2: Read the request body with size limit enforcement
    this.readBody(req)
      .then((body) => {
        // Step 3: Parse JSON
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          this.status.totalErrors++;
          this.sendJson(res, 400, {
            error: "Invalid JSON",
            message: "Request body is not valid JSON.",
          });
          return;
        }

        // Step 4: Validate against the HealthSnapshot Zod schema
        const validation = HealthSnapshotSchema.safeParse(parsed);
        if (!validation.success) {
          this.status.totalErrors++;
          // Return Zod's structured error messages to help debug the iOS payload
          this.sendJson(res, 422, {
            error: "Validation failed",
            message: "The payload does not match the expected HealthSnapshot format.",
            details: validation.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          });
          return;
        }

        // Step 5: Normalize and store
        const snapshot = validation.data;
        const counts = this.processSnapshot(snapshot);

        // Step 6: Update status and respond
        this.status.lastIngestAt = new Date().toISOString();
        this.status.lastIngestCounts = counts;
        this.status.totalIngests++;

        this.sendJson(res, 200, {
          success: true,
          message: "Health data ingested successfully.",
          fetched_at: snapshot.fetched_at,
          records_stored: counts,
          total_records: Object.values(counts).reduce((a, b) => a + b, 0),
        });
      })
      .catch((err) => {
        this.status.totalErrors++;
        if (err instanceof Error && err.message === "BODY_TOO_LARGE") {
          this.sendJson(res, 413, {
            error: "Payload too large",
            message: `Request body exceeds the ${MAX_BODY_SIZE / 1024 / 1024}MB limit.`,
          });
        } else {
          this.sendJson(res, 500, {
            error: "Internal server error",
            message: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });
  }

  /**
   * Handles GET /ingest/health/status requests.
   *
   * Returns the current server status, last ingest time, record counts,
   * and overall data inventory from the storage layer.
   */
  private handleStatus(_req: http.IncomingMessage, res: http.ServerResponse): void {
    // Get data inventory from storage for a complete picture
    const inventory = this.storage.getDataInventory();
    const device = this.storage.getDevice("apple_health");

    this.sendJson(res, 200, {
      status: "ok",
      provider: "apple_health",
      server: {
        running: this.status.running,
        port: this.port,
        api_key_configured: this.apiKey !== null,
      },
      last_ingest: {
        at: this.status.lastIngestAt,
        records: this.status.lastIngestCounts,
      },
      totals: {
        successful_ingests: this.status.totalIngests,
        failed_ingests: this.status.totalErrors,
      },
      device: device
        ? {
            last_sync: device.last_sync,
            status: device.status,
          }
        : null,
      data_inventory: inventory,
    });
  }

  // -------------------------------------------------------------------------
  // Chat endpoint handlers
  // -------------------------------------------------------------------------

  /**
   * Zod schema for validating POST /chat request bodies.
   * - message: Required question from the user
   * - api_key: Anthropic API key (optional if previously stored via /chat/api-key)
   * - user_id: Used to look up a stored API key (optional)
   * - model: Override the default Claude model (optional)
   * - days: Override the health context time window (optional)
   */
  private static ChatRequestSchema = z.object({
    message: z.string().min(1, "Message is required").max(10000, "Message too long (max 10,000 chars)"),
    api_key: z.string().optional(),
    user_id: z.string().optional(),
    model: z.string().optional(),
    days: z.number().int().min(1).max(365).optional(),
  });

  /**
   * Zod schema for validating POST /chat/api-key request bodies.
   * - api_key: The Anthropic API key to store
   * - user_id: Identifier for the user (defaults to "default")
   */
  private static StoreApiKeySchema = z.object({
    api_key: z.string().min(1, "API key is required"),
    user_id: z.string().optional(),
  });

  /**
   * Handles POST /chat requests.
   *
   * Processing pipeline:
   *   1. Authenticate request (if ingest API key is configured)
   *   2. Parse and validate JSON body with Zod
   *   3. Resolve the Anthropic API key (from request body or stored keys)
   *   4. Call ChatService.chat() which builds context, calls Claude, returns response
   *   5. Return the AI response to the client
   *
   * Error mapping:
   *   - 400: Invalid JSON or missing required fields
   *   - 401: Missing/invalid ingest API key OR invalid Anthropic API key
   *   - 422: Zod validation failure (detailed field errors)
   *   - 429: Anthropic API rate limit exceeded
   *   - 500: Unexpected server error
   */
  private handleChat(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Step 1: Authenticate the request against the ingest API key.
    // This protects the endpoint itself. The user's Anthropic API key is
    // separate and only used for the Claude API call.
    if (!this.authenticateRequest(req)) {
      this.sendJson(res, 401, {
        error: "Unauthorized",
        message: "Missing or invalid API key. Set the X-API-Key header or Authorization: Bearer <key>.",
      });
      return;
    }

    // Step 2: Read and parse the request body
    this.readBody(req)
      .then(async (body) => {
        // Parse JSON
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          this.sendJson(res, 400, {
            error: "Invalid JSON",
            message: "Request body is not valid JSON.",
          });
          return;
        }

        // Validate with Zod
        const validation = IngestServer.ChatRequestSchema.safeParse(parsed);
        if (!validation.success) {
          this.sendJson(res, 422, {
            error: "Validation failed",
            message: "The request does not match the expected format.",
            details: validation.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          });
          return;
        }

        const { message, api_key, user_id, model, days } = validation.data;

        // Step 3: Resolve the Anthropic API key.
        // Priority: request body > stored key > environment variable
        const resolvedApiKey =
          api_key ??
          (user_id ? this.storedApiKeys.get(user_id) : undefined) ??
          this.storedApiKeys.get("default") ??
          process.env.ANTHROPIC_API_KEY;

        if (!resolvedApiKey) {
          this.sendJson(res, 400, {
            error: "Missing API key",
            message:
              "No Anthropic API key provided. Either include 'api_key' in the request body, " +
              "store one via POST /chat/api-key, or set the ANTHROPIC_API_KEY environment variable.",
          });
          return;
        }

        // Step 4: Call the chat service
        try {
          const options: ChatOptions = {};
          if (model) options.model = model;
          if (days) options.days = days;

          const result = await this.chatService.chat(message, resolvedApiKey, options);

          // Step 5: Return the response
          this.sendJson(res, 200, {
            response: result.response,
            model: result.model,
            context_days: result.contextDays,
          });
        } catch (err: unknown) {
          // Map ChatService errors to HTTP status codes
          const errMsg = err instanceof Error ? err.message : String(err);

          if (errMsg.includes("Invalid Anthropic API key")) {
            this.sendJson(res, 401, {
              error: "Invalid Anthropic API key",
              message: errMsg,
            });
          } else if (errMsg.includes("rate limit")) {
            this.sendJson(res, 429, {
              error: "Rate limited",
              message: errMsg,
            });
          } else {
            console.error("[IngestServer] Chat error:", errMsg);
            this.sendJson(res, 500, {
              error: "Chat failed",
              message: errMsg,
            });
          }
        }
      })
      .catch((err) => {
        if (err instanceof Error && err.message === "BODY_TOO_LARGE") {
          this.sendJson(res, 413, {
            error: "Payload too large",
            message: `Request body exceeds the ${MAX_BODY_SIZE / 1024 / 1024}MB limit.`,
          });
        } else {
          this.sendJson(res, 500, {
            error: "Internal server error",
            message: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });
  }

  /**
   * Handles POST /chat/api-key requests.
   *
   * Stores an Anthropic API key in memory so subsequent /chat requests
   * can omit it. Keys are stored in a simple Map keyed by user_id.
   *
   * This is a convenience feature for the iOS app — it can store the key
   * once after the user enters it, then all future chat requests automatically
   * use the stored key.
   *
   * NOTE: Keys are stored in memory only and are lost on server restart.
   * For persistent storage, the iOS app should store the key in its own
   * Keychain and send it with each request.
   */
  private handleStoreApiKey(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Authenticate against the ingest API key
    if (!this.authenticateRequest(req)) {
      this.sendJson(res, 401, {
        error: "Unauthorized",
        message: "Missing or invalid API key. Set the X-API-Key header or Authorization: Bearer <key>.",
      });
      return;
    }

    this.readBody(req)
      .then((body) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          this.sendJson(res, 400, {
            error: "Invalid JSON",
            message: "Request body is not valid JSON.",
          });
          return;
        }

        const validation = IngestServer.StoreApiKeySchema.safeParse(parsed);
        if (!validation.success) {
          this.sendJson(res, 422, {
            error: "Validation failed",
            message: "The request does not match the expected format.",
            details: validation.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          });
          return;
        }

        const { api_key, user_id } = validation.data;
        const effectiveUserId = user_id ?? "default";

        // Store the key in the in-memory map
        this.storedApiKeys.set(effectiveUserId, api_key);

        console.error(`[IngestServer] Stored API key for user: ${effectiveUserId}`);

        this.sendJson(res, 200, {
          success: true,
          message: "API key stored successfully. It will be used for subsequent /chat requests.",
          user_id: effectiveUserId,
        });
      })
      .catch((err) => {
        if (err instanceof Error && err.message === "BODY_TOO_LARGE") {
          this.sendJson(res, 413, {
            error: "Payload too large",
            message: `Request body exceeds the ${MAX_BODY_SIZE / 1024 / 1024}MB limit.`,
          });
        } else {
          this.sendJson(res, 500, {
            error: "Internal server error",
            message: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });
  }

  /**
   * Handles GET /chat/models requests.
   *
   * Returns the list of supported Claude models with their descriptions.
   * No authentication required — this is public information.
   */
  private handleListModels(_req: http.IncomingMessage, res: http.ServerResponse): void {
    this.sendJson(res, 200, {
      models: SUPPORTED_MODELS,
      default: "claude-sonnet-4-20250514",
    });
  }

  // -------------------------------------------------------------------------
  // Data processing
  // -------------------------------------------------------------------------

  /**
   * Processes a validated HealthSnapshot by normalizing all data categories
   * and persisting them to SQLite via the StorageManager.
   *
   * Each category is processed independently — a failure in one category
   * does not prevent others from being stored.
   *
   * @param snapshot - A validated HealthSnapshot from the Zod schema
   * @returns An object mapping category names to the number of records stored
   */
  private processSnapshot(snapshot: HealthSnapshot): Record<string, number> {
    const counts: Record<string, number> = {};

    // --- Sleep ---
    const sleepRecords = normalizeSleep(snapshot.sleep.sessions);
    for (const record of sleepRecords) {
      this.storage.upsertSleep(record);
    }
    counts.sleep = sleepRecords.length;

    // --- Activity (daily summaries + individual workouts) ---
    const activityRecords = normalizeActivity(
      snapshot.activity,
      snapshot.cardio_fitness,
    );
    for (const record of activityRecords) {
      this.storage.upsertActivity(record);
    }
    counts.activity = activityRecords.length;

    // --- Vitals (HRV, resting HR, SpO2) ---
    const vitalRecords = normalizeVitals(snapshot.vitals);
    for (const record of vitalRecords) {
      this.storage.upsertVital(record);
    }
    counts.vitals = vitalRecords.length;

    // --- Body Composition ---
    const bodyRecords = normalizeBodyComposition(snapshot.body_composition);
    for (const record of bodyRecords) {
      this.storage.upsertBodyComposition(record);
    }
    counts.body_composition = bodyRecords.length;

    // Update the device's last sync timestamp so MCP tools can report it
    this.storage.updateDeviceSync("apple_health");

    return counts;
  }

  // -------------------------------------------------------------------------
  // Utility methods
  // -------------------------------------------------------------------------

  /**
   * Checks whether the incoming request is authenticated.
   *
   * If no API key is configured (WELLNESS_MCP_INGEST_KEY not set), all
   * requests are allowed. This is intentional for local-only development
   * setups where security is handled at the network level.
   *
   * When an API key is configured, the request must include it as either:
   *   - `X-API-Key: <key>` header
   *   - `Authorization: Bearer <key>` header
   *
   * @param req - The incoming HTTP request
   * @returns true if the request is authenticated (or no key is required)
   */
  private authenticateRequest(req: http.IncomingMessage): boolean {
    // If no API key is configured, allow all requests
    if (!this.apiKey) {
      return true;
    }

    // Check X-API-Key header
    const apiKeyHeader = req.headers["x-api-key"];
    if (apiKeyHeader === this.apiKey) {
      return true;
    }

    // Check Authorization: Bearer <key> header
    const authHeader = req.headers["authorization"];
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7); // Remove "Bearer " prefix
      if (token === this.apiKey) {
        return true;
      }
    }

    return false;
  }

  /**
   * Reads the full request body as a string, enforcing a maximum size limit.
   *
   * Accumulates chunks from the readable stream until the "end" event.
   * If the accumulated size exceeds MAX_BODY_SIZE, the request is destroyed
   * and the promise rejects with a BODY_TOO_LARGE error.
   *
   * @param req - The incoming HTTP request stream
   * @returns A promise that resolves with the body string
   * @throws Error with message "BODY_TOO_LARGE" if the body exceeds the limit
   */
  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;

      req.on("data", (chunk: Buffer) => {
        totalSize += chunk.length;

        // Enforce size limit to prevent memory exhaustion
        if (totalSize > MAX_BODY_SIZE) {
          req.destroy();
          reject(new Error("BODY_TOO_LARGE"));
          return;
        }

        chunks.push(chunk);
      });

      req.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf-8"));
      });

      req.on("error", (err) => {
        reject(err);
      });
    });
  }

  /**
   * Sends a JSON response with the given status code and body.
   *
   * Sets the Content-Type header to application/json and serializes
   * the body with 2-space indentation for readability.
   *
   * @param res - The HTTP response object
   * @param statusCode - HTTP status code (e.g., 200, 400, 401)
   * @param body - Object to serialize as JSON
   */
  private sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
    const json = JSON.stringify(body, null, 2);
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json),
    });
    res.end(json);
  }
}
