import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod/v4";

/**
 * LLMProvider — the only place the agent talks to a model.
 *
 * The agent logic depends on two capabilities, not on a model name:
 *   - `agentTurn`  : the "brain" — reasoning + tool calling + streaming (main model, default claude-haiku-5-5)
 *   - `lightTask`  : cheap structured jobs — intent classification, preference extraction, summaries
 *                    (light model, e.g. claude-haiku-5-5)
 * Changing models (or the effort level, or moving the main role to an Opus model) is a config change
 * in config.llm, not a code change in the agent loop.
 *
 * Message history stays in the Claude Messages format on purpose: assistant turns carry thinking blocks
 * that must be sent back unchanged, so a lossy "provider-neutral" message format would break them.
 */
export type Message = Anthropic.Beta.Messages.BetaMessageParam;
export type ContentBlock = Anthropic.Beta.Messages.BetaContentBlock;
export type ToolDefinition = Anthropic.Messages.Tool;

export interface TurnUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface AgentTurnRequest {
  system: string;
  tools: ToolDefinition[];
  messages: Message[];
  /** Called with each visible text delta as it streams. */
  onText: (delta: string) => void;
  signal?: AbortSignal;
}

export interface AgentTurnResult {
  content: ContentBlock[];
  stopReason: string | null;
  requestId: string;
  usage: TurnUsage;
  /** Readable summaries of the model's reasoning / progress notes (for the audit log, not for the customer). */
  thinkingSummaries: string[];
  latencyMs: number;
}

export interface LightTaskRequest<S extends z.ZodTypeAny> {
  task: "intent" | "preference_extraction" | "summarize_conversation" | "summarize_reviews";
  system: string;
  input: string;
  schema: S;
  maxTokens?: number;
}

export interface LightTaskResult<T> {
  output: T;
  usage: TurnUsage;
}

export interface LLMProvider {
  agentTurn(req: AgentTurnRequest): Promise<AgentTurnResult>;
  lightTask<S extends z.ZodTypeAny>(req: LightTaskRequest<S>): Promise<LightTaskResult<z.infer<S>>>;
}

/** Raised when the model service is unavailable after retries; the agent shows a polite fallback message. */
export class LLMUnavailableError extends Error {
  constructor(
    public reason: "overloaded" | "rate_limited" | "timeout" | "network" | "server_error" | "partial_stream",
    cause?: unknown,
  ) {
    super(`LLM unavailable: ${reason}`, { cause });
  }
}

/** Raised when the provider rejects our credentials or configuration (401/403/404) — not retryable, needs an operator. */
export class LLMConfigError extends Error {
  constructor(
    public reason: "invalid_api_key" | "permission_denied" | "model_not_found",
    cause?: unknown,
  ) {
    super(`LLM configuration error: ${reason}`, { cause });
  }
}

/** Raised for model-side refusals (stop_reason "refusal" after any fallback). */
export class LLMRefusalError extends Error {
  constructor(public category: string | null) {
    super(`LLM refusal: ${category ?? "unknown"}`);
  }
}
