import { redis } from "../checkout/confirmation.js";
import { db } from "../db/pool.js";
import { config } from "../config.js";
import type { Message } from "../llm/provider.js";

/**
 * Chat session state (table chat_sessions + Redis for the live history, 24h TTL).
 * `messages` is APPEND-ONLY within an epoch: assistant turns are stored exactly as returned (thinking blocks
 * included). When the conversation gets long, the context manager starts a NEW epoch from a summary instead
 * of editing old turns — editing would invalidate replayed thinking blocks and the prompt cache.
 */
export interface AgentSession {
  sessionId: string;
  userId: string;
  locale: "ja" | "en";
  turnIndex: number;
  epoch: number;
  messages: Message[];
  /** Summary carried into the current epoch (null in epoch 0). */
  carriedSummary: string | null;
  /** Input tokens of the latest model call — drives summarization. */
  lastInputTokens: number;
  /** Preference profile version last given to Claude, to re-send the summary only when it changes. */
  preferenceVersionSent: number | null;
  sessionExtraAllergens: string[];
  totals: { inputTokens: number; outputTokens: number; costUsd: number };
}

const TTL = 24 * 3600;
const k = (id: string) => `agent:session:${id}`;

export function newSession(sessionId: string, userId: string, locale: "ja" | "en"): AgentSession {
  return {
    sessionId,
    userId,
    locale,
    turnIndex: 0,
    epoch: 0,
    messages: [],
    carriedSummary: null,
    lastInputTokens: 0,
    preferenceVersionSent: null,
    sessionExtraAllergens: [],
    totals: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };
}

/** Redis first (hot), then PostgreSQL (chat history survives Redis expiry and restarts). */
export async function loadSession(sessionId: string): Promise<AgentSession | null> {
  const raw = await redis.get(k(sessionId));
  if (raw) return JSON.parse(raw) as AgentSession;
  const { rows } = await db.query<{ state: AgentSession | null }>("SELECT state FROM chat_sessions WHERE session_id = $1", [sessionId]);
  const state = rows[0]?.state ?? null;
  if (state) await redis.set(k(sessionId), JSON.stringify(state), "EX", TTL);
  return state;
}

export async function saveSession(s: AgentSession): Promise<void> {
  await redis.set(k(s.sessionId), JSON.stringify(s), "EX", TTL);
  await db.query(
    `INSERT INTO chat_sessions (session_id, user_id, locale, epoch, state, main_model, light_model,
       total_input_tokens, total_output_tokens, total_cost_usd, last_activity_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
     ON CONFLICT (session_id) DO UPDATE SET epoch = EXCLUDED.epoch, state = EXCLUDED.state,
       total_input_tokens = EXCLUDED.total_input_tokens, total_output_tokens = EXCLUDED.total_output_tokens,
       total_cost_usd = EXCLUDED.total_cost_usd, last_activity_at = now()`,
    [s.sessionId, s.userId, s.locale, s.epoch, JSON.stringify(s), config.llm.mainModel, config.llm.lightModel,
      s.totals.inputTokens, s.totals.outputTokens, s.totals.costUsd],
  );
}

/** Per-session mutex so two concurrent requests never interleave turns. */
export async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const lockKey = `${k(sessionId)}:lock`;
  const ok = await redis.set(lockKey, "1", "EX", 150, "NX");
  if (!ok) throw new Error("SESSION_BUSY");
  try {
    return await fn();
  } finally {
    await redis.del(lockKey);
  }
}

// ---------- transcript (what the UI shows) ----------
export async function appendTranscript(sessionId: string, userId: string, role: "user" | "assistant" | "event", text: string | null, data?: Record<string, unknown>) {
  await db.query("INSERT INTO chat_messages (session_id, user_id, role, text, data) VALUES ($1,$2,$3,$4,$5)", [sessionId, userId, role, text, data ? JSON.stringify(data) : null]);
  if (role === "user" && text) await db.query("UPDATE chat_sessions SET title = COALESCE(title, $2) WHERE session_id = $1", [sessionId, text.slice(0, 60)]);
}

export async function setSessionOrder(sessionId: string, orderId: string) {
  await db.query("UPDATE chat_sessions SET order_id = $2, status = 'completed' WHERE session_id = $1", [sessionId, orderId]);
}

export async function listSessions(userId: string) {
  const { rows } = await db.query(
    `SELECT s.session_id, s.title, s.started_at, s.last_activity_at, s.order_id,
            (SELECT count(*)::int FROM chat_messages m WHERE m.session_id = s.session_id AND m.role = 'user') AS user_messages
       FROM chat_sessions s WHERE s.user_id = $1 ORDER BY s.last_activity_at DESC LIMIT 50`,
    [userId],
  );
  return rows;
}

export async function getTranscript(sessionId: string, userId: string) {
  const s = await db.query("SELECT session_id, title, order_id FROM chat_sessions WHERE session_id = $1 AND user_id = $2", [sessionId, userId]);
  if (!s.rows[0]) return null;
  const m = await db.query("SELECT message_id, role, text, data, created_at FROM chat_messages WHERE session_id = $1 ORDER BY message_id", [sessionId]);
  return { ...s.rows[0], messages: m.rows };
}
