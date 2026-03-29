/**
 * @module ingest/server
 *
 * Stateless HTTP proxy server for the WellnessMCP health chat service.
 *
 * Provider-agnostic: routes requests to Anthropic (Claude), OpenAI, or any
 * custom HTTP endpoint. The iOS app chooses the provider per-request.
 *
 * Architecture:
 *   AthletiqX (iOS) --POST /chat--> WellnessServer
 *     1. Authenticate request (X-API-Key header)
 *     2. Validate payload (Zod: message + health_data + api_key + provider)
 *     3. Redact PII from health_data via PrivacyLayer
 *     4. Build health context text from redacted data (HealthContextBuilder)
 *     5. Route to chosen LLM provider (Anthropic / OpenAI / custom endpoint)
 *     6. Return AI response
 *
 * This server is completely stateless — no database, no storage. All health
 * data arrives inline with each request from the iOS app.
 *
 * Uses Node.js built-in `http` module — no Express dependency required.
 *
 * Configuration (environment variables):
 *   - WELLNESS_MCP_INGEST_PORT: Port to listen on (default: 3456)
 *   - WELLNESS_MCP_INGEST_KEY: Optional API key for authenticating requests
 *
 * Endpoints:
 *   - POST /chat         — Send health data + question, get AI response
 *   - GET  /chat/models  — List available Claude models
 *   - GET  /health       — Simple health check
 */

import http from "node:http";
import { z } from "zod";
import { HealthSnapshotSchema } from "./types.js";
import { PrivacyLayer } from "../privacy/index.js";
import { HealthContextBuilder } from "../chat/context.js";
import { ChatService, SUPPORTED_MODELS, SUPPORTED_PROVIDERS } from "../chat/service.js";
import type { ChatOptions, LLMProvider } from "../chat/service.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default port for the HTTP server */
const DEFAULT_PORT = 3456;

/** Maximum request body size in bytes (5 MB). Prevents memory exhaustion
 *  from oversized payloads, whether malicious or accidental. */
const MAX_BODY_SIZE = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Request validation schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for validating POST /chat request bodies.
 *
 * The iOS app sends:
 *   - message: The user's health question
 *   - health_data: The full HealthSnapshot (same format as the old /ingest/health payload)
 *   - api_key: The user's Anthropic API key for Claude
 *   - model: (optional) Override the default Claude model
 *   - days: (optional) Unused in stateless mode but kept for API compatibility
 */
/**
 * Zod schema for validating POST /chat request bodies.
 *
 * The iOS app sends health data + a question, and the server routes it
 * to the chosen LLM provider (Anthropic, OpenAI, or a custom endpoint).
 */
const ChatRequestSchema = z.object({
  /** The user's question about their health */
  message: z.string().min(1, "Message is required").max(10000, "Message too long (max 10,000 chars)"),

  /** Health data from the iOS app — the full HealthSnapshot */
  health_data: HealthSnapshotSchema,

  /** API key for the chosen LLM provider (Anthropic, OpenAI, or custom) */
  api_key: z.string().min(1, "API key is required"),

  /** LLM provider to use: "anthropic" (default), "openai", or "custom" */
  provider: z.enum(["anthropic", "openai", "custom"]).optional(),

  /** Model identifier — provider-specific (e.g., "claude-sonnet-4-20250514", "gpt-4o") */
  model: z.string().optional(),

  /**
   * Custom instructions to prepend to the system prompt.
   * Use this to control the LLM's behavior per-request:
   *   - "Act as a sports performance coach"
   *   - "Give a brief 2-sentence answer"
   *   - "Generate a morning health briefing"
   *   - "Compare this week vs last week"
   *   - "Focus on recovery and sleep quality"
   */
  instructions: z.string().max(5000).optional(),

  /**
   * Custom endpoint URL for "openai" or "custom" providers.
   * For "openai": the base URL (e.g., "https://api.openai.com/v1")
   * For "custom": the full URL to POST to (e.g., "https://your-server.com/api/analyze")
   */
  endpoint: z.string().url().optional(),
});

// ---------------------------------------------------------------------------
// WellnessServer class
// ---------------------------------------------------------------------------

/**
 * Stateless HTTP proxy server that accepts health data + questions from the
 * AthletiqX iOS app, applies PII redaction, builds a health context, calls
 * the Claude API, and returns the AI response.
 *
 * No database. No storage. All data arrives inline with each request.
 */
export class IngestServer {
  private server: http.Server | null = null;
  private privacy: PrivacyLayer;
  private port: number;
  private apiKey: string | null;

  /** Stateless chat service — calls Claude API */
  private chatService: ChatService;

  /** Stateless context builder — formats HealthSnapshot as text */
  private contextBuilder: HealthContextBuilder;

  /**
   * Creates a new WellnessServer instance.
   *
   * @param privacy - The PrivacyLayer instance for PII redaction
   * @param port - Port to listen on (defaults to WELLNESS_MCP_INGEST_PORT env var or 3456)
   * @param apiKey - Optional API key for authenticating requests (defaults to WELLNESS_MCP_INGEST_KEY env var)
   */
  constructor(privacy: PrivacyLayer, port?: number, apiKey?: string) {
    this.privacy = privacy;
    this.port = port ?? parseInt(process.env.WELLNESS_MCP_INGEST_PORT ?? String(DEFAULT_PORT), 10);
    this.apiKey = apiKey ?? process.env.WELLNESS_MCP_INGEST_KEY ?? null;

    // Both are stateless — no constructor dependencies
    this.chatService = new ChatService();
    this.contextBuilder = new HealthContextBuilder();
  }

  /**
   * Starts the HTTP server.
   *
   * The server handles three routes:
   *   - POST /chat         — Accept health data + question, return AI response
   *   - GET  /chat/models  — List available Claude models
   *   - GET  /health       — Simple health check
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
        // Log to stderr so it doesn't interfere with MCP stdio on stdout
        console.error(`[WellnessServer] Listening on port ${this.port}`);
        if (this.apiKey) {
          console.error(`[WellnessServer] API key authentication is enabled`);
        } else {
          console.error(`[WellnessServer] WARNING: No API key configured (set WELLNESS_MCP_INGEST_KEY)`);
        }
        resolve();
      });
    });
  }

  /**
   * Stops the HTTP server gracefully.
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
        console.error("[WellnessServer] Server stopped");
        resolve();
      });
    });
  }

  /**
   * Returns whether the server is currently running.
   */
  isRunning(): boolean {
    return this.server !== null;
  }

  /**
   * Returns the current port the server is configured to use.
   */
  getPort(): number {
    return this.port;
  }

  // -------------------------------------------------------------------------
  // Request handling
  // -------------------------------------------------------------------------

  /**
   * Main request router. Dispatches to the appropriate handler based on
   * the HTTP method and URL path.
   *
   * Also sets CORS headers on every response to allow the iOS app to
   * communicate from any origin.
   */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Set CORS headers for cross-origin access from the iOS app
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

    // Route: POST /chat — process a health question through the LLM
    if (req.method === "POST" && url === "/chat") {
      this.handleChat(req, res);
      return;
    }

    // Route: GET /chat/models — list available Claude models
    if (req.method === "GET" && url === "/chat/models") {
      this.handleListModels(req, res);
      return;
    }

    // Route: GET /health — simple health check
    if (req.method === "GET" && url === "/health") {
      this.sendJson(res, 200, { status: "ok" });
      return;
    }

    // All other routes: 404
    this.sendJson(res, 404, { error: "Not found", path: url });
  }

  // -------------------------------------------------------------------------
  // Chat endpoint handler
  // -------------------------------------------------------------------------

  /**
   * Handles POST /chat requests.
   *
   * Processing pipeline:
   *   1. Authenticate request (X-API-Key header, if configured)
   *   2. Parse + validate JSON body with Zod (message + health_data + api_key)
   *   3. Apply PII redaction to health_data via privacy.redact()
   *   4. Build health context text from the redacted HealthSnapshot
   *   5. Call ChatService.chat() with message + context + user's API key
   *   6. Return the AI response
   *
   * Error mapping:
   *   - 400: Invalid JSON or missing required fields
   *   - 401: Missing/invalid server API key OR invalid Anthropic API key
   *   - 413: Payload too large
   *   - 422: Zod validation failure (detailed field errors)
   *   - 429: Anthropic API rate limit exceeded
   *   - 500: Unexpected server error
   */
  private handleChat(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Step 1: Authenticate the request against the server's API key.
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
        const validation = ChatRequestSchema.safeParse(parsed);
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

        const { message, health_data, api_key, provider, model, instructions, endpoint } = validation.data;

        // Step 3: Apply PII redaction to the health data.
        // The PIIRedactor strips any personally identifiable information
        // (names, emails, GPS coords, etc.) before data reaches any LLM.
        const { data: redactedHealthData, fieldsRedacted } = this.privacy.redactor.redact(health_data);
        const wasRedacted = fieldsRedacted.length > 0;

        // Step 4: Build health context text from the redacted snapshot.
        // This formats the HealthSnapshot into a structured text summary
        // that gets injected into the LLM's system prompt.
        const healthContext = this.contextBuilder.buildContext(redactedHealthData);

        // Step 5: Call the chat service with the chosen provider
        try {
          const options: ChatOptions = {};
          if (provider) options.provider = provider as LLMProvider;
          if (model) options.model = model;
          if (instructions) options.instructions = instructions;
          if (endpoint) options.endpoint = endpoint;

          const result = await this.chatService.chat(
            message,
            healthContext,
            api_key,
            options,
          );

          // Step 6: Return the response
          this.sendJson(res, 200, {
            response: result.response,
            model: result.model,
            provider: result.provider,
            was_redacted: wasRedacted,
          });
        } catch (err: unknown) {
          // Map ChatService errors to HTTP status codes
          const errMsg = err instanceof Error ? err.message : String(err);

          if (errMsg.includes("Invalid API key") || errMsg.includes("auth")) {
            this.sendJson(res, 401, {
              error: "Invalid API key",
              message: errMsg,
            });
          } else if (errMsg.includes("rate limit") || errMsg.includes("Rate limit")) {
            this.sendJson(res, 429, {
              error: "Rate limited",
              message: errMsg,
            });
          } else {
            console.error("[WellnessServer] Chat error:", errMsg);
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
   * Handles GET /chat/models requests.
   *
   * Returns the list of supported Claude models with their descriptions.
   * No authentication required — this is public information.
   */
  private handleListModels(_req: http.IncomingMessage, res: http.ServerResponse): void {
    this.sendJson(res, 200, {
      providers: SUPPORTED_PROVIDERS,
      models: SUPPORTED_MODELS,
      default_provider: "anthropic",
      default_model: "claude-sonnet-4-20250514",
    });
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
