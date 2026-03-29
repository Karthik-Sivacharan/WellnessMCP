/**
 * @module chat/service
 *
 * Chat Service — provider-agnostic LLM proxy.
 *
 * Supports multiple LLM providers and custom endpoints:
 *   - "anthropic" — Claude API via @anthropic-ai/sdk
 *   - "openai"    — OpenAI-compatible APIs (OpenAI, Azure, local models)
 *   - "custom"    — Any HTTP endpoint that accepts a JSON POST
 *
 * The service builds a system prompt from health context + optional custom
 * instructions, sends it to the chosen provider, and returns the response.
 *
 * Fully stateless — no constructor dependencies, no cached clients.
 */

import Anthropic from "@anthropic-ai/sdk";
import https from "node:https";
import http from "node:http";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported LLM provider identifiers */
export type LLMProvider = "anthropic" | "openai" | "custom";

/** All supported providers with descriptions */
export const SUPPORTED_PROVIDERS: { id: LLMProvider; name: string; description: string }[] = [
  { id: "anthropic", name: "Anthropic (Claude)", description: "Claude models — default provider" },
  { id: "openai", name: "OpenAI-compatible", description: "OpenAI, Azure OpenAI, or any OpenAI-compatible API" },
  { id: "custom", name: "Custom endpoint", description: "Any HTTP endpoint that accepts JSON POST" },
];

/** Built-in Claude models */
export const SUPPORTED_MODELS = [
  { id: "claude-opus-4-20250514", name: "Claude Opus 4", provider: "anthropic", description: "Most capable, best for complex health analysis" },
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic", description: "Balanced speed and capability (default)" },
  { id: "claude-haiku-3-5-20241022", name: "Claude Haiku 3.5", provider: "anthropic", description: "Fastest, best for simple questions" },
  { id: "gpt-4o", name: "GPT-4o", provider: "openai", description: "OpenAI GPT-4o (requires OpenAI-compatible endpoint)" },
  { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai", description: "OpenAI GPT-4o Mini (fast and cheap)" },
] as const;

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_PROVIDER: LLMProvider = "anthropic";
const MAX_TOKENS = 2048;

/** Options for customizing the chat request. */
export interface ChatOptions {
  /** LLM provider: "anthropic", "openai", or "custom" (default: "anthropic") */
  provider?: LLMProvider;
  /** Model identifier (provider-specific, e.g., "claude-sonnet-4-20250514" or "gpt-4o") */
  model?: string;
  /** Custom instructions to prepend to the system prompt (e.g., "Act as a sports coach") */
  instructions?: string;
  /**
   * Custom endpoint URL for "openai" or "custom" providers.
   * For "openai": the base URL (e.g., "https://api.openai.com/v1" or your Azure endpoint)
   * For "custom": the full URL to POST to
   */
  endpoint?: string;
}

/** Structured response from a chat request. */
export interface ChatResponse {
  /** The AI-generated response text */
  response: string;
  /** The model that generated the response */
  model: string;
  /** Which provider was used */
  provider: LLMProvider;
}

// ---------------------------------------------------------------------------
// ChatService
// ---------------------------------------------------------------------------

/**
 * Provider-agnostic chat service that routes health questions to any LLM.
 *
 * Usage:
 * ```ts
 * const service = new ChatService();
 *
 * // Anthropic (default)
 * const result = await service.chat("How's my sleep?", context, "sk-ant-...");
 *
 * // OpenAI
 * const result = await service.chat("How's my sleep?", context, "sk-...", {
 *   provider: "openai",
 *   model: "gpt-4o",
 *   endpoint: "https://api.openai.com/v1"
 * });
 *
 * // Custom endpoint (your own server)
 * const result = await service.chat("How's my sleep?", context, "any-key", {
 *   provider: "custom",
 *   endpoint: "https://your-server.com/api/analyze"
 * });
 * ```
 */
export class ChatService {
  /**
   * Processes a user question with pre-built health context.
   *
   * Routes to the appropriate provider based on options.provider:
   *   - "anthropic": Calls Claude API via @anthropic-ai/sdk
   *   - "openai": Calls OpenAI-compatible chat completions API
   *   - "custom": POSTs { message, health_context, instructions } to a custom URL
   *
   * @param message - The user's question
   * @param healthContext - Pre-built health context string
   * @param apiKey - API key for the chosen provider
   * @param options - Provider, model, instructions, and endpoint overrides
   */
  async chat(
    message: string,
    healthContext: string,
    apiKey: string,
    options?: ChatOptions,
  ): Promise<ChatResponse> {
    const provider = options?.provider ?? DEFAULT_PROVIDER;
    const systemPrompt = this.buildSystemPrompt(healthContext, options?.instructions);

    switch (provider) {
      case "anthropic":
        return this.callAnthropic(message, systemPrompt, apiKey, options?.model);
      case "openai":
        return this.callOpenAI(message, systemPrompt, apiKey, options?.model, options?.endpoint);
      case "custom":
        return this.callCustom(message, systemPrompt, healthContext, apiKey, options?.endpoint, options?.instructions);
      default:
        throw new Error(`Unsupported provider: ${provider}. Use "anthropic", "openai", or "custom".`);
    }
  }

  // -------------------------------------------------------------------------
  // Provider implementations
  // -------------------------------------------------------------------------

  /**
   * Calls Anthropic's Claude API.
   */
  private async callAnthropic(
    message: string,
    systemPrompt: string,
    apiKey: string,
    model?: string,
  ): Promise<ChatResponse> {
    const resolvedModel = model ?? DEFAULT_MODEL;
    const client = new Anthropic({ apiKey });

    try {
      const response = await client.messages.create({
        model: resolvedModel,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: "user", content: message }],
      });

      const responseText = response.content
        .filter((block) => block.type === "text")
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n");

      return { response: responseText, model: response.model, provider: "anthropic" };
    } catch (err: unknown) {
      if (err instanceof Anthropic.AuthenticationError) {
        throw new Error("Invalid API key. Please check your Anthropic API key.");
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new Error("Rate limit exceeded. Please wait and try again.");
      }
      if (err instanceof Anthropic.APIError) {
        throw new Error(`Anthropic API error (${err.status}): ${err.message}`);
      }
      throw err;
    }
  }

  /**
   * Calls an OpenAI-compatible chat completions API.
   *
   * Works with OpenAI, Azure OpenAI, Ollama, LM Studio, vLLM, or any
   * endpoint that implements the /chat/completions spec.
   */
  private async callOpenAI(
    message: string,
    systemPrompt: string,
    apiKey: string,
    model?: string,
    endpoint?: string,
  ): Promise<ChatResponse> {
    const resolvedModel = model ?? "gpt-4o";
    const baseURL = endpoint ?? "https://api.openai.com/v1";
    const url = `${baseURL}/chat/completions`;

    const body = JSON.stringify({
      model: resolvedModel,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
    });

    const responseData = await this.httpPost(url, body, {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    });

    const parsed = JSON.parse(responseData);

    if (parsed.error) {
      const errMsg = parsed.error.message ?? parsed.error;
      if (typeof errMsg === "string" && errMsg.toLowerCase().includes("auth")) {
        throw new Error("Invalid API key. Please check your OpenAI API key.");
      }
      throw new Error(`OpenAI API error: ${errMsg}`);
    }

    const responseText = parsed.choices?.[0]?.message?.content ?? "";
    const usedModel = parsed.model ?? resolvedModel;

    return { response: responseText, model: usedModel, provider: "openai" };
  }

  /**
   * Calls a custom HTTP endpoint.
   *
   * Sends the full context as a JSON POST and expects a JSON response
   * with a `response` field. This lets you route health queries to your
   * own backend, ML models, or any custom service.
   *
   * Request format sent to the custom endpoint:
   * ```json
   * {
   *   "message": "How's my sleep?",
   *   "health_context": "=== HEALTH DATA CONTEXT ...",
   *   "system_prompt": "You are a health assistant...",
   *   "instructions": "Act as a sports coach"
   * }
   * ```
   *
   * Expected response format:
   * ```json
   * {
   *   "response": "Your sleep was...",
   *   "model": "my-custom-model"
   * }
   * ```
   */
  private async callCustom(
    message: string,
    systemPrompt: string,
    healthContext: string,
    apiKey: string,
    endpoint?: string,
    instructions?: string,
  ): Promise<ChatResponse> {
    if (!endpoint) {
      throw new Error('Custom provider requires an "endpoint" URL. Specify where to send the request.');
    }

    const body = JSON.stringify({
      message,
      health_context: healthContext,
      system_prompt: systemPrompt,
      instructions: instructions ?? null,
    });

    const responseData = await this.httpPost(endpoint, body, {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    });

    const parsed = JSON.parse(responseData);
    const responseText = parsed.response ?? parsed.text ?? parsed.output ?? parsed.result ?? "";
    const usedModel = parsed.model ?? "custom";

    return { response: responseText, model: usedModel, provider: "custom" };
  }

  // -------------------------------------------------------------------------
  // System prompt construction
  // -------------------------------------------------------------------------

  /**
   * Builds the system prompt with health context and optional custom instructions.
   *
   * Structure:
   *   1. Custom instructions (if provided) — e.g., "Act as a sports coach"
   *   2. Default role identity — health assistant
   *   3. Health data context — formatted from HealthContextBuilder
   *   4. Behavioral guidelines — reference data, be specific
   *   5. Medical disclaimer — don't diagnose
   */
  private buildSystemPrompt(healthContext: string, instructions?: string): string {
    const parts: string[] = [];

    // Custom instructions from the iOS app (e.g., "Act as a sports performance coach",
    // "Give brief 2-sentence answers", "Generate a morning briefing")
    if (instructions) {
      parts.push(`CUSTOM INSTRUCTIONS:\n${instructions}`);
    }

    parts.push(
      `You are a knowledgeable health assistant with access to the user's Apple Health data. Your role is to help them understand their health trends, answer questions about their data, and provide actionable wellness insights.`
    );

    parts.push(healthContext);

    parts.push(
      `GUIDELINES:
- Reference specific data values from the context above when answering. Say "Your average sleep was 7.2 hours" rather than generic statements.
- Identify meaningful trends and patterns across categories.
- Be concise but thorough. Provide context for why a metric matters.
- If the data shows concerning trends, mention them proactively but gently.
- When data is missing or limited, acknowledge it and work with what's available.
- Use plain language — avoid jargon unless the user seems technically inclined.
- Format responses with clear structure when covering multiple topics.

IMPORTANT MEDICAL DISCLAIMER:
- You are NOT a doctor. Do not provide medical diagnoses or treatment recommendations.
- For concerning health values, recommend consulting a healthcare professional.
- Frame insights as observations and general wellness guidance, not medical advice.
- Never tell the user to stop taking medication or change prescribed treatments.`
    );

    return parts.join("\n\n");
  }

  // -------------------------------------------------------------------------
  // HTTP helper
  // -------------------------------------------------------------------------

  /**
   * Makes an HTTP/HTTPS POST request and returns the response body.
   * Used for OpenAI-compatible and custom endpoints.
   */
  private httpPost(url: string, body: string, headers: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const transport = parsedUrl.protocol === "https:" ? https : http;

      const req = transport.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: parsedUrl.pathname + parsedUrl.search,
          method: "POST",
          headers: {
            ...headers,
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        },
      );

      req.on("error", (err) => reject(new Error(`Network error: ${err.message}`)));
      req.write(body);
      req.end();
    });
  }
}
