import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod/v4";
import { config } from "../config.js";
import { costUsd } from "./pricing.js";
import {
  LLMConfigError,
  LLMRefusalError,
  LLMUnavailableError,
  type AgentTurnRequest,
  type AgentTurnResult,
  type LLMProvider,
  type LightTaskRequest,
  type LightTaskResult,
  type TurnUsage,
} from "./provider.js";

/**
 * Claude implementation of LLMProvider.
 * - API key: read by the SDK from ANTHROPIC_API_KEY (local .env / Azure Key Vault via Managed Identity in prod).
 *   Never hard-code it, never send it to the browser.
 * - Retries are done here (not by the SDK) so a stream is only retried if nothing reached the customer yet.
 */
const client = new Anthropic({ maxRetries: 0, timeout: config.llm.requestTimeoutMs });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SERVER_FALLBACK_MODELS = /^claude-(sonnet|opus)-/;

function classify(e: unknown): LLMUnavailableError["reason"] | null {
  if (e instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (e instanceof Anthropic.APIConnectionError) return "network";
  if (e instanceof Anthropic.RateLimitError) return "rate_limited";
  if (e instanceof Anthropic.InternalServerError) return e.status === 529 ? "overloaded" : "server_error";
  return null; // 400/401/403/404 etc. are bugs or config errors: do not retry
}

/** Exponential backoff with full jitter; honors retry-after when the API sends it. */
async function withRetry<T>(fn: (attempt: number) => Promise<T>, canRetry: () => boolean = () => true): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs } = config.llm.retry;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      const reason = classify(e);
      if (!reason) {
        if (e instanceof Anthropic.AuthenticationError) throw new LLMConfigError("invalid_api_key", e);
        if (e instanceof Anthropic.PermissionDeniedError) throw new LLMConfigError("permission_denied", e);
        if (e instanceof Anthropic.NotFoundError) throw new LLMConfigError("model_not_found", e);
        throw e;
      }
      if (attempt >= maxRetries || !canRetry()) throw new LLMUnavailableError(canRetry() ? reason : "partial_stream", e);
      const retryAfter = Number((e as { headers?: Headers }).headers?.get?.("retry-after"));
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) * Math.random();
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff);
    }
  }
}

function toUsage(model: string, u: Anthropic.Beta.Messages.BetaUsage | Anthropic.Messages.Usage): TurnUsage {
  return {
    model,
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    costUsd: costUsd(model, u),
  };
}

export class AnthropicProvider implements LLMProvider {
  async agentTurn(req: AgentTurnRequest): Promise<AgentTurnResult> {
    let streamedText = false;
    const started = Date.now();

    const message = await withRetry(
      async () => {
        const stream = client.beta.messages.stream(
          {
            model: config.llm.mainModel,
            max_tokens: config.llm.maxOutputTokens,
            // Prompt caching: tools + system are byte-stable and cached; top-level cache_control also caches
            // the growing conversation prefix turn after turn.
            system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
            tools: req.tools,
            messages: req.messages,
            cache_control: { type: "ephemeral" },
            // Adaptive thinking; "summarized" returns readable summaries (logged for audit, never shown to the customer).
            thinking: { type: "adaptive", display: "summarized" },
            output_config: { effort: config.llm.mainEffort },
            // Server-side fallback on a safety-classifier decline exists only for Sonnet/Opus-class models;
            // Haiku 5.5 has none, so refusals are handled below with a polite message.
            ...(SERVER_FALLBACK_MODELS.test(config.llm.mainModel)
              ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }
              : {}),
          } as Anthropic.Beta.Messages.MessageCreateParamsStreaming,
          { signal: req.signal },
        );
        stream.on("text", (delta) => {
          streamedText = true;
          req.onText(delta);
        });
        return stream.finalMessage();
      },
      // Once text reached the customer, a retry would duplicate it: fail and let the agent apologize instead.
      () => !streamedText,
    );

    if (message.stop_reason === "refusal") {
      throw new LLMRefusalError((message as { stop_details?: { category?: string } }).stop_details?.category ?? null);
    }

    const thinkingSummaries = message.content
      .filter((b): b is Anthropic.Beta.Messages.BetaThinkingBlock => b.type === "thinking")
      .map((b) => b.thinking)
      .filter(Boolean);

    return {
      content: message.content,
      stopReason: message.stop_reason,
      requestId: message.id,
      usage: toUsage(config.llm.mainModel, message.usage),
      thinkingSummaries,
      latencyMs: Date.now() - started,
    };
  }

  async lightTask<S extends z.ZodTypeAny>(req: LightTaskRequest<S>): Promise<LightTaskResult<z.infer<S>>> {
    const response = await withRetry(() =>
      client.messages.parse({
        model: config.llm.lightModel,
        // Thinking is on by default on Haiku 5.5 and counts toward max_tokens: leave room for it.
        max_tokens: req.maxTokens ?? 4000,
        system: req.system,
        messages: [{ role: "user", content: req.input }],
        output_config: { effort: "low", format: zodOutputFormat(req.schema) },
      }),
    );
    if (response.stop_reason === "refusal") throw new LLMRefusalError(null);
    if (response.parsed_output == null) throw new Error(`light task ${req.task}: no parsed output (${response.stop_reason})`);
    return { output: response.parsed_output as z.infer<S>, usage: toUsage(config.llm.lightModel, response.usage) };
  }
}

export const llm: LLMProvider = new AnthropicProvider();
