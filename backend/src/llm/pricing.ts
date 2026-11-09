/**
 * Claude API list prices (USD per million tokens) used for per-turn cost accounting and user budgets.
 * Source: Anthropic pricing as of 2026-10. Re-check https://platform.claude.com/docs/en/about-claude/pricing
 * before budgeting, and keep this table in config if prices change.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheRead: number;
}

export const PRICES: Record<string, ModelPrice> = {
  // Kept so cost stays correct if LLM_MAIN_MODEL is switched to Sonnet.
  "claude-sonnet-5-5": { input: 2.0, output: 10.0, cacheWrite5m: 2.5, cacheRead: 0.2 },
  // Haiku 5.5 rate card for prompts <= 100K tokens (longer prompts: $0.50 / $2.50).
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheRead: 0.01 },
};

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Cost in USD of one API call. `input_tokens` excludes cached tokens (they are reported separately). */
export function costUsd(model: string, u: Usage): number {
  const p = PRICES[model];
  if (!p) return 0;
  return (
    (u.input_tokens * p.input +
      (u.cache_creation_input_tokens ?? 0) * p.cacheWrite5m +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      u.output_tokens * p.output) /
    1_000_000
  );
}
