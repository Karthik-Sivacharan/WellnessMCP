/**
 * @module chat/service
 *
 * Chat Service — orchestrates the flow from user question to AI response.
 *
 * Architecture (stateless):
 *   User question + pre-built health context + API key
 *     --> System prompt construction (health data + instructions)
 *       --> Claude API call (via @anthropic-ai/sdk)
 *         --> Response text returned to caller
 *
 * Key design decisions:
 *   - A new Anthropic client is created per request because different users
 *     have different API keys. We do not cache or pool clients.
 *   - The system prompt includes actual health data values so Claude can
 *     reference them specifically rather than giving generic advice.
 *   - A medical disclaimer is baked into the system prompt to prevent
 *     Claude from overstepping into diagnostic territory.
 *   - The health context is pre-built and passed in — this class does NOT
 *     query a database or build context itself.
 */

import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default Claude model to use for chat responses.
 * Claude Sonnet is chosen as the default for its balance of speed, cost,
 * and capability — fast enough for interactive chat, capable enough to
 * reason about health trends.
 */
const DEFAULT_MODEL = "claude-sonnet-4-20250514";

/**
 * List of supported Claude models that users can choose from.
 * Ordered from most capable (but slower/costlier) to fastest (but less capable).
 */
export const SUPPORTED_MODELS = [
  { id: "claude-opus-4-20250514", name: "Claude Opus 4", description: "Most capable, best for complex health analysis" },
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", description: "Balanced speed and capability (default)" },
  { id: "claude-haiku-3-5-20241022", name: "Claude Haiku 3.5", description: "Fastest, best for simple questions" },
] as const;

/**
 * Maximum tokens for the Claude response.
 * Health questions typically need moderate-length answers — enough to
 * explain trends and provide context, but not so long that it becomes
 * overwhelming.
 */
const MAX_TOKENS = 2048;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for customizing the chat request.
 */
export interface ChatOptions {
  /** Override the default Claude model */
  model?: string;
}

/**
 * Structured response from a chat request.
 */
export interface ChatResponse {
  /** The AI-generated response text */
  response: string;
  /** The Claude model that generated the response */
  model: string;
}

// ---------------------------------------------------------------------------
// ChatService
// ---------------------------------------------------------------------------

/**
 * Stateless chat service that processes user questions about their health data.
 *
 * This class has no constructor dependencies — it is a pure orchestrator
 * that takes a message, pre-built health context, and API key, then calls
 * the Claude API and returns the response.
 *
 * Usage:
 * ```ts
 * const service = new ChatService();
 * const result = await service.chat(
 *   "How has my sleep been this week?",
 *   healthContextString,
 *   "sk-ant-api03-...",
 *   { model: "claude-sonnet-4-20250514" }
 * );
 * console.log(result.response);
 * ```
 */
export class ChatService {
  /**
   * Processes a user question with pre-built health context.
   *
   * Flow:
   *   1. Construct system prompt with health data and behavioral instructions
   *   2. Call Claude API with the user's API key
   *   3. Return the response text along with metadata
   *
   * Error handling:
   *   - Invalid API key: throws with a message containing "Invalid Anthropic API key"
   *   - Rate limiting: throws with a message containing "rate limit"
   *   - Other API errors: re-thrown with descriptive messages
   *
   * @param message - The user's question about their health data
   * @param healthContext - Pre-built health context string (from HealthContextBuilder)
   * @param apiKey - The user's Anthropic API key (used to create a per-request client)
   * @param options - Optional overrides for model selection
   * @returns Structured ChatResponse with the AI answer and metadata
   * @throws Error if the API call fails (invalid key, rate limit, network error, etc.)
   */
  async chat(
    message: string,
    healthContext: string,
    apiKey: string,
    options?: ChatOptions,
  ): Promise<ChatResponse> {
    const model = options?.model ?? DEFAULT_MODEL;

    // Step 1: Construct the system prompt.
    // The prompt includes the health data context and behavioral instructions
    // for Claude. We keep it focused: reference actual data, be specific,
    // but don't diagnose.
    const systemPrompt = this.buildSystemPrompt(healthContext);

    // Step 2: Call the Claude API.
    // Create a new client per request — different users have different API keys,
    // so we cannot reuse a single client instance.
    const client = new Anthropic({ apiKey });

    try {
      const response = await client.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [
          { role: "user", content: message },
        ],
      });

      // Extract the text content from the response.
      // Claude's response is an array of content blocks — we join all text blocks.
      const responseText = response.content
        .filter((block) => block.type === "text")
        .map((block) => {
          if (block.type === "text") return block.text;
          return "";
        })
        .join("\n");

      return {
        response: responseText,
        model: response.model,
      };
    } catch (err: unknown) {
      // Re-throw with more descriptive error messages for common failure modes.
      // The caller (HTTP handler) maps these to appropriate HTTP status codes.
      if (err instanceof Anthropic.AuthenticationError) {
        throw new Error(
          "Invalid Anthropic API key. Please check your API key and try again."
        );
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new Error(
          "Anthropic API rate limit exceeded. Please wait a moment and try again."
        );
      }
      if (err instanceof Anthropic.APIError) {
        throw new Error(
          `Anthropic API error (${err.status}): ${err.message}`
        );
      }

      // Unknown error — re-throw as-is
      throw err;
    }
  }

  /**
   * Builds the system prompt that instructs Claude how to behave and provides
   * the health data context.
   *
   * The prompt structure:
   *   1. Role identity: health assistant with access to user's data
   *   2. Health data context: the formatted summary from HealthContextBuilder
   *   3. Behavioral instructions: be specific, reference data, provide insights
   *   4. Medical disclaimer: don't diagnose, recommend professional care
   *
   * @param healthContext - The formatted health data context string
   * @returns Complete system prompt string
   */
  private buildSystemPrompt(healthContext: string): string {
    return `You are a knowledgeable health assistant with access to the user's Apple Health data. Your role is to help them understand their health trends, answer questions about their data, and provide actionable wellness insights.

${healthContext}

INSTRUCTIONS:
- Reference specific data values from the context above when answering questions. For example, say "Your average sleep was 7.2 hours" rather than generic statements.
- Identify meaningful trends and patterns across categories (e.g., correlation between sleep quality and activity levels).
- Be concise but thorough. Provide context for why a metric matters.
- If the data shows concerning trends, mention them proactively but gently.
- When data is missing or limited, acknowledge it and work with what's available.
- Use plain language — avoid jargon unless the user seems technically inclined.
- Format responses with clear structure when covering multiple topics.

IMPORTANT MEDICAL DISCLAIMER:
- You are NOT a doctor. Do not provide medical diagnoses or treatment recommendations.
- For any concerning health values or symptoms, recommend consulting a healthcare professional.
- Frame insights as observations and general wellness guidance, not medical advice.
- Never tell the user to stop taking medication or change prescribed treatments.`;
  }
}
