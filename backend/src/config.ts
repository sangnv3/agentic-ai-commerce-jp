function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing env ${name}`);
  return v;
}

/** PEM keys in env vars: accept real newlines or "\n"-escaped single-line values (common in hosting dashboards). */
export function pemFromEnv(name: string): string {
  return (process.env[name] ?? "").replace(/\\n/g, "\n").trim();
}

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

const isProduction = process.env.NODE_ENV === "production";

/**
 * Local dev mode (DEV_MODE=true): "Bearer dev:<user>" login bypass, file-based signing key. Refused in production.
 */
const devMode = process.env.DEV_MODE === "true";
if (devMode && isProduction) throw new Error("DEV_MODE must never be enabled in production");

/**
 * AUTH_MODE
 *  - "entra": Microsoft Entra ID access tokens (the real setup).
 *  - "demo" : shared demo password → each visitor gets their own sample customer (for a public demo deployment).
 */
const authMode = env("AUTH_MODE", "entra") as "entra" | "demo";
if (authMode === "demo" && (!process.env.DEMO_PASSWORD || (process.env.DEMO_AUTH_SECRET ?? "").length < 32)) {
  throw new Error("AUTH_MODE=demo requires DEMO_PASSWORD and DEMO_AUTH_SECRET (at least 32 characters)");
}

// On Railway, RAILWAY_PUBLIC_DOMAIN is set automatically when the service has a public domain.
const defaultOrigin = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "http://localhost:5173";

export const config = {
  isProduction,
  devMode,
  port: Number(env("PORT", "8080")),
  authMode,
  demo: {
    password: env("DEMO_PASSWORD", ""),
    secret: env("DEMO_AUTH_SECRET", ""),
    sessionTtlSec: 8 * 3600,
  },
  llm: {
    // ANTHROPIC_API_KEY is read by the SDK from the environment (never hard-coded, never in the browser).
    // Cost-first choice: Claude Haiku 5.5 runs the agent too (reasoning, planning, tool calling).
    // If evals show it struggles on complex flows, set LLM_MAIN_MODEL=claude-sonnet-5-5 — no code change.
    mainModel: env("LLM_MAIN_MODEL", "claude-haiku-5-5"),
    lightModel: env("LLM_LIGHT_MODEL", "claude-haiku-5-5"), // intent, preference extraction, summaries
    // "medium" keeps multistep tool use reliable on the small model; "low" is cheaper/faster — decide with evals.
    mainEffort: env("LLM_MAIN_EFFORT", "medium") as Effort,
    maxOutputTokens: 16000, // includes thinking
    requestTimeoutMs: Number(env("LLM_REQUEST_TIMEOUT_MS", "45000")), // per API call
    turnTimeoutMs: Number(env("LLM_TURN_TIMEOUT_MS", "90000")), // whole chat turn incl. tools
    retry: { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 8000 },
    perUserDailyUsd: Number(env("LLM_PER_USER_DAILY_USD", "0.05")),
    perUserDailyTurns: Number(env("LLM_PER_USER_DAILY_TURNS", "80")),
    // Hard cap for the whole deployment per JST day — protects a public demo from runaway cost.
    globalDailyUsd: Number(env("LLM_GLOBAL_DAILY_USD", "2")),
    // Summarize the conversation when the prompt grows beyond this many tokens. Keep it well under 100K:
    // Haiku 5.5 prompts above 100K tokens are billed at a 5x higher rate card.
    summarizeAboveInputTokens: Number(env("LLM_SUMMARIZE_ABOVE_TOKENS", "60000")),
  },
  entra: {
    tenantId: env("ENTRA_TENANT_ID", ""),
    audience: env("ENTRA_API_AUDIENCE", "api://food-ordering"),
    // Public SPA settings handed to the browser by GET /api/auth/config (no secrets).
    spaClientId: env("ENTRA_SPA_CLIENT_ID", ""),
    apiScope: env("ENTRA_API_SCOPE", "api://food-ordering/Orders.ReadWrite"),
  },
  algolia: {
    appId: env("ALGOLIA_APP_ID", ""),
    searchKey: env("ALGOLIA_SEARCH_KEY", ""),
    indexByLocale: { ja: "menu_items_ja", en: "menu_items_en" } as const,
  },
  redisUrl: env("REDIS_URL", "redis://localhost:6379"),
  databaseUrl: env("DATABASE_URL", "postgres://localhost/food"),
  databaseSsl: env("DATABASE_SSL", "false") === "true",
  confirmation: {
    signingKeyPem: pemFromEnv("CONFIRMATION_SIGNING_KEY_PEM"),
    // Alternative to the PEM env var (used by local dev: dev/keys/confirmation-private.pem).
    signingKeyFile: env("CONFIRMATION_SIGNING_KEY_FILE", ""),
    requestTtlSec: 300,
    tokenTtlSec: 300,
  },
  webOrigin: env("WEB_ORIGIN", defaultOrigin),
  /** Directory of the built SPA (web/dist). Served by this service so the app and API share one origin. */
  webDistDir: env("WEB_DIST_DIR", ""),
  limits: {
    maxIterationsPerTurn: 12,
    maxToolCallsPerTurn: 30,
  },
};
